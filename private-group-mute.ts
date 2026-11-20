import { groupTimeUnits, parseGroupMuteDuration, type GroupMuteContext, type GroupMuteResult, type GroupWholeMuteResult } from "./group-mute.ts";

export interface PrivateGroupMuteResult {
  readonly status: GroupMuteResult;
  readonly memberName?: string;
}

export interface PrivateGroupWholeMuteResult {
  readonly status: GroupWholeMuteResult;
  readonly groupName?: string;
}

export interface PrivateGroupMuteContext extends Pick<GroupMuteContext,
  "adapter" | "isBotMaster" | "isDelegated" | "message" | "message_id" | "message_type" |
  "normalizedMessage" | "self_id" | "user_id"> {
  readonly privateGroupKick?: (groupId: number, userId: number) => Promise<PrivateGroupMuteResult>;
  readonly privateGroupWholeMute?: (groupId: number, enabled: boolean) => Promise<PrivateGroupWholeMuteResult>;
  readonly privateGroupMute?: (groupId: number, userId: number, seconds: number) => Promise<PrivateGroupMuteResult>;
}

export const privateGroupMuteFeature = "[group] 私聊群管";

const timeUnits = [...groupTimeUnits.keys()].join("|");
const amount = String.raw`[一壹二两三四五六七八九十百千万亿\d]+`;
const mutePattern = new RegExp(String.raw`^#禁言\s?(\d+)\s(\d+)\s(${amount}(?:${timeUnits})?|${timeUnits})$`, "u");
const releasePattern = /^#解禁\s?(\d+)\s(\d+)$/u;
const wholeMutePattern = /^#全体(禁言|解禁)(\d+)$/u;
const kickPattern = /^#踢\s?(\d+)\s(\d+)$/u;
const maxRememberedMessages = 2048;

export function isPrivateGroupMuteCommand(command: string): boolean {
  return mutePattern.test(command) || releasePattern.test(command) || wholeMutePattern.test(command) || kickPattern.test(command);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function legalMessageId(value: unknown): value is number | string {
  return typeof value === "number" ? Number.isSafeInteger(value) :
    typeof value === "string" && value.length > 0 && value.length <= 128;
}

function displayName(value: string | undefined): string | undefined {
  const name = value?.slice(0, 256).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim();
  return name && Array.from(name).slice(0, 80).join("");
}

export function createPrivateGroupMute(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();

  return async (message: string, context: PrivateGroupMuteContext): Promise<string | readonly [] | undefined> => {
    if (context.message_type !== "private" || context.isDelegated || signal?.aborted) return;
    const input = (context.normalizedMessage ?? message).trim();
    const kick = kickPattern.exec(input);
    const member = kick ?? mutePattern.exec(input) ?? releasePattern.exec(input);
    const whole = wholeMutePattern.exec(input);
    if (!member && !whole) return;
    const { isBotMaster, message: original, message_id, privateGroupKick, privateGroupMute, privateGroupWholeMute, self_id, user_id } = context;
    const nativeAdapter = context.adapter ?? "onebot";
    if (Array.isArray(original) && original.some(part => part.type !== "text")) return;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id) ||
        (nativeAdapter !== "onebot" && nativeAdapter !== "milky") || !legalMessageId(message_id) ||
        (whole ? !privateGroupWholeMute : kick ? !privateGroupKick : !privateGroupMute)) {
      return kick ? "当前私聊会话没有移出群成员的权限。" : "当前私聊会话没有群禁言权限。";
    }
    const groupId = Number(whole ? whole[2] : member?.[1]);
    if (whole && !positiveId(groupId)) return "请填写有效的群号。";
    const target = Number(member?.[2]);
    const seconds = member?.[3] === undefined ? 0 : parseGroupMuteDuration(member[3]);
    if (member && (!positiveId(groupId) || !positiveId(target) || seconds === undefined)) {
      return kick ? "请填写有效的群号和 QQ 号。" : "请填写有效的群号、QQ 号和禁言时长。";
    }
    if (kick && (target === self_id || isBotMaster(target))) return `群 ${groupId} 的 ${target} 受群管保护。`;
    if (member && target === self_id) return `群 ${groupId} 的 ${target} 受群禁言保护。`;
    const key = JSON.stringify([nativeAdapter, self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const action = whole ? (whole[1] === "禁言" ? "开启全体禁言" : "解除全体禁言")
      : kick ? "踢出群聊" : seconds === 0 ? "解禁" : "禁言";
    const state = kick ? "群成员状态" : "禁言状态";
    try {
      if (whole && privateGroupWholeMute) {
        const { status, groupName } = await privateGroupWholeMute(groupId, whole[1] === "禁言");
        switch (status) {
          case "confirmed": {
            const name = displayName(groupName);
            return `✅ 已将群「${name && name !== String(groupId) ? `${name}(${groupId})` : groupId}」${action}`;
          }
          case "rejected": return `协议端拒绝了群 ${groupId} 的${action}操作。`;
          case "unavailable": return `无法对群 ${groupId} 执行${action}，请核对群管理权限。`;
          default: return `群 ${groupId} 的${action}结果未确认，请核对当前禁言状态。`;
        }
      }
      if (!member || seconds === undefined) return;
      const result = kick ? await privateGroupKick?.(groupId, target) : await privateGroupMute?.(groupId, target, seconds);
      switch (result?.status) {
        case "confirmed": {
          if (kick) return `✅ 已将「${target}」踢出群聊（群 ${groupId}）`;
          const name = displayName(result.memberName);
          const identity = name && name !== String(target) ? `${name}（${target}）` : String(target);
          return seconds === 0 ? `✅ 已将群 ${groupId} 的「${identity}」解除禁言` :
            `✅ 已将群 ${groupId} 的「${identity}」禁言 ${seconds} 秒`;
        }
        case "rejected": return `协议端拒绝了群 ${groupId} 对 ${target} 的${action}。`;
        case "protected": return `群 ${groupId} 的 ${target} ${kick ? "受群管保护" : "受群禁言保护"}。`;
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
    const scope = whole ? `群 ${groupId}` : `群 ${groupId} 对 ${target}`;
    return `${scope} 的${action}结果未确认，请核对当前${state}。`;
  };
}
