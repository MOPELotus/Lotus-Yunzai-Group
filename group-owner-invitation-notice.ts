import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerInvitationNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly groupName?: string;
  readonly nickname?: string;
}
export type GroupOwnerInvitationNoticePart = string | { readonly type: "image"; readonly file: string };
export type GroupOwnerInvitationNotice = (input: GroupOwnerInvitationNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupOwnerInvitationNoticePart[] | undefined>;

export const groupOwnerInvitationNoticeFeature = "[group] 群邀请主人通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerInvitationNotice(options: PrivateNoticeOptions): GroupOwnerInvitationNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupInviteRequest");
  return async ({ botId, groupId, userId, groupName, nickname }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(userId) || botId === userId ||
        !await isEnabled(botId, signal, groupId) || options.signal?.aborted || signal?.aborted) return;

    return [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/0` },
      `[通知(${botId}) - 邀请机器人进群]\n`,
      `目标群号：${groupId}\n`,
      `目标群名：${displayRequestField(groupName, 128) || "未知"}\n`,
      `邀请人账号：${userId}\n`,
      `邀请人昵称：${displayRequestField(nickname, 128) || "未知"}\n`,
      "邀请人群身份：未知\n",
    ];
  };
}
