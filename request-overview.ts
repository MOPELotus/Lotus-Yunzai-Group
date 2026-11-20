import type { FriendRequestListContext } from "./friend-request-list.ts";
import type { GroupInvitationListContext } from "./group-invitation-list.ts";
import type { GroupPendingJoinContext } from "./group-pending-join.ts";

type OverviewContext = Pick<FriendRequestListContext, "message_type" | "self_id" | "user_id" | "isDelegated" |
  "isBotMaster" | "listPendingFriendRequests"> &
  Pick<GroupInvitationListContext, "listPendingGroupInvitations"> &
  Pick<GroupPendingJoinContext, "group_id" | "groupListPendingJoinRequests">;
type Snapshot = { readonly entries: readonly unknown[]; readonly complete: boolean };
type OverviewReply = string | { readonly type: "forward"; readonly nodes: readonly (readonly string[])[] };

export const requestOverviewFeature = "[group] 请求总览";
const lookup = /^#?查看全部请求$/u;

export function isRequestOverviewCommand(command: string): boolean {
  return lookup.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function summary(label: string, detail: string, read?: () => Promise<Snapshot | undefined>): Promise<string> {
  try {
    const result = await read?.();
    if (result && Array.isArray(result.entries) && typeof result.complete === "boolean") {
      const count = result.entries.length;
      const status = result.complete ? `${count} 条` :
        count > 0 ? `本次查到 ${count} 条，未能核验完整列表` : "本次查询范围内未发现，未能核验完整列表";
      return `${label}：${status}` + (count > 0 ? `\n可使用 ${detail} 查看详情` : "");
    }
  } catch { /* Other request categories may still be available. */ }
  return `${label}：未核实`;
}

export async function requestOverviewCommand(command: string, context: OverviewContext, signal?: AbortSignal): Promise<OverviewReply | undefined> {
  if (!isRequestOverviewCommand(command) || context.message_type === "terminal" || context.isDelegated || signal?.aborted) return;
  const { self_id, user_id, isBotMaster } = context;
  if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "仅当前机器人的主人可查看请求总览。";

  let rows: string[];
  if (context.message_type === "group") {
    if (!positiveId(context.group_id)) return;
    rows = [await summary("当前群申请", "#查看加群申请", context.groupListPendingJoinRequests)];
  } else {
    rows = await Promise.all([
      summary("好友申请", "#查看好友申请", context.listPendingFriendRequests),
      summary("群邀请", "#查看群邀请", context.listPendingGroupInvitations),
    ]);
    rows.push("单向好友：未核实");
  }

  if (signal?.aborted || !isBotMaster(user_id)) return;
  return { type: "forward", nodes: [["以下为暂未处理的请求"], ...rows.map(row => [row])] };
}
