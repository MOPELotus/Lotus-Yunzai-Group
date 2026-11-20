import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendMessageNoticePart = string |
  { readonly type: "image"; readonly file: string | Uint8Array } |
  { readonly type: "face"; readonly data: { readonly id: string | number; readonly is_large?: boolean } };
export interface FriendMessageNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly nickname?: string;
  readonly text?: string;
  readonly readParts?: () => Promise<readonly FriendMessageNoticePart[] | undefined>;
  readonly canQuote?: boolean;
  readonly showHint?: boolean | (() => Promise<boolean>);
}
export type FriendMessageNotice = (message: FriendMessageNoticeInput, signal?: AbortSignal) =>
  Promise<readonly FriendMessageNoticePart[] | undefined>;

export const friendMessageNoticeFeature = "[group] 好友消息通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function formatNoticeBodyText(value: string): string {
  const limit = 4096;
  const text = value.slice(0, limit * 2).replace(/\r\n?|[\u2028\u2029]/gu, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  return text.length > limit ? text.slice(0, limit - 1).toWellFormed() + "…" : text.toWellFormed();
}

function faceId(value: unknown): boolean {
  if (typeof value === "string" && /^\d{1,16}$/u.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function verifiedParts(original: readonly FriendMessageNoticePart[] | undefined): FriendMessageNoticePart[] | undefined {
  if (!Array.isArray(original)) return;
  const parts: FriendMessageNoticePart[] = [];
  const source: readonly FriendMessageNoticePart[] = original;
  for (const part of source) {
    if (typeof part === "string") {
      parts.push(formatNoticeBodyText(part));
    } else if (part?.type === "image" && part.file instanceof Uint8Array && part.file.byteLength > 0) {
      parts.push({ type: "image", file: part.file });
    } else if (part?.type === "face" && part.data && faceId(part.data.id) &&
        (part.data.is_large === undefined || typeof part.data.is_large === "boolean")) {
      const { id, is_large } = part.data;
      parts.push({ type: "face", data: { id, ...(is_large !== undefined ? { is_large } : {}) } });
    } else return;
  }
  if (parts.some(part => typeof part !== "string" || part.trim())) return parts;
}

async function readVerifiedParts(readParts: NonNullable<FriendMessageNoticeInput["readParts"]>) {
  try { return verifiedParts(await readParts()); } catch { return; }
}

export function createFriendMessageNotice(options: PrivateNoticeOptions): FriendMessageNotice {
  const isEnabled = createPrivateNoticeSettings(options, "privateMessage");
  return async ({ botId, userId, nickname, text, readParts, showHint, canQuote }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId) return;
    const textOnly = !readParts && typeof text === "string" ? formatNoticeBodyText(text) : "";
    if ((!readParts && !textOnly.trim()) || !await isEnabled(botId, signal) || options.signal?.aborted || signal?.aborted) return;
    const content = readParts ? await readVerifiedParts(readParts) : [textOnly];
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
