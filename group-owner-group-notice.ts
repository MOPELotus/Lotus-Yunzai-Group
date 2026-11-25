import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { formatGroupNoticeTime } from "./group-owner-member-notice.ts";
import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerGroupNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly kind: "joined" | "left" | "removed" | "dissolved" | "departed";
  readonly operatorId?: number;
  readonly groupName?: string;
  readonly describe?: () => Promise<string | undefined>;
  readonly time: number;
}
export type GroupOwnerGroupNotice = (event: GroupOwnerGroupNoticeInput, signal?: AbortSignal) => Promise<string | undefined>;

export const groupOwnerGroupNoticeFeature = "[group] 群聊列表变动通知";
const titles = {
  joined: $t("group-owner-group-notice.text_fe68ee6c6e"),
  left: $t("group-owner-group-notice.text_6b788db055"),
  removed: $t("group-owner-group-notice.text_bb45c39ec7"),
  dissolved: $t("group-owner-group-notice.text_887474db24"),
  departed: $t("group-owner-group-notice.text_cc3929ad37"),
} as const;

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerGroupNotice(options: PrivateNoticeOptions): GroupOwnerGroupNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupNumberChange");
  return async ({ botId, groupId, kind, operatorId, groupName, time, describe }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(time) || time > 8_640_000_000_000 ||
        !Object.hasOwn(titles, kind) || !await isEnabled(botId, signal, groupId) ||
        options.signal?.aborted || signal?.aborted) return;

    let name = displayRequestField(groupName, 128);
    if (!name && describe) {
      try { name = displayRequestField(await describe(), 128); } catch { /* The group number is still known. */ }
    }
    if (options.signal?.aborted || signal?.aborted) return;

    const lines = [
      titles[kind],
      "────────────",
      $t("group-owner-group-notice.text_5bfa724a8c", { "value1": name || $t("group-owner-group-notice.text_1b6b59544b") }),
      $t("group-owner-group-notice.text_64bbec1614", { "groupId": groupId }),
    ];
    if ((kind === "removed" || kind === "dissolved") && positiveId(operatorId)) lines.push($t("group-owner-group-notice.text_0845c2a43b", { "operatorId": operatorId }));
    lines.push("", $t("group-owner-group-notice.text_bfc7ca3615", { "value1": formatGroupNoticeTime(time * 1_000) }), $t("group-owner-group-notice.text_e0048482bb", { "botId": botId }));
    return lines.join("\n");
  };
}
