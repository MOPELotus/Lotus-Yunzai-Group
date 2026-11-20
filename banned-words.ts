import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegexCandidate } from "./banned-rule-worker.ts";
import { readManagedWhitelist, type ManagedBlacklistStore } from "./managed-blacklist.ts";

const actions = ["kick", "mute", "recall", "kick-recall", "mute-recall", "kick-blacklist"] as const;
export interface GroupBannedWordMatch {
  readonly action: typeof actions[number];
  readonly seconds: number;
  readonly preview: string;
}

export interface GroupBannedWords {
  match(groupId: number, userId: number, text: string, signal?: AbortSignal,
    readImageMd5?: (signal: AbortSignal) => Promise<string | undefined>): Promise<GroupBannedWordMatch | undefined>;
  recordConfirmedKick(userId: number, signal: AbortSignal, authorize: () => Promise<boolean>): Promise<void>;
}

export class GroupRulesWritePermissionError extends Error {}

interface Context {
  readonly message_type: "group" | "private" | "terminal";
  readonly group_id?: number;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly adapter?: "milky" | "onebot";
  readonly message_id?: number | string;
  readonly isDelegated?: boolean;
  readonly normalizedMessage: string;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupRuleImageDigest?: (signal: AbortSignal) => Promise<string | undefined>;
}

type LockFile = (file: string, subject: string) => Promise<{ close(): void }>;
type WordPart = string | { readonly type: "face"; readonly id: string };
type WordReply = string | readonly WordPart[] | { readonly type: "forward"; readonly nodes: readonly (readonly WordPart[])[] };
type Data = Record<string, unknown>;

const maxBytes = 512 * 1024;
const maxRules = 256;
const maxForwardNodes = 100;
const maxWordLength = 512;
const maxTextLength = 4096;
const defaultMuteSeconds = 300;
const maxMuteSeconds = 2_147_483_647;
const ruleModes = ["精确", "模糊", "正则"] as const;
const penaltyNames = ["踢", "禁", "撤", "踢撤", "禁撤", "踢黑"] as const;
const addRule = /^#?新增(模糊|精确|正则[12]?)?(踢撤|禁撤|踢黑|踢|禁|撤)?违禁词([\s\S]*)$/u;
const queryRule = /^#?(删除|查看)违禁词([\s\S]*)$/u;
const listRules = /^#?违禁词列表(原始|raw)?$/u;
const setTime = /^#?设置违禁词禁言时间(\d+)$/u;
const helpCommand = /^#?违禁词帮助$/u;
const imageRule = /^\{image[:_]([a-fA-F0-9]{32})\}$/u;
const md5 = /^[a-fA-F0-9]{32}$/u;
export const groupBannedWordsFeature = "[group] 违禁词";

const help = "违禁词帮助\n新增：#新增违禁词 内容（默认精确匹配、禁言）\n" +
  "支持精确、模糊、正则1（表达式）、正则2（/表达式/标志），以及踢、禁、撤、踢撤、禁撤、踢黑。\n" +
  "例如：#新增模糊撤违禁词 内容；#新增正则2禁违禁词 /^示例$/i\n" +
  "查看：#查看违禁词 内容；#违禁词列表；#违禁词列表原始\n删除：#删除违禁词 内容\n" +
  "新增、查看或删除精确图片规则时，可在命令后附一张原图。\n" +
  "设置禁言秒数：#设置违禁词禁言时间300";

export function isGroupBannedWordCommand(message: string): boolean {
  return addRule.test(message) || queryRule.test(message) || listRules.test(message) || setTime.test(message) || helpCommand.test(message);
}

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function record(value: unknown): value is Data { return !!value && typeof value === "object" && !Array.isArray(value); }

async function readFile(path: string): Promise<Buffer | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!file) return;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("违禁词文件无效。");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size !== stat.size) throw new Error("违禁词文件正由其他程序修改。");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

function decode(bytes?: Buffer): Data {
  if (!bytes) return {};
  const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!record(data) || data.bannedWords != null && !record(data.bannedWords)) throw new Error("违禁词配置格式无效。");
  return data;
}

function muteTime(data: Data): number {
  const raw = data.muteTime;
  const seconds = typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : raw;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 0 && seconds <= maxMuteSeconds ? seconds : defaultMuteSeconds;
}

function regexRule(raw: string, requireLiteral = false): { source: string; flags: string } | undefined {
  if (raw.length > maxWordLength || /[\r\n]/u.test(raw)) return;
  let source = raw, flags = "";
  if (raw.startsWith("/") && (requireLiteral || raw.lastIndexOf("/") > 0)) {
    const close = raw.lastIndexOf("/");
    if (close < 1) return;
    source = raw.slice(1, close);
    flags = raw.slice(close + 1);
    if (!/^[dgimsuvy]*$/u.test(flags) || /^(?:[^\\/]|\\.)*\//u.test(source)) return;
  } else if (requireLiteral) return;
  try { new RegExp(source, flags); } catch { return; }
  return { source, flags };
}

function matchType(entry: unknown) { return record(entry) ? Number(entry.matchType) : 0; }
function penalty(entry: unknown) { return record(entry) ? actions[Number(entry.penaltyType) - 1] : undefined; }

function imageRuleMd5(raw: string, entry: unknown): string | undefined {
  if (matchType(entry) === 1 && penalty(entry)) return imageRule.exec(raw)?.[1]?.toUpperCase();
}

function findImageRule(rules: Data, digest: string) {
  return Object.entries(rules).slice(0, maxRules).find(([raw, entry]) => imageRuleMd5(raw, entry) === digest);
}

function wordMatch(data: Data, matched: readonly [string, unknown], image = false): GroupBannedWordMatch | undefined {
  let action = penalty(matched[1]);
  if (!action) return;
  const seconds = muteTime(data);
  if (!seconds && action === "mute") return;
  if (!seconds && action === "mute-recall") action = "recall";
  if (image) return { action, seconds, preview: "[图片]" };
  const characters = Array.from(matched[0].replace(/[\p{Cc}\p{Cf}]/gu, ""));
  return { action, seconds, preview: characters.slice(0, 2).join("") + "*".repeat(Math.max(0, characters.length - 2)) };
}

function display(raw: string, entry: unknown, rawMode = false): readonly WordPart[] {
  const info = record(entry) ? entry : {};
  const clean = raw.slice(0, maxWordLength).replace(/[\p{Cc}\p{Cf}]/gu, "");
  const word: WordPart[] = rawMode ? [clean] : imageRule.test(clean) ? ["[图片]"] : clean.split(/(\{face[:_](\d+)\})/u).flatMap<WordPart>((part, index) => {
    if (index % 3 === 1 || !part) return [];
    return index % 3 === 2 ? [{ type: "face" as const, id: part }] : [part];
  });
  return ["屏蔽词：", ...word, `\n匹配模式：${ruleModes[matchType(entry) - 1] ?? "旧规则待核对"}` +
    `\n处理方式：${penaltyNames[Number(info.penaltyType) - 1] ?? "旧规则待核对"}` +
    `\n添加人：${positive(info.addedBy) || typeof info.addedBy === "string" && /^\d{1,16}$/u.test(info.addedBy) ? info.addedBy : "未知"}` +
    `\n添加时间：${typeof info.date === "string" ? info.date.slice(0, 48).replace(/[\p{Cc}\p{Cf}]/gu, "") : "未知"}`];
}

function forwardRules(rules: Data, rawMode: boolean): WordReply {
  const entries = Object.entries(rules).slice(0, maxRules);
  if (!entries.length) return "没有违禁词。";
  const perNode = Math.ceil(entries.length / maxForwardNodes);
  const nodes: WordPart[][] = [];
  for (const [index, [word, data]] of entries.entries()) {
    if (index % perNode === 0) nodes.push([]);
    const node = nodes.at(-1)!;
    if (node.length) node.push("\n\n");
    node.push(...display(word, data, rawMode));
  }
  return { type: "forward", nodes };
}

async function regexMatch(text: string, rules: readonly RegexCandidate[], signal: AbortSignal): Promise<number> {
  if (signal.aborted) return -1;
  const worker = new Worker(new URL("./banned-rule-worker.ts", import.meta.url), { smol: true });
  const result = Promise.withResolvers<number>();
  const stop = () => result.resolve(-1);
  const deadline = setTimeout(stop, 200);
  signal.addEventListener("abort", stop, { once: true });
  worker.onmessage = ({ data }) => result.resolve(typeof data === "number" && Number.isSafeInteger(data) ? data : -1);
  worker.onerror = (error) => { error.preventDefault(); stop(); };
  try {
    worker.postMessage({ text, rules });
    return await result.promise;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", stop);
    worker.terminate();
  }
}

export function createGroupBannedWords(root: URL, lockFile: LockFile, blacklist: ManagedBlacklistStore, signal: AbortSignal) {
  const directory = fileURLToPath(new URL("data/group/banned-words/", root));
  const legacy = fileURLToPath(new URL("plugins/yenai-plugin/config/group/", root));
  const recognized = new Set<string>();
  let regexActive = 0;

  async function read(groupId: number) {
    if (!positive(groupId)) throw new TypeError("群号无效。");
    const primary = join(directory, `${groupId}.json`);
    const target = await readFile(primary);
    const previous = target === undefined ? await readFile(join(legacy, `${groupId}.json`)) : undefined;
    return { primary, target, previous, data: decode(target ?? previous) };
  }

  async function update<T extends WordReply>(groupId: number, authorize: () => Promise<boolean>, change: (data: Data) => T): Promise<T | string> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(directory, `.${groupId}.sqlite`), "群违禁词");
    try {
      const before = await read(groupId);
      const original = JSON.stringify(before.data);
      const reply = change(before.data);
      const next = JSON.stringify(before.data, null, 2) + "\n";
      if (original === JSON.stringify(before.data)) return reply;
      if (Buffer.byteLength(next) > maxBytes) throw new Error("违禁词文件超出上限。");
      const stage = await mkdtemp(join(directory, ".rules-"));
      try {
        const staged = join(stage, "rules.json");
        const file = await open(staged, "wx", 0o600);
        try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
        if (!await authorize()) throw new GroupRulesWritePermissionError();
        const latest = await read(groupId);
        if (before.target ? !latest.target?.equals(before.target) : latest.target ||
            (before.previous ? !latest.previous?.equals(before.previous) : latest.previous)) {
          throw new Error("违禁词配置正由其他程序修改。");
        }
        signal.throwIfAborted();
        if (before.target) await rename(staged, before.primary);
        else await link(staged, before.primary);
        return reply;
      } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
    } finally { lock.close(); }
  }

  const policy: GroupBannedWords = {
    async match(groupId, userId, text, eventSignal, readImageMd5) {
      const active = eventSignal ? AbortSignal.any([signal, eventSignal]) : signal;
      if (!positive(groupId) || !positive(userId) || active.aborted || (!text && !readImageMd5) || text.length > maxTextLength) return;
      const data = (await read(groupId)).data;
      const rules = Object.entries(data.bannedWords ?? {}).slice(0, maxRules);
      if (!rules.length || active.aborted || (await readManagedWhitelist(root)).has(userId) || active.aborted) return;
      if (!text && readImageMd5) {
        if (!rules.some(([raw, entry]) => imageRuleMd5(raw, entry))) return;
        let digest: string | undefined;
        try { digest = await readImageMd5(active); } catch { return; }
        if (typeof digest !== "string" || !md5.test(digest) || active.aborted) return;
        const current = (await read(groupId)).data;
        const matched = findImageRule(record(current.bannedWords) ? current.bannedWords : {}, digest.toUpperCase());
        if (!matched || active.aborted || (await readManagedWhitelist(root)).has(userId) || active.aborted) return;
        return wordMatch(current, matched, true);
      }
      const candidates: RegexCandidate[] = [];
      for (const [index, [raw, entry]] of rules.entries()) {
        if (!penalty(entry) || !raw || raw.length > maxWordLength || imageRule.test(raw)) continue;
        const mode = matchType(entry);
        if (mode === 3) {
          const regex = regexRule(raw);
          if (regex) candidates.push({ index, ...regex });
        } else if (mode === 1 && text === raw || mode === 2 && text.includes(raw)) {
          candidates.push({ index });
          break;
        }
      }
      const first = candidates[0];
      if (!first || active.aborted) return;
      let index = first.index;
      if (first.source !== undefined) {
        if (regexActive >= 2) return;
        regexActive++;
        try { index = await regexMatch(text, candidates, active); } finally { regexActive--; }
      }
      const matched = rules[index];
      if (active.aborted || !matched) return;
      return wordMatch(data, matched);
    },
    async recordConfirmedKick(userId, eventSignal, authorize) {
      await blacklist.update([userId], true, AbortSignal.any([signal, eventSignal]), authorize);
    },
  };

  async function command(_message: string, context: Context): Promise<WordReply | undefined> {
    const value = context.normalizedMessage.trim();
    const { group_id, self_id, user_id, message_id } = context;
    if (context.message_type !== "group" || context.isDelegated || signal.aborted ||
        !positive(group_id) || !positive(self_id) || !positive(user_id) || !isGroupBannedWordCommand(value)) return;
    if (helpCommand.test(value)) return help;
    const add = addRule.exec(value), query = queryRule.exec(value), list = listRules.exec(value), time = setTime.exec(value);
    let word = (add?.[3] ?? query?.[2])?.trim();
    const readImage = !word && (add || query) ? context.groupRuleImageDigest : undefined;
    if ((add || query) && (!word && !readImage || word && word.length > maxWordLength)) return add && !word ? help : "请填写有效的违禁词。";
    const viewing = query?.[1] === "查看";
    const permission = "当前会话没有编辑违禁词的权限。";
    try {
      if (list || viewing && !readImage) {
        const data = (await read(group_id)).data;
        const records = record(data.bannedWords) ? data.bannedWords : {};
        if (list) return forwardRules(records, !!list[1]);
        return word && Object.hasOwn(records, word) ? display(word, records[word]) : "这条违禁词不存在。";
      }
      const authorize = async () => {
        try { return !signal.aborted && await context.groupManageBlacklist?.() === true && !signal.aborted; }
        catch { return false; }
      };
      if (!viewing && !await authorize()) return permission;
      const ruleMode = add?.[1]?.startsWith("正则") ? 3 : add?.[1] === "模糊" ? 2 : 1;
      if (readImage && ruleMode !== 1) return "图片违禁词仅支持精确匹配。";
      const seconds = Number(time?.[1]);
      if (time && (!Number.isInteger(seconds) || seconds < 0 || seconds > maxMuteSeconds)) return "请输入有效的禁言秒数。";
      if (add && word && ruleMode === 3 && !regexRule(word, add[1] === "正则2")) return "正则表达式无效。";
      if (!(typeof message_id === "number" && Number.isSafeInteger(message_id)) &&
          !(typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128)) return [];
      const key = JSON.stringify([context.adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
      if (recognized.has(key)) return [];
      recognized.add(key);
      if (recognized.size > 2048) {
        const oldest = recognized.values().next();
        if (!oldest.done) recognized.delete(oldest.value);
      }
      let digest: string | undefined;
      if (readImage) {
        let received: string | undefined;
        try { received = await readImage(signal); } catch { /* The original image was unavailable. */ }
        if (signal.aborted || typeof received !== "string" || !md5.test(received)) return "无法读取原消息的违禁词图片。";
        digest = received.toUpperCase();
        word = `{image:${digest}}`;
        if (viewing) {
          const { data } = await read(group_id);
          if (signal.aborted) return;
          const matched = findImageRule(record(data.bannedWords) ? data.bannedWords : {}, digest);
          return matched ? display(...matched) : "这条违禁词不存在。";
        }
        if (!await authorize()) return permission;
      }
      return await update(group_id, authorize, (data) => {
        if (time) {
          data.muteTime = seconds;
          return `本群违禁词禁言时间已设置为 ${seconds} 秒。`;
        }
        const rules = record(data.bannedWords) ? data.bannedWords : {};
        if (!word) return "请填写有效的违禁词。";
        const imageKey = digest && findImageRule(rules, digest)?.[0];
        if (query) {
          const target = digest ? imageKey : word;
          if (!target || !Object.hasOwn(rules, target)) return "这条违禁词不存在。";
          delete rules[target];
          return "已删除违禁词。";
        }
        if (imageKey || Object.hasOwn(rules, word)) return "这条违禁词已存在。";
        if (Object.keys(rules).length >= maxRules) return "本群违禁词已达上限。";
        const entry = { matchType: ruleMode, penaltyType: penaltyNames.indexOf((add?.[2] ?? "禁") as typeof penaltyNames[number]) + 1,
          addedBy: user_id, date: new Date().toISOString() };
        data.bannedWords = { ...rules, [word]: entry };
        return ["已添加违禁词。\n", ...display(word, entry)];
      });
    } catch (error) {
      return error instanceof GroupRulesWritePermissionError ? permission : "违禁词配置暂不可用。";
    }
  }

  return { policy, command, titleStore: { read: async (groupId: number) => (await read(groupId)).data, update } };
}
