import type { FriendRequestReviewContext } from "./friend-request-review.ts";

export type OwnerFriendReplyResult = "confirmed" | "rejected" | "unknown" | "not-friend" | "unavailable";

export interface OwnerFriendReplyContext extends Pick<FriendRequestReviewContext,
  "message_type" | "self_id" | "user_id" | "isDelegated" | "isBotMaster" | "adapter" | "message_id"> {
  readonly message?: string | readonly { readonly type: string }[];
  readonly reply_id?: number | string;
  readonly sendOwnerFriendReply?: (userId: number, text: string) => Promise<OwnerFriendReplyResult>;
}

export const ownerFriendReplyFeature = "[group] 主人回复好友";
const direct = /^#?回复[ \t]*(\d+)(?:[ \t]+([\s\S]*))?$/u;
const unavailable = "当前无法通过这条私聊发送好友消息，请在 QQ 中发送。";
const unknown = "好友消息发送结果未确认，请先在 QQ 中核对。";
const maxRememberedMessages = 2048;

export function isOwnerFriendReplyCommand(command: string, replyId?: number | string): boolean {
  return replyId === undefined && direct.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receipt(result: OwnerFriendReplyResult): string {
  switch (result) {
    case "confirmed": return "✅ 已把消息发给它了哦~";
    case "rejected": return "❎ 协议端拒绝发送这条好友消息。";
    case "not-friend": return "❎ 好友列表查无此人";
    case "unavailable": return unavailable;
    default: return unknown;
  }
}

export function createOwnerFriendReply(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();

  return async (command: string, context: OwnerFriendReplyContext): Promise<string | readonly [] | undefined> => {
    if (context.message_type !== "private" || context.isDelegated || signal?.aborted || context.reply_id !== undefined) return;
    const match = direct.exec(command);
    if (!match) return;
    const { adapter, self_id, user_id, message_id, message, sendOwnerFriendReply, isBotMaster } = context;
    if (Array.isArray(message) && message.some(part => part.type === "reply" || part.type === "quote")) return;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "请由当前机器人的主人私聊回复好友。";
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    if (!nativeId || !sendOwnerFriendReply) return unavailable;

    const target = Number(match[1]);
    if (!positiveId(target)) return "❎ QQ号不正确，人家做不到的啦>_<~";
    if (target === self_id) return "❎ 不能给当前机器人自己发送好友消息。";
    if (Array.isArray(message) && message.some(part => part.type !== "text")) return "❎ 这条命令只支持发送纯文本。";
    const body = match[2]?.trim();
    if (!body) return "❎ 消息不能为空";

    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    try {
      const result = await sendOwnerFriendReply(target, body);
      if (!signal?.aborted && isBotMaster(user_id)) return receipt(result);
    } catch {
      if (!signal?.aborted && isBotMaster(user_id)) return unknown;
    } finally {
      inFlight.delete(key);
      seen.add(key);
      if (seen.size > maxRememberedMessages) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
    }
  };
}
