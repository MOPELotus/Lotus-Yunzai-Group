import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
const unavailable = $t("friend-request-review.text_46b6463018");
const unknown = $t("friend-request-review.text_f19a731cd0");
const maxRememberedMessages = 2048;

export function isFriendRequestReviewCommand(command: string): boolean {
  return review.test(command) || reviewAll.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receipt(result: PendingFriendRequestReviewResult, applicant: number, verb: string): string {
  switch (result.status) {
    case "confirmed": return $t("friend-request-review.text_9130311e8b", { "verb": verb, "applicant": applicant });
    case "submitted": return $t("friend-request-review.text_f502a4c980", { "verb": verb, "applicant": applicant });
    case "rejected": return $t("friend-request-review.text_a5a7d5bd90");
    case "not-found": return $t("friend-request-review.text_32e3cb3096");
    case "ambiguous": return $t("friend-request-review.text_f641747f89");
    case "risk": return $t("friend-request-review.text_33079e0a3b");
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
    if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return $t("friend-request-review.text_b8b406d9cf");
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    const approve = match[1] === "同意";
    const verb = approve ? $t("friend-request-review.text_905819e2e3") : $t("friend-request-review.text_136de7a8c4");
    const applicant = Number(match[2]);
    if (batch && (!nativeId || !reviewAllPendingFriendRequests)) return ownerRequestBatchReply({ status: "unavailable" }, $t("friend-request-review.text_74d9ad48d6"), verb);
    if (!batch && (!nativeId || !reviewPendingFriendRequest)) return unavailable;
    if (!batch && !positiveId(applicant)) return $t("friend-request-review.text_d7c9ed2121");

    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    try {
      if (batch && reviewAllPendingFriendRequests) {
        const result = await reviewAllPendingFriendRequests(approve);
        if (!signal?.aborted && isBotMaster(user_id)) return ownerRequestBatchReply(result, $t("friend-request-review.text_74d9ad48d6"), verb);
      } else if (reviewPendingFriendRequest) {
        const result = await reviewPendingFriendRequest(applicant, approve);
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
