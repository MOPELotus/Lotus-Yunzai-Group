import { randomInt } from "node:crypto";
import { ManagedBlacklistPermissionError, maxGroupVerificationSeconds, type GroupVerificationSettings, type ManagedBlacklistStore } from "./managed-blacklist.ts";
import type { GroupVotePart, GroupVoteResult } from "./group-vote.ts";

interface VerificationScope {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly connection: AbortSignal;
  readonly signal: AbortSignal;
}

type Role = "member" | "admin" | "owner";
export interface GroupVerificationJoin extends VerificationScope {
  readonly time: number;
  readonly inviterId?: number;
  inspect(): Promise<{ readonly botRole: Role; readonly targetRole: Role; readonly protectedTarget: boolean;
    readonly inviterRole?: Role; readonly targetJoinTime?: number } | undefined>;
  reply(parts: readonly GroupVotePart[]): Promise<boolean>;
  kick(signal: AbortSignal, expectedJoinTime?: number): Promise<GroupVoteResult>;
}

export interface GroupVerificationLeave extends VerificationScope {
  readonly time?: number;
  readonly voluntary?: boolean;
  readonly dismissed?: boolean;
  readonly operatorId?: number;
}

export interface GroupVerificationAnswer extends VerificationScope {
  readonly messageId: string | number;
  readonly text: string;
  canAnswer(): Promise<boolean>;
  recall(): Promise<unknown>;
  reply(parts: readonly GroupVotePart[]): Promise<boolean>;
}

export interface GroupVerification {
  join(event: GroupVerificationJoin): Promise<void>;
  leave(event: GroupVerificationLeave): Promise<void>;
  answer(event: GroupVerificationAnswer): Promise<boolean>;
}

export interface GroupVerificationContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_id?: string | number;
  readonly adapter?: "onebot" | "milky";
  readonly isDelegated?: boolean;
  readonly message?: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupVerification?: {
    readonly connection: AbortSignal;
    readonly signal: AbortSignal;
    canConfigure(): Promise<boolean>;
    prepare(target: number): Promise<GroupVerificationJoin | undefined>;
  };
}

export const groupVerificationFeature = "[group] 入群验证";
const switchPattern = /^#(开启|关闭)验证$/u;
const bypassPattern = /^#绕过验证(\d+)?$/u;
const repeatPattern = /^#重新验证(\d+)?$/u;
const modeCommand = "#切换验证模式";
const timeCommand = /^#设置验证超时时间(\d+)(?:s|秒)?$/u;
export const isGroupVerificationCommand = (message: string) => switchPattern.test(message) || bypassPattern.test(message) ||
  repeatPattern.test(message) || message === modeCommand || timeCommand.test(message);

type Clock = { now(): number; schedule(milliseconds: number, callback: () => void): () => void; random(min: number, max: number): number };
const nativeClock: Clock = {
  now: () => performance.now(),
  schedule(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  random: randomInt,
};

interface Challenge {
  readonly event: GroupVerificationJoin;
  readonly noticeTime?: number;
  readonly controller: AbortController;
  readonly cleanups: (() => void)[];
  readonly messages: Set<string>;
  deadline?: number;
  expression?: string;
  answer?: string;
  joined?: number;
  remaining: number;
  settling: boolean;
  kickInFlight: boolean;
  queue: Promise<void>;
}

const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const groupScope = (event: Pick<VerificationScope, "botId" | "groupId">) => `${event.botId}:${event.groupId}`;
const position = (event: Pick<VerificationScope, "botId" | "groupId" | "userId">) => `${groupScope(event)}:${event.userId}`;
const live = (event: Pick<VerificationScope, "signal" | "connection">) => !event.signal.aborted && !event.connection.aborted;
const validIdentity = (event: VerificationScope) => id(event.botId) && id(event.groupId) && id(event.userId);
const at = (qq: number): GroupVotePart => ({ type: "at", qq });

function nativeMessageId(value: unknown): value is string | number {
  return typeof value === "number" ? Number.isSafeInteger(value) : typeof value === "string" && value.length > 0 && value.length <= 128;
}

function commandTarget(message: GroupVerificationContext["message"], spelling: string | undefined, bot: number) {
  const mentions = new Set<number>();
  if (Array.isArray(message)) for (const part of message) {
    if (part.type !== "at" || String(part.qq) === String(bot)) continue;
    const target = typeof part.qq === "string" && /^\d+$/u.test(part.qq) ? Number(part.qq) : part.qq;
    if (!id(target)) return;
    mentions.add(target);
  }
  if (mentions.size > 1) return;
  const explicit = spelling === undefined ? undefined : Number(spelling);
  if (spelling !== undefined && !id(explicit)) return;
  const mentioned = mentions.values().next().value;
  if (mentioned !== undefined && explicit !== undefined && mentioned !== explicit) return;
  return mentioned ?? explicit;
}

export function createGroupVerification(store: Pick<ManagedBlacklistStore, "readGroupVerificationSettings" | "setGroupVerification" |
  "toggleGroupVerificationMode" | "setGroupVerificationTime">,
  whitelisted: (user: number) => Promise<boolean>, signal: AbortSignal, clock: Clock = nativeClock) {
  const challenges = new Map<string, Challenge>();
  const events = new Map<string, number>();
  const commands = new Set<string>();
  const detached = new Set<Promise<void>>();
  let stopped = false;

  function inBackground(run: () => Promise<void>) {
    const work = run().catch(() => undefined);
    detached.add(work);
    void work.then(() => detached.delete(work));
  }

  function remove(challenge: Challenge) {
    const key = position(challenge.event);
    if (challenges.get(key) === challenge) challenges.delete(key);
    challenge.controller.abort();
    for (const cleanup of challenge.cleanups.splice(0)) cleanup();
  }

  const available = (challenge: Challenge) => !stopped && !signal.aborted && live(challenge.event) &&
    !challenge.controller.signal.aborted && challenges.get(position(challenge.event)) === challenge;
  const sameConnection = (challenge: Challenge, event: VerificationScope) => challenge.event.adapter === event.adapter &&
    challenge.event.connection === event.connection;
  const currentLeave = (challenge: Challenge, event: GroupVerificationLeave) => {
    const joined = challenge.noticeTime ?? challenge.joined;
    return event.time === undefined || joined === undefined || event.time >= joined;
  };

  function createChallenge(event: GroupVerificationJoin, noticeTime?: number) {
    const challenge: Challenge = { event, noticeTime, controller: new AbortController(), messages: new Set(), cleanups: [], remaining: 0,
      settling: false, kickInFlight: false, queue: Promise.resolve() };
    challenges.set(position(event), challenge);
    const cancel = () => remove(challenge);
    for (const ending of new Set([event.signal, event.connection])) {
      ending.addEventListener("abort", cancel, { once: true });
      challenge.cleanups.push(() => ending.removeEventListener("abort", cancel));
    }
    return challenge;
  }

  function remember(key: string, stamp: number) {
    if ((events.get(key) ?? 0) >= stamp) return;
    events.delete(key);
    events.set(key, stamp);
    if (events.size > 8192) {
      const oldest = events.keys().next().value;
      if (oldest) events.delete(oldest);
    }
  }

  async function announce(event: GroupVerificationJoin | GroupVerificationAnswer, text: string, mention = true) {
    if (stopped || signal.aborted || !live(event)) return false;
    try { return await event.reply(mention ? [at(event.userId), text] : [text]) === true; }
    catch { return false; }
  }

  async function settings(group: number) { return store.readGroupVerificationSettings(group).catch(() => undefined); }

  async function authorized(challenge: Challenge, starting = false): Promise<true | false | "management" | "protected"> {
    if (!available(challenge)) return false;
    const { event } = challenge;
    const automatic = challenge.noticeTime !== undefined;
    if ((automatic && await whitelisted(event.userId).catch(() => true)) || !available(challenge)) return false;
    let roles: Awaited<ReturnType<GroupVerificationJoin["inspect"]>>;
    try { roles = await event.inspect(); } catch { return false; }
    if (!available(challenge) || !roles || !["admin", "owner"].includes(roles.botRole)) return false;
    if (roles.targetRole !== "member") return "management";
    if (roles.protectedTarget) return "protected";
    if (starting && automatic && event.inviterId !== undefined && (roles.inviterRole === "admin" || roles.inviterRole === "owner")) return false;
    if (challenge.joined !== undefined && roles.targetJoinTime !== challenge.joined) return false;
    if (starting && id(roles.targetJoinTime)) {
      if (challenge.noticeTime !== undefined && roles.targetJoinTime > challenge.noticeTime) return false;
      challenge.joined = roles.targetJoinTime;
    }
    return true;
  }

  async function end(challenge: Challenge, reason: "验证超时" | "验证失败", replyEvent: GroupVerificationJoin | GroupVerificationAnswer = challenge.event) {
    if (!available(challenge) || challenge.settling) return;
    challenge.settling = true;
    try {
      if (!(await settings(challenge.event.groupId))?.enabled || await authorized(challenge) !== true || !available(challenge)) return;
      let result: GroupVoteResult;
      challenge.kickInFlight = true;
      try { result = await challenge.event.kick(AbortSignal.any([challenge.controller.signal, signal, challenge.event.signal, challenge.event.connection]), challenge.joined); }
      catch { result = "unknown"; }
      finally { challenge.kickInFlight = false; }
      if (!available(challenge)) return;
      const message = result === "confirmed" ? `\n${reason}，已移出群聊，请重新申请。`
        : result === "unknown" ? `\n${reason}，移出结果未确认，请在 QQ 核对。`
        : `\n${reason}，未能移出该成员。`;
      await announce(replyEvent, message);
    } finally { remove(challenge); }
  }

  async function ask(challenge: Challenge): Promise<string | undefined> {
    const unavailable = "无法确认目标群成员或验证权限。";
    if (!available(challenge)) return unavailable;
    const { event } = challenge;
    const config = await settings(event.groupId);
    if (!config?.enabled) { remove(challenge); return "当前群未开启验证哦~"; }
    const permission = await authorized(challenge, true);
    if (permission !== true || !available(challenge)) {
      remove(challenge);
      if (permission === "management") return "❎ 该命令对群主或管理员无效";
      if (permission === "protected") return "❎ 该命令对机器人主人无效";
      return unavailable;
    }
    const first = clock.random(config.min, config.max + 1);
    const candidate = clock.random(config.min, config.max);
    const second = candidate >= first ? candidate + 1 : candidate;
    const [larger, smaller] = first > second ? [first, second] : [second, first];
    const plus = clock.random(0, 2) === 0;
    const expression = `${larger} ${plus ? "+" : "-"} ${smaller}`;
    const question = ` 欢迎！\n请在「${config.time}」秒内发送\n「${expression}」的运算结果\n否则将会被移出群聊`;
    if (!await announce(event, question) || !available(challenge)) { remove(challenge); return "验证通知未获确认，未启动计时。"; }
    challenge.expression = expression;
    challenge.answer = String(plus ? larger + smaller : larger - smaller);
    challenge.remaining = config.times;
    challenge.deadline = clock.now() + config.time * 1000;
    challenge.cleanups.push(clock.schedule(config.time * 1000, () => inBackground(() => end(challenge, "验证超时"))));
    if (config.remind && config.time >= 120) challenge.cleanups.push(clock.schedule((config.time - 60) * 1000, () => inBackground(async () => {
      if (!available(challenge) || challenge.settling || !challenge.deadline || clock.now() >= challenge.deadline) return;
      if (!(await settings(event.groupId))?.enabled || await authorized(challenge) !== true || !available(challenge) || challenge.settling) return;
      await announce(event, `\n验证仅剩最后一分钟\n请发送「${expression}」的运算结果\n否则将会被移出群聊`);
    })));
  }

  const policy: GroupVerification = {
    async join(event) {
      if (stopped || signal.aborted || !validIdentity(event) || !live(event) || event.botId === event.userId || !id(event.time)) return;
      const config = await settings(event.groupId);
      if (!config?.enabled || stopped || signal.aborted || !live(event)) return;
      const key = position(event);
      if ((events.get(key) ?? 0) >= event.time || (events.get(groupScope(event)) ?? 0) >= event.time || challenges.size >= 4096) return;
      const prior = challenges.get(key);
      remember(key, event.time);
      if (prior && prior.noticeTime === undefined && available(prior)) return;
      if (prior) remove(prior);
      const challenge = createChallenge(event, event.time);
      const prompt = () => inBackground(async () => { await ask(challenge); });
      if (config.delay) challenge.cleanups.push(clock.schedule(config.delay * 1000, prompt));
      else prompt();
    },
    async leave(event) {
      if (!validIdentity(event) || !live(event)) return;
      if (event.dismissed || event.userId === event.botId) {
        if (id(event.time)) remember(groupScope(event), event.time);
        for (const challenge of challenges.values()) {
          if (challenge.event.botId === event.botId && challenge.event.groupId === event.groupId && sameConnection(challenge, event) &&
              currentLeave(challenge, event)) remove(challenge);
        }
        return;
      }
      const key = position(event);
      if (id(event.time)) remember(key, event.time);
      const challenge = challenges.get(key);
      if (!challenge || !sameConnection(challenge, event) || !currentLeave(challenge, event)) return;
      if (challenge.kickInFlight && event.voluntary !== true && event.operatorId === event.botId) return;
      const announceLeave = available(challenge) && !challenge.settling && challenge.deadline !== undefined && event.voluntary === true;
      remove(challenge);
      if (announceLeave) inBackground(async () => {
        if ((await settings(event.groupId))?.enabled && live(event)) await announce(challenge.event, `「${event.userId}」主动退群，验证流程结束`, false);
      });
    },
    async answer(event) {
      if (!validIdentity(event) || !nativeMessageId(event.messageId) || typeof event.text !== "string" ||
          event.text.length > 4096 || !live(event)) return false;
      const challenge = challenges.get(position(event));
      if (!challenge || !sameConnection(challenge, event) || !available(challenge) || challenge.deadline === undefined) return false;
      const check = challenge.queue.then(async () => {
        if (!available(challenge) || challenge.settling || !live(event) || challenge.deadline === undefined || clock.now() >= challenge.deadline) return false;
        const config = await settings(event.groupId);
        if (!config?.enabled) { remove(challenge); return false; }
        if (challenge.noticeTime !== undefined && await whitelisted(event.userId).catch(() => true)) { remove(challenge); return false; }
        if (!available(challenge) || !live(event) || challenge.settling || clock.now() >= challenge.deadline) return false;
        if (!await event.canAnswer().catch(() => false) || !available(challenge) || !live(event) || challenge.settling || clock.now() >= challenge.deadline) return false;
        const key = String(event.messageId);
        if (challenge.messages.has(key)) return true;
        challenge.messages.add(key);
        const value = challenge.answer!;
        if (config.mode === "精确" ? event.text === value : event.text.includes(value)) {
          remove(challenge);
          await announce(event, config.success, false);
        } else if (--challenge.remaining <= 0) await end(challenge, "验证失败", event);
        else {
          try { await event.recall(); } catch { /* A denied recall should not remove the remaining chances. */ }
          if (available(challenge) && !challenge.settling) await announce(event,
            `\n❎ 验证失败\n你还有「${challenge.remaining}」次机会\n请发送「${challenge.expression}」的运算结果`);
        }
        return true;
      });
      challenge.queue = check.then(() => {}, () => {});
      return check.catch(() => false);
    },
  };

  async function command(text: string, context: GroupVerificationContext): Promise<string | readonly [] | undefined> {
    if (context.message_type !== "group" || !isGroupVerificationCommand(text)) return;
    const { group_id: group, self_id: bot, user_id: user, groupVerification: session, message_id } = context;
    const timed = timeCommand.exec(text);
    const ownerCommand = text === modeCommand || timed !== null;
    const permission = ownerCommand ? "仅当前机器人主人可以设置入群验证模式和时限。" : "当前会话没有管理入群验证的权限。";
    if (stopped || signal.aborted || context.isDelegated || !session || !live(session) || !id(group) || !id(bot) || !id(user)) return permission;
    const authorize = async () => {
      try {
        if (stopped || signal.aborted || !live(session)) return false;
        const allowed = ownerCommand ? await session.canConfigure() : await context.groupManageBlacklist?.();
        return allowed === true && !stopped && !signal.aborted && live(session);
      }
      catch { return false; }
    };
    if (!await authorize()) return permission;
    if (!nativeMessageId(message_id)) return [];
    const commandId = JSON.stringify([context.adapter ?? "onebot", bot, group, user, String(message_id)]);
    if (commands.has(commandId)) return [];
    commands.add(commandId);
    if (commands.size > 4096) {
      const oldest = commands.keys().next().value;
      if (oldest) commands.delete(oldest);
    }
    try {
      const commandSignal = AbortSignal.any([signal, session.signal, session.connection]);
      if (text === modeCommand) {
        const mode = await store.toggleGroupVerificationMode(commandSignal, authorize);
        return `✅ 已切换验证模式为${mode}验证`;
      }
      if (timed) {
        const seconds = Number(timed[1]);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxGroupVerificationSeconds) return "请填写有效的正整数验证秒数。";
        const changed = await store.setGroupVerificationTime(seconds, commandSignal, authorize);
        const reply = changed ? `✅ 已将验证超时时间设置为${seconds}秒` : `验证超时时间已是${seconds}秒。`;
        return seconds < 60 ? `${reply}\n建议至少一分钟（60秒）` : reply;
      }
      const toggle = switchPattern.exec(text);
      if (toggle) {
        const enabled = toggle[1] === "开启";
        const changed = await store.setGroupVerification(group, enabled, commandSignal, authorize);
        if (!enabled) for (const challenge of challenges.values()) if (challenge.event.groupId === group) remove(challenge);
        if (!changed) return enabled ? "❎ 本群验证已处于开启状态" : "❎ 本群暂未开启验证";
        return `✅ 已${toggle[1]}本群验证`;
      }
      const config = await settings(group);
      if (!config?.enabled) return "当前群未开启验证哦~";
      if (!await authorize()) return permission;
      const repeat = repeatPattern.exec(text);
      const target = commandTarget(context.message, (repeat ?? bypassPattern.exec(text))?.[1], bot);
      if (!target || target === bot) return "❎ 请输入正确的 QQ 号或艾特一位群成员";
      const key = position({ botId: bot, groupId: group, userId: target });
      const adapter = context.adapter ?? "onebot";
      if (repeat) {
        if (challenges.has(key)) return "❎ 目标群成员处于验证状态";
        if (challenges.size >= 4096) return "当前待验证成员过多，请稍后再试。";
        const event = await session.prepare(target).catch(() => undefined);
        if (!event || event.botId !== bot || event.groupId !== group || event.userId !== target || event.adapter !== adapter ||
            event.connection !== session.connection || !live(event) || !live(session) || stopped || signal.aborted) {
          return "无法确认目标群成员或验证权限。";
        }
        if (challenges.has(key)) return "❎ 目标群成员处于验证状态";
        const prepared = { ...event, signal: AbortSignal.any([event.signal, session.signal]) };
        return (await ask(createChallenge(prepared))) ?? [];
      }
      const challenge = challenges.get(key);
      if (!challenge || !available(challenge) || challenge.event.adapter !== adapter || challenge.event.connection !== session.connection || challenge.settling) {
        return "❎ 目标群成员当前无需验证";
      }
      remove(challenge);
      return config.success;
    } catch (error) {
      return error instanceof ManagedBlacklistPermissionError ? permission : "暂无法保存入群验证配置。";
    }
  }

  function cancelAll() { for (const challenge of challenges.values()) remove(challenge); }
  signal.addEventListener("abort", cancelAll, { once: true });
  return { policy, command, async stop() { stopped = true; signal.removeEventListener("abort", cancelAll); cancelAll(); await Promise.allSettled(detached); } };
}
