import type { GroupWholeMuteResult } from "./group-mute.ts";

export interface GroupNotificationPart extends Readonly<Record<string, unknown>> {
  readonly type: string;
}

export interface GroupNotificationContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly adapter?: "onebot" | "milky";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_id?: number | string;
  readonly isDelegated?: boolean;
  readonly normalizedMessage: string;
  readonly message?: string | readonly GroupNotificationPart[];
  readonly groupNotifyAll?: (parts: readonly GroupNotificationPart[]) => Promise<GroupWholeMuteResult>;
}

export const groupNotificationFeature = "[group] 群通知";
const entry = "#发通知";
const originalPrefix = /^[#＃井/]发通知/u;
export const isGroupNotificationCommand = (message: string) => message.startsWith(entry);
const bodyTypes = new Set(["text", "at", "face", "image", "record", "video"]);

function bodyParts(source: readonly GroupNotificationPart[], input: string, bot: number): readonly GroupNotificationPart[] | undefined {
  // The host may strip a configured text alias before routing while retaining the original segments.
  const originalText = source.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("").trimStart();
  const trailingTrimmedText = originalText.trimEnd();
  const offset = trailingTrimmedText.length - input.length;
  if (offset < 0 || !originalPrefix.test(trailingTrimmedText.slice(offset)) || trailingTrimmedText.slice(offset + 1) !== input.slice(1)) return;

  let prefixLeft = offset + entry.length;
  let leadingSpace = true;
  const result: GroupNotificationPart[] = [];
  for (const part of source) {
    if (part.type === "at" && part.qq === "all") continue;
    if (prefixLeft) {
      if (leadingSpace && (part.type === "reply" || part.type === "at" && String(part.qq) === String(bot))) continue;
      if (part.type !== "text" || typeof part.text !== "string") return;
      const text = leadingSpace ? part.text.trimStart() : part.text;
      if (!text) continue;
      leadingSpace = false;
      if (text.length >= prefixLeft) {
        const body = text.slice(prefixLeft).trim();
        prefixLeft = 0;
        if (body) result.push({ type: "text", text: body });
      } else prefixLeft -= text.length;
      continue;
    }
    if (!bodyTypes.has(part.type) || part.type === "text" && typeof part.text !== "string") return;
    if (part.type === "at" && !validMention(part.qq)) return;
    result.push(part);
  }
  if (!prefixLeft) return result;
}

function positiveId(value: number | undefined): value is number { return value !== undefined && Number.isSafeInteger(value) && value > 0; }
function validMention(value: unknown): boolean {
  if (typeof value === "number") return positiveId(value);
  return typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value) && positiveId(Number(value));
}

export function createGroupNotification(signal?: AbortSignal) {
  const seen = new Set<string>();
  return async (context: GroupNotificationContext): Promise<string | readonly [] | undefined> => {
    const input = context.normalizedMessage.trim();
    if (context.message_type !== "group" || !isGroupNotificationCommand(input)) return;
    const { adapter, self_id, user_id, group_id, message_id, message, groupNotifyAll } = context;
    const validId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    if (context.isDelegated || signal?.aborted || !groupNotifyAll || !validId ||
        !positiveId(self_id) || !positiveId(user_id) || !positiveId(group_id)) return "当前会话无法发送群通知，请核对群管理权限和网关连接。";
    const source = typeof message === "string" ? [{ type: "text", text: message }] : message;
    const body = source && bodyParts(source, input, self_id);
    if (!body) return "通知含有当前不支持发送的消息段，请调整后重试。";
    if (!body.some((part) => part.type !== "text" || (typeof part.text === "string" && part.text.trim()))) return "❎ 通知不能为空";

    const id = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
    if (seen.has(id)) return [];
    seen.add(id);
    if (seen.size > 2048) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    let status: GroupWholeMuteResult;
    try { status = await groupNotifyAll(body); } catch { status = "unknown"; }
    switch (status) {
      case "confirmed": return [];
      case "rejected": return "协议端拒绝发送群通知。";
      case "unavailable": return "当前会话无法发送群通知，请核对群管理权限和消息段是否受支持。";
      case "unknown": return "群通知发送结果未确认，请在群内核对。";
    }
  };
}
