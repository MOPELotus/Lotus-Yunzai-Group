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
}

export class ManagedBlacklistPermissionError extends Error {}

const legacy = "plugins/yenai-plugin/config/config/groupAdmin.yaml";
const canonical = "config/groupAdmin.yaml";
const maxBytes = 256 * 1024;
type ListField = "blackQQ" | "whiteQQ";
type Field = ListField | "noBan";

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

function listOf(values: Map<unknown, unknown>, field: ListField): number[] {
  const list = values.get(field);
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${field} 须为 QQ 号列表。`);
  return list.map(id);
}

function patchField({ text, doc, values }: ReturnType<typeof decode>, field: Field, next: boolean | readonly number[]): string {
  const contents = doc.contents;
  const node = doc.get(field, true);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const inline = typeof next === "boolean" ? String(next) : `[${next.join(", ")}]`;
  const splice = (start: number, end: number, value: string) => text.slice(0, start) + value + text.slice(end);
  const unsafe = () => new Error(`无法安全定位 ${field} 的 YAML 源码范围。`);
  const lineStart = (index: number) => text.lastIndexOf("\n", index - 1) + 1;
  if (isNode(node) && node.range) {
    const [start, end, trailing] = node.range;
    if (isSeq(node) && typeof next !== "boolean" && field !== "noBan") {
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
      const edits: { start: number; end: number }[] = [];
      for (const [index, item] of node.items.entries()) {
        if (next.includes(ids[index]!)) continue;
        if (!isNode(item) || !item.range) throw unsafe();
        const start = lineStart(item.range[0]);
        const newline = text.indexOf("\n", start);
        const end = newline >= 0 ? newline + 1 : text.length;
        if (item.range[1] > end || !/^ *-(?:[ \t]|$)/u.test(text.slice(start, item.range[0]))) throw unsafe();
        edits.push({ start, end });
      }
      let output = text;
      for (const edit of edits.reverse()) {
        const allRemoved = !next.length && edit === edits.at(-1);
        const pair = isMap(contents) ? contents.items.find(({ key }) => isScalar(key) && key.value === field) : undefined;
        const keyStart = isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
        if (allRemoved && keyStart === undefined) throw unsafe();
        const emptyIndent = allRemoved ? Math.max(indent.length, keyStart! - lineStart(keyStart!) + 2) : 0;
        const replacement = allRemoved ? " ".repeat(emptyIndent) + "[]" + (text[edit.end - 1] === "\n" ? eol : "") : "";
        output = output.slice(0, edit.start) + replacement + output.slice(edit.end);
      }
      return output;
    }
    if (field !== "noBan" && listOf(values, field).length) throw unsafe();
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
    return splice(start + 1, start + 1, `${field}: ${inline}${contents.items.length ? ", " : ""}`);
  }
  if (isScalar(contents) && contents.value === null && contents.range && contents.range[0] !== contents.range[1]) {
    return splice(contents.range[0], contents.range[1], `{${field}: ${inline}}`);
  }
  const point = isMap(contents) ? contents.range?.[1] : doc.range?.[1];
  if (point === undefined || contents && !isMap(contents) && !isScalar(contents)) throw unsafe();
  const beforeField = text.slice(0, point).replace(/^\uFEFF/u, "");
  const key = isMap(contents) ? contents.items[0]?.key : undefined;
  const keyStart = isScalar(key) ? key.range?.[0] : undefined;
  const indent = keyStart === undefined ? "" : text.slice(lineStart(keyStart), keyStart).replace(/^\uFEFF/u, "");
  if (!/^ *$/u.test(indent)) throw unsafe();
  return splice(point, point, (beforeField && !beforeField.endsWith("\n") ? eol : "") + `${indent}${field}: ${inline}${eol}`);
}

function paths(root: URL) {
  const primary = fileURLToPath(new URL(canonical, root));
  const previous = fileURLToPath(new URL(legacy, root));
  return { primary, async read(field: Field) {
    const candidate = await snapshot(primary);
    if (candidate && decode(candidate.bytes).doc.has(field)) return candidate;
    return await snapshot(previous) ?? candidate;
  } };
}

export async function readManagedWhitelist(root: URL): Promise<ReadonlySet<number>> {
  const current = await paths(root).read("whiteQQ");
  return new Set(listOf(decode(current?.bytes).values, "whiteQQ"));
}

export function createManagedBlacklist(root: URL, lockFile: LockFile): ManagedBlacklistStore {
  const { primary, read } = paths(root);
  let cached: { bytes: Buffer; ids: ReadonlySet<number> } | undefined;

  async function write(field: Field, change: (current: ReturnType<typeof decode>) => boolean | readonly number[] | undefined,
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
      const value = field === "noBan" ? check.values.get(field) : listOf(check.values, field);
      check.values.delete(field);
      current.values.delete(field);
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
