import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
export interface PendingGroupJoin {
  readonly userId: number;
  readonly nickname?: string;
  readonly comment?: string;
  readonly tip?: string;
  readonly risk?: boolean;
}

export interface PendingGroupJoins {
  readonly entries: readonly PendingGroupJoin[];
  readonly complete: boolean;
}

export interface PendingGroupJoinReviewResult {
  readonly status: "confirmed" | "rejected" | "unknown" | "unavailable" | "not-found" | "ambiguous" | "risk" | "expired";
  readonly nickname?: string;
}

type BatchReviewStatus = "confirmed" | "rejected" | "unknown" | "unavailable" | "risk" | "expired";

export interface PendingGroupJoinBatchResult {
  readonly status: "processed" | "unavailable" | "not-found";
  readonly entries?: readonly { readonly userId: number; readonly status: BatchReviewStatus }[];
}

export interface GroupPendingJoinContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly group_id?: number;
  readonly user_id?: number;
  readonly isDelegated?: boolean;
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly groupReviewPendingJoin?: (userId: number, approve: boolean) => Promise<PendingGroupJoinReviewResult>;
  readonly groupReviewAllPendingJoins?: (approve: boolean) => Promise<PendingGroupJoinBatchResult>;
  readonly groupListPendingJoinRequests?: () => Promise<PendingGroupJoins | undefined>;
}

type Part = string | { readonly type: "image"; readonly file: string };
type Reply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Part[])[] };

export const groupPendingJoinFeature = "[group] 加群申请列表";
export const groupPendingJoinReviewFeature = "[group] 加群申请审核";
const review = /^#?(同意|拒绝)(?:加|入)?群申请(\d+)$/u;
const reviewAll = /^#?(同意|拒绝)全部(?:加|入)?群申请$/u;
const lookup = /^#?查看(?:全部)?(?:加|入)?群申请$/u;
const maxShown = 50;
const unavailable = $t("group-pending-join.text_fd8660b736");

export function isGroupPendingJoinCommand(message: string): boolean {
  return lookup.test(message);
}

export function isGroupPendingJoinReviewCommand(message: string): boolean {
  return review.test(message) || reviewAll.test(message);
}

function positiveId(id: number | undefined): boolean {
  return id !== undefined && Number.isSafeInteger(id) && id > 0;
}

export function displayRequestField(value: string | undefined, limit: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.slice(0, limit * 2)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
  return cleaned.length > limit ? cleaned.slice(0, limit - 1).toWellFormed() + "…" : cleaned.toWellFormed();
}

export async function groupPendingJoinCommand(message: string, context: GroupPendingJoinContext, signal?: AbortSignal): Promise<Reply | undefined> {
  if (context.message_type !== "group" || !isGroupPendingJoinCommand(message)) return;
  const { self_id, group_id, user_id, groupListPendingJoinRequests } = context;
  if (context.isDelegated || signal?.aborted || !positiveId(self_id) || !positiveId(group_id) ||
      !positiveId(user_id) || !groupListPendingJoinRequests) return unavailable;

  try {
    const result = await groupListPendingJoinRequests();
    if (signal?.aborted) return;
    if (!result || !Array.isArray(result.entries) || typeof result.complete !== "boolean" ||
        result.entries.some(entry => !entry || !positiveId(entry.userId))) return unavailable;

    const { entries, complete } = result;
    if (!entries.length) return complete ? $t("group-pending-join.text_7f37189c6c") :
      $t("group-pending-join.text_405fdfb59a");

    const shown = entries.slice(0, maxShown);
    const heading = complete ? $t("group-pending-join.text_effe03effd", { "length": entries.length }) :
      $t("group-pending-join.text_226af6cc05", { "length": entries.length });
    const summary = [
      heading,
      ...(shown.length < entries.length ? [$t("group-pending-join.text_8259da8992", { "length": shown.length })] : []),
    ];
    const nodes = shown.map(({ userId, nickname, comment, tip, risk }): Part[] => {
      const note = displayRequestField(tip, 256);
      return [
        { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        $t("group-pending-join.text_ce7c0f9436", { "userId": userId, "value2": displayRequestField(nickname, 128) || $t("group-pending-join.text_4d8c1c5b42") }) +
        (risk === true ? $t("group-pending-join.text_dad8fb9cfc") : "") +
        (note ? `\nTips：${note}` : "") +
        $t("group-pending-join.text_8b328b830a", { "value1": displayRequestField(comment, 512) || $t("group-pending-join.text_d67cd0210e") }),
      ];
    });
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}

const reviewUnavailable = $t("group-pending-join.text_b405cff8d7");
const batchUnavailable = $t("group-pending-join.text_87fa90add5");
const reviewUnknown = $t("group-pending-join.text_f956eda5d4");

function reviewReply(result: PendingGroupJoinReviewResult, verb: string, applicant: number): string {
  switch (result.status) {
    case "confirmed": {
      const name = displayRequestField(result.nickname, 128);
      return $t("group-pending-join.text_4a76ccc820", { "verb": verb, "value2": name ? `${name}(${applicant})` : applicant });
    }
    case "rejected": return $t("group-pending-join.text_2c8239c6ae");
    case "not-found": return $t("group-pending-join.text_14903b8370");
    case "ambiguous": return $t("group-pending-join.text_5d3ec98b49");
    case "risk": return $t("group-pending-join.text_f8693f4988");
    case "expired": return $t("group-pending-join.text_8a28483bab");
    case "unavailable": return reviewUnavailable;
    default: return reviewUnknown;
  }
}

function batchReviewReply(result: PendingGroupJoinBatchResult, verb: string): Reply {
  if (result.status === "unavailable") return batchUnavailable;
  if (result.status === "not-found") return $t("group-pending-join.text_7f37189c6c");
  if (result.status !== "processed" || !Array.isArray(result.entries) || !result.entries.length) return reviewUnknown;

  const labels = {
    confirmed: $t("group-pending-join.text_597ee8e766", { "verb": verb }),
    rejected: $t("group-pending-join.text_28384d7afd"),
    risk: $t("group-pending-join.text_af75e78cac"),
    unknown: $t("group-pending-join.text_fb7e71452c"),
    unavailable: $t("group-pending-join.text_83fbf42f9e"),
    expired: $t("group-pending-join.text_83fbf42f9e"),
  } satisfies Record<BatchReviewStatus, string>;
  const rows = new Map([...new Set(Object.values(labels))].map(label => [label, [] as string[]]));
  for (const entry of result.entries) {
    if (!entry || !positiveId(entry.userId) || !Object.hasOwn(labels, entry.status)) return reviewUnknown;
    const status = entry.status as BatchReviewStatus;
    const id = String(entry.userId);
    rows.get(labels[status])?.push(status === "expired" ? $t("group-pending-join.text_9391be06da", { "id": id }) : id);
  }

  const summary = [$t("group-pending-join.text_bd409adca9", { "length": result.entries.length }),
    ...[...rows].map(([label, items]) => $t("group-pending-join.text_f8a770e14e", { "label": label, "length": items.length }))].join("\n");
  const nodes = [...rows].filter(([, items]) => items.length).map(([label, items]) => {
    const shown = items.slice(0, maxShown).map((item, index) => `${index + 1}、${item}`);
    if (items.length > shown.length) shown.push($t("group-pending-join.text_593c328a9d", { "value1": items.length - shown.length }));
    return [$t("group-pending-join.text_e9339d3412", { "label": label, "value2": shown.join("\n") })];
  });
  return { type: "forward", nodes: [[summary], ...nodes] };
}

export function createGroupPendingJoinReview(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();
  return async (message: string, context: GroupPendingJoinContext): Promise<Reply | readonly [] | undefined> => {
    const batch = reviewAll.exec(message);
    const match = batch ?? review.exec(message);
    if (!match || context.message_type !== "group" || context.isDelegated || signal?.aborted) return;
    const { adapter, self_id, group_id, user_id, message_id, groupReviewPendingJoin, groupReviewAllPendingJoins } = context;
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    if (!nativeId || !positiveId(self_id) || !positiveId(group_id) || !positiveId(user_id) ||
        (batch ? !groupReviewAllPendingJoins : !groupReviewPendingJoin)) {
      return batch ? batchUnavailable : reviewUnavailable;
    }
    const applicant = Number(match[2]);
    if (!batch && !positiveId(applicant)) return $t("group-pending-join.text_d7c9ed2121");

    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const approve = match[1] === "同意";
    const verb = approve ? $t("group-pending-join.text_905819e2e3") : $t("group-pending-join.text_136de7a8c4");
    try {
      if (batch) {
        const result = await groupReviewAllPendingJoins?.(approve);
        return result ? batchReviewReply(result, verb) : reviewUnknown;
      }
      const result = await groupReviewPendingJoin?.(applicant, approve);
      return result ? reviewReply(result, verb, applicant) : reviewUnknown;
    } catch {
      return reviewUnknown;
    } finally {
      inFlight.delete(key);
      seen.add(key);
      if (seen.size > 2048) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
    }
  };
}
