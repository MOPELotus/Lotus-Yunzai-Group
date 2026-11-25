import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { formatNoticeBodyText, readMessageNoticeParts, type MessageNoticePart, type ReadMessageNoticeParts } from "./message-notice-content.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type TemporaryMessageNoticePart = MessageNoticePart;
export interface TemporaryMessageNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly text?: string;
  readonly readParts?: ReadMessageNoticeParts;
  readonly groupId?: number;
  readonly reportedGroupId?: number;
}
export type TemporaryMessageNotice = (message: TemporaryMessageNoticeInput, signal?: AbortSignal) =>
  Promise<readonly TemporaryMessageNoticePart[] | undefined>;

export const temporaryMessageNoticeFeature = "[group] 群临时消息通知";

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createTemporaryMessageNotice(options: PrivateNoticeOptions): TemporaryMessageNotice {
  const isEnabled = createPrivateNoticeSettings(options, "grouptemporaryMessage");
  return async ({ botId, userId, text, readParts, groupId, reportedGroupId }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId) return;
    const textOnly = !readParts && typeof text === "string" ? formatNoticeBodyText(text) : "";
    const group = positiveId(groupId) ? groupId : undefined;
    if ((!readParts && !textOnly.trim()) || !await isEnabled(botId, signal, group) || options.signal?.aborted || signal?.aborted) return;
    const content = readParts ? await readMessageNoticeParts(readParts) : [textOnly];
    if (!content || options.signal?.aborted || signal?.aborted) return;

    const source = group ?? (positiveId(reportedGroupId) ? $t("temporary-message-notice.text_0c4d421224", { "reportedGroupId": reportedGroupId }) : $t("temporary-message-notice.text_433b841fe3"));
    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      $t("temporary-message-notice.text_0d8ac3f352", { "botId": botId }),
      $t("temporary-message-notice.text_eaae0032b0", { "source": source }),
      $t("temporary-message-notice.text_4f25f2b199", { "userId": userId }),
      $t("temporary-message-notice.text_34c8fc816b"), ...content,
    ];
  };
}
