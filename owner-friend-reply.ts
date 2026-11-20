import type { FriendRequestReviewContext } from "./friend-request-review.ts";

export type OwnerFriendReplyBody = string | readonly (string | { readonly sourceIndex: number })[];
export type OwnerFriendReplyResult = "confirmed" | "rejected" | "unknown" | "not-friend" | "unavailable" | "unsupported";

interface OriginalSegment {
  readonly type: string;
  readonly text?: unknown;
}

export interface OwnerFriendReplyContext extends Pick<FriendRequestReviewContext,
  "message_type" | "self_id" | "user_id" | "isDelegated" | "isBotMaster" | "adapter" | "message_id"> {
  readonly message?: string | readonly OriginalSegment[];
  readonly reply_id?: number | string;
  readonly sendOwnerFriendReply?: (userId: number, body: OwnerFriendReplyBody) => Promise<OwnerFriendReplyResult>;
}

export const ownerFriendReplyFeature = "[group] 主人回复好友";
const direct = /^#?回复[ \t]*(\d+)(?:[ \t]+([\s\S]*))?$/u;
const unavailable = "当前无法通过这条私聊发送好友消息，请在 QQ 中发送。";
const unknown = "好友消息发送结果未确认，请先在 QQ 中核对。";
const maxRememberedMessages = 2048;

function originalAddress(command: string, segments: readonly OriginalSegment[]): RegExpExecArray | null {
  const first = segments[0];
  if (!/^#?回复/u.test(command) || first?.type !== "text" || typeof first.text !== "string") return null;
  const text = first.text.trimStart().replace(/^[＃井/](?=回复)/u, "#");
  return direct.exec(text);
}

export function isOwnerFriendReplyCommand(
  command: string, replyId?: number | string, message?: OwnerFriendReplyContext["message"],
): boolean {
  return replyId === undefined && (direct.test(command) ||
    (Array.isArray(message) && message.some(part => part.type !== "text") && originalAddress(command, message) !== null));
}

function originalBody(segments: readonly OriginalSegment[], leadingBody: string | undefined): OwnerFriendReplyBody | undefined {
  const body: (string | { sourceIndex: number })[] = [];
  if (leadingBody) body.push(leadingBody);
  for (let sourceIndex = 1; sourceIndex < segments.length; sourceIndex++) {
    const part = segments[sourceIndex];
    if (part?.type === "text" && typeof part.text === "string") body.push(part.text);
    else if (part?.type === "image" || part?.type === "face") body.push({ sourceIndex });
    else return;
  }
  return body;
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
    case "unsupported": return "❎ 无法核验原消息中的图片或 QQ 表情，整条消息未发送。";
    default: return unknown;
  }
}

export function createOwnerFriendReply(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();

  return async (command: string, context: OwnerFriendReplyContext): Promise<string | readonly [] | undefined> => {
    if (context.message_type !== "private" || context.isDelegated || signal?.aborted || context.reply_id !== undefined) return;
    const { adapter, self_id, user_id, message_id, message, sendOwnerFriendReply, isBotMaster } = context;
    if (Array.isArray(message) && message.some(part => part.type === "reply" || part.type === "quote")) return;
    const mixed = Array.isArray(message) && message.some(part => part.type !== "text") ? message : undefined;
    const address = mixed ? originalAddress(command, mixed) : null;
    const match = address ?? direct.exec(command);
    if (!match) return;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "请由当前机器人的主人私聊回复好友。";
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    if (!nativeId || !sendOwnerFriendReply) return unavailable;

    const target = Number(match[1]);
    if (!positiveId(target)) return "❎ QQ号不正确，人家做不到的啦>_<~";
    if (target === self_id) return "❎ 不能给当前机器人自己发送好友消息。";
    const body = mixed ? (address ? originalBody(mixed, address[2]) : undefined) : match[2]?.trim();
    if (mixed && body === undefined) return "❎ 回复含有不支持的消息段，整条消息未发送。";
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
