import { displayRequestField } from "./group-pending-join.ts";

export interface PendingFriendRequest {
  readonly userId: number;
  readonly nickname?: string;
  readonly source?: string;
  readonly time?: number;
  readonly comment?: string;
  readonly risk?: boolean;
}

export interface PendingFriendRequests {
  readonly entries: readonly PendingFriendRequest[];
  readonly complete: boolean;
}

export interface FriendRequestListContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly isDelegated?: boolean;
  readonly isBotMaster: (userId: number) => boolean;
  readonly listPendingFriendRequests?: () => Promise<PendingFriendRequests | undefined>;
}

type Part = string | { readonly type: "image"; readonly file: string };
type Reply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Part[])[] };

export const friendRequestListFeature = "[group] 好友申请列表";
const lookup = /^#?查看(?:全部)?好友申请$/u;
const maxShown = 50;
const unavailable = "当前无法核验该机器人的好友申请，请在 QQ 中查看。";
const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function isFriendRequestListCommand(command: string): boolean {
  return lookup.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requestTime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000) return "未知";
  return `${shanghaiTime.format(seconds * 1000)}（北京时间）`;
}

export async function friendRequestListCommand(command: string, context: FriendRequestListContext, signal?: AbortSignal): Promise<Reply | undefined> {
  if (context.message_type !== "private" || context.isDelegated || signal?.aborted || !isFriendRequestListCommand(command)) return;
  const { self_id, user_id, isBotMaster, listPendingFriendRequests } = context;
  if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "请由当前机器人的主人私聊查看好友申请。";
  if (!listPendingFriendRequests) return unavailable;

  try {
    const result = await listPendingFriendRequests();
    if (signal?.aborted || !isBotMaster(user_id)) return;
    if (!result || !Array.isArray(result.entries) || typeof result.complete !== "boolean" ||
        result.entries.some(entry => !entry || !positiveId(entry.userId))) return unavailable;

    const { complete } = result;
    const entries: readonly PendingFriendRequest[] = result.entries;
    if (!entries.length) {
      return complete ? "暂无好友申请(。-ω-)zzz" : "本次查询范围内未发现待处理的好友申请，未能核验完整列表，请在 QQ 中查看。";
    }
    const shown = entries.slice(0, maxShown);
    const heading = complete ? `现有未处理的好友申请如下，共 ${entries.length} 条` :
      `本次查到 ${entries.length} 条待处理好友申请，未能核验完整列表`;
    const summary = [
      heading,
      ...(shown.length < entries.length ? [`\n仅展示前 ${shown.length} 条，请在 QQ 中查看其余申请。`] : []),
    ];
    const nodes = shown.map(({ userId, nickname, source, time, comment, risk }): Part[] => [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `\n申请人QQ：${userId}\n申请人昵称：${displayRequestField(nickname, 128) || "未知"}` +
      `\n申请来源：${displayRequestField(source, 256) || "未知"}\n申请时间：${requestTime(time)}` +
      `\n附加信息：${displayRequestField(comment, 512) || "无附加信息"}` +
      (risk === true ? "\n风险申请，请在 QQ 中查看。" : risk === false ? "\n普通申请" : ""),
    ]);
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}
