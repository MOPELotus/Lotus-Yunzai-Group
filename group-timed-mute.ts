import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupMuteContext, GroupWholeMuteResult } from "./group-mute.ts";

export interface GroupTimedMuteBinding {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly groupId: number;
  readonly issuerId: number;
  readonly enabled: boolean;
}

export interface GroupTimedMuteServices {
  readLegacy(): Promise<string | null>;
  validateCron(cron: string): boolean;
  register(name: string, cron: string, run: () => Promise<void>): () => void | Promise<void>;
  execute(binding: GroupTimedMuteBinding, signal: AbortSignal): Promise<GroupWholeMuteResult>;
  report?(binding: GroupTimedMuteBinding, result: GroupWholeMuteResult): void;
}

type LockFile = (file: string, subject: string) => Promise<{ close(): void }>;
type Context = GroupMuteContext & { readonly normalizedMessage: string };
type Reply = string | readonly [] | { readonly type: "forward"; readonly nodes: readonly (readonly (string | { type: "image"; file: string })[])[] };
type Mode = { readonly groupId: number; readonly enabled: boolean };
type Task = GroupTimedMuteBinding & { readonly cron: string };
type LegacyTask = Mode & { readonly cron?: string; readonly botId?: number };
interface State { readonly version: 1; readonly tasks: readonly Task[]; readonly retiredLegacy: readonly Mode[] }

const empty: State = { version: 1, tasks: [], retiredLegacy: [] };
const filename = "data/group/mute-schedule.json";
const make = /^#(?:设置)?定时(禁言|解禁)(.*)$/u;
const change = /^#(取消定时|绑定旧定时)(禁言|解禁)$/u;
const list = "#定时禁言任务";
const maxBytes = 512 * 1024;
const maxCronLength = 160;
export const groupTimedMuteFeature = "[group] 定时群禁言";

export function isGroupTimedMuteCommand(message: string): boolean { return message === list || make.test(message) || change.test(message); }
function key({ groupId, enabled }: Mode): string { return `${groupId}:${enabled}`; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function legacyId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (positive(id)) return id;
}

function mode(value: unknown): value is Mode & Record<string, unknown> { return record(value) && positive(value.groupId) && typeof value.enabled === "boolean"; }
function task(value: unknown): value is Task {
  return mode(value) && (value.adapter === "onebot" || value.adapter === "milky") && positive(value.botId) &&
    positive(value.issuerId) && typeof value.cron === "string" && value.cron.length > 0 && value.cron.length <= maxCronLength;
}

function equalTask(a: Task, b?: Task): boolean {
  return b !== undefined && a.groupId === b.groupId && a.enabled === b.enabled && a.cron === b.cron &&
    a.adapter === b.adapter && a.botId === b.botId && a.issuerId === b.issuerId;
}

function decode(raw?: Buffer): State {
  if (!raw) return empty;
  const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!record(data) || data.version !== 1 || !Array.isArray(data.tasks) || !data.tasks.every(task) ||
      !Array.isArray(data.retiredLegacy) || !data.retiredLegacy.every(mode) || new Set(data.tasks.map(key)).size !== data.tasks.length) {
    throw new Error("定时群禁言记录无效。");
  }
  return { version: 1, tasks: data.tasks, retiredLegacy: data.retiredLegacy };
}

function legacyRows(raw: string | null): readonly unknown[] {
  if (raw === null) return [];
  if (raw.length > maxBytes) throw new Error("旧定时群禁言记录过大。");
  const rows: unknown = JSON.parse(raw);
  if (rows == null) return [];
  if (!Array.isArray(rows)) throw new Error("旧定时群禁言记录无效。");
  return rows;
}

function legacyMode(entry: unknown): Mode | undefined {
  if (!record(entry) || typeof entry.type !== "boolean") return;
  const groupId = legacyId(entry.group);
  if (groupId !== undefined) return { groupId, enabled: entry.type };
}

function legacyTasks(raw: string | null): readonly LegacyTask[] {
  return legacyRows(raw).flatMap((entry) => {
    if (!record(entry)) return [];
    const scope = legacyMode(entry);
    return scope ? [{ ...scope, botId: legacyId(entry.botId),
      cron: typeof entry.cron === "string" && entry.cron.length <= maxCronLength ? entry.cron : undefined }] : [];
  });
}

export function prepareLegacyMuteHandoff(state: Buffer, legacy: string | null): { value: string | null; removed: number } {
  if (state.length > maxBytes) throw new Error("定时群禁言记录过大。");
  const { retiredLegacy } = decode(state);
  const retired = new Set(retiredLegacy.map(key));
  const rows = legacyRows(legacy);
  const kept = rows.filter((entry) => {
    const scope = legacyMode(entry);
    return !scope || !retired.has(key(scope));
  });
  const removed = rows.length - kept.length;
  return { value: removed ? JSON.stringify(kept) : legacy, removed };
}

function normalizeCron(input: string): string | undefined {
  if (!input || input.length > maxCronLength || /[^A-Za-z0-9*?,/#:\uff1a\- \t]/u.test(input)) return;
  const text = input.trim().replace(/[ \t]+/gu, " ");
  const clock = /^(\d{1,2})[:：](\d{1,2})$/u.exec(text);
  if (clock) {
    const hour = Number(clock[1]), minute = Number(clock[2]);
    if (hour <= 23 && minute <= 59) return `0 ${minute} ${hour} * * ?`;
    return;
  }
  const fields = text.split(" ");
  const [,,, day,, weekday] = fields;
  if (fields.length !== 6 || !((day === "?") !== (weekday === "?") || day === "*" && weekday === "*")) return;
  return text;
}

async function snapshot(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("定时群禁言文件无效。");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error("定时群禁言文件已变更。");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function createGroupTimedMute(root: URL, lockFile: LockFile, services: GroupTimedMuteServices, signal: AbortSignal) {
  const file = fileURLToPath(new URL(filename, root));
  const directory = dirname(file);
  const shutdown = new AbortController();
  const active = AbortSignal.any([signal, shutdown.signal]);
  const jobs = new Map<string, { readonly task: Task; readonly controller: AbortController; readonly dispose: () => void | Promise<void> }>();
  const seen = new Set<string>();
  let queue = Promise.resolve();
  let stopPending: Promise<void> | undefined;

  function supported(cron: string | undefined): cron is string {
    if (!cron || normalizeCron(cron) !== cron) return false;
    try { return services.validateCron(cron); } catch { return false; }
  }

  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.then(() => {}, () => {});
    return result;
  }

  async function sync(state: State) {
    const desired = new Map(state.tasks.filter((entry) => supported(entry.cron)).map((entry) => [key(entry), entry]));
    for (const [id, job] of jobs) {
      if (equalTask(job.task, desired.get(id))) continue;
      jobs.delete(id);
      job.controller.abort();
      await Promise.resolve().then(job.dispose).catch(() => {});
    }
    for (const [id, entry] of desired) {
      if (active.aborted || jobs.has(id)) continue;
      const controller = new AbortController();
      const runSignal = AbortSignal.any([active, controller.signal]);
      let running = false;
      try {
        const dispose = services.register(`${groupTimedMuteFeature} ${entry.groupId} ${entry.enabled ? "禁言" : "解禁"}`, entry.cron, async () => {
          if (runSignal.aborted || running) return;
          running = true;
          try {
            const latest = decode(await snapshot(file)).tasks.find((item) => key(item) === id);
            if (runSignal.aborted || !equalTask(entry, latest)) return;
            const result = await services.execute(entry, runSignal).catch(() => "unknown" as const);
            services.report?.(entry, result);
          } catch { if (!runSignal.aborted) services.report?.(entry, "unavailable"); }
          finally { running = false; }
        });
        jobs.set(id, { task: entry, controller, dispose });
      } catch { if (!active.aborted) services.report?.(entry, "unavailable"); }
    }
  }

  type Edit = { state?: State; retry?: State; reply: string };
  async function update(authorize: () => Promise<boolean>, mutate: (state: State) => Promise<Edit>): Promise<string> {
    active.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(directory, ".lotus-mute-schedule.sqlite"), "定时群禁言");
    let result: Edit;
    try {
      active.throwIfAborted();
      const before = await snapshot(file);
      result = await mutate(decode(before));
      if (result.state) {
        const bytes = Buffer.from(JSON.stringify(result.state, null, 2) + "\n");
        if (bytes.length > maxBytes) throw new Error("定时群禁言记录过大。");
        const stage = await mkdtemp(join(directory, ".lotus-mute-schedule-"));
        try {
          const staged = join(stage, "tasks.json");
          const output = await open(staged, "wx", 0o600);
          try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
          if (!await authorize()) return "当前会话没有管理定时群禁言的权限。";
          const latest = await snapshot(file);
          if (before ? !latest?.equals(before) : latest !== undefined) throw new Error("定时群禁言已被其他程序修改。");
          active.throwIfAborted();
          if (before) await rename(staged, file);
          else await link(staged, file);
        } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
      }
    } finally { lock.close(); }
    if (result.state) await sync(result.state);
    if (result.retry && await authorize()) await sync(result.retry);
    return result.reply;
  }

  const stop = () => stopPending ??= (async () => {
    shutdown.abort();
    await queue;
    await sync(empty);
  })();
  signal.addEventListener("abort", () => { void stop(); }, { once: true });
  if (!active.aborted) await snapshot(file).then(decode).then(sync).catch(() => {});

  function claim(context: Context): boolean {
    const id = context.message_id;
    if (!(typeof id === "number" && Number.isSafeInteger(id)) && !(typeof id === "string" && id.length > 0 && id.length <= 128)) return false;
    const message = JSON.stringify([context.adapter ?? "onebot", context.self_id, context.group_id, context.user_id, String(id)]);
    if (seen.has(message)) return false;
    seen.add(message);
    if (seen.size > 2048) {
      const first = seen.values().next();
      if (!first.done) seen.delete(first.value);
    }
    return true;
  }

  async function command(context: Context): Promise<Reply | undefined> {
    const text = context.normalizedMessage.trim();
    if (context.message_type !== "group" || context.isDelegated || active.aborted || !isGroupTimedMuteCommand(text) ||
        !positive(context.group_id) || !positive(context.self_id) || !positive(context.user_id)) return;
    const groupId = context.group_id, botId = context.self_id, issuerId = context.user_id;
    const adapter = context.adapter === "milky" ? "milky" : "onebot";
    const authorize = async () => {
      try { return !active.aborted && await context.groupManageBlacklist?.() === true && !active.aborted; } catch { return false; }
    };
    if (!await authorize()) return "当前会话没有管理定时群禁言的权限。";
    try {
      if (text === list) {
        const state = decode(await snapshot(file));
        const old = legacyTasks(await services.readLegacy());
        const lines: string[] = [];
        for (const enabled of [true, false]) {
          const id = key({ groupId, enabled });
          const label = enabled ? "禁言时间" : "解禁时间";
          const current = state.tasks.find((entry) => key(entry) === id);
          if (current) {
            const health = !supported(current.cron) ? "当前调度器不支持" : !jobs.has(id) ? "已保存，未能注册" : "已注册";
            lines.push(`${label}："${supported(current.cron) ? current.cron : "原表达式待核对"}"（${health}）`);
          } else if (!state.retiredLegacy.some((entry) => key(entry) === id)) {
            const candidates = old.filter((entry) => key(entry) === id);
            if (!candidates.length) continue;
            const legacy = candidates[0]!;
            const cron = legacy.cron?.trim().replace(/[ \t]+/gu, " ");
            const health = candidates.length > 1 ? "多条旧记录待处理" : !supported(cron) ? "旧 cron 无法调度，可取消后重设"
              : legacy.botId === botId ? "待绑定，使用 #绑定旧定时" + (enabled ? "禁言" : "解禁") : "旧机器人身份未匹配，可取消后重设";
            lines.push(`${label}："${supported(cron) ? cron : "旧表达式待核对"}"（${health}）`);
          }
        }
        return lines.length ? { type: "forward", nodes: [[{ type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
          `\n群号：${groupId}\n${lines.join("\n")}`]] } : "目前本群还没有定时禁言任务。";
      }
      const edit = change.exec(text), create = make.exec(text);
      const enabled = (edit?.[2] ?? create?.[1]) === "禁言";
      const target: Mode = { groupId, enabled };
      const id = key(target);
      const label = enabled ? "禁言" : "解禁";
      const cron = create ? normalizeCron(create[2]?.trim() ?? "") : undefined;
      if (create && !supported(cron)) return `请输入有效的时间或调度器支持的六段 cron，例如 #定时${label}21:30。`;
      if (!claim(context)) return [];
      return await serialize(async () => {
        const reply = await update(authorize, async (state) => {
          const current = state.tasks.find((entry) => key(entry) === id);
          const retired = state.retiredLegacy.some((entry) => key(entry) === id);
          const old = current || retired ? [] : legacyTasks(await services.readLegacy()).filter((entry) => key(entry) === id);
          if (edit?.[1] === "取消定时") {
            if (!current && !old.length) return { reply: `本群没有定时${label}任务。` };
            return { state: { ...state, tasks: state.tasks.filter((entry) => key(entry) !== id),
              retiredLegacy: retired ? state.retiredLegacy : [...state.retiredLegacy, target] }, reply: `已取消本群定时${label}。` };
          }
          if (current) {
            if (create && !jobs.has(id) && current.cron === cron && current.adapter === adapter && current.botId === botId && current.issuerId === issuerId) {
              return { retry: state, reply: `已保存本群定时${label}，可发送 #定时禁言任务 查看。` };
            }
            return { reply: `本群已有定时${label}任务，请先取消；如果未能注册，原发令人可重新发送相同设置。` };
          }
          let expression = cron;
          if (edit?.[1] === "绑定旧定时") {
            const legacy = old[0];
            if (old.length !== 1 || legacy?.botId !== botId) return { reply: "没有可绑定到当前机器人的唯一旧任务。" };
            expression = legacy.cron?.trim().replace(/[ \t]+/gu, " ");
            if (!supported(expression)) return { reply: "旧任务 cron 无法调度，请取消后重新设置。" };
          } else if (old.length) return { reply: `本群有待绑定的旧定时${label}，请先绑定或取消。` };
          if (!expression) return { reply: "无法读取定时群禁言表达式。" };
          const entry: Task = { ...target, cron: expression, adapter, botId, issuerId };
          return { state: { ...state, tasks: [...state.tasks, entry], retiredLegacy: retired ? state.retiredLegacy : [...state.retiredLegacy, target] },
            reply: `已保存本群定时${label}，可发送 #定时禁言任务 查看。` };
        });
        if (reply.startsWith("已保存") && !jobs.has(id)) return `定时${label}已保存，但暂未注册。`;
        return reply;
      });
    } catch { return "定时群禁言配置暂不可用。"; }
  }

  return { command, stop };
}
