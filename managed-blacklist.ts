import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";

export interface GroupManagedBlacklist {
  blocked(userId: number): Promise<boolean>;
  shouldAutoUnmute(userId: number): Promise<boolean>;
}

type LockFile = (file: string, subject: string) => Promise<{ close(): void }>;
export interface ManagedBlacklistStore extends GroupManagedBlacklist {
  update(ids: readonly number[], add: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
  updateWhitelist(ids: readonly number[], add: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
  setAutoUnmute(enabled: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
  readGroupAddNotice(groupId: number): Promise<string | undefined>;
  setGroupAddNotice(groupId: number, enabled: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
  readGroupVoteSettings(): Promise<GroupVoteSettings>;
  setGroupVoteSetting(field: GroupVoteEditableSetting, value: boolean | number, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
  readGroupVerificationSettings(groupId: number): Promise<GroupVerificationSettings>;
  setGroupVerification(groupId: number, enabled: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
  toggleGroupVerificationMode(signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<GroupVerificationSettings["mode"]>;
  setGroupVerificationTime(seconds: number, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
}

export interface GroupVoteSettings {
  readonly VoteBan: boolean;
  readonly VoteKick: boolean;
  readonly outTime: number;
  readonly minNum: number;
  readonly BanTime: number;
  readonly veto: boolean;
  readonly voteAdmin: boolean;
}

export type GroupVoteEditableSetting = Exclude<keyof GroupVoteSettings, "veto" | "voteAdmin">;

export interface GroupVerificationSettings {
  readonly enabled: boolean;
  readonly mode: "精确" | "模糊";
  readonly times: number;
  readonly time: number;
  readonly delay: number;
  readonly min: number;
  readonly max: number;
  readonly remind: boolean;
  readonly success: string;
}

export class ManagedBlacklistPermissionError extends Error {}

const legacy = "plugins/yenai-plugin/config/config/groupAdmin.yaml";
const canonical = "config/groupAdmin.yaml";
const maxBytes = 256 * 1024;
const groupAddNoticeDefault = "有一个加群通知，管理员快去看看吧~";
const groupAddNoticeSection = "groupAddNotice";
const noticeGroups = "groupAddNotice.openGroup";
const noticeMessage = "groupAddNotice.msg";
const verifySection = "groupVerify";
const verifyGroups = "groupVerify.openGroup";
const verifyMode = "groupVerify.mode";
const verifyTime = "groupVerify.time";
export const maxGroupVerificationSeconds = 2_147_483;
type ListField = "blackQQ" | "whiteQQ" | typeof noticeGroups | typeof verifyGroups;
type Field = ListField | "noBan" | GroupVoteEditableSetting | typeof verifyMode | typeof verifyTime;
type ReadField = Field | typeof noticeMessage;
type FieldValue = boolean | number | readonly number[] | GroupVerificationSettings["mode"];

const defaultGroupVote: GroupVoteSettings = { VoteBan: false, VoteKick: false, outTime: 180, minNum: 4, BanTime: 3600, veto: true, voteAdmin: false };
export const groupVoteNumericLimits = { outTime: 2_147_483, minNum: 10_000, BanTime: 2_147_483_647 } as const;

export function groupVoteSetting(field: keyof GroupVoteSettings, value: unknown): boolean | number | undefined {
  if (!(field in groupVoteNumericLimits)) return typeof value === "boolean" ? value : undefined;
  const numeric = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  const maximum = groupVoteNumericLimits[field as keyof typeof groupVoteNumericLimits];
  if (typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 && numeric <= maximum) return numeric;
}

function voteSettings(primary?: ReturnType<typeof decode>, previous?: ReturnType<typeof decode>): GroupVoteSettings {
  function get<K extends keyof GroupVoteSettings>(field: K): GroupVoteSettings[K] {
    const source = primary?.doc.has(field) ? primary : previous?.doc.has(field) ? previous : undefined;
    const value = source ? groupVoteSetting(field, source.values.get(field)) : field === "VoteBan" && previous ? true : defaultGroupVote[field];
    if (value === undefined) throw new Error(`群投票 ${field} 配置无效。`);
    return value as GroupVoteSettings[K];
  }
  return { VoteBan: get("VoteBan"), VoteKick: get("VoteKick"), outTime: get("outTime"), minNum: get("minNum"),
    BanTime: get("BanTime"), veto: get("veto"), voteAdmin: get("voteAdmin") };
}

function codeOf(error: unknown) { return (error as NodeJS.ErrnoException | undefined)?.code; }

function id(value: unknown): number {
  const qq = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof qq !== "number" || !Number.isSafeInteger(qq) || qq < 1) throw new TypeError("群管名单包含无效 QQ 号。");
  return qq;
}

async function snapshot(path: string) {
  const pathExists = await lstat(path).catch((error: unknown) => { if (codeOf(error) !== "ENOENT") throw error; });
  if (!pathExists) return;
  const file = await realpath(path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("群管名单配置文件无效。");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error("群管名单配置正由其他程序修改。");
    return { file, bytes: bytes.subarray(0, size), stat };
  } finally {
    await handle.close();
  }
}

function decode(bytes?: Buffer) {
  const text = bytes ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : "";
  const doc = parseDocument(text, { merge: true, strict: true, uniqueKeys: true });
  if (doc.errors.length) throw new Error("群管名单 YAML 无效。");
  const values = doc.toJS({ mapAsMap: true }) ?? new Map();
  if (!(values instanceof Map)) throw new Error("群管名单配置须为映射。");
  return { text, doc, values };
}

function fieldPath(field: ReadField): readonly string[] { return field.split("."); }

function yamlSection(values: Map<unknown, unknown>, key: string): Map<unknown, unknown> | undefined {
  const section: unknown = values.get(key);
  if (section == null) return;
  if (!(section instanceof Map)) throw new Error(`${key} 须为映射。`);
  return section;
}

function nestedGroupField(field: ReadField) {
  if (field === noticeGroups) return [groupAddNoticeSection, "openGroup"] as const;
  if (field === verifyGroups) return [verifySection, "openGroup"] as const;
  if (field === verifyMode) return [verifySection, "mode"] as const;
  if (field === verifyTime) return [verifySection, "time"] as const;
}

function listOf(values: Map<unknown, unknown>, field: ListField): number[] {
  const key = nestedGroupField(field);
  const list = key ? yamlSection(values, key[0])?.get(key[1]) : values.get(field);
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${field} 须为 QQ 号列表。`);
  return list.map(id);
}

function isListField(field: Field): field is ListField { return field === "whiteQQ" || field === "blackQQ" || field === noticeGroups || field === verifyGroups; }

function verificationSettings(group: number, primary?: ReturnType<typeof decode>, previous?: ReturnType<typeof decode>, readDisabled = false): GroupVerificationSettings {
  const current = primary && yamlSection(primary.values, verifySection);
  const legacy = previous && yamlSection(previous.values, verifySection);
  const configured = (field: string) => current?.has(field) ? current.get(field) : legacy?.get(field);
  const groups = primary?.doc.hasIn(fieldPath(verifyGroups)) ? primary : previous;
  const enabled = !!groups && listOf(groups.values, verifyGroups).includes(group);
  const defaults: GroupVerificationSettings = { enabled, mode: "精确", times: 7, time: 300, delay: 2, min: 10, max: 100,
    remind: true, success: "✅ 验证成功，欢迎入群" };
  if (!enabled && !readDisabled) return defaults;

  const number = (value: unknown, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    const normalized = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
    if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
      throw new Error("入群验证时间或运算范围无效。");
    }
    return normalized;
  };
  const mode = configured("mode") ?? defaults.mode;
  const remind = configured("remindAtLastMinute") ?? defaults.remind;
  if ((mode !== "精确" && mode !== "模糊") || typeof remind !== "boolean") throw new Error("入群验证模式无效。");
  const currentRange = current && yamlSection(current, "range");
  const oldRange = legacy && yamlSection(legacy, "range");
  const min = number(currentRange?.get("min") ?? oldRange?.get("min"), defaults.min, -1_000_000, 1_000_000);
  const max = number(currentRange?.get("max") ?? oldRange?.get("max"), defaults.max, -1_000_000, 1_000_000);
  if (min >= max) throw new Error("入群验证需要两个不同的可用整数。");
  const currentMessages = current && yamlSection(current, "SuccessMsgs");
  const oldMessages = legacy && yamlSection(legacy, "SuccessMsgs");
  const messageFor = (id: number) => currentMessages?.get(id) ?? currentMessages?.get(String(id)) ?? oldMessages?.get(id) ?? oldMessages?.get(String(id));
  const success = messageFor(group) || messageFor(0) || defaults.success;
  if (typeof success !== "string" || success.length > 2048) throw new Error("入群验证成功消息无效。");
  return { enabled, mode, remind, min, max, success, times: number(configured("times"), defaults.times, 1, 100),
    time: number(configured("time"), defaults.time, 1, maxGroupVerificationSeconds), delay: number(configured("DelayTime"), defaults.delay, 0, maxGroupVerificationSeconds) };
}

export async function readGroupManagementPanelValues(root: URL) {
  const { primary, previous } = paths(root);
  const [modernFile, oldFile] = await Promise.all([snapshot(primary), snapshot(previous)]);
  const modern = modernFile && decode(modernFile.bytes), old = oldFile && decode(oldFile.bytes);
  const pick = (field: ReadField) => modern?.doc.hasIn(fieldPath(field)) ? modern : old;
  const groups = (field: ListField) => [...new Set(listOf(pick(field)?.values ?? new Map(), field))];
  const notice = yamlSection(pick(noticeMessage)?.values ?? new Map(), groupAddNoticeSection)?.get("msg") ?? groupAddNoticeDefault;
  if (typeof notice !== "string" || notice.length > 2048) throw new Error("加群通知文案无效。");
  const verification = verificationSettings(0, modern, old, true);
  const messageMap = (document?: ReturnType<typeof decode>) => yamlSection(yamlSection(document?.values ?? new Map(), verifySection) ?? new Map(), "SuccessMsgs");
  const messages = new Map<string, string>();
  for (const document of [old, modern]) {
    const entries = messageMap(document);
    if (!entries) continue;
    const keys = new Set([...entries.keys()].map(String));
    for (const key of keys) {
      if (!/^(?:0|[1-9]\d*)$/u.test(key) || !Number.isSafeInteger(Number(key))) continue;
      const message = entries.get(Number(key)) ?? entries.get(key);
      if (message == null) continue;
      if (typeof message !== "string" || message.length > 2048) throw new Error("入群验证成功消息无效。");
      messages.set(key, message);
    }
  }
  return {
    whiteQQ: groups("whiteQQ"), blackQQ: groups("blackQQ"),
    noBan: pick("noBan")?.values.get("noBan") === true,
    ...voteSettings(modern, old),
    noticeGroups: groups(noticeGroups), noticeMessage: notice,
    verifyGroups: groups(verifyGroups), verifyMode: verification.mode,
    verifyAttempts: verification.times, verifySeconds: verification.time, verifyDelay: verification.delay,
    verifyMin: verification.min, verifyMax: verification.max, verifyReminder: verification.remind,
    verifyMessages: Object.fromEntries([...messages].filter(([, message]) => message !== "")),
  };
}

function patchField({ text, doc, values }: ReturnType<typeof decode>, field: Field, next: FieldValue): string {
  const nested = nestedGroupField(field);
  const parent = nested ? doc.get(nested[0], true) : undefined;
  const insertParent = nested !== undefined && !isMap(parent);
  if (insertParent && parent !== undefined && parent !== null && !(isScalar(parent) && parent.value === null)) {
    throw new Error(`无法安全定位 ${field} 的 YAML 源码范围。`);
  }
  const contents = nested && !insertParent ? parent : doc.contents;
  const keyName = nested ? (insertParent ? nested[0] : nested[1]) : field;
  const node = insertParent ? parent : doc.getIn(fieldPath(field), true);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const encoded = typeof next === "object" ? `[${next.join(", ")}]` : String(next);
  const inline = insertParent ? `{${nested[1]}: ${encoded}}` : encoded;
  const splice = (start: number, end: number, value: string) => text.slice(0, start) + value + text.slice(end);
  const unsafe = () => new Error(`无法安全定位 ${field} 的 YAML 源码范围。`);
  const lineStart = (index: number) => text.lastIndexOf("\n", index - 1) + 1;
  if (isNode(node) && node.range) {
    const [start, end, trailing] = node.range;
    if (isSeq(node) && typeof next === "object" && isListField(field)) {
      const ids = listOf(values, field);
      const adding = next.length > ids.length;
      if (node.flow) {
        if (text[start] !== "[" || text[end - 1] !== "]") throw unsafe();
        if (adding) {
          const last = node.items.at(-1);
          const point = isNode(last) && last.range ? last.range[1] : start + 1;
          return splice(point, point, `${last ? ", " : ""}${next.slice(ids.length).join(", ")}`);
        }
        // In a flow sequence commas and comments can belong to adjacent items.
        if (/[#&!]/u.test(text.slice(start, end))) throw unsafe();
        const remaining = node.items.flatMap((item, index) => {
          if (!next.includes(ids[index]!)) return [];
          if (!isNode(item) || !item.range) throw unsafe();
          return [text.slice(item.range[0], item.range[1])];
        });
        return splice(start, end, `[${remaining.join(", ")}]`);
      }
      const indent = text.slice(lineStart(start), start);
      if (!/^ *$/u.test(indent) || text[start] !== "-") throw unsafe();
      if (adding) {
        const newline = text[trailing - 1] === "\n";
        const items = next.slice(ids.length).map((id) => `${indent}- ${id}`).join(eol);
        return splice(trailing, trailing, newline ? items + eol : eol + items);
      }
      const edits: { start: number; end: number; retainedComment: string }[] = [];
      for (const [index, item] of node.items.entries()) {
        if (next.includes(ids[index]!)) continue;
        if (!isNode(item) || !item.range) throw unsafe();
        const start = lineStart(item.range[0]);
        const newline = text.indexOf("\n", start);
        const end = newline >= 0 ? newline + 1 : text.length;
        if (item.range[1] > end || !/^ *-(?:[ \t]|$)/u.test(text.slice(start, item.range[0]))) throw unsafe();
        const follow = text.slice(item.range[1], end);
        const comment = nested ? /^[ \t]*(#.*)(?:\r?\n)?$/u.exec(follow)?.[1] : undefined;
        const retainedComment = comment ? indent + comment + (text[end - 1] === "\n" ? eol : "") : "";
        edits.push({ start, end, retainedComment });
      }
      let output = text;
      for (const edit of edits.reverse()) {
        const allRemoved = !next.length && edit === edits.at(-1);
        const pair = isMap(contents) ? contents.items.find(({ key }) => isScalar(key) && key.value === keyName) : undefined;
        const keyStart = isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
        if (allRemoved && keyStart === undefined) throw unsafe();
        const emptyIndent = allRemoved ? Math.max(indent.length, keyStart! - lineStart(keyStart!) + 2) : 0;
        const replacement = allRemoved ? " ".repeat(emptyIndent) + "[]" + (edit.retainedComment || text[edit.end - 1] === "\n" ? eol : "") : "";
        output = output.slice(0, edit.start) + replacement + edit.retainedComment + output.slice(edit.end);
      }
      return output;
    }
    if (isListField(field) && listOf(values, field).length) throw unsafe();
    if (start !== end) return splice(start, end, inline);
    const before = text[start - 1];
    const after = text[start];
    // An implicit null has a zero-width range, immediately before its comment or after the colon.
    const prefix = before === ":" ? " " : "";
    return splice(start, start, prefix + inline + (after === "#" ? " " : ""));
  }
  if (isMap(contents) && contents.flow && contents.range) {
    const start = contents.range[0];
    if (text[start] !== "{") throw unsafe();
    return splice(start + 1, start + 1, `${keyName}: ${inline}${contents.items.length ? ", " : ""}`);
  }
  if (isScalar(contents) && contents.value === null && contents.range && contents.range[0] !== contents.range[1]) {
    return splice(contents.range[0], contents.range[1], `{${keyName}: ${inline}}`);
  }
  const point = isMap(contents) ? contents.range?.[1] : doc.range?.[1];
  if (point === undefined || contents && !isMap(contents) && !isScalar(contents)) throw unsafe();
  const beforeField = text.slice(0, point).replace(/^\uFEFF/u, "");
  const key = isMap(contents) ? contents.items[0]?.key : undefined;
  const keyStart = isScalar(key) ? key.range?.[0] : undefined;
  const indent = keyStart === undefined ? "" : text.slice(lineStart(keyStart), keyStart).replace(/^\uFEFF/u, "");
  if (!/^ *$/u.test(indent)) throw unsafe();
  return splice(point, point, (beforeField && !beforeField.endsWith("\n") ? eol : "") + `${indent}${keyName}: ${inline}${eol}`);
}

function paths(root: URL) {
  const primary = fileURLToPath(new URL(canonical, root));
  const previous = fileURLToPath(new URL(legacy, root));
  return { primary, previous, async read(field: ReadField) {
    const candidate = await snapshot(primary);
    if (candidate && decode(candidate.bytes).doc.hasIn(fieldPath(field))) return candidate;
    const backup = await snapshot(previous);
    if (nestedGroupField(field) || field === noticeMessage) {
      if (backup && decode(backup.bytes).doc.hasIn(fieldPath(field))) return backup;
      return candidate ?? backup;
    }
    return backup ?? candidate;
  } };
}

export async function readManagedWhitelist(root: URL): Promise<ReadonlySet<number>> {
  const current = await paths(root).read("whiteQQ");
  return new Set(listOf(decode(current?.bytes).values, "whiteQQ"));
}

export function createManagedBlacklist(root: URL, lockFile: LockFile): ManagedBlacklistStore {
  const { primary, previous, read } = paths(root);
  let cached: { bytes: Buffer; ids: ReadonlySet<number> } | undefined;

  async function write(field: Field, change: (current: ReturnType<typeof decode>) => FieldValue | undefined,
    signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean> {
    signal?.throwIfAborted();
    await mkdir(dirname(primary), { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(dirname(primary), ".lotus-group-admin.sqlite"), "群管名单");
    try {
      signal?.throwIfAborted();
      const before = await read(field);
      const current = decode(before?.bytes);
      const next = change(current);
      if (next === undefined) return false;
      const yaml = patchField(current, field, next);
      const bytes = Buffer.from(yaml);
      if (bytes.length > maxBytes) throw new Error("群管名单超过文件大小上限。");
      const check = decode(bytes);
      const nested = nestedGroupField(field);
      const value = isListField(field) ? listOf(check.values, field) : nested ? yamlSection(check.values, nested[0])?.get(nested[1]) : check.values.get(field);
      if (nested) {
        const [section, child] = nested;
        const previousSection = yamlSection(current.values, section);
        const newSection = yamlSection(check.values, section);
        // Copy only the edited map so references from other fields retain their actual values for comparison.
        if (previousSection) {
          const retained = new Map(previousSection);
          retained.delete(child);
          current.values.set(section, retained);
        }
        if (newSection) {
          const retained = new Map(newSection);
          retained.delete(child);
          if (previousSection || retained.size) check.values.set(section, retained);
          else if (current.values.has(section)) check.values.set(section, current.values.get(section));
          else check.values.delete(section);
        }
      } else {
        check.values.delete(field);
        current.values.delete(field);
      }
      if (!isDeepStrictEqual(check.values, current.values) || !isDeepStrictEqual(value, next)) {
        throw new Error("保存将改变其他 YAML 字段，请检查配置引用。");
      }

      const file = before?.file ?? primary;
      const stage = await mkdtemp(join(dirname(file), ".lotus-group-admin-"));
      try {
        const staged = join(stage, basename(file));
        const output = await open(staged, "wx", 0o600);
        try {
          await output.writeFile(bytes);
          if (before) {
            const stat = await output.stat();
            if (stat.uid !== before.stat.uid || stat.gid !== before.stat.gid) await output.chown(before.stat.uid, before.stat.gid);
            await output.chmod(before.stat.mode & 0o777);
          }
          await output.sync();
        } finally {
          await output.close();
        }
        if (authorize && !await authorize()) throw new ManagedBlacklistPermissionError();
        const latest = await read(field);
        if (before ? !latest || latest.file !== file || latest.stat.ino !== before.stat.ino ||
            latest.stat.dev !== before.stat.dev || !latest.bytes.equals(before.bytes) : latest !== undefined) {
          throw new Error("群管名单配置已变更，请重试。");
        }
        signal?.throwIfAborted();
        if (before) await rename(staged, file);
        else await link(staged, file);
        return true;
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      lock.close();
    }
  }

  function updateList(field: ListField, users: readonly number[], add: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>) {
    const selected = new Set(users.map(id));
    if (!selected.size) return Promise.resolve(false);
    return write(field, ({ values }) => {
      const current = listOf(values, field);
      const next = add ? [...current, ...[...selected].filter((qq) => !current.includes(qq))] : current.filter((qq) => !selected.has(qq));
      if (isDeepStrictEqual(current, next)) return;
      return next;
    }, signal, authorize);
  }

  return {
    async blocked(userId) {
      const current = await read("blackQQ");
      if (!current) return false;
      if (!cached?.bytes.equals(current.bytes)) cached = { bytes: current.bytes, ids: new Set(listOf(decode(current.bytes).values, "blackQQ")) };
      return cached.ids.has(id(userId));
    },
    async shouldAutoUnmute(userId) {
      const current = await read("noBan");
      if (!current || decode(current.bytes).values.get("noBan") !== true) return false;
      return (await readManagedWhitelist(root)).has(id(userId));
    },
    update: (users, add, signal, authorize) => updateList("blackQQ", users, add, signal, authorize),
    updateWhitelist: (users, add, signal, authorize) => updateList("whiteQQ", users, add, signal, authorize),
    async readGroupAddNotice(groupId) {
      const groups = await read(noticeGroups);
      if (!groups || !listOf(decode(groups.bytes).values, noticeGroups).includes(id(groupId))) return;
      const template = await read(noticeMessage);
      const message: unknown = yamlSection(decode(template?.bytes).values, groupAddNoticeSection)?.get("msg");
      if (message == null) return groupAddNoticeDefault;
      if (typeof message !== "string" || message.length > 2048) throw new Error("groupAddNotice.msg 无效。");
      return message;
    },
    setGroupAddNotice: (groupId, enabled, signal, authorize) => updateList(noticeGroups, [groupId], enabled, signal, authorize),
    async readGroupVerificationSettings(groupId) {
      const [community, old] = await Promise.all([snapshot(primary), snapshot(previous)]);
      return verificationSettings(id(groupId), community && decode(community.bytes), old && decode(old.bytes));
    },
    setGroupVerification: (groupId, enabled, signal, authorize) => updateList(verifyGroups, [groupId], enabled, signal, authorize),
    async toggleGroupVerificationMode(signal, authorize) {
      let next: GroupVerificationSettings["mode"] = "模糊";
      await write(verifyMode, ({ values }) => {
        const current = yamlSection(values, verifySection)?.get("mode");
        if (current != null && current !== "精确" && current !== "模糊") throw new Error("入群验证模式无效。");
        next = current === "模糊" ? "精确" : "模糊";
        return next;
      }, signal, authorize);
      return next;
    },
    setGroupVerificationTime(seconds, signal, authorize) {
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxGroupVerificationSeconds) throw new Error("入群验证超时时间无效。");
      return write(verifyTime, ({ values }) => {
        const current = yamlSection(values, verifySection)?.get("time");
        const numeric = typeof current === "string" && /^\d+$/u.test(current) ? Number(current) : current;
        if ((numeric ?? 300) === seconds) return;
        return seconds;
      }, signal, authorize);
    },
    async readGroupVoteSettings() {
      const [current, old] = await Promise.all([snapshot(primary), snapshot(previous)]);
      return voteSettings(current && decode(current.bytes), old && decode(old.bytes));
    },
    setGroupVoteSetting(field, value, signal, authorize) {
      const next = groupVoteSetting(field, value);
      if (next === undefined) throw new Error(`群投票 ${field} 配置无效。`);
      return write(field, ({ doc, values }) => {
        if (doc.has(field) && groupVoteSetting(field, values.get(field)) === next) return;
        return next;
      }, signal, authorize);
    },
    setAutoUnmute(enabled, signal, authorize) {
      return write("noBan", ({ values }) => {
        const current = values.get("noBan");
        if (current != null && typeof current !== "boolean") throw new Error("noBan 须为布尔值。");
        if ((current ?? false) === enabled) return;
        return enabled;
      }, signal, authorize);
    },
  };
}
