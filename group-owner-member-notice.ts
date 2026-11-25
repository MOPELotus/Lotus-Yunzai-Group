import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

interface MemberDisplay {
  readonly groupName?: string;
  readonly nickname?: string;
  readonly card?: string;
}

export interface GroupOwnerMemberNoticeInput extends MemberDisplay {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly direction: "increase" | "decrease";
  readonly action?: string;
  readonly dismiss?: boolean;
  readonly time?: number;
  readonly inviterId?: number;
  readonly describe?: () => Promise<MemberDisplay>;
}

export type GroupOwnerMemberNotice = (event: GroupOwnerMemberNoticeInput, signal?: AbortSignal) =>
  Promise<string | undefined>;

export const groupOwnerMemberNoticeFeature = "[group] 群成员变动通知";

const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function formatGroupNoticeTime(timestampMs: number): string {
  return shanghaiTime.format(timestampMs);
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerMemberNotice(options: PrivateNoticeOptions): GroupOwnerMemberNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupMemberNumberChange");
  return async ({ botId, groupId, userId, direction, action, dismiss, time, groupName, nickname, card, inviterId, describe }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(userId) || botId === userId ||
        dismiss || action === "disband" || action === "kick_me" || (direction !== "increase" && direction !== "decrease") ||
        !await isEnabled(botId, signal, groupId) || options.signal?.aborted || signal?.aborted) return;

    const details = await describe?.();
    if (options.signal?.aborted || signal?.aborted) return;
    const name = displayRequestField(nickname ?? details?.nickname, 128);
    const displayCard = displayRequestField(card ?? details?.card, 128);
    const timestamp = time !== undefined && positiveId(time) && time <= 8_640_000_000_000 ? time * 1_000 : Date.now();
    const lines = [
      direction === "increase" ? $t("group-owner-member-notice.text_9051fddcc2") : $t("group-owner-member-notice.text_78369cbbac"),
      "────────────",
      $t("group-owner-member-notice.text_5bfa724a8c", { "value1": displayRequestField(groupName ?? details?.groupName, 128) || $t("group-owner-member-notice.text_1b6b59544b") }),
      $t("group-owner-member-notice.text_64bbec1614", { "groupId": groupId }),
      $t("group-owner-member-notice.text_df572f6429", { "value1": name ? `${name}（${userId}）` : userId }),
    ];
    if (displayCard && displayCard !== name) lines.push($t("group-owner-member-notice.text_3832f15144", { "displayCard": displayCard }));
    if (direction === "increase") {
      if (action === "invite") lines.push($t("group-owner-member-notice.text_a2fef33cce"));
      if (action === "approve") lines.push($t("group-owner-member-notice.text_9676b62fed"));
      if (inviterId !== undefined && positiveId(inviterId)) lines.push($t("group-owner-member-notice.text_770ec6e737", { "inviterId": inviterId }));
    }
    lines.push("", $t("group-owner-member-notice.text_bfc7ca3615", { "value1": formatGroupNoticeTime(timestamp) }), $t("group-owner-member-notice.text_e0048482bb", { "botId": botId }));
    return lines.join("\n");
  };
}
