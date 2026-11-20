import type { FriendRequestReviewContext } from "./friend-request-review.ts";

export type OwnerFriendReplyBody = string | readonly (string | { readonly sourceIndex: number })[];
export type QuotedOwnerFriendReplyResult = OwnerFriendReplyResult | "unrelated" | "expired";
export type OwnerFriendReplyResult = "confirmed" | "rejected" | "unknown" | "not-friend" | "unavailable" | "unsupported";

interface OriginalSegment {
  readonly type: string;
  readonly text?: unknown;
}

export interface OwnerFriendReplyContext extends Pick<FriendRequestReviewContext,
  "message_type" | "self_id" | "user_id" | "isDelegated" | "isBotMaster" | "adapter" | "message_id"> {
  readonly message?: string | readonly OriginalSegment[];
  readonly reply_id?: number | string;
  readonly sendQuotedOwnerFriendReply?: (body: OwnerFriendReplyBody) => Promise<QuotedOwnerFriendReplyResult>;
  readonly sendOwnerFriendReply?: (userId: number, body: OwnerFriendReplyBody) => Promise<OwnerFriendReplyResult>;
}

export const ownerFriendReplyFeature = "[group] 主人回复好友";
const direct = /^#?回复[ \t]*(\d+)(?:[ \t]+([\s\S]*))?$/u;
const quote = /^#?回复(?:[ \t]+([\s\S]*))?$/u;
const unavailable = "当前无法通过这条私聊发送好友消息，请在 QQ 中发送。";
const unknown = "好友消息发送结果未确认，请先在 QQ 中核对。";
const maxRememberedMessages = 2048;

function replySegment(part: OriginalSegment | undefined): boolean {
  return part?.type === "reply" || part?.type === "quote";
}

function nativeId(value: number | string | undefined): boolean {
  return typeof value === "number" ? Number.isSafeInteger(value) :
    typeof value === "string" && value.length > 0 && value.length <= 128;
}

function originalAddress(command: string, segments: readonly OriginalSegment[], quoted: boolean) {
  const index = quoted && replySegment(segments[0]) ? 1 : 0;
  const first = segments[index];
  if (!/^#?回复/u.test(command) || first?.type !== "text" || typeof first.text !== "string") return;
  const text = first.text.trimStart().replace(/^[＃井/](?=回复)/u, "#");
  const match = (quoted ? quote : direct).exec(text);
  if (match) return { match, index };
}

export function isOwnerFriendReplyCommand(
  command: string, replyId?: number | string, message?: OwnerFriendReplyContext["message"],
): boolean {
  const quoted = replyId !== undefined;
  if (quoted && !nativeId(replyId)) return false;
  return (quoted ? quote : direct).test(command) ||
    (Array.isArray(message) && message.some(part => part.type !== "text") && originalAddress(command, message, quoted) !== undefined);
}

function originalBody(segments: readonly OriginalSegment[], index: number, leadingBody: string | undefined, quoted: boolean): OwnerFriendReplyBody | undefined {
  const body: (string | { sourceIndex: number })[] = [];
  if (leadingBody) body.push(leadingBody);
  for (let sourceIndex = index + 1; sourceIndex < segments.length; sourceIndex++) {
    const part = segments[sourceIndex];
    if (quoted && replySegment(part)) continue;
    if (part?.type === "text" && typeof part.text === "string") body.push(part.text);
    else if (part?.type === "image" || part?.type === "face") body.push({ sourceIndex });
    else return;
  }
  return body;
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receipt(result: Exclude<QuotedOwnerFriendReplyResult, "unrelated">): string {
  switch (result) {
    case "confirmed": return "✅ 已把消息发给它了哦~";
    case "rejected": return "❎ 协议端拒绝发送这条好友消息。";
    case "not-friend": return "❎ 好友列表查无此人";
    case "unavailable": return unavailable;
    case "expired": return "原好友消息通知已过期，请改用「回复 QQ号 <内容>」直接发送。";
    case "unsupported": return "❎ 无法核验原消息中的图片或 QQ 表情，整条消息未发送。";
    default: return unknown;
  }
}

export function createOwnerFriendReply(signal?: AbortSignal) {
  const inFlight = new Map<string, Promise<{ reply?: string; unrelated?: true }>>();
  const seen = new Set<string>();

  return async (command: string, context: OwnerFriendReplyContext): Promise<string | readonly [] | undefined> => {
    if (context.message_type !== "private" || context.isDelegated || signal?.aborted) return;
    const { adapter, self_id, user_id, message_id, message, reply_id, sendOwnerFriendReply, sendQuotedOwnerFriendReply, isBotMaster } = context;
    const quoted = reply_id !== undefined;
    if (quoted && !nativeId(reply_id)) return;
    const segments = Array.isArray(message) ? message : undefined;
    if (segments && segments.filter(replySegment).length > (quoted ? 1 : 0)) return;
    const mixed = segments?.some(part => part.type !== "text") ? segments : undefined;
    const address = mixed && originalAddress(command, mixed, quoted);
    const match = address?.match ?? (quoted ? quote : direct).exec(command);
    if (!match) return;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) {
      return quoted ? undefined : "请由当前机器人的主人私聊回复好友。";
    }
    if (!nativeId(message_id)) return quoted ? undefined : unavailable;

    let submit: (body: OwnerFriendReplyBody) => Promise<QuotedOwnerFriendReplyResult>;
    if (quoted) {
      if (!sendQuotedOwnerFriendReply) return;
      submit = sendQuotedOwnerFriendReply;
    } else {
      if (!sendOwnerFriendReply) return unavailable;
      const target = Number(match[1]);
      if (!positiveId(target)) return "❎ QQ号不正确，人家做不到的啦>_<~";
      if (target === self_id) return "❎ 不能给当前机器人自己发送好友消息。";
      submit = body => sendOwnerFriendReply(target, body);
    }
    const leadingBody = quoted ? match[1] : match[2];
    const body = mixed ? (address ? originalBody(mixed, address.index, leadingBody, quoted) : undefined) : leadingBody?.trim();
    if (mixed && body === undefined) return quoted ? undefined : "❎ 回复含有不支持的消息段，整条消息未发送。";
    if (!body || (typeof body !== "string" && !body.some(part => typeof part !== "string" || part.trim()))) {
      return quoted ? undefined : "❎ 消息不能为空";
    }

    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, String(message_id)]);
    if (seen.has(key)) return [];
    const pending = inFlight.get(key);
    if (pending) return quoted && (await pending).unrelated ? undefined : [];

    const attempt = Promise.resolve().then(async () => {
      if (signal?.aborted || !isBotMaster(user_id)) return {};
      try {
        const result = await submit(body);
        if (result === "unrelated") return { unrelated: true as const };
        if (!signal?.aborted && isBotMaster(user_id)) return { reply: receipt(result) };
      } catch {
        if (!signal?.aborted && isBotMaster(user_id)) return { reply: unknown };
      }
      return {};
    });
    inFlight.set(key, attempt);
    try {
      const result = await attempt;
      if (!result.unrelated) {
        seen.add(key);
        if (seen.size > maxRememberedMessages) {
          const oldest = seen.values().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
      }
      return result.reply;
    } finally {
      inFlight.delete(key);
    }
  };
}
