import { randomInt } from "node:crypto";
import { ManagedBlacklistPermissionError, type GroupVerificationSettings, type ManagedBlacklistStore } from "./managed-blacklist.ts";
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
  readonly groupVerification?: { readonly connection: AbortSignal; readonly signal: AbortSignal };
}

export const groupVerificationFeature = "[group] 入群验证";
const switchPattern = /^#(开启|关闭)验证$/u;
const bypassPattern = /^#绕过验证(\d+)?$/u;
export const isGroupVerificationCommand = (message: string) => switchPattern.test(message) || bypassPattern.test(message);

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

export function createGroupVerification(store: Pick<ManagedBlacklistStore, "readGroupVerificationSettings" | "setGroupVerification">,
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

  async function authorized(challenge: Challenge, invitation = false) {
    if (!available(challenge)) return false;
    const { event } = challenge;
    if (await whitelisted(event.userId).catch(() => true) || !available(challenge)) return false;
    let roles: Awaited<ReturnType<GroupVerificationJoin["inspect"]>>;
    try { roles = await event.inspect(); } catch { return false; }
    if (!available(challenge) || !roles || !["admin", "owner"].includes(roles.botRole) || roles.targetRole !== "member" || roles.protectedTarget) return false;
    if (invitation && event.inviterId !== undefined && (roles.inviterRole === "admin" || roles.inviterRole === "owner")) return false;
    if (challenge.joined !== undefined && roles.targetJoinTime !== challenge.joined) return false;
    if (invitation && id(roles.targetJoinTime)) {
      if (roles.targetJoinTime > event.time) return false;
      challenge.joined = roles.targetJoinTime;
    }
    return true;
  }

  async function end(challenge: Challenge, reason: "验证超时" | "验证失败", replyEvent: GroupVerificationJoin | GroupVerificationAnswer = challenge.event) {
    if (!available(challenge) || challenge.settling) return;
    challenge.settling = true;
    try {
      if (!(await settings(challenge.event.groupId))?.enabled || !await authorized(challenge) || !available(challenge)) return;
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

  async function ask(challenge: Challenge) {
    if (!available(challenge)) return;
    const { event } = challenge;
    const config = await settings(event.groupId);
    if (!config?.enabled || !await authorized(challenge, true) || !available(challenge)) { remove(challenge); return; }
    const first = clock.random(config.min, config.max + 1);
    const candidate = clock.random(config.min, config.max);
    const second = candidate >= first ? candidate + 1 : candidate;
    const [larger, smaller] = first > second ? [first, second] : [second, first];
    const plus = clock.random(0, 2) === 0;
    const expression = `${larger} ${plus ? "+" : "-"} ${smaller}`;
    const question = ` 欢迎！\n请在「${config.time}」秒内发送\n「${expression}」的运算结果\n否则将会被移出群聊`;
    if (!await announce(event, question) || !available(challenge)) { remove(challenge); return; }
    challenge.expression = expression;
    challenge.answer = String(plus ? larger + smaller : larger - smaller);
    challenge.remaining = config.times;
    challenge.deadline = clock.now() + config.time * 1000;
    challenge.cleanups.push(clock.schedule(config.time * 1000, () => inBackground(() => end(challenge, "验证超时"))));
    if (config.remind && config.time >= 120) challenge.cleanups.push(clock.schedule((config.time - 60) * 1000, () => inBackground(async () => {
      if (!available(challenge) || challenge.settling || !challenge.deadline || clock.now() >= challenge.deadline) return;
      if (!(await settings(event.groupId))?.enabled || !await authorized(challenge) || !available(challenge) || challenge.settling) return;
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
      if (prior) remove(prior);
      remember(key, event.time);
      const challenge: Challenge = { event, controller: new AbortController(), messages: new Set(), cleanups: [], remaining: 0,
        settling: false, kickInFlight: false, queue: Promise.resolve() };
      challenges.set(key, challenge);
      const cancel = () => remove(challenge);
      for (const ending of new Set([event.signal, event.connection])) {
        ending.addEventListener("abort", cancel, { once: true });
        challenge.cleanups.push(() => ending.removeEventListener("abort", cancel));
      }
      if (config.delay) challenge.cleanups.push(clock.schedule(config.delay * 1000, () => inBackground(() => ask(challenge))));
      else inBackground(() => ask(challenge));
    },
    async leave(event) {
      if (!validIdentity(event) || !live(event)) return;
      if (event.dismissed || event.userId === event.botId) {
        if (id(event.time)) remember(groupScope(event), event.time);
        for (const challenge of challenges.values()) {
          if (challenge.event.botId === event.botId && challenge.event.groupId === event.groupId && sameConnection(challenge, event) &&
              (event.time === undefined || event.time >= challenge.event.time)) remove(challenge);
        }
        return;
      }
      const key = position(event);
      if (id(event.time)) remember(key, event.time);
      const challenge = challenges.get(key);
      if (!challenge || !sameConnection(challenge, event) || (event.time !== undefined && event.time < challenge.event.time)) return;
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
        if (await whitelisted(event.userId).catch(() => true)) { remove(challenge); return false; }
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
    const permission = "当前会话没有管理入群验证的权限。";
    if (stopped || signal.aborted || context.isDelegated || !session || !live(session) || !id(group) || !id(bot) || !id(user)) return permission;
    const authorize = async () => {
      try { return !stopped && !signal.aborted && live(session) && await context.groupManageBlacklist?.() === true && live(session); }
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
      const toggle = switchPattern.exec(text);
      if (toggle) {
        const enabled = toggle[1] === "开启";
        const changed = await store.setGroupVerification(group, enabled, AbortSignal.any([signal, session.signal, session.connection]), authorize);
        if (!enabled) for (const challenge of challenges.values()) if (challenge.event.groupId === group) remove(challenge);
        if (!changed) return enabled ? "❎ 本群验证已处于开启状态" : "❎ 本群暂未开启验证";
        return `✅ 已${toggle[1]}本群验证`;
      }
      const config = await settings(group);
      if (!config?.enabled) return "当前群未开启验证哦~";
      if (!await authorize()) return permission;
      const target = commandTarget(context.message, bypassPattern.exec(text)?.[1], bot);
      if (!target || target === bot) return "❎ 请输入正确的 QQ 号或艾特一位群成员";
      const challenge = challenges.get(position({ botId: bot, groupId: group, userId: target }));
      if (!challenge || !available(challenge) || challenge.event.adapter !== (context.adapter ?? "onebot") || challenge.event.connection !== session.connection || challenge.settling) {
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
