import type { GroupInvitationListContext } from "./group-invitation-list.ts";
import { ownerRequestBatchReply, type OwnerRequestBatchReply, type OwnerRequestBatchResult } from "./owner-request-batch.ts";
import { groupRequestReview } from "./request-review.ts";

export interface PendingGroupInvitationReviewResult {
  readonly status: "confirmed" | "rejected" | "unknown" | "unavailable" | "not-found" | "ambiguous";
  readonly resolvedFlag?: string;
}

export interface QuotedGroupInvitationReviewResult {
  readonly status: "confirmed" | "rejected" | "unknown" | "unavailable" | "expired" | "unrelated";
  readonly groupId?: number;
  readonly resolvedFlag?: string;
}

export interface GroupInvitationReviewContext extends Pick<GroupInvitationListContext,
  "message_type" | "self_id" | "user_id" | "isDelegated" | "isBotMaster"> {
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly reply_id?: number | string;
  readonly reviewQuotedGroupInvitation?: (approve: boolean) => Promise<QuotedGroupInvitationReviewResult>;
  readonly reviewPendingGroupInvitation?: (groupId: number, approve: boolean) => Promise<PendingGroupInvitationReviewResult>;
  readonly reviewAllPendingGroupInvitations?: (approve: boolean) => Promise<OwnerRequestBatchResult>;
}

export const groupInvitationReviewFeature = "[group] 群邀请审核";
const review = /^#?(同意|拒绝)群邀请(\d+)$/u;
const reviewAll = /^#?(同意|拒绝)全部群邀请$/u;
const quotedReview = /^#?(同意|拒绝)$/u;
const unavailable = "当前无法按群号核实并处理这条群邀请，请在 QQ 中处理。";
const unknown = "群邀请处理结果未确认，请先在 QQ 中核对。";
const maxRememberedMessages = 2048;

export function isGroupInvitationReviewCommand(command: string): boolean {
  return review.test(command) || reviewAll.test(command);
}

function nativeId(value: number | string | undefined): value is number | string {
  return typeof value === "number" ? Number.isSafeInteger(value) :
    typeof value === "string" && value.length > 0 && value.length <= 128;
}

function milkySequence(value: number | string | undefined): boolean {
  if (typeof value === "string" && !/^(?:0|[1-9]\d{0,15})$/u.test(value)) return false;
  const sequence = typeof value === "string" ? Number(value) : value;
  return sequence !== undefined && Number.isSafeInteger(sequence) && sequence >= 0;
}

export function isQuotedGroupInvitationReviewCommand(command: string, replyId: number | string | undefined): boolean {
  return milkySequence(replyId) && quotedReview.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receipt(result: PendingGroupInvitationReviewResult | QuotedGroupInvitationReviewResult,
  groupId: number | undefined, verb: string, quoted: boolean): string {
  switch (result.status) {
    case "confirmed": return `✅ 已${verb}${positiveId(groupId) ? `群 ${groupId} 的邀请` : "这条群邀请"}`;
    case "rejected": return "❎ 协议端拒绝了这次群邀请审核。";
    case "not-found": return "本次查询范围内未找到这个群的待处理邀请，请在 QQ 中查看。";
    case "ambiguous": return "这个群有多条待处理的邀请，请在 QQ 中处理。";
    case "expired": return "原群邀请通知已过期或已处理，请在 QQ 中核对。";
    case "unavailable": return quoted ? "当前无法核实并处理原群邀请，请在 QQ 中处理。" : unavailable;
    default: return unknown;
  }
}

export function createGroupInvitationReview(signal?: AbortSignal, completeInvitation = groupRequestReview.completeMilkyInvitation) {
  const inFlight = new Map<string, Promise<{ reply?: string | OwnerRequestBatchReply; unrelated?: true }>>();
  const seen = new Set<string>();

  return async (command: string, context: GroupInvitationReviewContext): Promise<string | OwnerRequestBatchReply | readonly [] | undefined> => {
    if (context.message_type !== "private" || context.isDelegated || signal?.aborted) return;
    const batch = reviewAll.exec(command);
    const direct = batch ?? review.exec(command);
    const reply = milkySequence(context.reply_id) ? quotedReview.exec(command) : null;
    const match = direct ?? reply;
    if (!match) return;
    const { adapter, self_id, user_id, message_id, reviewPendingGroupInvitation, reviewAllPendingGroupInvitations,
      reviewQuotedGroupInvitation, isBotMaster } = context;
    if (reply && (adapter !== "milky" || !reviewQuotedGroupInvitation)) return;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) {
      return direct ? "请由当前机器人的主人私聊处理群邀请。" : undefined;
    }
    const verb = match[1] === "同意" ? "同意" : "拒绝";
    const approve = verb === "同意";
    if (batch && (!nativeId(message_id) || !reviewAllPendingGroupInvitations)) {
      return ownerRequestBatchReply({ status: "unavailable" }, "群邀请", verb);
    }
    if (!nativeId(message_id)) return direct ? unavailable : undefined;

    let groupId: number | undefined;
    let submit: (() => Promise<PendingGroupInvitationReviewResult | QuotedGroupInvitationReviewResult>) | undefined;
    if (direct && !batch) {
      if (!reviewPendingGroupInvitation) return unavailable;
      const target = Number(direct[2]);
      if (!positiveId(target)) return "请填写有效的群号。";
      groupId = target;
      submit = () => reviewPendingGroupInvitation(target, approve);
    } else if (reply) {
      if (!reviewQuotedGroupInvitation) return;
      submit = () => reviewQuotedGroupInvitation(approve);
    }

    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, String(message_id)]);
    if (seen.has(key)) return [];
    const pending = inFlight.get(key);
    if (pending) return reply && (await pending).unrelated ? undefined : [];

    const attempt = Promise.resolve().then(async () => {
      if (signal?.aborted || !isBotMaster(user_id)) return {};
      try {
        if (batch && reviewAllPendingGroupInvitations) {
          const result = await reviewAllPendingGroupInvitations(approve);
          if (adapter === "milky" && result.status === "processed") {
            for (const entry of result.entries) {
              if (entry.status === "confirmed" && entry.resolvedFlag) completeInvitation(self_id, entry.resolvedFlag);
            }
          }
          return !signal?.aborted && isBotMaster(user_id) ? { reply: ownerRequestBatchReply(result, "群邀请", verb) } : {};
        }
        if (!submit) return {};
        const result = await submit();
        if (result.status === "unrelated") return { unrelated: true as const };
        if (adapter === "milky" && result.status === "confirmed" && result.resolvedFlag) {
          completeInvitation(self_id, result.resolvedFlag);
        }
        const target = "groupId" in result ? result.groupId : groupId;
        return !signal?.aborted && isBotMaster(user_id) ? { reply: receipt(result, target, verb, reply !== null) } : {};
      } catch {
        return !signal?.aborted && isBotMaster(user_id) ? { reply: unknown } : {};
      }
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
