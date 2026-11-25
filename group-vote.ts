import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
const settingsHelp = $t("group-vote.text_e0950272ac") +
  $t("group-vote.text_b3757a54ea");
const unavailable = $t("group-vote.text_512ad5fa01");

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
  if (roles.protectedTarget) return $t("group-vote.text_32e7c7dffc");
  if (roles.target === "owner") return $t("group-vote.text_171a798bfa");
  if (roles.target === "admin" && (!allowAdmin || roles.bot !== "owner")) return $t("group-vote.text_51a4f02eda");
}

const active = (capability: GroupVoteCapability) => !capability.signal.aborted && !capability.connection.aborted;
const enabled = (settings: GroupVoteSettings, action: Action) => action === "mute" ? settings.VoteBan : settings.VoteKick;
const label = (action: Action) => action === "mute" ? $t("group-vote.text_f76935bcd9") : $t("group-vote.text_752d574779");
const at = (qq: number): GroupVotePart => ({ type: "at", qq });
const quoted = (message: string) => ({ type: "quoted", message } as const);
const voteInstructions = (target: number) => $t("group-vote.text_51d017efdc", { "target": target, "value2": target });
const count = (poll: Poll) => $t("group-vote.text_3ffd79f6b2", { "yes": poll.yes, "no": poll.no });

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
      if (!current || !enabled(current, poll.action)) return $t("group-vote.text_5aa496f083");
      const heading = voter ? $t("group-vote.text_d5bb8fdec8") : $t("group-vote.text_bdf8068cda", { "value1": count(poll) });
      if (!voter && (poll.yes <= poll.no || poll.yes < poll.settings.minNum)) {
        return heading + $t("group-vote.text_18c155b040", { "minNum": poll.settings.minNum });
      }
      if (voter && !current.veto) return $t("group-vote.text_055c598567");
      const authority = voter ?? poll.capability;
      let result: GroupVoteResult;
      try {
        result = active(authority) ? await authority.execute(poll.target, poll.action,
          poll.action === "mute" ? (voter ? current.BanTime : poll.settings.BanTime) : 0,
          poll.settings.voteAdmin && current.voteAdmin, voter !== undefined) : "unavailable";
      } catch { result = "unknown"; }
      if (!available(poll)) return;
      switch (result) {
        case "confirmed": return heading + $t("group-vote.text_7d571592ba", { "value1": label(poll.action), "target": poll.target });
        case "rejected": return heading + $t("group-vote.text_78e143627f", { "value1": label(poll.action) });
        case "unknown": return heading + $t("group-vote.text_e5fe024945");
        case "protected": return heading + $t("group-vote.text_ea554ce990");
        case "unavailable": return heading + $t("group-vote.text_b68fa22994");
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
      await announce(poll.capability, [at(poll.target), $t("group-vote.text_17013daf99", { "value1": label(poll.action), "value2": count(poll), "value3": voteInstructions(poll.target), "issuer": poll.issuer })]);
    })));
  }

  async function start(pollKey: string, target: number, user: number, action: Action, capability: GroupVoteCapability, settings: GroupVoteSettings) {
    if (polls.has(pollKey)) return $t("group-vote.text_112697e730");
    if (polls.size >= 256) return $t("group-vote.text_5a799d94fd");
    const poll: Poll = { key: pollKey, target, issuer: user, action, settings, capability, voters: new Set([user]), listeners: [], closing: false, yes: 1, no: 0 };
    polls.set(pollKey, poll);
    const cancel = () => remove(poll);
    for (const ending of new Set([capability.signal, capability.connection])) {
      ending.addEventListener("abort", cancel, { once: true });
      poll.listeners.push(() => ending.removeEventListener("abort", cancel));
    }
    const announcement: GroupVotePart[] = [at(target), $t("group-vote.text_60999611c6", { "target": target, "value2": label(action) }), at(user),
      $t("group-vote.text_5056520007", { "user": user, "value2": voteInstructions(target), "outTime": settings.outTime }),
      action === "mute" ? $t("group-vote.text_ba6d66092c", { "BanTime": settings.BanTime }) : $t("group-vote.text_69d9bf48b3"),
      $t("group-vote.text_3a40ae615f", { "minNum": settings.minNum }), ...(settings.veto ? [$t("group-vote.text_2d5a6f5390")] : [])];
    if (!await announce(capability, announcement, true) || !available(poll)) {
      remove(poll);
      return $t("group-vote.text_63bca11588");
    }
    startTimers(poll);
    return [] as const;
  }

  async function configure(toggle: RegExpExecArray | null, setting: RegExpExecArray | null, capability: GroupVoteCapability) {
    const authorize = async () => {
      try { return !stopped && !signal.aborted && active(capability) && await capability.canConfigure() === true && active(capability); }
      catch { return false; }
    };
    if (!await authorize()) return $t("group-vote.text_850233f5ba");
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
      if (next === undefined) return $t("group-vote.text_439a8df5aa");
    }
    if (settings[field] === next) return toggle ? $t("group-vote.text_fdbd691c31", { "value1": toggle[2], "value2": toggle[1] }) : $t("group-vote.text_749cb8aee9", { "value1": setting?.[1], "next": next });
    const activeSignal = AbortSignal.any([signal, capability.signal, capability.connection]);
    const changed = await store.setGroupVoteSetting(field, next, activeSignal, authorize);
    if (toggle && !next) {
      const action = field === "VoteBan" ? "mute" : "kick";
      for (const poll of polls.values()) if (poll.action === action) remove(poll);
    }
    if (!changed) return $t("group-vote.text_8373262f61");
    return toggle ? $t("group-vote.text_26d8b8eb01", { "value1": toggle[1], "value2": toggle[2] }) : $t("group-vote.text_d54c6721a5", { "value1": setting?.[1], "next": next });
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
      if (!target) return $t("group-vote.text_14d3bb0705");
      if (target === user) return $t("group-vote.text_d91eaddd9c");
      if (target === bot) return $t("group-vote.text_c7fe838c46");
      if (!claim(scope, user, message_id)) return [];
      const pollKey = JSON.stringify([scope, target]);
      const existing = polls.get(pollKey);
      const settings = await store.readGroupVoteSettings();
      if (stopped || !active(capability) || signal.aborted) return;
      if (initiate && existing && available(existing)) return $t("group-vote.text_112697e730");
      if (follow && (!existing || existing.capability.connection !== capability.connection || !available(existing))) return $t("group-vote.text_885b329f02");
      const action = existing?.action ?? (initiate?.[1] === "禁言" ? "mute" : "kick");
      if (!enabled(settings, action)) {
        if (existing) remove(existing);
        return $t("group-vote.text_ef700df3e9", { "value1": action === "mute" ? $t("group-vote.text_f76935bcd9") : $t("group-vote.text_7bff31095b") });
      }
      const roles = await capability.inspect(target).catch(() => undefined);
      if (stopped || !active(capability) || signal.aborted) return;
      const forbidden = targetAllowed(roles, (existing?.settings.voteAdmin ?? true) && settings.voteAdmin);
      if (forbidden) return forbidden;
      if (initiate) return await start(pollKey, target, user, action, capability, settings);
      if (!existing || !available(existing) || existing.closing || existing.deadline === undefined || clock.now() >= existing.deadline) return $t("group-vote.text_ffdf791c8e");
      const support = follow?.[1] === "支持";
      if (settings.veto && (roles?.actor === "admin" || roles?.actor === "owner")) {
        if (support) {
          const reply = await finish(existing, capability);
          return reply ? quoted(reply) : [];
        }
        remove(existing);
        return quoted($t("group-vote.text_6a87c96de2"));
      }
      if (existing.voters.has(user)) return $t("group-vote.text_e6a8acd2a9");
      if (existing.voters.size >= 10_000) return $t("group-vote.text_ddca42f1a9");
      existing.voters.add(user);
      if (support) existing.yes++;
      else existing.no++;
      return quoted($t("group-vote.text_8a68d0c6ad", { "yes": existing.yes, "no": existing.no }));
    } catch (error) {
      return error instanceof ManagedBlacklistPermissionError ? $t("group-vote.text_850233f5ba") : $t("group-vote.text_09625cec9f");
    }
  }

  function cancelAll() { for (const poll of polls.values()) remove(poll); }
  signal.addEventListener("abort", cancelAll, { once: true });
  return { command, async stop() { stopped = true; signal.removeEventListener("abort", cancelAll); cancelAll(); await Promise.allSettled(pending); } };
}
