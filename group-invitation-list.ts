import { displayRequestField } from "./group-pending-join.ts";

export interface PendingGroupInvitation {
  readonly groupId: number;
  readonly groupName?: string;
  readonly inviterId: number;
  readonly nickname?: string;
  readonly role?: "member" | "admin" | "owner";
}

export interface PendingGroupInvitations {
  readonly entries: readonly PendingGroupInvitation[];
  readonly complete: boolean;
}

export interface GroupInvitationListContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly isDelegated?: boolean;
  readonly isBotMaster: (userId: number) => boolean;
  readonly listPendingGroupInvitations?: () => Promise<PendingGroupInvitations | undefined>;
}

type Part = string | { readonly type: "image"; readonly file: string };
type Reply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Part[])[] };

export const groupInvitationListFeature = "[group] 群邀请列表";
const lookup = /^#?查看(?:全部)?群邀请$/u;
const maxShown = 50;
const unavailable = "当前无法核验该机器人的群邀请，请在 QQ 中查看。";
const roleNames = { member: "群员", admin: "群管理", owner: "群主" } as const;

export function isGroupInvitationListCommand(command: string): boolean {
  return lookup.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function groupInvitationListCommand(command: string, context: GroupInvitationListContext, signal?: AbortSignal): Promise<Reply | undefined> {
  if (context.message_type !== "private" || context.isDelegated || signal?.aborted || !isGroupInvitationListCommand(command)) return;
  const { self_id, user_id, isBotMaster, listPendingGroupInvitations } = context;
  if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return "请由当前机器人的主人私聊查看群邀请。";
  if (!listPendingGroupInvitations) return unavailable;

  try {
    const result = await listPendingGroupInvitations();
    if (signal?.aborted) return;
    if (!result || !Array.isArray(result.entries) || typeof result.complete !== "boolean" ||
        result.entries.some(entry => !entry || !positiveId(entry.groupId) || !positiveId(entry.inviterId))) return unavailable;

    const { complete } = result;
    const entries: readonly PendingGroupInvitation[] = result.entries;
    if (!entries.length) {
      return complete ? "暂无群邀请哦(。-ω-)zzz" : "本次查询范围内未发现待处理的群邀请，未能核验完整列表，请在 QQ 中查看。";
    }
    const shown = entries.slice(0, maxShown);
    const heading = complete ? `现有未处理的群邀请如下，共 ${entries.length} 条` :
      `本次查到 ${entries.length} 条待处理群邀请，未能核验完整列表`;
    const summary = [
      heading,
      ...(shown.length < entries.length ? [`\n仅展示前 ${shown.length} 条，请在 QQ 中查看其余邀请。`] : []),
    ];
    const nodes = shown.map(({ groupId, groupName, inviterId, nickname, role }): Part[] => [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
      `\n邀请群号：${groupId}\n邀请群名：${displayRequestField(groupName, 128) || "未知"}` +
      `\n邀请人QQ：${inviterId}\n邀请人昵称：${displayRequestField(nickname, 128) || "未知"}` +
      (role && Object.hasOwn(roleNames, role) ? `\n邀请人身份：${roleNames[role]}` : ""),
    ]);
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}
