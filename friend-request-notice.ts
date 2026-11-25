import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { configuredPrivateNotice, createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";
import { displayRequestField } from "./group-pending-join.ts";

export type FriendRequestNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRequestNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly nickname?: string;
  readonly source?: string;
  readonly comment?: string;
  readonly autoResult?: "confirmed" | "rejected" | "unknown";
}
export type FriendRequestNoticeOptions = PrivateNoticeOptions;

export type FriendRequestNotice = (request: FriendRequestNoticeInput, signal?: AbortSignal) => Promise<readonly FriendRequestNoticePart[] | undefined>;

export const friendRequestNoticeFeature = "[group] 好友申请通知";

export function configuredFriendRequestNotice(value: unknown, botId: number): boolean {
  return configuredPrivateNotice(value, botId, "friendRequest");
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function status(result: FriendRequestNoticeInput["autoResult"]): string | undefined {
  switch (result) {
    case "confirmed": return $t("friend-request-notice.text_9df4a97a6b");
    case "rejected": return $t("friend-request-notice.text_91b32d7e24");
    case "unknown": return $t("friend-request-notice.text_373678a285");
  }
}

export function createFriendRequestNotice(options: FriendRequestNoticeOptions): FriendRequestNotice {
  const isEnabled = createPrivateNoticeSettings(options, "friendRequest");
  return async (request, signal) => {
    const { botId, userId, nickname, source, comment, autoResult } = request;
    if (!positiveId(botId) || !positiveId(userId) || botId === userId || !await isEnabled(botId, signal) ||
        options.signal?.aborted || signal?.aborted) return;

    const result = status(autoResult);
    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      $t("friend-request-notice.text_8f3453d252", { "botId": botId }),
      $t("friend-request-notice.text_ab396461c0", { "userId": userId }),
      $t("friend-request-notice.text_7432151306", { "value1": displayRequestField(nickname, 128) || $t("friend-request-notice.text_4d8c1c5b42") }),
      $t("friend-request-notice.text_eefb7113fb", { "value1": displayRequestField(source, 256) || $t("friend-request-notice.text_4d8c1c5b42") }),
      $t("friend-request-notice.text_cd8c63c469", { "value1": displayRequestField(comment, 512) || $t("friend-request-notice.text_d67cd0210e") }),
      ...(result ? [`${result}\n`] : []),
      $t("friend-request-notice.text_9785ebc975"),
    ];
  };
}
