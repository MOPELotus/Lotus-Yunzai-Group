import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerJoinRequestNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly groupName?: string;
  readonly nickname?: string;
  readonly comment?: string;
}
export type GroupOwnerJoinRequestNoticePart = string | { readonly type: "image"; readonly file: string };
export type GroupOwnerJoinRequestNotice = (input: GroupOwnerJoinRequestNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupOwnerJoinRequestNoticePart[] | undefined>;

export const groupOwnerJoinRequestNoticeFeature = "[group] 加群申请主人通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerJoinRequestNotice(options: PrivateNoticeOptions): GroupOwnerJoinRequestNotice {
  const isEnabled = createPrivateNoticeSettings(options, "addGroupApplication");
  return async ({ botId, groupId, userId, groupName, nickname, comment }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(userId) || botId === userId ||
        !await isEnabled(botId, signal, groupId) || options.signal?.aborted || signal?.aborted) return;

    return [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/0` },
      `[通知(${botId}) - 加群申请]\n`,
      `群号：${groupId}\n`,
      `群名：${displayRequestField(groupName, 128) || "未知"}\n`,
      `账号：${userId}\n`,
      `昵称：${displayRequestField(nickname, 128) || "未知"}`,
      `\n附言：${displayRequestField(comment, 512) || "无附加信息"}`,
    ];
  };
}
