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
      `[消息(${botId}) - 好友消息]\n`,
      `好友账号：${userId}\n`,
      `好友昵称：${displayRequestField(nickname, 128) || "未知"}\n`,
      "消息内容：", ...content,
    ];
    if (includeHint) {
      const quoteHint = canQuote === true ? "引用该消息：回复 <内容>\n" : "";
      parts.push(`\n-------------\n${quoteHint}可发送：回复 ${userId} <内容>`);
    }
    return parts;
  };
}
