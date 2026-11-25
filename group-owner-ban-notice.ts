import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerBanNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly operatorId: number;
  readonly duration: number;
}

export type GroupOwnerBanNoticePart = string | { readonly type: "image"; readonly file: string };
export type GroupOwnerBanNotice = (event: GroupOwnerBanNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupOwnerBanNoticePart[] | undefined>;

export const groupOwnerBanNoticeFeature = "[group] 机器人禁言通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function banDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3_600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const repeating = [[hours, $t("group-owner-ban-notice.text_3b6fefc50f")], [minutes, $t("group-owner-ban-notice.text_b6a993c256")], [seconds % 60, $t("group-owner-ban-notice.text_9dcdc2b289")]] as const;
  const clock = repeating.filter(([amount]) => amount > 0)
    .map(([amount, unit]) => String(amount).padStart(2, "0") + unit).join("");
  return (days ? $t("group-owner-ban-notice.text_63c4ff4f1e", { "days": days }) : "") + clock;
}

export function createGroupOwnerBanNotice(options: PrivateNoticeOptions): GroupOwnerBanNotice {
  const isEnabled = createPrivateNoticeSettings(options, "botBeenBanned");
  return async ({ botId, groupId, userId, operatorId, duration }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || userId !== botId || !positiveId(operatorId) ||
        !Number.isSafeInteger(duration) || duration < 0 || !await isEnabled(botId, signal, groupId) ||
        options.signal?.aborted || signal?.aborted) return;

    const image = { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` } as const;
    if (duration === 0) {
      return [image, $t("group-owner-ban-notice.text_646d81965a", { "botId": botId }), $t("group-owner-ban-notice.text_c10961f23a", { "operatorId": operatorId }), $t("group-owner-ban-notice.text_6d5dbc507f", { "groupId": groupId })];
    }
    return [
      image, $t("group-owner-ban-notice.text_3d4cf71236", { "botId": botId }), $t("group-owner-ban-notice.text_1ef04217ab", { "operatorId": operatorId }), $t("group-owner-ban-notice.text_fcc77b1c08", { "groupId": groupId }),
      $t("group-owner-ban-notice.text_472dcb1058", { "value1": banDuration(duration) }),
    ];
  };
}
