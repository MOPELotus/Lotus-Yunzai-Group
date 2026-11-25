import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import type { MessageNoticePart } from "./message-notice-content.ts";
import type { PrivateNoticeOptions } from "./private-notice-config.ts";
import { createRecallRetention, formatRecallBody, formatRecallTime, positiveRecallId, type RecallNoticeBodyPart } from "./recall-notice.ts";

export type FriendRecallNoticePart = RecallNoticeBodyPart | { readonly type: "image"; readonly file: string };
export interface FriendRecallNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly time: number;
  readonly text: string;
  readonly parts?: readonly MessageNoticePart[];
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
    async format({ botId, userId, time, text, parts }, signal) {
      if (!positiveRecallId(userId) || botId === userId || typeof text !== "string") return;
      const when = formatRecallTime(time);
      if (!when) return;
      const content = formatRecallBody(text, parts);
      if (!content || await retention(botId, signal) === undefined || options.signal?.aborted || signal?.aborted) return;
      return [
        { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        $t("friend-recall-notice.text_56e16f2899", { "botId": botId }),
        $t("friend-recall-notice.text_36000fb53f", { "userId": userId }),
        $t("friend-recall-notice.text_60d3b54396", { "when": when }),
        $t("friend-recall-notice.text_f45b01a9e9"), ...(content.parts ?? [content.text]),
      ];
    },
  };
}
