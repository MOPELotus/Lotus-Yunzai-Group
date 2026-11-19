import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export type GroupLeaveBlacklistAction = "confirmed" | "rejected" | "unknown";

export interface GroupLeaveBlacklistEvent {
  readonly kind: "leave" | "join" | "apply";
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly session: AbortSignal;
  readonly time?: number;
  readonly name?: string;
  readonly dismissed?: boolean;
  readonly operatorId?: number;
  /** Stable transport-namespaced identity when the protocol provides one. */
  readonly id?: string;
  act?(signal: AbortSignal): Promise<GroupLeaveBlacklistAction>;
}

export interface GroupLeaveBlacklistIO {
  get(groupId: number, userId: number): Promise<string | null>;
  set(groupId: number, userId: number, json: string): Promise<void>;
  remove(groupId: number, userId: number): Promise<boolean>;
  appendGlobal(userId: number, signal: AbortSignal): Promise<"added" | "existing" | "protected" | "unavailable">;
  isProtected(userId: number): boolean;
  report?(stage: "config" | "record" | "global" | "kick" | "decline" | "storage", outcome: GroupLeaveBlacklistAction): void;
}

/** The host only supplies a scope for a currently verified, non-delegated owner in this group. */
export interface GroupLeaveBlacklistOwnerScope {
  readonly groupId: number;
  readonly signal: AbortSignal;
}

export interface GroupLeaveBlacklist {
  isEnabled(groupId: number): boolean;
  matchesCommand(command: string): boolean;
  refresh(): Promise<void>;
  /** True when the host should consume a rejoin or application after a confirmed or uncertain moderation action. */
  handle(event: GroupLeaveBlacklistEvent, signal?: AbortSignal): Promise<boolean>;
  manage(command: string, scope: GroupLeaveBlacklistOwnerScope, signal?: AbortSignal): Promise<string | undefined>;
}

const commandPattern = /^#退群拉黑(解除|查询)\s*(\d+)$/u;
const maxRememberedEvents = 2048;
const kickNoticeWindowMs = 30_000;

export function matchesGroupLeaveBlacklistCommand(command: string): boolean {
  return commandPattern.test(command);
}

export function groupLeaveBlacklistKey(groupId: number): string {
  if (!positiveId(groupId)) throw new TypeError("无效群号。");
  return `Yz:group-leave-blacklist:${groupId}`;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readGroups(root: URL, configName: string): Promise<ReadonlySet<number>> {
  for (const directory of ["config/", "config/config/"]) {
    const source = await readFile(new URL(directory + configName, root), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (source === undefined) continue;
    const config: unknown = parse(source);
    if (config == null) return new Set();
    if (typeof config !== "object" || Array.isArray(config)) throw new TypeError("退群黑名单配置须为映射。");
    const { enable, groups } = config as Record<string, unknown>;
    if (enable !== true || groups == null) return new Set();
    if (!Array.isArray(groups)) throw new TypeError("退群黑名单 groups 应为群号列表。");
    return new Set(groups.map((value: unknown) => {
      const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
      if (!positiveId(id)) throw new TypeError("退群黑名单 groups 包含无效群号。");
      return id;
    }));
  }
  return new Set();
}

export async function readGroupLeaveBlacklist(
  root: URL, io: GroupLeaveBlacklistIO, { configName = "group-leave-blacklist.yaml" }: { readonly configName?: string } = {},
): Promise<GroupLeaveBlacklist> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u.test(configName)) throw new TypeError("无效退群黑名单配置文件名。");
  let groups: ReadonlySet<number> = new Set();
  let invalid = false;
  let reading: Promise<void> | undefined;
  const queues = new Map<string, Promise<unknown>>();
  const seen = new Map<string, boolean>();
  const recentKicks = new Map<string, number>();
  const isEnabled = (groupId: number) => groups.has(groupId);

  function refresh(): Promise<void> {
    return reading ??= readGroups(root, configName).then((latest) => {
      groups = latest;
      invalid = false;
    }, () => {
      groups = new Set();
      if (!invalid) io.report?.("config", "rejected");
      invalid = true;
    }).finally(() => { reading = undefined; });
  }

  async function runInOrder<T>(groupId: number, userId: number, run: () => Promise<T>): Promise<T> {
    const key = `${groupId}:${userId}`;
    const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (queues.get(key) === pending) queues.delete(key);
    }
  }

  function remember(key: string, consume: boolean) {
    seen.set(key, consume);
    if (seen.size > maxRememberedEvents) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
  }

  function rememberKick(groupId: number, userId: number, botId: number) {
    const key = `${groupId}:${userId}:${botId}`;
    recentKicks.delete(key);
    recentKicks.set(key, performance.now() + kickNoticeWindowMs);
    if (recentKicks.size > maxRememberedEvents) {
      const oldest = recentKicks.keys().next();
      if (!oldest.done) recentKicks.delete(oldest.value);
    }
  }

  await refresh();
  return {
    isEnabled, matchesCommand: matchesGroupLeaveBlacklistCommand, refresh,
    async handle(event, lifecycle) {
      const { kind, botId, groupId, userId, session } = event;
      if (!positiveId(groupId) || !positiveId(botId) || !positiveId(userId) || userId === botId || event.dismissed) return false;
      const signal = lifecycle ? AbortSignal.any([session, lifecycle]) : session;
      const active = () => !signal.aborted && !io.isProtected(userId);
      if (!active() || (kind !== "leave" && !event.act)) return false;
      const key = event.id && event.id.length <= 2048 ? JSON.stringify([kind, botId, groupId, userId, event.id]) : undefined;
      return runInOrder(groupId, userId, async () => {
        if (!active()) return false;
        await refresh();
        if (!isEnabled(groupId) || !active()) return false;
        const previous = key ? seen.get(key) : undefined;
        if (previous !== undefined) return previous;
        if (kind === "leave") {
          if (event.operatorId !== undefined &&
              (recentKicks.get(`${groupId}:${userId}:${event.operatorId}`) ?? 0) > performance.now()) return false;
          const time = positiveId(event.time) ? event.time : Math.floor(Date.now() / 1000);
          const name = (event.name ?? "").replace(/[\p{Cc}]/gu, "").slice(0, 256).toWellFormed();
          if (key) remember(key, false);
          try {
            await io.set(groupId, userId, JSON.stringify({ time, self_id: botId, name }));
          } catch {
            io.report?.("record", "unknown");
            return false;
          }
          if (active()) await refresh();
          if (isEnabled(groupId) && active()) {
            let result: Awaited<ReturnType<GroupLeaveBlacklistIO["appendGlobal"]>>;
            try {
              result = await io.appendGlobal(userId, signal);
            } catch {
              result = "unavailable";
            }
            if (result === "unavailable") io.report?.("global", "unknown");
          }
          return false;
        }

        let listed: boolean;
        try {
          listed = (await io.get(groupId, userId)) !== null;
        } catch {
          io.report?.("storage", "unknown");
          return false;
        }
        if (!listed || !active() || !event.act) return false;
        await refresh();
        if (!isEnabled(groupId) || !active()) return false;
        let result: GroupLeaveBlacklistAction;
        try {
          result = await event.act(signal);
        } catch {
          result = "unknown";
        }
        const consume = result !== "rejected";
        if (key) remember(key, consume);
        if (consume && kind === "join") rememberKick(groupId, userId, botId);
        io.report?.(kind === "join" ? "kick" : "decline", result);
        return consume;
      });
    },
    async manage(command, scope, lifecycle) {
      const match = commandPattern.exec(command);
      if (!match || !positiveId(scope.groupId)) return;
      const signal = lifecycle ? AbortSignal.any([scope.signal, lifecycle]) : scope.signal;
      if (signal.aborted) return;
      const userId = Number(match[2]);
      return runInOrder(scope.groupId, userId, async () => {
        if (signal.aborted) return;
        await refresh();
        if (signal.aborted || !isEnabled(scope.groupId)) return;
        if (!positiveId(userId)) return "请输入有效 QQ 号。";
        try {
          if (match[1] === "解除") {
            const removed = await io.remove(scope.groupId, userId);
            if (removed) return `已解除 ${userId} 在本群的退群黑名单。全局黑名单如有记录，仍需手动处理。`;
          } else if ((await io.get(scope.groupId, userId)) !== null) {
            return `${userId} 在本群退群黑名单中。`;
          }
          return `${userId} 不在本群退群黑名单中。`;
        } catch {
          io.report?.("storage", "unknown");
          return "退群黑名单暂不可用。";
        }
      });
    },
  };
}
