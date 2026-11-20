import { formatNoticeBodyText, readMessageNoticeParts, type MessageNoticePart, type ReadMessageNoticeParts } from "./message-notice-content.ts";
import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupMessageNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly text?: string;
  readonly readParts?: ReadMessageNoticeParts;
  readonly nickname?: string;
  readonly describeGroup?: () => Promise<string | undefined>;
}
export type GroupMessageNoticePart = MessageNoticePart;
export type GroupMessageNotice = (message: GroupMessageNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupMessageNoticePart[] | undefined>;

export const groupMessageNoticeFeature = "[group] 群消息通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createGroupMessageNotice(options: PrivateNoticeOptions): GroupMessageNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupMessage");
  return async ({ botId, groupId, userId, text, readParts, nickname, describeGroup }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(userId) || botId === userId) return;
    const textOnly = !readParts && typeof text === "string" ? formatNoticeBodyText(text) : "";
    if ((!readParts && !textOnly.trim()) || !await isEnabled(botId, signal, groupId) || options.signal?.aborted || signal?.aborted) return;
    const content = readParts ? await readMessageNoticeParts(readParts) : [textOnly];
    if (!content || options.signal?.aborted || signal?.aborted) return;

    let groupName: string | undefined;
    if (describeGroup) {
      try { groupName = displayRequestField(await describeGroup(), 128); } catch { /* The group number is still known. */ }
    }
    if (options.signal?.aborted || signal?.aborted) return;

    return [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
      `[消息(${botId}) - 群聊消息]\n`,
      `来源群号：${groupId}\n`,
      `来源群名：${groupName || "未知"}\n`,
      `发送人账号：${userId}\n`,
      `发送人昵称：${displayRequestField(nickname, 128) || "未知"}\n`,
      "消息内容：",
      ...content,
    ];
  };
}
