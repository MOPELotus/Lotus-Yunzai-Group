import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { formatGroupModerationMember, groupModerationName, groupTimeUnits, parseGroupMuteDuration,
  type GroupMuteContext, type GroupMuteResult, type GroupWholeMuteResult } from "./group-mute.ts";

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
      return kick ? $t("private-group-mute.text_a97279717e") : $t("private-group-mute.text_054404a3c8");
    }
    const groupId = Number(whole ? whole[2] : member?.[1]);
    if (whole && !positiveId(groupId)) return $t("private-group-mute.text_9c48f6c70c");
    const target = Number(member?.[2]);
    const seconds = member?.[3] === undefined ? 0 : parseGroupMuteDuration(member[3]);
    if (member && (!positiveId(groupId) || !positiveId(target) || seconds === undefined)) {
      return kick ? $t("private-group-mute.text_4229d2fb99") : $t("private-group-mute.text_691d8a1458");
    }
    if (kick && (target === self_id || isBotMaster(target))) return $t("private-group-mute.text_b5203e02df", { "groupId": groupId, "target": target });
    if (member && target === self_id) return $t("private-group-mute.text_b19d453c21", { "groupId": groupId, "target": target });
    const key = JSON.stringify([nativeAdapter, self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const action = whole ? (whole[1] === "禁言" ? $t("private-group-mute.text_92a98d5729") : $t("private-group-mute.text_1221f79fd5"))
      : kick ? $t("private-group-mute.text_d5586c8693") : seconds === 0 ? $t("private-group-mute.text_75a8ec42b1") : $t("private-group-mute.text_f76935bcd9");
    const state = kick ? $t("private-group-mute.text_ee2d379872") : $t("private-group-mute.text_7dc7680369");
    try {
      if (whole && privateGroupWholeMute) {
        const { status, groupName } = await privateGroupWholeMute(groupId, whole[1] === "禁言");
        switch (status) {
          case "confirmed": {
            const name = groupModerationName(groupName);
            return $t("private-group-mute.text_e2b54849e1", { "value1": name && name !== String(groupId) ? `${name}(${groupId})` : groupId, "action": action });
          }
          case "rejected": return $t("private-group-mute.text_48f797024f", { "groupId": groupId, "action": action });
          case "unavailable": return $t("private-group-mute.text_ab4ac54c96", { "groupId": groupId, "action": action });
          default: return $t("private-group-mute.text_30381f77e8", { "groupId": groupId, "action": action });
        }
      }
      if (!member || seconds === undefined) return;
      const result = kick ? await privateGroupKick?.(groupId, target) : await privateGroupMute?.(groupId, target, seconds);
      switch (result?.status) {
        case "confirmed": {
          const identity = formatGroupModerationMember(target, result.memberName);
          if (kick) return $t("private-group-mute.text_7119778e87", { "identity": identity, "groupId": groupId });
          return seconds === 0 ? $t("private-group-mute.text_b15986e965", { "groupId": groupId, "identity": identity }) :
            $t("private-group-mute.text_818db34ec9", { "groupId": groupId, "identity": identity, "seconds": seconds });
        }
        case "rejected": return $t("private-group-mute.text_7481c6123b", { "groupId": groupId, "target": target, "action": action });
        case "protected": return $t("private-group-mute.text_b858d99bee", { "groupId": groupId, "target": target, "value3": kick ? $t("private-group-mute.text_22624520a4") : $t("private-group-mute.text_6e802272b0") });
        case "unavailable": return $t("private-group-mute.text_54f265889a", { "groupId": groupId, "target": target, "action": action });
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
    const scope = whole ? $t("private-group-mute.text_060d121dff", { "groupId": groupId }) : $t("private-group-mute.text_8f381d9aa5", { "groupId": groupId, "target": target });
    return $t("private-group-mute.text_5c7217592e", { "scope": scope, "action": action, "state": state });
  };
}
