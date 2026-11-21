import { createHash } from "node:crypto";
import { constants, linkSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Document, parseDocument } from "yaml";

export interface LikeSettings {
  readonly enable: boolean;
  readonly cloneAllThumbUp: boolean;
  readonly strangeThumbUp: boolean;
  readonly count: number;
  readonly recall: number;
  readonly closeTips: string | false;
  readonly successMsg: string | false;
  readonly failsMsg: string | false;
  readonly noFriendMsg: string | false;
}

interface LikeSettingsLocation {
  readonly file?: string | URL;
  readonly root?: URL;
}

export class LikeSettingsError extends Error {
  constructor(readonly code: "invalid" | "conflict", message: string) {
    super(message);
    this.name = "LikeSettingsError";
  }
}

const defaults: LikeSettings = {
  enable: true,
  cloneAllThumbUp: false,
  strangeThumbUp: true,
  count: 10,
  recall: 0,
  closeTips: "",
  successMsg: "给你点了 {{thumbUpNum}} 下赞。",
  failsMsg: "点赞未成功，可能已达到平台次数上限或协议端暂不接受。",
  noFriendMsg: "当前仅向好友点赞。",
};

const defaultRoot = new URL("../../", import.meta.url);
const legacyConfig = "plugins/yenai-plugin/config/config/thumbUp.yaml";
const pendingWrites = new Map<string, Promise<void>>();

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function recallSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120;
}

function validate(key: string, value: unknown): string | number | boolean {
  switch (key) {
    case "enable":
    case "cloneAllThumbUp":
    case "strangeThumbUp":
      if (typeof value === "boolean") return value;
      throw new LikeSettingsError("invalid", `${key} 须为布尔值。`);
    case "count":
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10) return value;
      throw new LikeSettingsError("invalid", "count 须为 1–10 的整数。");
    case "recall":
      if (recallSeconds(value)) return value;
      throw new LikeSettingsError("invalid", "recall 须为 0–120 秒。");
    case "closeTips":
    case "successMsg":
    case "failsMsg":
    case "noFriendMsg":
      if (value === false || value === "false") return false;
      if (typeof value === "string") return value;
      throw new LikeSettingsError("invalid", `${key} 须为文本或 false。`);
    default:
      throw new LikeSettingsError("invalid", "包含未知的点赞配置字段。");
  }
}

function readSettings(values: Map<unknown, unknown>, legacy: boolean): LikeSettings {
  const result = { ...defaults, recall: legacy ? 20 : defaults.recall };
  for (const key of Object.keys(defaults)) {
    const value = values.get(key);
    if (value === undefined || (key === "count" && value === null)) continue;
    if (key === "recall" && !recallSeconds(value)) {
      result.recall = 0;
      continue;
    }
    Object.assign(result, { [key]: validate(key, value) });
  }
  return result;
}

async function configLocation(options?: LikeSettingsLocation) {
  const overridden = options?.file;
  const configured = Bun.env.LOTUS_GROUP_CONFIG;
  const root = options?.root ?? defaultRoot;
  const file = overridden ?? (configured || new URL("config/group.yaml", root));
  const path = typeof file === "string" ? resolve(file) : fileURLToPath(file);
  const resolved = await canonical(path);
  const fallback = overridden === undefined && !configured ? fileURLToPath(new URL(legacyConfig, root)) : undefined;
  const sharedSource = fallback !== undefined && await canonical(fallback) === resolved;
  return {
    file: resolved,
    legacy: sharedSource || basename(path) === "thumbUp.yaml",
    required: overridden === undefined && Boolean(configured),
    fallback: sharedSource ? undefined : fallback,
  };
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

async function readSnapshot(path: string, required: boolean) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "ENOENT" && !required) {
      return { text: "", revision: "missing", mode: 0o600 };
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LikeSettingsError("invalid", "点赞配置须为普通文件。");
    const contents = await handle.readFile();
    return {
      text: contents.toString("utf8"),
      revision: createHash("sha256").update(contents).digest("hex"),
      mode: stat.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

function readDocument(text: string) {
  const document = parseDocument(text, { merge: true, strict: true, uniqueKeys: true });
  if (document.errors.length) throw new LikeSettingsError("invalid", "点赞配置的 YAML 无效。");

  let values: unknown;
  try {
    values = document.toJS({ mapAsMap: true });
  } catch {
    throw new LikeSettingsError("invalid", "点赞配置的 YAML 引用无效。");
  }

  if (values == null) return { document, values: new Map<unknown, unknown>() };
  if (!(values instanceof Map)) throw new LikeSettingsError("invalid", "群功能配置须为映射。");
  return { document, values: values as Map<unknown, unknown> };
}

function unknownFields(values: Map<unknown, unknown>) {
  return new Map([...values].filter(([key]) => typeof key !== "string" || !Object.hasOwn(defaults, key)));
}

function conflict() {
  return new LikeSettingsError("conflict", "点赞配置已变更，请重新读取后保存。");
}

function settingsRevision(primary: string, fallback?: string) {
  return fallback === undefined ? primary : createHash("sha256").update(`${primary}:${fallback}`).digest("hex");
}

async function readFallback(path: string | undefined) {
  if (path === undefined) return;
  const source = await readSnapshot(await canonical(path), false);
  if (source.revision !== "missing") return { values: readDocument(source.text).values, revision: source.revision };
}

function effectiveSettings(values: Map<unknown, unknown>, legacy: boolean, fallback?: Awaited<ReturnType<typeof readFallback>>) {
  return fallback ? readSettings(new Map([...fallback.values, ...values]), true) : readSettings(values, legacy);
}

export async function readLikeSettings(options?: LikeSettingsLocation) {
  const { file, required, legacy, fallback } = await configLocation(options);
  const current = await readSnapshot(file, required);
  const inherited = await readFallback(fallback);
  return {
    settings: effectiveSettings(readDocument(current.text).values, legacy, inherited),
    revision: settingsRevision(current.revision, inherited?.revision),
  };
}

/**
 * Existing files are checked again immediately before atomic replacement.
 * Writes in this process are serialized by canonical path. Editors outside this
 * process do not share that lock.
 */
export async function saveLikeSettings(patch: unknown, options: LikeSettingsLocation & {
  readonly revision: string;
  readonly canWrite?: () => boolean;
}) {
  const prototype = typeof patch === "object" && patch !== null ? Object.getPrototypeOf(patch) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LikeSettingsError("invalid", "点赞配置修改须为映射。");
  }
  if (typeof options.revision !== "string" || !/^(missing|[a-f0-9]{64})$/u.test(options.revision)) {
    throw new LikeSettingsError("invalid", "点赞配置版本无效，请重新读取。");
  }
  const updates = Object.entries(patch as Record<string, unknown>).map(([key, value]) => [key, validate(key, value)] as const);
  const { file, required, legacy, fallback } = await configLocation(options);
  const authorize = () => {
    if (options.canWrite && !options.canWrite()) throw new LikeSettingsError("conflict", "点赞配置写入权限已失效。");
  };
  const operation = (pendingWrites.get(file) ?? Promise.resolve()).then(async () => {
    authorize();
    const current = await readSnapshot(file, required);
    const inherited = await readFallback(fallback);
    const revision = settingsRevision(current.revision, inherited?.revision);
    if (revision !== options.revision) throw conflict();

    const { document, values } = readDocument(current.text);
    const before = effectiveSettings(values, legacy, inherited);
    const changes = updates.filter(([key, value]) => before[key as keyof LikeSettings] !== value ||
      (key === "recall" && values.has(key) && !recallSeconds(values.get(key))));
    if (!changes.length) {
      authorize();
      return { settings: before, revision };
    }

    const output = values.size || document.contents === null ? document : new Document();
    for (const [key, value] of changes) output.set(key, value);
    const yaml = output.toString();
    const after = readDocument(yaml).values;
    const settings = effectiveSettings(after, legacy, inherited);
    if (!isDeepStrictEqual(unknownFields(values), unknownFields(after)) ||
        !isDeepStrictEqual(settings, { ...before, ...Object.fromEntries(changes) })) {
      throw new LikeSettingsError("invalid", "保存将改变其他 YAML 字段，请先检查配置中的引用。");
    }

    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(dirname(file), ".lotus-like-"));
    try {
      const staged = join(directory, "settings.yaml");
      const handle = await open(staged, "wx", 0o600);
      try {
        await handle.writeFile(yaml, "utf8");
        await handle.chmod(current.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }

      if ((await readSnapshot(file, false)).revision !== current.revision) throw conflict();
      if ((await readFallback(fallback))?.revision !== inherited?.revision) throw conflict();
      authorize();
      if (current.revision === "missing") {
        try {
          linkSync(staged, file);
        } catch (error) {
          if (codeOf(error) === "EEXIST") throw conflict();
          throw error;
        }
      } else {
        renameSync(staged, file);
      }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }

    return { settings, revision: settingsRevision(createHash("sha256").update(yaml).digest("hex"), inherited?.revision) };
  });

  const finished = operation.then(() => undefined, () => undefined);
  pendingWrites.set(file, finished);
  try {
    return await operation;
  } finally {
    if (pendingWrites.get(file) === finished) pendingWrites.delete(file);
  }
}
