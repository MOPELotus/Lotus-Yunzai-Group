import { groupVoteSetting, ManagedBlacklistPermissionError, type GroupVoteEditableSetting, type GroupVoteSettings, type ManagedBlacklistStore } from "./managed-blacklist.ts";

type Role = "member" | "admin" | "owner";
type Action = "mute" | "kick";
export type GroupVotePart = string | { readonly type: "at"; readonly qq: number };
export type GroupVoteResult = "confirmed" | "rejected" | "unknown" | "unavailable" | "protected";
type CommandReply = string | readonly [] | { readonly type: "quoted"; readonly message: string };
export interface GroupVoteRoles { readonly actor: Role; readonly bot: Role; readonly target: Role; readonly protectedTarget: boolean }

export interface GroupVoteCapability {
  readonly connection: AbortSignal;
  readonly signal: AbortSignal;
  inspect(target: number): Promise<GroupVoteRoles | undefined>;
  execute(target: number, action: Action, seconds: number, allowAdmin: boolean, requireActorAdmin?: boolean): Promise<GroupVoteResult>;
  canConfigure(): Promise<boolean>;
  reply(parts: readonly GroupVotePart[], quote?: boolean): Promise<boolean>;
}

export interface GroupVoteContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly adapter?: "onebot" | "milky";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_id?: number | string;
  readonly isDelegated?: boolean;
  readonly message?: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly groupVote?: GroupVoteCapability;
}

export const groupVoteFeature = "[group] 群投票";
const startPattern = /^#(?:发起)?投票(禁言|踢人)\s*(\d*)$/u;
const followPattern = /^#(支持|反对)投票\s*(\d*)$/u;
const togglePattern = /^#(启用|禁用)投票(禁言|踢人)$/u;
const settingsPattern = /^#?投票设置(超时时间|最低票数|禁言时间)?(\d*)$/u;
export const isGroupVoteCommand = (text: string) => [startPattern, followPattern, togglePattern, settingsPattern].some(pattern => pattern.test(text));

const settingsFields = { 超时时间: "outTime", 最低票数: "minNum", 禁言时间: "BanTime" } as const;
const settingsHelp = "#启用投票禁言 / #禁用投票禁言\n#启用投票踢人 / #禁用投票踢人\n" +
  "可设置超时时间（秒）、最低票数及禁言时间（秒），例如 #投票设置禁言时间8600。";
const unavailable = "当前会话无法确认本群投票权限。";

type Clock = { now(): number; schedule(milliseconds: number, callback: () => void): () => void };
const nativeClock: Clock = {
  now: () => performance.now(),
  schedule(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

interface Poll {
  readonly key: string;
  readonly target: number;
  readonly issuer: number;
  readonly action: Action;
  readonly settings: GroupVoteSettings;
  readonly capability: GroupVoteCapability;
  readonly voters: Set<number>;
  readonly listeners: (() => void)[];
  deadline?: number;
  closing: boolean;
  yes: number;
  no: number;
}

function id(value: unknown): number | undefined {
  const numeric = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0) return numeric;
}

function targetFrom(message: GroupVoteContext["message"], spelling: string | undefined, bot: number) {
  const mentions = new Set<number>();
  if (Array.isArray(message)) for (const part of message) {
    if (part.type !== "at" || String(part.qq) === String(bot)) continue;
    const target = id(part.qq);
    if (target === undefined) return;
    mentions.add(target);
  }
  if (mentions.size > 1) return;
  const explicit = spelling ? id(spelling) : undefined;
  if (spelling && explicit === undefined) return;
  const mention = mentions.values().next().value;
  if (mention && explicit && mention !== explicit) return;
  return mention ?? explicit;
}

function targetAllowed(roles: GroupVoteRoles | undefined, allowAdmin: boolean): string | undefined {
  if (!roles || roles.bot === "member") return unavailable;
  if (roles.protectedTarget) return "❎ 该命令对主人或机器人无效";
  if (roles.target === "owner") return "❎ 权限不足，该命令对群主无效";
  if (roles.target === "admin" && (!allowAdmin || roles.bot !== "owner")) return "❎ 该命令对管理员无效或机器人权限不足";
}

const active = (capability: GroupVoteCapability) => !capability.signal.aborted && !capability.connection.aborted;
const enabled = (settings: GroupVoteSettings, action: Action) => action === "mute" ? settings.VoteBan : settings.VoteKick;
const label = (action: Action) => action === "mute" ? "禁言" : "踢出";
const at = (qq: number): GroupVotePart => ({ type: "at", qq });
const quoted = (message: string) => ({ type: "quoted", message } as const);
const voteInstructions = (target: number) => `支持请发送 #支持投票${target}，反对请发送 #反对投票${target}`;
const count = (poll: Poll) => `支持票数：${poll.yes}\n反对票数：${poll.no}`;

export function createGroupVote(store: Pick<ManagedBlacklistStore, "readGroupVoteSettings" | "setGroupVoteSetting">, signal: AbortSignal, clock: Clock = nativeClock) {
  const polls = new Map<string, Poll>();
  const replays = new Set<string>();
  const pending = new Set<Promise<void>>();
  let stopped = false;

  function remove(poll: Poll) {
    if (polls.get(poll.key) === poll) polls.delete(poll.key);
    for (const dispose of poll.listeners.splice(0)) dispose();
  }

  function available(poll: Poll) { return !stopped && !signal.aborted && active(poll.capability) && polls.get(poll.key) === poll; }

  async function announce(capability: GroupVoteCapability, parts: readonly GroupVotePart[], quote = false): Promise<boolean> {
    if (stopped || signal.aborted || !active(capability)) return false;
    try { return await capability.reply(parts, quote) === true; } catch { return false; }
  }

  function inBackground(run: () => Promise<void>) {
    const work = run().catch(() => undefined);
    pending.add(work);
    void work.then(() => pending.delete(work));
  }

  function claim(scope: string, user: number, messageId: number | string | undefined): boolean {
    if (!(typeof messageId === "number" && Number.isSafeInteger(messageId)) &&
        !(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 128)) return false;
    const key = JSON.stringify([scope, user, String(messageId)]);
    if (replays.has(key)) return false;
    replays.add(key);
    if (replays.size > 4096) {
      const oldest = replays.values().next();
      if (!oldest.done) replays.delete(oldest.value);
    }
    return true;
  }

  async function finish(poll: Poll, voter?: GroupVoteCapability): Promise<string | undefined> {
    if (!available(poll) || poll.closing) return;
    poll.closing = true;
    try {
      const current = await store.readGroupVoteSettings().catch(() => undefined);
      if (!available(poll)) return;
      if (!current || !enabled(current, poll.action)) return "投票已取消，当前配置不允许这项操作。";
      const heading = voter ? "投票结束，管理员介入。" : `投票结束，投票结果：\n${count(poll)}\n`;
      if (!voter && (poll.yes <= poll.no || poll.yes < poll.settings.minNum)) {
        return heading + `赞成票未达到 ${poll.settings.minNum} 票或未超过反对票，投票失败。`;
      }
      if (voter && !current.veto) return "投票已结束，当前配置不允许管理员一票决定。";
      const authority = voter ?? poll.capability;
      let result: GroupVoteResult;
      try {
        result = active(authority) ? await authority.execute(poll.target, poll.action,
          poll.action === "mute" ? (voter ? current.BanTime : poll.settings.BanTime) : 0,
          poll.settings.voteAdmin && current.voteAdmin, voter !== undefined) : "unavailable";
      } catch { result = "unknown"; }
      if (!available(poll)) return;
      switch (result) {
        case "confirmed": return heading + `已${label(poll.action)}目标 ${poll.target}。`;
        case "rejected": return heading + `协议端拒绝${label(poll.action)}目标。`;
        case "unknown": return heading + "操作结果未确认，请先在 QQ 核对。";
        case "protected": return heading + "目标受到保护，无法执行。";
        case "unavailable": return heading + "当前会话无法执行投票结果。";
      }
    } finally { remove(poll); }
  }

  function startTimers(poll: Poll) {
    const milliseconds = poll.settings.outTime * 1000;
    poll.deadline = clock.now() + milliseconds;
    poll.listeners.push(clock.schedule(milliseconds, () => inBackground(async () => {
      const reply = await finish(poll);
      if (reply) await announce(poll.capability, [reply], true);
    })));
    if (milliseconds > 60_000) poll.listeners.push(clock.schedule(milliseconds - 60_000, () => inBackground(async () => {
      if (!available(poll) || poll.closing) return;
      const current = await store.readGroupVoteSettings().catch(() => undefined);
      if (!available(poll) || poll.closing) return;
      if (!current || !enabled(current, poll.action)) { remove(poll); return; }
      await announce(poll.capability, [at(poll.target), ` 的${label(poll.action)}投票仅剩一分钟\n${count(poll)}\n${voteInstructions(poll.target)}\n发起人 ${poll.issuer}`]);
    })));
  }

  async function start(pollKey: string, target: number, user: number, action: Action, capability: GroupVoteCapability, settings: GroupVoteSettings) {
    if (polls.has(pollKey)) return "❎ 已有相同投票，请勿重复发起";
    if (polls.size >= 256) return "当前活跃投票过多，请稍后再发起。";
    const poll: Poll = { key: pollKey, target, issuer: user, action, settings, capability, voters: new Set([user]), listeners: [], closing: false, yes: 1, no: 0 };
    polls.set(pollKey, poll);
    const cancel = () => remove(poll);
    for (const ending of new Set([capability.signal, capability.connection])) {
      ending.addEventListener("abort", cancel, { once: true });
      poll.listeners.push(() => ending.removeEventListener("abort", cancel));
    }
    const announcement: GroupVotePart[] = [at(target), `(${target})的${label(action)}投票已发起\n发起人 `, at(user),
      `(${user})\n${voteInstructions(target)}\n超时时间 ${settings.outTime} 秒\n`,
      action === "mute" ? `禁言时间 ${settings.BanTime} 秒\n` : "投票通过后将移出群聊\n",
      `赞成票需超过反对票且至少 ${settings.minNum} 票`, ...(settings.veto ? ["\n管理员拥有一票决定权"] : [])];
    if (!await announce(capability, announcement, true) || !available(poll)) {
      remove(poll);
      return "投票通知未获确认，未启动计票。";
    }
    startTimers(poll);
    return [] as const;
  }

  async function configure(toggle: RegExpExecArray | null, setting: RegExpExecArray | null, capability: GroupVoteCapability) {
    const authorize = async () => {
      try { return !stopped && !signal.aborted && active(capability) && await capability.canConfigure() === true && active(capability); }
      catch { return false; }
    };
    if (!await authorize()) return "当前会话没有设置群投票的权限。";
    const settings = await store.readGroupVoteSettings();
    let field: GroupVoteEditableSetting;
    let next: number | boolean | undefined;
    if (toggle) {
      field = toggle[2] === "禁言" ? "VoteBan" : "VoteKick";
      next = toggle[1] === "启用";
    } else {
      const name = setting?.[1] as keyof typeof settingsFields | undefined;
      if (!name || !setting?.[2]) return settingsHelp;
      field = settingsFields[name];
      next = groupVoteSetting(field, setting[2]);
      if (next === undefined) return "请输入有效的投票设置正整数。";
    }
    if (settings[field] === next) return toggle ? `❎ 投票${toggle[2]}功能已处于${toggle[1]}状态` : `❎ 当前${setting?.[1]}已经是${next}了`;
    const activeSignal = AbortSignal.any([signal, capability.signal, capability.connection]);
    const changed = await store.setGroupVoteSetting(field, next, activeSignal, authorize);
    if (toggle && !next) {
      const action = field === "VoteBan" ? "mute" : "kick";
      for (const poll of polls.values()) if (poll.action === action) remove(poll);
    }
    if (!changed) return "群投票配置已是该设置。";
    return toggle ? `✅ 已${toggle[1]}投票${toggle[2]}功能` : `✅ 已把${setting?.[1]}设置成${next}了`;
  }

  async function command(text: string, context: GroupVoteContext): Promise<CommandReply | undefined> {
    if (context.message_type !== "group" || !isGroupVoteCommand(text)) return;
    const { groupVote: capability, message, message_id } = context;
    const bot = id(context.self_id), group = id(context.group_id), user = id(context.user_id);
    if (stopped || !capability || !active(capability) || signal.aborted || context.isDelegated || !bot || !group || !user || user === bot) return unavailable;
    const scope = JSON.stringify([context.adapter ?? "onebot", bot, group]);
    const initiate = startPattern.exec(text), follow = followPattern.exec(text), toggle = togglePattern.exec(text), setting = settingsPattern.exec(text);
    try {
      if (toggle || setting) {
        if (!claim(scope, user, message_id)) return [];
        return await configure(toggle, setting, capability);
      }
      const target = targetFrom(message, (initiate ?? follow)?.[2], bot);
      if (!target) return "❎ 请艾特或输入一位被投票人的 QQ";
      if (target === user) return "❎ 您不能对自己进行投票";
      if (target === bot) return "❎ 该命令对机器人无效";
      if (!claim(scope, user, message_id)) return [];
      const pollKey = JSON.stringify([scope, target]);
      const existing = polls.get(pollKey);
      const settings = await store.readGroupVoteSettings();
      if (stopped || !active(capability) || signal.aborted) return;
      if (initiate && existing && available(existing)) return "❎ 已有相同投票，请勿重复发起";
      if (follow && (!existing || existing.capability.connection !== capability.connection || !available(existing))) return "❎ 未找到对应投票";
      const action = existing?.action ?? (initiate?.[1] === "禁言" ? "mute" : "kick");
      if (!enabled(settings, action)) {
        if (existing) remove(existing);
        return `❎ 该功能已被禁用，请发送 #启用投票${action === "mute" ? "禁言" : "踢人"} 来启用该功能。`;
      }
      const roles = await capability.inspect(target).catch(() => undefined);
      if (stopped || !active(capability) || signal.aborted) return;
      const forbidden = targetAllowed(roles, (existing?.settings.voteAdmin ?? true) && settings.voteAdmin);
      if (forbidden) return forbidden;
      if (initiate) return await start(pollKey, target, user, action, capability, settings);
      if (!existing || !available(existing) || existing.closing || existing.deadline === undefined || clock.now() >= existing.deadline) return "❎ 未找到正在计票的投票";
      const support = follow?.[1] === "支持";
      if (settings.veto && (roles?.actor === "admin" || roles?.actor === "owner")) {
        if (support) {
          const reply = await finish(existing, capability);
          return reply ? quoted(reply) : [];
        }
        remove(existing);
        return quoted("投票取消，管理员介入。");
      }
      if (existing.voters.has(user)) return "❎ 你已参与过投票，请勿重复参与";
      if (existing.voters.size >= 10_000) return "群投票参与人数已达上限。";
      existing.voters.add(user);
      if (support) existing.yes++;
      else existing.no++;
      return quoted(`投票成功，当前票数\n支持：${existing.yes} 反对：${existing.no}`);
    } catch (error) {
      return error instanceof ManagedBlacklistPermissionError ? "当前会话没有设置群投票的权限。" : "群投票暂不可用。";
    }
  }

  function cancelAll() { for (const poll of polls.values()) remove(poll); }
  signal.addEventListener("abort", cancelAll, { once: true });
  return { command, async stop() { stopped = true; signal.removeEventListener("abort", cancelAll); cancelAll(); await Promise.allSettled(pending); } };
}
