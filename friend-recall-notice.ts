import { formatNoticeBodyText } from "./message-notice-content.ts";
import type { PrivateNoticeOptions } from "./private-notice-config.ts";
import { createRecallRetention, formatRecallTime, positiveRecallId } from "./recall-notice.ts";

export type FriendRecallNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRecallNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly time: number;
  readonly text: string;
}
export interface FriendRecallNotice {
  retention(botId: number, signal?: AbortSignal): Promise<number | undefined>;
  format(input: FriendRecallNoticeInput, signal?: AbortSignal): Promise<readonly FriendRecallNoticePart[] | undefined>;
}

export const friendRecallNoticeFeature = "[group] 好友撤回通知";
export function createFriendRecallNotice(options: PrivateNoticeOptions): FriendRecallNotice {
  const readRetention = createRecallRetention(options, "PrivateRecall");
  const retention = (botId: number, signal?: AbortSignal) => readRetention(botId, undefined, signal);

  return {
    retention,
    async format({ botId, userId, time, text }, signal) {
      if (!positiveRecallId(userId) || botId === userId || typeof text !== "string") return;
      const when = formatRecallTime(time);
      if (!when) return;
      const content = formatNoticeBodyText(text);
      if (!content.trim() || await retention(botId, signal) === undefined || options.signal?.aborted || signal?.aborted) return;
      return [
        { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        `[消息(${botId}) - 好友撤回消息]\n`,
        `好友账号：${userId}\n`,
        `撤回时间：${when}\n`,
        "撤回消息：", content,
      ];
    },
  };
}
