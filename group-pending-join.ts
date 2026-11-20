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

export interface GroupPendingJoinContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly group_id?: number;
  readonly user_id?: number;
  readonly isDelegated?: boolean;
  readonly groupListPendingJoinRequests?: () => Promise<PendingGroupJoins | undefined>;
}

type Part = string | { readonly type: "image"; readonly file: string };
type Reply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Part[])[] };

export const groupPendingJoinFeature = "[group] 加群申请列表";
const lookup = /^#?查看(?:全部)?(?:加|入)?群申请$/u;
const maxShown = 50;
const unavailable = "当前无法核验本群的加群申请，请在 QQ 中查看。";

export function isGroupPendingJoinCommand(message: string): boolean {
  return lookup.test(message);
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
