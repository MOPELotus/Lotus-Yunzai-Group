import { groupTimeUnits, parseGroupMuteDuration, type GroupMuteContext, type GroupMuteResult } from "./group-mute.ts";

export interface PrivateGroupMuteResult {
  readonly status: GroupMuteResult;
  readonly memberName?: string;
}

export interface PrivateGroupMuteContext extends Pick<GroupMuteContext,
  "adapter" | "isBotMaster" | "isDelegated" | "message" | "message_id" | "message_type" |
  "normalizedMessage" | "self_id" | "user_id"> {
  readonly privateGroupMute?: (groupId: number, userId: number, seconds: number) => Promise<PrivateGroupMuteResult>;
}

export const privateGroupMuteFeature = "[group] 私聊群管";

const timeUnits = [...groupTimeUnits.keys()].join("|");
const amount = String.raw`[一壹二两三四五六七八九十百千万亿\d]+`;
const mutePattern = new RegExp(String.raw`^#禁言\s?(\d+)\s(\d+)\s(${amount}(?:${timeUnits})?|${timeUnits})$`, "u");
const releasePattern = /^#解禁\s?(\d+)\s(\d+)$/u;
const maxRememberedMessages = 2048;

export function isPrivateGroupMuteCommand(command: string): boolean {
  return mutePattern.test(command) || releasePattern.test(command);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function legalMessageId(value: unknown): value is number | string {
  return typeof value === "number" ? Number.isSafeInteger(value) :
    typeof value === "string" && value.length > 0 && value.length <= 128;
}

function displayMember(userId: number, memberName: string | undefined): string {
  const name = memberName?.slice(0, 256).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim();
  const shortName = name && Array.from(name).slice(0, 80).join("");
  return shortName && shortName !== String(userId) ? `${shortName}（${userId}）` : String(userId);
}

export function createPrivateGroupMute(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();

  return async (message: string, context: PrivateGroupMuteContext): Promise<string | readonly [] | undefined> => {
    if (context.message_type !== "private" || context.isDelegated || signal?.aborted) return;
    const input = (context.normalizedMessage ?? message).trim();
    const match = mutePattern.exec(input) ?? releasePattern.exec(input);
    if (!match) return;
    const { adapter, isBotMaster, message: original, message_id, privateGroupMute, self_id, user_id } = context;
    if (Array.isArray(original) && original.some(part => part.type !== "text")) return;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id) ||
        (adapter !== "onebot" && adapter !== "milky") || !legalMessageId(message_id) || !privateGroupMute) {
      return "当前私聊会话没有群禁言权限。";
    }
    const groupId = Number(match[1]), target = Number(match[2]);
    const seconds = match[3] === undefined ? 0 : parseGroupMuteDuration(match[3]);
    if (!positiveId(groupId) || !positiveId(target) || seconds === undefined) {
      return "请填写有效的群号、QQ 号和禁言时长。";
    }
    if (target === self_id) return `群 ${groupId} 的 ${target} 受群禁言保护。`;
    const key = JSON.stringify([adapter, self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const action = seconds === 0 ? "解禁" : "禁言";
    try {
      const { status, memberName } = await privateGroupMute(groupId, target, seconds);
      switch (status) {
        case "confirmed": {
          const member = displayMember(target, memberName);
          return seconds === 0 ? `✅ 已将群 ${groupId} 的「${member}」解除禁言` :
            `✅ 已将群 ${groupId} 的「${member}」禁言 ${seconds} 秒`;
        }
        case "rejected": return `协议端拒绝了群 ${groupId} 对 ${target} 的${action}。`;
        case "protected": return `群 ${groupId} 的 ${target} 受群禁言保护。`;
        case "unavailable": return `无法对群 ${groupId} 的 ${target} 执行${action}，请核对成员身份与权限。`;
        case "unknown": break;
      }
    } catch {
      // A transport failure does not confirm whether the gateway applied the operation.
    } finally {
      inFlight.delete(key);
      seen.add(key);
      if (seen.size > maxRememberedMessages) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
    }
    return `群 ${groupId} 对 ${target} 的${action}结果未确认，请核对当前禁言状态。`;
  };
}
