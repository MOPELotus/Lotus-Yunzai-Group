import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendRelationshipNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRelationshipNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly kind: "increase" | "decrease";
  readonly nickname?: string;
  readonly readNickname?: () => Promise<string | undefined>;
}
export type FriendRelationshipNotice = (event: FriendRelationshipNoticeInput, signal?: AbortSignal) =>
  Promise<readonly FriendRelationshipNoticePart[] | undefined>;

export const friendRelationshipNoticeFeature = "[group] 好友增减通知";
const titles = { increase: $t("friend-relationship-notice.text_3a4e7852ea"), decrease: $t("friend-relationship-notice.text_f845e0cdfa") } as const;

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createFriendRelationshipNotice(options: PrivateNoticeOptions): FriendRelationshipNotice {
  const isEnabled = createPrivateNoticeSettings(options, "friendNumberChange");
  return async ({ botId, userId, kind, nickname, readNickname }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId || !Object.hasOwn(titles, kind) ||
        !await isEnabled(botId, signal) || options.signal?.aborted || signal?.aborted) return;

    let name = displayRequestField(nickname, 128);
    if (!name && readNickname) {
      try { name = displayRequestField(await readNickname(), 128); } catch { /* The account number is still known. */ }
    }
    if (options.signal?.aborted || signal?.aborted) return;

    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      $t("friend-relationship-notice.text_0d2eb9c771", { "botId": botId, "value2": titles[kind] }),
      $t("friend-relationship-notice.text_36000fb53f", { "userId": userId }),
      $t("friend-relationship-notice.text_1a8679d6bb", { "value1": name || $t("friend-relationship-notice.text_4d8c1c5b42") }),
    ];
  };
}
