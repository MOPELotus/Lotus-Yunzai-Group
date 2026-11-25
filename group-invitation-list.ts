import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
const unavailable = $t("group-invitation-list.text_272f803dcf");
const roleNames = { member: $t("group-invitation-list.text_af43d2e34f"), admin: $t("group-invitation-list.text_628153beb4"), owner: $t("group-invitation-list.text_81d4acd17e") } as const;

export function isGroupInvitationListCommand(command: string): boolean {
  return lookup.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function groupInvitationListCommand(command: string, context: GroupInvitationListContext, signal?: AbortSignal): Promise<Reply | undefined> {
  if (context.message_type !== "private" || context.isDelegated || signal?.aborted || !isGroupInvitationListCommand(command)) return;
  const { self_id, user_id, isBotMaster, listPendingGroupInvitations } = context;
  if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return $t("group-invitation-list.text_90e5195857");
  if (!listPendingGroupInvitations) return unavailable;

  try {
    const result = await listPendingGroupInvitations();
    if (signal?.aborted) return;
    if (!result || !Array.isArray(result.entries) || typeof result.complete !== "boolean" ||
        result.entries.some(entry => !entry || !positiveId(entry.groupId) || !positiveId(entry.inviterId))) return unavailable;

    const { complete } = result;
    const entries: readonly PendingGroupInvitation[] = result.entries;
    if (!entries.length) {
      return complete ? $t("group-invitation-list.text_16f81de849") : $t("group-invitation-list.text_93940e80e1");
    }
    const shown = entries.slice(0, maxShown);
    const heading = complete ? $t("group-invitation-list.text_2d8fb3546f", { "length": entries.length }) :
      $t("group-invitation-list.text_d22910bde9", { "length": entries.length });
    const summary = [
      heading,
      ...(shown.length < entries.length ? [$t("group-invitation-list.text_588fd16580", { "length": shown.length })] : []),
    ];
    const nodes = shown.map(({ groupId, groupName, inviterId, nickname, role }): Part[] => [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
      $t("group-invitation-list.text_897485828f", { "groupId": groupId, "value2": displayRequestField(groupName, 128) || $t("group-invitation-list.text_4d8c1c5b42") }) +
      $t("group-invitation-list.text_fe45271e58", { "inviterId": inviterId, "value2": displayRequestField(nickname, 128) || $t("group-invitation-list.text_4d8c1c5b42") }) +
      (role && Object.hasOwn(roleNames, role) ? $t("group-invitation-list.text_bd8cf904d3", { "value1": roleNames[role] }) : ""),
    ]);
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}
