import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
    const title = self ? (set ? $t("group-owner-admin-notice.text_75ceaf6b5c") : $t("group-owner-admin-notice.text_b057c168a9")) : (set ? $t("group-owner-admin-notice.text_5f5f570d88") : $t("group-owner-admin-notice.text_633104b616"));
    const parts: GroupOwnerAdminNoticePart[] = [
      { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
      $t("group-owner-admin-notice.text_450bbee8b8", { "botId": botId, "title": title }),
    ];
    if (!self) parts.push($t("group-owner-admin-notice.text_659b0e8718", { "userId": userId }));
    parts.push($t("group-owner-admin-notice.text_2209785716", { "groupId": groupId }));
    return parts;
  };
}
