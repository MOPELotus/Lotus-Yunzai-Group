import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
  readonly screenedReply?: string;
}

export interface GroupWordMatchScope {
  readonly groupRules: boolean;
  readonly screenedText?: string;
}

type WordTextOrFace = { readonly type: "text"; readonly text: string } | { readonly type: "face"; readonly id: number };
export type GroupBannedWordPart = WordTextOrFace | { readonly type: "image"; readonly readMd5: (signal: AbortSignal) => Promise<string | undefined> };

export interface GroupBannedWords {
  match(groupId: number, userId: number, text: string, signal?: AbortSignal,
    readImageMd5?: (signal: AbortSignal) => Promise<string | undefined>, mixed?: readonly GroupBannedWordPart[],
    scope?: GroupWordMatchScope): Promise<GroupBannedWordMatch | undefined>;
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
const ruleModes = [$t("banned-words.text_235532a9c1"), $t("banned-words.text_36bab7a3de"), $t("banned-words.text_75b304aa94")] as const;
const penaltyLabels = [$t("banned-words.text_3b470aa585"), $t("banned-words.text_9e0ee023b2"), $t("banned-words.text_b8e928759e"), $t("banned-words.text_f0b232b249"), $t("banned-words.text_907a17c4be"), $t("banned-words.text_ab5be2dc91")] as const;
const penaltyNames = ["踢", "禁", "撤", "踢撤", "禁撤", "踢黑"] as const;
const addRule = /^#?新增(模糊|精确|正则[12]?)?(踢撤|禁撤|踢黑|踢|禁|撤)?违禁词([\s\S]*)$/u;
const queryRule = /^#?(删除|查看)违禁词([\s\S]*)$/u;
const listRules = /^#?违禁词列表(原始|raw)?$/u;
const setTime = /^#?设置违禁词禁言时间(\d+)$/u;
const helpCommand = /^#?违禁词帮助$/u;
const imageRule = /^\{image[:_]([a-fA-F0-9]{32})\}$/u;
const imageToken = /\{image[:_][a-fA-F0-9]{32}\}/u;
const md5 = /^[a-fA-F0-9]{32}$/u;
const legacyPart = /\{(?:image[:_]([a-fA-F0-9]{32})|face[:_](\d{1,16}))\}/gu;
const maxMixedImages = 3;
export const groupBannedWordsFeature = "[group] 违禁词";

const help = $t("banned-words.text_93df2f0113") +
  $t("banned-words.text_d6fe6c12b1") +
  $t("banned-words.text_6734533fef") +
  $t("banned-words.text_ab9cfc0c94") +
  $t("banned-words.text_9c2db968fe") +
  $t("banned-words.text_a206a3de0b");

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
    if (!stat.isFile() || stat.size > maxBytes) throw new Error($t("banned-words.text_18b28c4b48"));
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size !== stat.size) throw new Error($t("banned-words.text_1be34f23d0"));
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

function decode(bytes?: Buffer): Data {
  if (!bytes) return {};
  const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!record(data) || data.bannedWords != null && !record(data.bannedWords)) throw new Error($t("banned-words.text_079f417d9c"));
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

function appendPart(parts: GroupBannedWordPart[], part: GroupBannedWordPart) {
  if (part.type === "text") {
    if (!part.text) return;
    const previous = parts.at(-1);
    if (previous?.type === "text") {
      parts[parts.length - 1] = { type: "text", text: previous.text + part.text };
      return;
    }
  }
  parts.push(part);
}

function prepareMixed(input: readonly GroupBannedWordPart[] | undefined): readonly GroupBannedWordPart[] | undefined {
  if (!input || input.length < 2 || input.length > 64) return;
  const parts: GroupBannedWordPart[] = [];
  let images = 0, length = 0;
  for (const part of input) {
    if (part.type === "image" && ++images > maxMixedImages) return;
    if (part.type === "text" && (length += part.text.length) > maxTextLength) return;
    if (part.type === "face" && (!Number.isSafeInteger(part.id) || part.id < 0)) return;
    appendPart(parts, part);
  }
  const first = parts[0];
  if (first?.type === "text") {
    const text = first.text.trimStart();
    if (text) parts[0] = { type: "text", text };
    else parts.shift();
  }
  const last = parts.at(-1);
  if (last?.type === "text") {
    const text = last.text.trimEnd();
    if (text) parts[parts.length - 1] = { type: "text", text };
    else parts.pop();
  }
  if (images && parts.length > 1) return parts;
}

type LegacyMixedPart = WordTextOrFace | { readonly type: "image"; readonly digest: string };

function legacyMixedParts(raw: string): readonly LegacyMixedPart[] | undefined {
  if (!imageToken.test(raw) || raw.length > maxWordLength) return;
  const parts: LegacyMixedPart[] = [];
  let end = 0;
  for (const token of raw.matchAll(legacyPart)) {
    if (end < token.index) parts.push({ type: "text", text: raw.slice(end, token.index) });
    const [, digest, faceId] = token;
    if (digest) parts.push({ type: "image", digest: digest.toUpperCase() });
    else {
      const id = Number(faceId);
      if (!Number.isSafeInteger(id)) return;
      parts.push({ type: "face", id });
    }
    end = token.index + token[0].length;
  }
  if (end < raw.length) parts.push({ type: "text", text: raw.slice(end) });
  return parts;
}

type ImageCheck = readonly [position: number, digest: string];

function imageChecks(expected: readonly LegacyMixedPart[], parts: readonly GroupBannedWordPart[], offset: number, fuzzy: boolean) {
  const checks: ImageCheck[] = [];
  for (const [index, part] of expected.entries()) {
    const position = offset + index;
    const actual = parts[position];
    if (part.type !== actual?.type) return;
    if (part.type === "image") checks.push([position, part.digest]);
    else if (part.type === "face" && (actual.type !== "face" || part.id !== actual.id)) return;
    else if (part.type === "text") {
      if (actual.type !== "text") return;
      const matches = fuzzy && index === 0 ? actual.text.endsWith(part.text)
        : fuzzy && index === expected.length - 1 ? actual.text.startsWith(part.text) : actual.text === part.text;
      if (!matches) return;
    }
  }
  return checks;
}

function* mediaCandidates(rules: readonly [string, unknown][], parts: readonly GroupBannedWordPart[], stopAt: number) {
  for (const [index, [raw, entry]] of rules.entries()) {
    if (index === stopAt) return;
    const mode = matchType(entry);
    if ((mode !== 1 && mode !== 2) || !penalty(entry)) continue;
    const expected = legacyMixedParts(raw);
    if (!expected || (mode === 1 && expected.length !== parts.length)) continue;
    for (let offset = 0; offset <= parts.length - expected.length; offset++) {
      const checks = imageChecks(expected, parts, offset, mode === 2);
      if (checks?.length) yield { index, checks };
    }
  }
}

async function readDigest(part: GroupBannedWordPart | undefined, signal: AbortSignal): Promise<string | undefined> {
  if (part?.type !== "image" || signal.aborted) return;
  try {
    const value = await part.readMd5(signal);
    if (typeof value === "string" && md5.test(value) && !signal.aborted) return value.toUpperCase();
  } catch { /* The original image was unavailable. */ }
}

async function findMediaRule(rules: readonly [string, unknown][], parts: readonly GroupBannedWordPart[], stopAt: number,
  digests: Map<number, string | undefined>, signal: AbortSignal) {
  for (const { index, checks } of mediaCandidates(rules, parts, stopAt)) {
    if (signal.aborted) break;
    if (checks.some(([position, digest]) => digests.has(position) && digests.get(position) !== digest)) continue;
    const unread = checks.find(([position]) => !digests.has(position));
    if (!unread) return index;
    const [position] = unread;
    digests.set(position, await readDigest(parts[position], signal));
    // Re-evaluate current rules and whitelist before reading another image or acting.
    return;
  }
  return -1;
}

function wordMatch(data: Data, matched: readonly [string, unknown], image = false): GroupBannedWordMatch | undefined {
  let action = penalty(matched[1]);
  if (!action) return;
  const seconds = muteTime(data);
  if (!seconds && action === "mute") return;
  if (!seconds && action === "mute-recall") action = "recall";
  if (image) return { action, seconds, preview: $t("banned-words.text_a71f445d35") };
  const characters = Array.from(matched[0].replace(/[\p{Cc}\p{Cf}]/gu, ""));
  return { action, seconds, preview: characters.slice(0, 2).join("") + "*".repeat(Math.max(0, characters.length - 2)) };
}

function display(raw: string, entry: unknown, rawMode = false): readonly WordPart[] {
  const info = record(entry) ? entry : {};
  const clean = raw.slice(0, maxWordLength).replace(/[\p{Cc}\p{Cf}]/gu, "");
  const word: WordPart[] = rawMode ? [clean] : imageRule.test(clean) ? [$t("banned-words.text_a71f445d35")] : clean.split(/(\{face[:_](\d+)\})/u).flatMap<WordPart>((part, index) => {
    if (index % 3 === 1 || !part) return [];
    return index % 3 === 2 ? [{ type: "face" as const, id: part }] : [part];
  });
  return [$t("banned-words.text_515903994e"), ...word, $t("banned-words.text_271af2a977", { "value1": ruleModes[matchType(entry) - 1] ?? $t("banned-words.text_45436534d8") }) +
    $t("banned-words.text_259220ce1a", { "value1": penaltyLabels[Number(info.penaltyType) - 1] ?? $t("banned-words.text_45436534d8") }) +
    $t("banned-words.text_db77d61415", { "value1": positive(info.addedBy) || typeof info.addedBy === "string" && /^\d{1,16}$/u.test(info.addedBy) ? info.addedBy : $t("banned-words.text_4d8c1c5b42") }) +
    $t("banned-words.text_f31340cb38", { "value1": typeof info.date === "string" ? info.date.slice(0, 48).replace(/[\p{Cc}\p{Cf}]/gu, "") : $t("banned-words.text_4d8c1c5b42") })];
}

function forwardRules(rules: Data, rawMode: boolean): WordReply {
  const entries = Object.entries(rules).slice(0, maxRules);
  if (!entries.length) return $t("banned-words.text_fff11ce9d2");
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

async function regexMatch(text: string, rules: readonly RegexCandidate[], signal: AbortSignal): Promise<number | undefined> {
  if (signal.aborted) return;
  const worker = new Worker(new URL("./banned-rule-worker.ts", import.meta.url), { smol: true });
  const result = Promise.withResolvers<number | undefined>();
  const stop = () => result.resolve(undefined);
  const deadline = setTimeout(stop, 200);
  signal.addEventListener("abort", stop, { once: true });
  worker.onmessage = ({ data }) => result.resolve(typeof data === "number" && Number.isSafeInteger(data) ? data : undefined);
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

export function createGroupBannedWords(root: URL, lockFile: LockFile, blacklist: ManagedBlacklistStore, signal: AbortSignal,
  screened?: (group: number, text: string, signal: AbortSignal) => Promise<GroupBannedWordMatch | undefined>) {
  const directory = fileURLToPath(new URL("data/group/banned-words/", root));
  const legacy = fileURLToPath(new URL("plugins/yenai-plugin/config/group/", root));
  const recognized = new Set<string>();
  let regexActive = 0;

  async function read(groupId: number) {
    if (!positive(groupId)) throw new TypeError($t("banned-words.text_eecfc48be1"));
    const primary = join(directory, `${groupId}.json`);
    const target = await readFile(primary);
    const previous = target === undefined ? await readFile(join(legacy, `${groupId}.json`)) : undefined;
    return { primary, target, previous, data: decode(target ?? previous) };
  }

  async function update<T extends WordReply>(groupId: number, authorize: () => Promise<boolean>, change: (data: Data) => T): Promise<T | string> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(directory, `.${groupId}.sqlite`), $t("banned-words.text_222c77c1a1"));
    try {
      const before = await read(groupId);
      const original = JSON.stringify(before.data);
      const reply = change(before.data);
      const next = JSON.stringify(before.data, null, 2) + "\n";
      if (original === JSON.stringify(before.data)) return reply;
      if (Buffer.byteLength(next) > maxBytes) throw new Error($t("banned-words.text_3ffe6d0671"));
      const stage = await mkdtemp(join(directory, ".rules-"));
      try {
        const staged = join(stage, "rules.json");
        const file = await open(staged, "wx", 0o600);
        try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
        if (!await authorize()) throw new GroupRulesWritePermissionError();
        const latest = await read(groupId);
        if (before.target ? !latest.target?.equals(before.target) : latest.target ||
            (before.previous ? !latest.previous?.equals(before.previous) : latest.previous)) {
          throw new Error($t("banned-words.text_d5928ee880"));
        }
        signal.throwIfAborted();
        if (before.target) await rename(staged, before.primary);
        else await link(staged, before.primary);
        return reply;
      } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
    } finally { lock.close(); }
  }

  async function findTextRule(rules: readonly [string, unknown][], text: string, active: AbortSignal): Promise<number | undefined> {
    if (!text) return -1;
    const candidates: RegexCandidate[] = [];
    for (const [index, [raw, entry]] of rules.entries()) {
      if (!penalty(entry) || !raw || raw.length > maxWordLength || imageToken.test(raw)) continue;
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
    if (!first) return -1;
    if (first.source === undefined) return first.index;
    if (regexActive >= 2) return;
    regexActive++;
    try { return await regexMatch(text, candidates, active); } finally { regexActive--; }
  }

  const policy: GroupBannedWords = {
    async match(groupId, userId, text, eventSignal, readImageMd5, mixed, scope) {
      const active = eventSignal ? AbortSignal.any([signal, eventSignal]) : signal;
      if (!positive(groupId) || !positive(userId) || active.aborted) return;
      if (scope?.screenedText && screened) {
        const found = await screened(groupId, scope.screenedText, active).catch(() => undefined);
        if (found && !active.aborted && !(await readManagedWhitelist(root)).has(userId) && !active.aborted) return found;
      }
      if (scope?.groupRules === false || text.length > maxTextLength || active.aborted) return;
      const parts: readonly GroupBannedWordPart[] | undefined = prepareMixed(mixed) ??
        (!text && readImageMd5 ? [{ type: "image", readMd5: readImageMd5 }] : undefined);
      if (!text && !parts) return;
      const digests = new Map<number, string | undefined>();
      while (!active.aborted) {
        const data = (await read(groupId)).data;
        const rules = Object.entries(data.bannedWords ?? {}).slice(0, maxRules);
        if (!rules.length || active.aborted || (await readManagedWhitelist(root)).has(userId) || active.aborted) return;
        const textIndex = await findTextRule(rules, text, active);
        if (textIndex === undefined || active.aborted) return;
        const mediaIndex = parts ? await findMediaRule(rules, parts, textIndex, digests, active) : -1;
        if (mediaIndex === undefined) continue;
        if (active.aborted) return;
        const matched = rules[mediaIndex < 0 ? textIndex : mediaIndex];
        return matched && wordMatch(data, matched, mediaIndex >= 0);
      }
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
    if ((add || query) && (!word && !readImage || word && word.length > maxWordLength)) return add && !word ? help : $t("banned-words.text_e011d75927");
    const viewing = query?.[1] === "查看";
    const permission = $t("banned-words.text_a77abe6f71");
    try {
      if (list || viewing && !readImage) {
        const data = (await read(group_id)).data;
        const records = record(data.bannedWords) ? data.bannedWords : {};
        if (list) return forwardRules(records, !!list[1]);
        return word && Object.hasOwn(records, word) ? display(word, records[word]) : $t("banned-words.text_a1fe3c669f");
      }
      const authorize = async () => {
        try { return !signal.aborted && await context.groupManageBlacklist?.() === true && !signal.aborted; }
        catch { return false; }
      };
      if (!viewing && !await authorize()) return permission;
      const ruleMode = add?.[1]?.startsWith("正则") ? 3 : add?.[1] === "模糊" ? 2 : 1;
      if (readImage && ruleMode !== 1) return $t("banned-words.text_223f06e91e");
      const seconds = Number(time?.[1]);
      if (time && (!Number.isInteger(seconds) || seconds < 0 || seconds > maxMuteSeconds)) return $t("banned-words.text_aac341b388");
      if (add && word && ruleMode === 3 && !regexRule(word, add[1] === "正则2")) return $t("banned-words.text_2f0d4e72d8");
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
        if (signal.aborted || typeof received !== "string" || !md5.test(received)) return $t("banned-words.text_876a2f05fc");
        digest = received.toUpperCase();
        word = `{image:${digest}}`;
        if (viewing) {
          const { data } = await read(group_id);
          if (signal.aborted) return;
          const matched = findImageRule(record(data.bannedWords) ? data.bannedWords : {}, digest);
          return matched ? display(...matched) : $t("banned-words.text_a1fe3c669f");
        }
        if (!await authorize()) return permission;
      }
      return await update(group_id, authorize, (data) => {
        if (time) {
          data.muteTime = seconds;
          return $t("banned-words.text_e476b9f54c", { "seconds": seconds });
        }
        const rules = record(data.bannedWords) ? data.bannedWords : {};
        if (!word) return $t("banned-words.text_e011d75927");
        const imageKey = digest && findImageRule(rules, digest)?.[0];
        if (query) {
          const target = digest ? imageKey : word;
          if (!target || !Object.hasOwn(rules, target)) return $t("banned-words.text_a1fe3c669f");
          delete rules[target];
          return $t("banned-words.text_44d0e7b5ba");
        }
        if (imageKey || Object.hasOwn(rules, word)) return $t("banned-words.text_4fd516dd76");
        if (Object.keys(rules).length >= maxRules) return $t("banned-words.text_71c8715d42");
        const entry = { matchType: ruleMode, penaltyType: penaltyNames.indexOf((add?.[2] ?? "禁") as typeof penaltyNames[number]) + 1,
          addedBy: user_id, date: new Date().toISOString() };
        data.bannedWords = { ...rules, [word]: entry };
        return [$t("banned-words.text_70bd71aa4e"), ...display(word, entry)];
      });
    } catch (error) {
      return error instanceof GroupRulesWritePermissionError ? permission : $t("banned-words.text_dcf607b3ef");
    }
  }

  return { policy, command, titleStore: { read: async (groupId: number) => (await read(groupId)).data, update } };
}
