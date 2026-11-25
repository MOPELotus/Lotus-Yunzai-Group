import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { formatNoticeBodyText, readMessageNoticeParts, type MessageNoticePart, type ReadMessageNoticeParts } from "./message-notice-content.ts";
import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendMessageNoticePart = MessageNoticePart;
export interface FriendMessageNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly nickname?: string;
  readonly text?: string;
  readonly readParts?: ReadMessageNoticeParts;
  readonly canQuote?: boolean;
  readonly showHint?: boolean | (() => Promise<boolean>);
}
export type FriendMessageNotice = (message: FriendMessageNoticeInput, signal?: AbortSignal) =>
  Promise<readonly FriendMessageNoticePart[] | undefined>;

export const friendMessageNoticeFeature = "[group] 好友消息通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createFriendMessageNotice(options: PrivateNoticeOptions): FriendMessageNotice {
  const isEnabled = createPrivateNoticeSettings(options, "privateMessage");
  return async ({ botId, userId, nickname, text, readParts, showHint, canQuote }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId) return;
    const textOnly = !readParts && typeof text === "string" ? formatNoticeBodyText(text) : "";
    if ((!readParts && !textOnly.trim()) || !await isEnabled(botId, signal) || options.signal?.aborted || signal?.aborted) return;
    const content = readParts ? await readMessageNoticeParts(readParts) : [textOnly];
    if (!content || options.signal?.aborted || signal?.aborted) return;

    let includeHint = showHint === true;
    if (typeof showHint === "function") {
      try { includeHint = await showHint() === true; } catch { /* The notice can still be delivered without a hint. */ }
    }
    if (options.signal?.aborted || signal?.aborted) return;

    const parts: FriendMessageNoticePart[] = [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      $t("friend-message-notice.text_75c5a94f41", { "botId": botId }),
      $t("friend-message-notice.text_36000fb53f", { "userId": userId }),
      $t("friend-message-notice.text_7b0771ce1d", { "value1": displayRequestField(nickname, 128) || $t("friend-message-notice.text_4d8c1c5b42") }),
      $t("friend-message-notice.text_34c8fc816b"), ...content,
    ];
    if (includeHint) {
      const quoteHint = canQuote === true ? $t("friend-message-notice.text_842e677d46") : "";
      parts.push($t("friend-message-notice.text_8a28439754", { "quoteHint": quoteHint, "userId": userId }));
    }
    return parts;
  };
}
