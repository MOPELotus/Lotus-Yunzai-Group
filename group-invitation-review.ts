import type { GroupInvitationListContext } from "./group-invitation-list.ts";
import { groupRequestReview } from "./request-review.ts";

export interface PendingGroupInvitationReviewResult {
  readonly status: "confirmed" | "rejected" | "unknown" | "unavailable" | "not-found" | "ambiguous";
  readonly resolvedFlag?: string;
}

export interface GroupInvitationReviewContext extends Pick<GroupInvitationListContext,
  "message_type" | "self_id" | "user_id" | "isDelegated" | "isBotMaster"> {
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly reviewPendingGroupInvitation?: (groupId: number, approve: boolean) => Promise<PendingGroupInvitationReviewResult>;
}

export const groupInvitationReviewFeature = "[group] 群邀请审核";
const review = /^#?(同意|拒绝)群邀请(\d+)$/u;
const unavailable = "当前无法按群号核实并处理这条群邀请，请在 QQ 中处理。";
const unknown = "群邀请处理结果未确认，请先在 QQ 中核对。";
const maxRememberedMessages = 2048;

export function isGroupInvitationReviewCommand(command: string): boolean {
  return review.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receipt(result: PendingGroupInvitationReviewResult, groupId: number, verb: string): string {
  switch (result.status) {
    case "confirmed": return `✅ 已${verb}群 ${groupId} 的邀请`;
    case "rejected": return "❎ 协议端拒绝了这次群邀请审核。";
    case "not-found": return "本次查询范围内未找到这个群的待处理邀请，请在 QQ 中查看。";
    case "ambiguous": return "这个群有多条待处理的邀请，请在 QQ 中处理。";
    case "unavailable": return unavailable;
    default: return unknown;
  }
}

export function createGroupInvitationReview(signal?: AbortSignal, completeInvitation = groupRequestReview.completeMilkyInvitation) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();

  return async (command: string, context: GroupInvitationReviewContext): Promise<string | readonly [] | undefined> => {
    const match = review.exec(command);
    if (!match || context.message_type !== "private" || context.isDelegated || signal?.aborted) return;
    const { adapter, self_id, user_id, message_id, reviewPendingGroupInvitation, isBotMaster } = context;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "请由当前机器人的主人私聊处理群邀请。";
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    if (!nativeId || !reviewPendingGroupInvitation) return unavailable;
    const groupId = Number(match[2]);
    if (!positiveId(groupId)) return "请填写有效的群号。";

    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const verb = match[1] === "同意" ? "同意" : "拒绝";
    try {
      const result = await reviewPendingGroupInvitation(groupId, verb === "同意");
      if (adapter === "milky" && result.status === "confirmed" && result.resolvedFlag) {
        completeInvitation(self_id, result.resolvedFlag);
      }
      if (!signal?.aborted && isBotMaster(user_id)) return receipt(result, groupId, verb);
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
