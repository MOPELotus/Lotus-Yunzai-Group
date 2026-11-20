import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendRelationshipNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRelationshipNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly kind: "increase" | "decrease";
  readonly nickname?: string;
}
export type FriendRelationshipNotice = (event: FriendRelationshipNoticeInput, signal?: AbortSignal) =>
  Promise<readonly FriendRelationshipNoticePart[] | undefined>;

export const friendRelationshipNoticeFeature = "[group] 好友增减通知";
const titles = { increase: "新增好友", decrease: "好友减少" } as const;

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createFriendRelationshipNotice(options: PrivateNoticeOptions): FriendRelationshipNotice {
  const isEnabled = createPrivateNoticeSettings(options, "friendNumberChange");
  return async ({ botId, userId, kind, nickname }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId || !Object.hasOwn(titles, kind) ||
        !await isEnabled(botId, signal) || options.signal?.aborted || signal?.aborted) return;

    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `[通知(${botId}) - ${titles[kind]}]\n`,
      `好友账号：${userId}\n`,
      `好友昵称：${displayRequestField(nickname, 128) || "未知"}`,
    ];
  };
}
