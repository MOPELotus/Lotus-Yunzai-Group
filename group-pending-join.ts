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
const reviewAll = /^#?(同意|拒绝)全部(?:加|入)群申请$/u;
const lookup = /^#?查看(?:全部)?(?:加|入)?群申请$/u;
const maxShown = 50;
const unavailable = "当前无法核验本群的加群申请，请在 QQ 中查看。";

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
    if (!entries.length) return complete ? "暂无加群申请(。-ω-)zzz" :
      "本次查询范围内未发现待处理的加群申请，未能核验完整列表，请在 QQ 中查看。";

    const shown = entries.slice(0, maxShown);
    const heading = complete ? `现有未处理的加群申请如下，共 ${entries.length} 条` :
      `本次查到 ${entries.length} 条待处理加群申请，未能核验完整列表`;
    const summary = [
      heading,
      ...(shown.length < entries.length ? [`\n仅展示前 ${shown.length} 条，请在 QQ 中查看其余申请。`] : []),
    ];
    const nodes = shown.map(({ userId, nickname, comment, tip, risk }): Part[] => {
      const note = displayRequestField(tip, 256);
      return [
        { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        `\nQQ：${userId}\n昵称：${displayRequestField(nickname, 128) || "未知"}` +
        (risk === true ? "\n风险申请，请在 QQ 中处理。" : "") +
        (note ? `\nTips：${note}` : "") +
        `\n附加信息：${displayRequestField(comment, 512) || "无附加信息"}`,
      ];
    });
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}

const reviewUnavailable = "当前无法按 QQ 核实并审核这条加群申请，请引用原加群通知或在 QQ 中处理。";
const batchUnavailable = "当前无法核验本群的完整待审列表，不能批量审核。请引用原加群通知或在 QQ 中处理。";
const reviewUnknown = "加群申请处理结果未确认，请先在 QQ 核对。";

function reviewReply(result: PendingGroupJoinReviewResult, verb: string, applicant: number): string {
  switch (result.status) {
    case "confirmed": {
      const name = displayRequestField(result.nickname, 128);
      return `已${verb}${name ? `${name}(${applicant})` : applicant}的加群申请辣٩(๑^o^๑)۶`;
    }
    case "rejected": return "呜呜呜，处理失败辣(இωஇ)，协议端拒绝了这次审核。";
    case "not-found": return "呜呜呜，没找到这个淫的加群申请(つд⊂)";
    case "ambiguous": return "这个 QQ 有多条待处理的加群申请，请引用相应的原加群通知或在 QQ 中处理。";
    case "risk": return "该账号为风险账号请手动处理哦ಠ~ಠ";
    case "expired": return "这条加群申请已过期或已处理，请在 QQ 中核对。";
    case "unavailable": return reviewUnavailable;
    default: return reviewUnknown;
  }
}

function batchReviewReply(result: PendingGroupJoinBatchResult, verb: string): Reply {
  if (result.status === "unavailable") return batchUnavailable;
  if (result.status === "not-found") return "暂无加群申请(。-ω-)zzz";
  if (result.status !== "processed" || !Array.isArray(result.entries) || !result.entries.length) return reviewUnknown;

  const labels = {
    confirmed: `已${verb}`,
    rejected: "失败",
    risk: "风险",
    unknown: "结果未知",
    unavailable: "未处理",
    expired: "未处理",
  } satisfies Record<BatchReviewStatus, string>;
  const rows = new Map([...new Set(Object.values(labels))].map(label => [label, [] as string[]]));
  for (const entry of result.entries) {
    if (!entry || !positiveId(entry.userId) || !Object.hasOwn(labels, entry.status)) return reviewUnknown;
    const status = entry.status as BatchReviewStatus;
    const id = String(entry.userId);
    rows.get(labels[status])?.push(status === "expired" ? `${id}（已过期或已处理）` : id);
  }

  const summary = [`本次共核对 ${result.entries.length} 条加群申请`,
    ...[...rows].map(([label, items]) => `${label}：${items.length} 条`)].join("\n");
  const nodes = [...rows].filter(([, items]) => items.length).map(([label, items]) => {
    const shown = items.slice(0, maxShown).map((item, index) => `${index + 1}、${item}`);
    if (items.length > shown.length) shown.push(`另有 ${items.length - shown.length} 条，详见 QQ。`);
    return [`${label}名单\n${shown.join("\n")}`];
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
    if (!batch && !positiveId(applicant)) return "请填写有效的申请人 QQ 号。";

    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const verb = match[1] === "同意" ? "同意" : "拒绝";
    try {
      if (batch) {
        const result = await groupReviewAllPendingJoins?.(verb === "同意");
        return result ? batchReviewReply(result, verb) : reviewUnknown;
      }
      const result = await groupReviewPendingJoin?.(applicant, verb === "同意");
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
