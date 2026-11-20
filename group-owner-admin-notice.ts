import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerAdminNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly set: boolean;
}

export type GroupOwnerAdminNoticePart = string | { readonly type: "image"; readonly file: string };
export type GroupOwnerAdminNotice = (event: GroupOwnerAdminNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupOwnerAdminNoticePart[] | undefined>;

export const groupOwnerAdminNoticeFeature = "[group] 群管理变动通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerAdminNotice(options: PrivateNoticeOptions): GroupOwnerAdminNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupAdminChange");
  return async ({ botId, groupId, userId, set }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(userId) || typeof set !== "boolean" ||
        !await isEnabled(botId, signal, groupId) || options.signal?.aborted || signal?.aborted) return;

    const self = userId === botId;
    const title = self ? (set ? "机器人被设置管理" : "机器人被取消管理") : (set ? "新增群管理员" : "取消群管理员");
    const parts: GroupOwnerAdminNoticePart[] = [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
      `[通知(${botId}) - ${title}]\n`,
    ];
    if (!self) parts.push(`被操作账号：${userId}\n`);
    parts.push(`被操作群号：${groupId}`);
    return parts;
  };
}
