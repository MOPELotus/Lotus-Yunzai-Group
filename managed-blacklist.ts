import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isSeq, parseDocument } from "yaml";

export interface GroupManagedBlacklist {
  blocked(userId: number): Promise<boolean>;
}

type LockFile = (file: string, subject: string) => Promise<{ close(): void }>;
export interface ManagedBlacklistStore extends GroupManagedBlacklist {
  update(ids: readonly number[], add: boolean, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
}

export class ManagedBlacklistPermissionError extends Error {}

const legacy = "plugins/yenai-plugin/config/config/groupAdmin.yaml";
const canonical = "config/groupAdmin.yaml";
const maxBytes = 256 * 1024;
const field = "blackQQ";

function codeOf(error: unknown) { return (error as NodeJS.ErrnoException | undefined)?.code; }

function id(value: unknown): number {
  const qq = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof qq !== "number" || !Number.isSafeInteger(qq) || qq < 1) throw new TypeError("群管黑名单包含无效 QQ 号。");
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
  const list: unknown = values.get(field);
  if (list != null && !Array.isArray(list)) throw new Error("blackQQ 须为 QQ 号列表。");
  const ids = (list ?? []).map(id);
  values.delete(field);
  return { text, doc, ids, others: values };
}

export function createManagedBlacklist(root: URL, lockFile: LockFile): ManagedBlacklistStore {
  const primary = fileURLToPath(new URL(canonical, root));
  const previous = fileURLToPath(new URL(legacy, root));
  async function read() {
    const candidate = await snapshot(primary);
    if (candidate && decode(candidate.bytes).doc.has(field)) return candidate;
    return await snapshot(previous) ?? candidate;
  }
  let cached: { bytes: Buffer; ids: ReadonlySet<number> } | undefined;
  return {
    async blocked(userId) {
      const current = await read();
      if (!current) return false;
      if (!cached?.bytes.equals(current.bytes)) cached = { bytes: current.bytes, ids: new Set(decode(current.bytes).ids) };
      return cached.ids.has(id(userId));
    },
    async update(users, add, signal, authorize) {
      const selected = new Set(users.map(id));
      if (!selected.size) return false;
      signal?.throwIfAborted();
      await mkdir(dirname(primary), { recursive: true, mode: 0o700 });
      const lock = await lockFile(join(dirname(primary), ".lotus-group-admin.sqlite"), "群管名单");
      try {
        signal?.throwIfAborted();
        const before = await read();
        const current = decode(before?.bytes);
        const next = add ? [...current.ids, ...[...selected].filter((qq) => !current.ids.includes(qq))]
          : current.ids.filter((qq) => !selected.has(qq));
        if (isDeepStrictEqual(current.ids, next)) return false;
        const seq = current.doc.get(field, true);
        if (isSeq(seq)) {
          if (add) for (const qq of next.slice(current.ids.length)) seq.add(qq);
          else seq.items = seq.items.filter((_item, index) => !selected.has(current.ids[index]!));
        } else if (!seq || !current.ids.length) {
          current.doc.set(field, next);
        } else {
          throw new Error("blackQQ 引用了其他字段，请先改为独立列表。");
        }
        let yaml = current.doc.toString();
        if (current.text.includes("\r\n")) yaml = yaml.replaceAll("\n", "\r\n");
        if (current.text.startsWith("\uFEFF")) yaml = "\uFEFF" + yaml;
        const bytes = Buffer.from(yaml);
        if (bytes.length > maxBytes) throw new Error("群管名单超过文件大小上限。");
        const check = decode(bytes);
        if (!isDeepStrictEqual(check.others, current.others) || !isDeepStrictEqual(check.ids, next)) {
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
          const latest = await read();
          if (before ? !latest || latest.file !== file || latest.stat.ino !== before.stat.ino ||
              latest.stat.dev !== before.stat.dev || !latest.bytes.equals(before.bytes) : latest !== undefined) {
            throw new Error("群管名单配置已变更，请重试。");
          }
          signal?.throwIfAborted();
          if (before) await rename(staged, file);
          else await link(staged, file);
          cached = { bytes, ids: new Set(next) };
          return true;
        } finally {
          await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        }
      } finally {
        lock.close();
      }
    },
  };
}
