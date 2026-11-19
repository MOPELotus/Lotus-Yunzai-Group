import { parseGroupInteger } from "./group-mute.ts";
import type { GroupKickResult } from "./group-mute.ts";
import { readManagedWhitelist } from "./managed-blacklist.ts";

export interface GroupActivityMember {
  readonly userId: number;
  readonly joinTime: number;
  readonly lastSentTime: number;
  readonly role: "member" | "admin" | "owner";
  readonly name?: string;
}

export type GroupActivityVisibility = "management" | "member";

export interface GroupActivityContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly isDelegated?: boolean;
  readonly normalizedMessage: string;
  readonly groupActivityRoster?: (visibility?: GroupActivityVisibility) => Promise<readonly GroupActivityMember[] | undefined>;
  readonly groupActivitySignal?: AbortSignal;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupKick?: (userId: number, block: boolean) => Promise<GroupKickResult>;
  readonly isBotMaster?: (userId: number) => boolean;
}

export const groupActivityFeature = "[group] 从未发言成员";
export const groupActivityRankFeature = "[group] 群成员活动排行";
const commandPattern = /^#查看从未发言过?的人(?:第([零一壹二两三四五六七八九十百千万亿\d]+)页)?$/u;
const rankPattern = /^#(?:查看|获取)?(不活跃排行榜|潜水排行榜|最近的?入群(?:情况|记录))([零一壹二两三四五六七八九十百千万亿\d]+)?$/u;
const cleanupPattern = /^#清理从未发言过?的人$/u;
const responsePattern = /^#?(确认|取消)清理$/u;
const pageSize = 30;
const unavailable = "当前无法读取完整的群成员发言数据，请核对群管理权限和协议端支持。";
const maxDateTimestamp = 8_640_000_000_000;

type Entry = string | { readonly type: "image"; readonly file: string };
type ActivityReply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Entry[])[] };

export function isGroupActivityCommand(message: string): boolean { return commandPattern.test(message); }
export function isGroupActivityRankCommand(message: string): boolean { return rankPattern.test(message); }
export function isGroupActivityCleanupCommand(message: string): boolean { return cleanupPattern.test(message) || responsePattern.test(message); }

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

function verifiedMembers(members: readonly GroupActivityMember[], bot: number): boolean {
  if (!Array.isArray(members)) return false;
  const identities = new Set<number>();
  for (const entry of members) {
    if (!entry || !positive(entry.userId) || identities.has(entry.userId) || !positive(entry.joinTime) ||
        entry.joinTime > maxDateTimestamp || !Number.isSafeInteger(entry.lastSentTime) || entry.lastSentTime < 0 ||
        entry.lastSentTime > maxDateTimestamp || !["member", "admin", "owner"].includes(entry.role)) return false;
    identities.add(entry.userId);
  }
  return identities.has(bot);
}

function formattedDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function memberAvatar(userId: number): Entry {
  return { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` };
}

function memberLabel({ userId, name }: GroupActivityMember): string {
  const nickname = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 128).toWellFormed() : "";
  return `\nQQ：${userId}\n昵称：${nickname || userId}\n`;
}

async function readRoster(context: GroupActivityContext, bot: number, visibility?: GroupActivityVisibility): Promise<readonly GroupActivityMember[] | undefined> {
  try {
    const roster = await context.groupActivityRoster?.(visibility);
    if (roster && verifiedMembers(roster, bot)) return roster;
  } catch { return; }
}

async function readMembers(context: GroupActivityContext, bot: number): Promise<GroupActivityMember[] | undefined> {
  const roster = await readRoster(context, bot);
  return roster?.filter((entry) => entry.userId !== bot && entry.role === "member" && entry.joinTime === entry.lastSentTime)
    .sort((left, right) => left.joinTime - right.joinTime);
}

function activityRanking(roster: readonly GroupActivityMember[], recent: boolean, count: number): ActivityReply {
  const sorted = [...roster].sort(recent
    ? (left, right) => right.joinTime - left.joinTime
    : (left, right) => left.lastSentTime - right.lastSentTime).slice(0, count);
  const nodes: Entry[][] = [[recent ? `最近的${sorted.length}条入群记录` : `不活跃排行榜top1 - top${sorted.length}`]];
  const perNode = Math.max(1, Math.ceil(sorted.length / 99));
  for (let start = 0; start < sorted.length; start += perNode) {
    const node: Entry[] = [];
    for (const [index, entry] of sorted.slice(start, start + perNode).entries()) {
      if (node.length) node.push("\n\n");
      if (!recent) node.push(`第${start + index + 1}名：\n`);
      node.push(memberAvatar(entry.userId), memberLabel(entry));
      if (recent) node.push(`入群时间：${formattedDate(entry.joinTime)}\n`);
      node.push(`最后发言时间：${entry.lastSentTime === 0 ? "未记录" : formattedDate(entry.lastSentTime)}`);
    }
    nodes.push(node);
  }
  return { type: "forward", nodes };
}

export async function groupActivityCommand(context: GroupActivityContext, signal?: AbortSignal): Promise<ActivityReply | undefined> {
  const command = context.normalizedMessage.trim();
  const match = commandPattern.exec(command), rank = rankPattern.exec(command);
  if ((!match && !rank) || context.message_type !== "group" || context.isDelegated || signal?.aborted || context.groupActivitySignal?.aborted ||
      !positive(context.group_id) || !positive(context.user_id) || !positive(context.self_id)) return;
  if (rank) {
    const count = rank[2] === undefined ? 10 : parseGroupInteger(rank[2]);
    if (!count) return "请输入有效的成员数量。";
    const roster = await readRoster(context, context.self_id, "member");
    if (signal?.aborted || context.groupActivitySignal?.aborted) return;
    if (!roster) return "当前无法读取完整的群成员发言数据，请核对当前群会话和协议端支持。";
    return activityRanking(roster, rank[1]?.startsWith("最近") === true, count);
  }
  if (!match) return;
  const page = match[1] === undefined ? 1 : parseGroupInteger(match[1]);
  if (!page) return "请输入有效页码。";
  const members = await readMembers(context, context.self_id);
  if (signal?.aborted) return;
  if (!members) return unavailable;
  if (!members.length) return "本群暂无从未发言的成员。";
  const pages = Math.ceil(members.length / pageSize);
  if (page > pages) return `没有第 ${page} 页。本群共 ${pages} 页。`;
  const shown = members.slice((page - 1) * pageSize, page * pageSize);
  const nodes: Entry[][] = [[
    "以下为进群后从未发言过的人\n",
    `当前为第 ${page} 页，共 ${pages} 页，本页共 ${shown.length} 人，总共 ${members.length} 人。`,
  ]];
  if (page < pages) nodes[0]!.push(`\n可用「#查看从未发言过的人第${page + 1}页」翻页。`);
  for (const entry of shown) {
    nodes.push([memberAvatar(entry.userId), `${memberLabel(entry)}进群时间：${formattedDate(entry.joinTime)}`]);
  }
  return { type: "forward", nodes };
}

interface PendingCleanup {
  readonly members: ReadonlyMap<number, number>;
  readonly expires: number;
  readonly signal: AbortSignal;
}

function cleanupResult(outcomes: ReadonlyMap<GroupKickResult | "skipped", readonly number[]>): ActivityReply {
  const nodes: Entry[][] = [["以下为每次清理的结果"]];
  const total = [...outcomes.values()].reduce((count, ids) => count + ids.length, 0);
  const perNode = Math.max(40, Math.ceil(total / 94));
  for (const [outcome, label] of [["confirmed", "成功清理如下人员"], ["rejected", "协议端拒绝清理"],
    ["unknown", "清理结果未确认，请在群内核对"], ["protected", "以下成员受保护"],
    ["unavailable", "以下成员未能清理，请核对群管理权限"], ["skipped", "以下成员已不符合首次确认条件，已跳过"]] as const) {
    const ids = outcomes.get(outcome);
    if (!ids?.length) continue;
    for (let start = 0; start < ids.length; start += perNode) {
      nodes.push([`${label}\n${ids.slice(start, start + perNode).map((id, index) => `${start + index + 1}、${id}`).join("\n")}`]);
    }
  }
  return { type: "forward", nodes };
}

export function createGroupActivityCleanup(root: URL, signal: AbortSignal, now: () => number = () => performance.now()) {
  const pending = new Map<string, PendingCleanup>();
  const preparing = new Set<string>();
  const seen = new Set<string>();
  const busy = new Set<number>();
  signal.addEventListener("abort", () => pending.clear(), { once: true });

  function claim(scope: string, messageId: number | string | undefined): boolean {
    if (!(typeof messageId === "number" && Number.isSafeInteger(messageId)) &&
        !(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 128)) return false;
    const key = JSON.stringify([scope, String(messageId)]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 2048) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  return async (context: GroupActivityContext): Promise<ActivityReply | readonly [] | undefined> => {
    const text = context.normalizedMessage.trim();
    const preview = cleanupPattern.test(text), response = responsePattern.exec(text);
    const { group_id, self_id, user_id, adapter, message_id, groupActivitySignal, groupKick } = context;
    if ((!preview && !response) || context.message_type !== "group" || signal.aborted || context.isDelegated ||
        !groupActivitySignal || groupActivitySignal.aborted || !positive(group_id) || !positive(self_id) || !positive(user_id)) return;
    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id]);
    const time = now();
    for (const [scope, request] of pending) {
      if (request.expires <= time || request.signal.aborted) pending.delete(scope);
    }
    const current = pending.get(key);
    if (response && current?.signal !== groupActivitySignal) return;
    if (!claim(key, message_id)) return [];
    if (response?.[1] === "取消") {
      pending.delete(key);
      return "已取消清理。";
    }
    if (busy.has(group_id)) return "本群已有清理正在执行，请等待结果。";

    const active = () => !signal.aborted && !groupActivitySignal.aborted;
    const authorized = async () => {
      try { return !!groupKick && active() && await context.groupManageBlacklist?.() === true && active(); }
      catch { return false; }
    };
    const protectedId = (id: number, whitelist: ReadonlySet<number>) => id === user_id || context.isBotMaster?.(id) || whitelist.has(id);
    const denied = "当前会话没有清理群成员的权限。";

    if (preview) {
      if (preparing.has(key)) return "正在核对从未发言的成员，请稍候。";
      pending.delete(key);
      preparing.add(key);
      try {
        if (!await authorized()) return denied;
        const members = await readMembers(context, self_id);
        if (!members || !active()) return unavailable;
        let whitelist: ReadonlySet<number>;
        try { whitelist = await readManagedWhitelist(root); } catch { return "群管白名单暂不可用。"; }
        if (!active()) return;
        const selected = new Map(members.filter(({ userId }) => !protectedId(userId, whitelist))
          .map(({ userId, joinTime }) => [userId, joinTime]));
        if (!selected.size) return "本群暂无符合清理条件的从未发言成员。";
        if (pending.size >= 128) {
          const first = pending.keys().next();
          if (!first.done) pending.delete(first.value);
        }
        pending.set(key, { members: selected, expires: now() + 120_000, signal: groupActivitySignal });
        return `本次共需清理 ${selected.size} 人。请在 120 秒内发送「#确认清理」开始清理，或发送「#取消清理」。`;
      } finally {
        preparing.delete(key);
      }
    }

    if (!current) return;
    pending.delete(key);
    if (!groupKick) return denied;
    busy.add(group_id);
    try {
      if (!await authorized()) return denied;
      const members = await readMembers(context, self_id);
      if (!members || !active()) return unavailable;
      if (!await authorized()) return denied;
      const stillEligible = new Map(members.map(({ userId, joinTime }) => [userId, joinTime]));
      const outcomes = new Map<GroupKickResult | "skipped", number[]>();
      for (const [id, joined] of current.members) {
        let result: GroupKickResult | "skipped" = "skipped";
        if (active() && stillEligible.get(id) === joined) {
          try {
            const whitelist = await readManagedWhitelist(root);
            if (protectedId(id, whitelist)) result = "protected";
            else if (active()) {
              try { result = await groupKick(id, false); } catch { result = "unknown"; }
            }
          } catch { result = "unavailable"; }
        }
        const ids = outcomes.get(result);
        if (ids) ids.push(id);
        else outcomes.set(result, [id]);
      }
      return cleanupResult(outcomes);
    } finally { busy.delete(group_id); }
  };
}
