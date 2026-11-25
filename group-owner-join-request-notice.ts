import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
      $t("group-owner-join-request-notice.text_89d5765416", { "botId": botId }),
      $t("group-owner-join-request-notice.text_94afa695be", { "groupId": groupId }),
      $t("group-owner-join-request-notice.text_fd113754ab", { "value1": displayRequestField(groupName, 128) || $t("group-owner-join-request-notice.text_4d8c1c5b42") }),
      $t("group-owner-join-request-notice.text_57f576fae6", { "userId": userId }),
      $t("group-owner-join-request-notice.text_7c16f27f89", { "value1": displayRequestField(nickname, 128) || $t("group-owner-join-request-notice.text_4d8c1c5b42") }),
      $t("group-owner-join-request-notice.text_5d779b4638", { "value1": displayRequestField(comment, 512) || $t("group-owner-join-request-notice.text_d67cd0210e") }),
    ];
  };
}
