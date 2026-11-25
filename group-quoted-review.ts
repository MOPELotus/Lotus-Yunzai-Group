import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import type { GroupMuteContext } from "./group-mute.ts";

export interface GroupQuotedReviewResult {
  readonly status: "confirmed" | "rejected" | "unknown" | "unavailable" | "expired" | "risk" | "unrelated";
  readonly userId?: number;
  readonly nickname?: string;
}

export interface GroupQuotedReviewContext extends GroupMuteContext {
  readonly groupReviewQuotedRequest?: (approve: boolean) => Promise<GroupQuotedReviewResult>;
}

export const groupQuotedReviewFeature = "[group] 引用加群审核";
const decision = /^#?(同意|拒绝)$/u;
export const isGroupQuotedReviewCommand = (message: string) => decision.test(message);

function identity(value: number | undefined): value is number { return value !== undefined && Number.isSafeInteger(value) && value > 0; }

function messageId(value: number | string | undefined): value is number | string {
  return typeof value === "number" ? Number.isSafeInteger(value) : typeof value === "string" && value.length > 0 && value.length <= 128;
}

function decisionReply(result: GroupQuotedReviewResult, verb: string): string | undefined {
  switch (result.status) {
    case "unrelated": return;
    case "confirmed": {
      const name = result.nickname?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 128).toWellFormed();
      const applicant = identity(result.userId) ? (name ? `${name}(${result.userId})` : String(result.userId)) : $t("group-quoted-review.text_bcf5d24f94");
      return $t("group-quoted-review.text_4836a9d66c", { "verb": verb, "applicant": applicant });
    }
    case "rejected": return $t("group-quoted-review.text_51512e46aa");
    case "expired": return $t("group-quoted-review.text_df0e30f728", { "verb": verb });
    case "risk": return $t("group-quoted-review.text_f8693f4988");
    case "unknown": return $t("group-quoted-review.text_f956eda5d4");
    case "unavailable": return $t("group-quoted-review.text_569868d9f9");
  }
}

export function createGroupQuotedReview(signal?: AbortSignal) {
  const pending = new Map<string, Promise<string | undefined>>();
  const seen = new Set<string>();
  return async (message: string, context: GroupQuotedReviewContext): Promise<string | readonly [] | undefined> => {
    const verb = decision.exec(message)?.[1];
    const { groupReviewQuotedRequest, group_id, self_id, user_id, adapter, message_id, reply_id } = context;
    if (!verb || context.message_type !== "group" || context.isDelegated || signal?.aborted || !groupReviewQuotedRequest ||
        !identity(group_id) || !identity(self_id) || !identity(user_id) || !messageId(reply_id) || !messageId(message_id)) return;

    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
    if (seen.has(key)) return [];
    const existing = pending.get(key);
    if (existing) return (await existing) === undefined ? undefined : [];

    const attempt = (async () => {
      try { return decisionReply(await groupReviewQuotedRequest(verb === "同意"), verb); }
      catch { return decisionReply({ status: "unknown" }, verb); }
    })();
    pending.set(key, attempt);
    try {
      const response = await attempt;
      if (response !== undefined) {
        seen.add(key);
        if (seen.size > 2048) {
          const oldest = seen.values().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
      }
      return response;
    } finally { pending.delete(key); }
  };
}
