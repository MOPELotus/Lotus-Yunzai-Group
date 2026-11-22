import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isScalar, parseDocument, Parser, type YAMLMap } from "yaml";

export type NoticeSettingsField = "privateMessage" | "grouptemporaryMessage" | "groupRecall" | "PrivateRecall" |
  "friendRequest" | "friendNumberChange" | "groupMemberNumberChange" | "groupAdminChange" | "botBeenBanned" | "groupNumberChange" | "addGroupApplication" | "groupInviteRequest" | "groupMessage" | "notificationsAll" | "msgSaveDeltime";
export type NoticeSettingsScope = "default" | "group" | "bot" | "bot-group";
type Value = boolean | number;
type Update = readonly [field: NoticeSettingsField, value: Value | undefined];
type Authorize = () => boolean | Promise<boolean>;
type LockFile = (file: string, subject: string) => Promise<{ close(): void }>;

const maxBytes = 1_048_576;
const canonical = "config/group-notice.yaml";
const legacy = "plugins/yenai-plugin/config/config/notice.yaml";
const unsafe = () => new Error("无法安全定位通知设置的 YAML 字段。");

interface Edit { start: number; end: number; value: string }
interface ConfigBytes { readonly source: string; readonly file: string; readonly bytes: Buffer }
interface VersionedDefaults {
  readonly values: ReadonlyMap<unknown, unknown>;
  readonly revision: string;
  readonly writable: boolean;
}

async function snapshot(path: string) {
  try { await lstat(path); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
  const file = await realpath(path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw unsafe();
    const block = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < block.length) {
      const { bytesRead } = await handle.read(block, size, block.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw unsafe();
    return { source: path, file, bytes: block.subarray(0, size), stat };
  } finally { await handle.close(); }
}

function decode(bytes?: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const doc = parseDocument(text, { merge: true, strict: true, uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length || (!isMap(doc.contents) && doc.contents && !(isScalar(doc.contents) && doc.contents.value === null &&
      doc.contents.range?.[0] === doc.contents.range?.[1]))) throw unsafe();
  const values: unknown = doc.toJS({ mapAsMap: true, maxAliasCount: 50 });
  if (values !== null && !(values instanceof Map)) throw unsafe();
  return { text, doc, root: isMap(doc.contents) ? doc.contents : undefined, values: (values ?? new Map()) as Map<unknown, unknown> };
}

function eol(text: string) { return /\r?\n/u.exec(text)?.[0] ?? "\n"; }

function insert(text: string, map: YAMLMap | undefined, entries: readonly string[]): Edit {
  const token = map?.srcToken;
  if (token?.type === "flow-collection") {
    const offset = token.start.offset + token.start.source.length;
    return { start: offset, end: offset, value: entries.join(", ") + (map?.items.length ? ", " : "") };
  }
  if (map && (!map.range || token?.type !== "block-map")) throw unsafe();
  const offset = map?.range?.[1] ?? [...new Parser().parse(text)].find(part => part.type === "doc-end")?.offset ?? text.length;
  const newline = eol(text);
  const before = text.slice(0, offset).replace(/^\uFEFF/u, "");
  const prefix = before && !before.endsWith("\n") ? newline : "";
  const indent = " ".repeat(token?.type === "block-map" ? token.indent : 0);
  return { start: offset, end: offset, value: prefix + entries.map(entry => indent + entry + newline).join("") };
}

function erase(text: string, map: YAMLMap, index: number): Edit[] {
  const token = map.srcToken;
  const field = map.items[index];
  const key = field?.key, value = field?.value;
  if (!field || !isScalar(key) || !key.range || (!isScalar(value) && !isAlias(value)) || !value.range) throw unsafe();
  const start = key.range[0], end = value.range[1];
  if (token?.type === "flow-collection") {
    const comma = (index === 0 ? token.items[index + 1] : token.items[index])?.start.find(part => part.type === "comma");
    if (!comma && map.items.length > 1) throw unsafe();
    return [{ start, end, value: "" }, ...(comma ? [{ start: comma.offset, end: comma.offset + 1, value: "" }] : [])];
  }
  if (token?.type !== "block-map") throw unsafe();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextLine = text.indexOf("\n", start);
  const lineEnd = nextLine === -1 ? text.length : nextLine + 1;
  const indent = text.slice(lineStart, start);
  const suffix = text.slice(end, lineEnd);
  if (end > lineEnd || !/^ *$/u.test(indent) || !/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/u.test(suffix)) throw unsafe();
  const replacement = map.items.length === 1 ? indent + "{}" + suffix :
    suffix.includes("#") ? indent + suffix.trimStart() : "";
  return [{ start: lineStart, end: lineEnd, value: replacement }];
}

function applyPatch(current: ReturnType<typeof decode>, sectionKey: string, updates: readonly Update[]) {
  const { text, root, values } = current;
  const keys = [...values.keys()].filter(key => (typeof key === "string" || typeof key === "number") && String(key) === sectionKey);
  if (keys.length > 1) throw unsafe();
  const key = keys[0] ?? (/^\d+$/u.test(sectionKey) ? Number(sectionKey) : sectionKey);
  const scope = root?.items.find(pair => isScalar(pair.key) && pair.key.value === key);
  const map = scope?.value;
  if (map != null && !isMap(map) && !(isScalar(map) && map.value === null)) throw unsafe();
  const currentValue = values.get(key);
  if (currentValue != null && !(currentValue instanceof Map)) throw unsafe();
  const edits: Edit[] = [];
  const additions: string[] = [];

  for (const [field, value] of updates) {
    const existing = isMap(map) ? map.items.findIndex(pair => isScalar(pair.key) && pair.key.value === field) : -1;
    if (existing < 0) {
      if (value !== undefined) additions.push(`${field}: ${value}`);
      continue;
    }
    if (!isMap(map)) throw unsafe();
    if (value === undefined) {
      edits.push(...erase(text, map, existing));
      continue;
    }
    if (currentValue?.get(field) === value) continue;
    const node = map.items[existing]?.value;
    if ((!isScalar(node) && !isAlias(node)) || !node.range || node.srcToken?.type === "block-scalar") throw unsafe();
    const [start, end] = node.range;
    const gap = start === end && text[start - 1] === ":" ? " " : "";
    const after = start === end && text[start] === "#" ? " " : "";
    edits.push({ start, end, value: `${gap}${value}${after}` });
  }

  if (additions.length) {
    if (!scope) {
      const entryKey = typeof key === "number" ? String(key) : JSON.stringify(key);
      edits.push(insert(text, root, [`${entryKey}: {${additions.join(", ")}}`]));
    } else if (isMap(map)) {
      // An empty last value can end at the same offset as a new block entry.
      edits.unshift(insert(text, map, additions));
    } else {
      if (!isScalar(map) || !map.range) throw unsafe();
      const [start, end] = map.range;
      const gap = start === end && text[start - 1] === ":" ? " " : "";
      const after = start === end && text[start] === "#" ? " " : "";
      edits.push({ start, end, value: `${gap}{${additions.join(", ")}}${after}` });
    }
  }
  if (!edits.length) return;
  const updated = edits.sort((left, right) => right.start - left.start).reduce((source, edit) =>
    source.slice(0, edit.start) + edit.value + source.slice(edit.end), text);
  const output = Buffer.from(updated);
  if (output.length > maxBytes) throw unsafe();
  const next = decode(output);
  const nextValue = next.values.get(key);
  if (!(nextValue instanceof Map) || updates.some(([field, value]) => value !== undefined && nextValue.get(field) !== value)) {
    throw unsafe();
  }

  function otherFields(all: Map<unknown, unknown>, selected: Map<unknown, unknown> | undefined) {
    const root = new Map(all);
    const sibling = new Map(selected);
    for (const [field] of updates) sibling.delete(field);
    if (sibling.size) root.set(key, sibling);
    else root.delete(key);
    return root;
  }
  if (!isDeepStrictEqual(otherFields(values, currentValue ?? undefined), otherFields(next.values, nextValue))) throw unsafe();
  return output;
}

export function createNoticeSettingsStore(root: URL, lockFile: LockFile, moduleSignal?: AbortSignal) {
  const primary = fileURLToPath(new URL(canonical, root));
  const previous = fileURLToPath(new URL(legacy, root));
  const read = async () => await snapshot(primary) ?? await snapshot(previous);

  function revision(location: ConfigBytes | undefined, missing = "missing"): string {
    const hash = createHash("sha256");
    if (location) hash.update("present\0").update(location.source).update("\0").update(location.file).update("\0").update(location.bytes);
    else hash.update(missing).update("\0").update(primary);
    return hash.digest("hex");
  }

  function versionedDefaults(location: ConfigBytes | undefined, fields: readonly NoticeSettingsField[]): VersionedDefaults {
    const current = revision(location);
    const values = new Map<unknown, unknown>();
    try {
      const { root, values: config } = decode(location?.bytes);
      const scope = root?.items.find(pair => isScalar(pair.key) && pair.key.value === "default")?.value;
      const defaults = config.get("default");
      if (defaults instanceof Map) {
        for (const field of fields) if (defaults.has(field)) values.set(field, defaults.get(field));
      }
      const supported = [...values].every(([field, value]) => value === null ||
        (field === "msgSaveDeltime" ? typeof value === "number" || typeof value === "string" : typeof value === "boolean"));
      const writable = supported && (defaults == null || defaults instanceof Map) &&
        (scope == null || isMap(scope) || (isScalar(scope) && scope.value === null));
      return { values, revision: current, writable };
    } catch {
      return { values, revision: current, writable: false };
    }
  }

  async function write(section: string, updates: readonly Update[], authorize: Authorize,
    expected?: { readonly revision: string; readonly fields: readonly NoticeSettingsField[] },
  ): Promise<{ readonly changed: boolean; readonly location?: ConfigBytes }> {
    function active() { moduleSignal?.throwIfAborted(); }
    async function assertPermission() {
      active();
      if (!await authorize()) throw new NoticeSettingsPermissionError();
      active();
    }
    await assertPermission();
    await mkdir(dirname(primary), { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(dirname(primary), ".lotus-group-notice.sqlite"), "通知设置");
    try {
      active();
      const before = await read();
      if (expected && revision(before) !== expected.revision) throw new NoticeSettingsConflictError();
      if (expected && !versionedDefaults(before, expected.fields).writable) throw unsafe();
      const output = applyPatch(decode(before?.bytes), section, updates);
      if (!output) {
        await assertPermission();
        return { changed: false, location: before };
      }
      const file = before?.file ?? join(await realpath(dirname(primary)), basename(primary));
      const stage = await mkdtemp(join(dirname(file), ".lotus-group-notice-"));
      try {
        const staged = join(stage, basename(file));
        const handle = await open(staged, "wx", 0o600);
        try {
          await handle.writeFile(output);
          if (before) {
            const stat = await handle.stat();
            if (stat.uid !== before.stat.uid || stat.gid !== before.stat.gid) await handle.chown(before.stat.uid, before.stat.gid);
            await handle.chmod(before.stat.mode & 0o777);
          }
          await handle.sync();
        } finally { await handle.close(); }
        await assertPermission();
        const latest = await read();
        if (before ? !latest || latest.source !== before.source || latest.file !== file || latest.stat.ino !== before.stat.ino ||
            latest.stat.dev !== before.stat.dev || !latest.bytes.equals(before.bytes) : latest !== undefined) {
          if (expected) throw new NoticeSettingsConflictError();
          throw unsafe();
        }
        // Authorization may change while the asynchronous snapshot is being read.
        await assertPermission();
        if (before) await rename(staged, file);
        else {
          try { await link(staged, file); }
          catch (error) {
            if (expected && (error as NodeJS.ErrnoException).code === "EEXIST") throw new NoticeSettingsConflictError();
            throw error;
          }
        }
        return { changed: true, location: { source: before?.source ?? primary, file, bytes: output } };
      } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
    } finally { lock.close(); }
  }

  return {
    async read(): Promise<Record<string, unknown>> {
      const location = await read();
      const { root: map, doc } = decode(location?.bytes);
      if (!map) return {};
      return doc.toJS({ maxAliasCount: 50 }) as Record<string, unknown>;
    },

    async write(section: string, field: NoticeSettingsField, value: Value | undefined, authorize: Authorize): Promise<boolean> {
      return (await write(section, [[field, value]], authorize)).changed;
    },

    async writeDefaults(fields: readonly NoticeSettingsField[], value: boolean, authorize: Authorize): Promise<boolean> {
      return (await write("default", fields.map(field => [field, value]), authorize)).changed;
    },

    async readVersionedDefaults(fields: readonly NoticeSettingsField[]): Promise<VersionedDefaults> {
      try { return versionedDefaults(await read(), fields); }
      catch { return { values: new Map(), revision: revision(undefined, "unreadable"), writable: false }; }
    },

    async writeVersionedDefaults(revision: string, fields: readonly NoticeSettingsField[],
      updates: readonly (readonly [field: NoticeSettingsField, value: Value])[],
      authorize: Authorize,
    ): Promise<VersionedDefaults> {
      const { location } = await write("default", updates, authorize, { revision, fields });
      return versionedDefaults(location, fields);
    },
  };
}

export class NoticeSettingsPermissionError extends Error {}
export class NoticeSettingsConflictError extends Error {}
