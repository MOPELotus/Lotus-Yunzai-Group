import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendPokeNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendPokeNoticeInput {
  readonly botId: number;
  readonly userId: number;
}
export type FriendPokeNotice = (event: FriendPokeNoticeInput, signal?: AbortSignal) =>
  Promise<readonly FriendPokeNoticePart[] | undefined>;

export const friendPokeNoticeFeature = "[group] 好友戳一戳通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createFriendPokeNotice(options: PrivateNoticeOptions): FriendPokeNotice {
  const isEnabled = createPrivateNoticeSettings(options, "privateMessage");
  return async ({ botId, userId }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId ||
        !await isEnabled(botId, signal) || options.signal?.aborted || signal?.aborted) return;

    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `[消息(${botId}) - 戳一戳]\n`,
      `来源账号：${userId}`,
    ];
  };
}
