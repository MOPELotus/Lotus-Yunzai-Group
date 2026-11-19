import { parseGroupInteger } from "./group-mute.ts";

export interface GroupActivityMember {
  readonly userId: number;
  readonly joinTime: number;
  readonly lastSentTime: number;
  readonly role: "member" | "admin" | "owner";
  readonly name?: string;
}

export interface GroupActivityContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly isDelegated?: boolean;
  readonly normalizedMessage: string;
  readonly groupActivityRoster?: () => Promise<readonly GroupActivityMember[] | undefined>;
}

export const groupActivityFeature = "[group] 从未发言成员";
const commandPattern = /^#查看从未发言过?的人(?:第([零一壹二两三四五六七八九十百千万亿\d]+)页)?$/u;
const pageSize = 30;
const unavailable = "当前无法读取完整的群成员发言数据，请核对群管理权限和协议端支持。";
const maxDateTimestamp = 8_640_000_000_000;

type Entry = string | { readonly type: "image"; readonly file: string };
type ActivityReply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Entry[])[] };

export function isGroupActivityCommand(message: string): boolean { return commandPattern.test(message); }

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

function selectMembers(members: readonly GroupActivityMember[], bot: number): GroupActivityMember[] | undefined {
  if (!Array.isArray(members)) return;
  const identities = new Set<number>();
  const selected: GroupActivityMember[] = [];
  for (const entry of members) {
    if (!entry || !positive(entry.userId) || identities.has(entry.userId) || !positive(entry.joinTime) ||
        entry.joinTime > maxDateTimestamp || !Number.isSafeInteger(entry.lastSentTime) || entry.lastSentTime < 0 ||
        entry.lastSentTime > maxDateTimestamp || !["member", "admin", "owner"].includes(entry.role)) return;
    identities.add(entry.userId);
    if (entry.userId !== bot && entry.role === "member" && entry.joinTime === entry.lastSentTime) selected.push(entry);
  }
  return identities.has(bot) ? selected.sort((left, right) => left.joinTime - right.joinTime) : undefined;
}

function formattedDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function groupActivityCommand(context: GroupActivityContext, signal?: AbortSignal): Promise<ActivityReply | undefined> {
  const match = commandPattern.exec(context.normalizedMessage.trim());
  if (!match || context.message_type !== "group" || context.isDelegated || signal?.aborted ||
      !positive(context.group_id) || !positive(context.user_id) || !positive(context.self_id)) return;
  const page = match[1] === undefined ? 1 : parseGroupInteger(match[1]);
  if (!page) return "请输入有效页码。";
  let roster: readonly GroupActivityMember[] | undefined;
  try { roster = await context.groupActivityRoster?.(); } catch { return unavailable; }
  if (signal?.aborted) return;
  const members = roster && selectMembers(roster, context.self_id);
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
  for (const { userId, name, joinTime } of shown) {
    const nickname = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 128).toWellFormed() : "";
    nodes.push([
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `\nQQ：${userId}\n昵称：${nickname || userId}\n进群时间：${formattedDate(joinTime)}`,
    ]);
  }
  return { type: "forward", nodes };
}
