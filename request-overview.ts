import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
      const status = result.complete ? $t("request-overview.text_92559c8f27", { "count": count }) :
        count > 0 ? $t("request-overview.text_12e6915279", { "count": count }) : $t("request-overview.text_739389c5f9");
      return `${label}：${status}` + (count > 0 ? $t("request-overview.text_e670a464b8", { "detail": detail }) : "");
    }
  } catch { /* Other request categories may still be available. */ }
  return $t("request-overview.text_3206286770", { "label": label });
}

export async function requestOverviewCommand(command: string, context: OverviewContext, signal?: AbortSignal): Promise<OverviewReply | undefined> {
  if (!isRequestOverviewCommand(command) || context.message_type === "terminal" || context.isDelegated || signal?.aborted) return;
  const { self_id, user_id, isBotMaster } = context;
  if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return $t("request-overview.text_e2f62b93d2");

  let rows: string[];
  if (context.message_type === "group") {
    if (!positiveId(context.group_id)) return;
    rows = [await summary($t("request-overview.text_9716c7867a"), "#查看加群申请", context.groupListPendingJoinRequests)];
  } else {
    rows = await Promise.all([
      summary($t("request-overview.text_74d9ad48d6"), "#查看好友申请", context.listPendingFriendRequests),
      summary($t("request-overview.text_ad3e7e8fd5"), "#查看群邀请", context.listPendingGroupInvitations),
    ]);
    rows.push($t("request-overview.text_f27c7bf063"));
  }

  if (signal?.aborted || !isBotMaster(user_id)) return;
  return { type: "forward", nodes: [[$t("request-overview.text_e6a10aacbc")], ...rows.map(row => [row])] };
}
