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

export interface GroupPendingJoinContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly group_id?: number;
  readonly user_id?: number;
  readonly isDelegated?: boolean;
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly groupReviewPendingJoin?: (userId: number, approve: boolean) => Promise<PendingGroupJoinReviewResult>;
  readonly groupListPendingJoinRequests?: () => Promise<PendingGroupJoins | undefined>;
}

type Part = string | { readonly type: "image"; readonly file: string };
type Reply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Part[])[] };

export const groupPendingJoinFeature = "[group] 加群申请列表";
export const groupPendingJoinReviewFeature = "[group] 加群申请审核";
const review = /^#?(同意|拒绝)(?:加|入)?群申请(\d+)$/u;
const lookup = /^#?查看(?:全部)?(?:加|入)?群申请$/u;
const maxShown = 50;
const unavailable = "当前无法核验本群的加群申请，请在 QQ 中查看。";

export function isGroupPendingJoinCommand(message: string): boolean {
  return lookup.test(message);
}

export function isGroupPendingJoinReviewCommand(message: string): boolean {
  return review.test(message);
}

function positiveId(id: number | undefined): boolean {
  return id !== undefined && Number.isSafeInteger(id) && id > 0;
}

function display(value: string | undefined, limit: number): string {
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
      const note = display(tip, 256);
      return [
        { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        `\nQQ：${userId}\n昵称：${display(nickname, 128) || "未知"}` +
        (risk === true ? "\n风险申请，请在 QQ 中处理。" : "") +
        (note ? `\nTips：${note}` : "") +
        `\n附加信息：${display(comment, 512) || "无附加信息"}`,
      ];
    });
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}

const reviewUnavailable = "当前无法按 QQ 核实并审核这条加群申请，请引用原加群通知或在 QQ 中处理。";
const reviewUnknown = "加群申请处理结果未确认，请先在 QQ 核对。";

function reviewReply(result: PendingGroupJoinReviewResult, verb: string, applicant: number): string {
  switch (result.status) {
    case "confirmed": {
      const name = display(result.nickname, 128);
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

export function createGroupPendingJoinReview(signal?: AbortSignal) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();
  return async (message: string, context: GroupPendingJoinContext): Promise<string | readonly [] | undefined> => {
    const match = review.exec(message);
    if (!match || context.message_type !== "group" || context.isDelegated || signal?.aborted) return;
    const { adapter, self_id, group_id, user_id, message_id, groupReviewPendingJoin } = context;
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    if (!nativeId || !positiveId(self_id) || !positiveId(group_id) || !positiveId(user_id) || !groupReviewPendingJoin) {
      return reviewUnavailable;
    }
    const applicant = Number(match[2]);
    if (!positiveId(applicant)) return "请填写有效的申请人 QQ 号。";

    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
    if (inFlight.has(key) || seen.has(key)) return [];
    inFlight.add(key);
    const verb = match[1] === "同意" ? "同意" : "拒绝";
    try {
      return reviewReply(await groupReviewPendingJoin(applicant, verb === "同意"), verb, applicant);
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
