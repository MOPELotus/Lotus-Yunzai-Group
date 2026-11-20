import { configuredPrivateNotice, createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";
import { displayRequestField } from "./group-pending-join.ts";

export type FriendRequestNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRequestNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly nickname?: string;
  readonly source?: string;
  readonly comment?: string;
  readonly autoResult?: "confirmed" | "rejected" | "unknown";
}
export type FriendRequestNoticeOptions = PrivateNoticeOptions;

export type FriendRequestNotice = (request: FriendRequestNoticeInput, signal?: AbortSignal) => Promise<readonly FriendRequestNoticePart[] | undefined>;

export const friendRequestNoticeFeature = "[group] 好友申请通知";

export function configuredFriendRequestNotice(value: unknown, botId: number): boolean {
  return configuredPrivateNotice(value, botId, "friendRequest");
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function status(result: FriendRequestNoticeInput["autoResult"]): string | undefined {
  switch (result) {
    case "confirmed": return "Tip：自动审批请求已获协议端确认。";
    case "rejected": return "Tip：协议端未接受自动审批，请在 QQ 中处理。";
    case "unknown": return "Tip：自动审批结果未确认，请先在 QQ 核对。";
  }
}

export function createFriendRequestNotice(options: FriendRequestNoticeOptions): FriendRequestNotice {
  const isEnabled = createPrivateNoticeSettings(options, "friendRequest");
  return async (request, signal) => {
    const { botId, userId, nickname, source, comment, autoResult } = request;
    if (!positiveId(botId) || !positiveId(userId) || botId === userId || !await isEnabled(botId, signal) ||
        options.signal?.aborted || signal?.aborted) return;

    const result = status(autoResult);
    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `[通知(${botId}) - 添加好友申请]\n`,
      `申请人账号：${userId}\n`,
      `申请人昵称：${displayRequestField(nickname, 128) || "未知"}\n`,
      `申请来源：${displayRequestField(source, 256) || "未知"}\n`,
      `附加信息：${displayRequestField(comment, 512) || "无附加信息"}\n`,
      ...(result ? [`${result}\n`] : []),
      "-------------\n可回复：#查看好友申请",
    ];
  };
}
