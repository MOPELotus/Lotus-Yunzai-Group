import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendMessageNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendMessageNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly nickname?: string;
  readonly text: string;
  readonly canQuote?: boolean;
  readonly showHint?: boolean | (() => Promise<boolean>);
}
export type FriendMessageNotice = (message: FriendMessageNoticeInput, signal?: AbortSignal) =>
  Promise<readonly FriendMessageNoticePart[] | undefined>;

export const friendMessageNoticeFeature = "[group] 好友消息通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function messageText(value: string): string {
  const limit = 4096;
  const text = value.slice(0, limit * 2).replace(/\r\n?|[\u2028\u2029]/gu, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  return text.length > limit ? text.slice(0, limit - 1).toWellFormed() + "…" : text.toWellFormed();
}

export function createFriendMessageNotice(options: PrivateNoticeOptions): FriendMessageNotice {
  const isEnabled = createPrivateNoticeSettings(options, "privateMessage");
  return async ({ botId, userId, nickname, text, showHint, canQuote }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId || typeof text !== "string") return;
    const content = messageText(text);
    if (!content.trim() || !await isEnabled(botId, signal) || options.signal?.aborted || signal?.aborted) return;

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
      "消息内容：", content,
    ];
    if (includeHint) {
      const quoteHint = canQuote === true ? "引用该消息：回复 <内容>\n" : "";
      parts.push(`\n-------------\n${quoteHint}可发送：回复 ${userId} <内容>`);
    }
    return parts;
  };
}
