import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
      $t("group-owner-invitation-notice.text_05a49ee594", { "botId": botId }),
      $t("group-owner-invitation-notice.text_b70105504b", { "groupId": groupId }),
      $t("group-owner-invitation-notice.text_b031c1acd4", { "value1": displayRequestField(groupName, 128) || $t("group-owner-invitation-notice.text_4d8c1c5b42") }),
      $t("group-owner-invitation-notice.text_faa7cd8023", { "userId": userId }),
      $t("group-owner-invitation-notice.text_ea5aeefbc6", { "value1": displayRequestField(nickname, 128) || $t("group-owner-invitation-notice.text_4d8c1c5b42") }),
      $t("group-owner-invitation-notice.text_91857d9964"),
    ];
  };
}
