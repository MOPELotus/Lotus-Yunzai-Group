import type { FriendRequestListContext } from "./friend-request-list.ts";
import { ownerRequestBatchReply, type OwnerRequestBatchReply, type OwnerRequestBatchResult } from "./owner-request-batch.ts";

export interface PendingFriendRequestReviewResult {
  readonly status: "confirmed" | "submitted" | "rejected" | "unknown" | "unavailable" | "not-found" | "ambiguous" | "risk";
}

export interface FriendRequestReviewContext extends Pick<FriendRequestListContext,
  "message_type" | "self_id" | "user_id" | "isDelegated" | "isBotMaster"> {
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly reviewPendingFriendRequest?: (userId: number, approve: boolean) => Promise<PendingFriendRequestReviewResult>;
  readonly reviewAllPendingFriendRequests?: (approve: boolean) => Promise<OwnerRequestBatchResult>;
}

export const friendRequestReviewFeature = "[group] 好友申请审核";
const review = /^#?(同意|拒绝)好友申请(\d+)$/u;
const reviewAll = /^#?(同意|拒绝)全部好友申请$/u;
const unavailable = "当前无法按 QQ 核实并处理这条好友申请，请在 QQ 中处理。";
const unknown = "好友申请处理结果未确认，请先在 QQ 中核对。";
const maxRememberedMessages = 2048;

export function isFriendRequestReviewCommand(command: string): boolean {
  return review.test(command) || reviewAll.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receipt(result: PendingFriendRequestReviewResult, applicant: number, verb: string): string {
  switch (result.status) {
    case "confirmed": return `✅ 已${verb} ${applicant} 的好友申请`;
    case "submitted": return `协议端已受理${verb} ${applicant} 的好友申请，请在 QQ 中核对处理结果。`;
    case "rejected": return "❎ 协议端拒绝了这次好友申请审核。";
    case "not-found": return "本次查询范围内未找到这个人的待处理好友申请，请在 QQ 中查看。";
    case "ambiguous": return "这个 QQ 有多条待处理的好友申请，请在 QQ 中处理。";
    case "risk": return "该账号为风险账号请在 QQ 中手动处理。";
    case "unavailable": return unavailable;
    default: return unknown;
  }
}

export function createFriendRequestReview(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();

  return async (command: string, context: FriendRequestReviewContext): Promise<string | OwnerRequestBatchReply | readonly [] | undefined> => {
    const batch = reviewAll.exec(command);
    const match = batch ?? review.exec(command);
    if (!match || context.message_type !== "private" || context.isDelegated || signal?.aborted) return;
    const { adapter, self_id, user_id, message_id, reviewPendingFriendRequest, reviewAllPendingFriendRequests, isBotMaster } = context;
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "请由当前机器人的主人私聊处理好友申请。";
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    const verb = match[1] === "同意" ? "同意" : "拒绝";
    const applicant = Number(match[2]);
    if (batch && (!nativeId || !reviewAllPendingFriendRequests)) return ownerRequestBatchReply({ status: "unavailable" }, "好友申请", verb);
    if (!batch && (!nativeId || !reviewPendingFriendRequest)) return unavailable;
    if (!batch && !positiveId(applicant)) return "请填写有效的申请人 QQ 号。";

    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    try {
      if (batch && reviewAllPendingFriendRequests) {
        const result = await reviewAllPendingFriendRequests(verb === "同意");
        if (!signal?.aborted && isBotMaster(user_id)) return ownerRequestBatchReply(result, "好友申请", verb);
      } else if (reviewPendingFriendRequest) {
        const result = await reviewPendingFriendRequest(applicant, verb === "同意");
        if (!signal?.aborted && isBotMaster(user_id)) return receipt(result, applicant, verb);
      }
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
