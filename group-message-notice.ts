import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
      $t("group-message-notice.text_9e90ae4f85", { "botId": botId }),
      $t("group-message-notice.text_d8c98c9c97", { "groupId": groupId }),
      $t("group-message-notice.text_57923cdce7", { "value1": groupName || $t("group-message-notice.text_4d8c1c5b42") }),
      $t("group-message-notice.text_4f25f2b199", { "userId": userId }),
      $t("group-message-notice.text_668b44003e", { "value1": displayRequestField(nickname, 128) || $t("group-message-notice.text_4d8c1c5b42") }),
      $t("group-message-notice.text_34c8fc816b"),
      ...content,
    ];
  };
}
