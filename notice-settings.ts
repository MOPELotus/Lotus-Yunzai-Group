import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { createNoticeSettingsStore, NoticeSettingsPermissionError, type NoticeSettingsField, type NoticeSettingsScope } from "./notice-settings-store.ts";
import { buildNoticeSettingsCard, type NoticeSettingsCardRenderer } from "./notice-settings-card-model.ts";
import { configuredOwnerNoticeRecipients } from "./owner-notice-recipients.ts";
import { recallRetentionSeconds } from "./recall-notice.ts";
import { configuredPrivateNotice, privateNoticeSetting } from "./private-notice-config.ts";

export type { NoticeSettingsScope } from "./notice-settings-store.ts";
export interface NoticeSettingsContext {
  readonly message_type: "private" | "group" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly isDelegated?: boolean;
  readonly isBotMaster: (userId: number) => boolean;
  readonly configureNoticeSettings?: (scope: NoticeSettingsScope) => Promise<boolean>;
}

export const noticeSettingsFeature = "[group] 通知设置";
const title = "#通知设置";
const bulk = /^#(启用|禁用)全部通知$/u;
const change = /^#通知设置(好友消息|群消息|群临时消息|群撤回|好友撤回|好友申请|群邀请|加群申请|群管理变动|好友列表变动|群聊列表变动|群成员变动|禁言|删除缓存时间|全部通知)(群单独|bot单独|bot群单独|单独)?(开启|关闭|取消|(\d+)秒?)$/u;
const denied = $t("notice-settings.text_1124352949");
const fields = {
  好友消息: { key: "privateMessage", specific: "bot", note: $t("notice-settings.text_2160a6c80b") },
  群消息: { key: "groupMessage", specific: "group", note: $t("notice-settings.text_99f8ca068b") },
  群临时消息: { key: "grouptemporaryMessage", specific: "group", note: $t("notice-settings.text_02ca33c606") },
  群撤回: { key: "groupRecall", specific: "group", note: $t("notice-settings.text_0763d1024c") },
  好友撤回: { key: "PrivateRecall", specific: "bot", note: $t("notice-settings.text_0763d1024c") },
  好友申请: { key: "friendRequest", specific: "bot", note: "" },
  群邀请: { key: "groupInviteRequest", specific: "bot", note: $t("notice-settings.text_a8ab9d7a94") },
  加群申请: { key: "addGroupApplication", specific: "group", note: $t("notice-settings.text_a8ab9d7a94") },
  好友列表变动: { key: "friendNumberChange", specific: "bot", note: $t("notice-settings.text_a95adab598") },
  群管理变动: { key: "groupAdminChange", specific: "group", note: "" },
  群成员变动: { key: "groupMemberNumberChange", specific: "group", note: "" },
  群聊列表变动: { key: "groupNumberChange", specific: "group", note: $t("notice-settings.text_7a4a4cc85a") },
  禁言: { key: "botBeenBanned", specific: "group", note: $t("notice-settings.text_cf311caa29") },
  全部通知: { key: "notificationsAll", specific: "default", note: "" },
} as const;
const eventFields = Object.values(fields).flatMap(({ key, specific }) => specific === "default" ? [] : [key]);

export function isNoticeSettingsCommand(message: string): boolean {
  return message === title || bulk.test(message) || change.test(message);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function resolvedScope(value: string | undefined, hasGroup: boolean): NoticeSettingsScope {
  switch (value) {
    case "群单独": return "group";
    case "bot群单独": return "bot-group";
    case "bot单独": return "bot";
    case "单独": return hasGroup ? "group" : "bot";
    default: return "default";
  }
}

function status(config: Record<string, unknown>, botId: number, groupId: number | undefined): string {
  const rows = Object.entries(fields).map(([label, { key, specific, note }]) => {
    if (key === "notificationsAll") {
      const all = configuredOwnerNoticeRecipients(config, botId);
      const recipients = all === false ? $t("notice-settings.text_5fa03850e5") : $t("notice-settings.text_350b867641");
      return $t("notice-settings.text_5aa2915072", { "recipients": recipients, "value2": all === undefined ? $t("notice-settings.text_ccb91ce53d") : "" });
    }
    const groupSetting = specific === "group";
    const source = groupSetting && groupId === undefined ? { default: config.default } : config;
    const enabled = configuredPrivateNotice(source, botId, key, groupSetting ? groupId : undefined);
    return `${label}：${enabled ? $t("notice-settings.text_8da97ddda9") : $t("notice-settings.text_3fd47edce4")}${note}`;
  });
  const raw = privateNoticeSetting(config, botId, "msgSaveDeltime", groupId);
  const seconds = recallRetentionSeconds(raw);
  return [$t("notice-settings.text_edd04bcc54"), ...rows, $t("notice-settings.text_214adbb965", { "value1": seconds === undefined ? $t("notice-settings.text_2c1bdb2ae6") : $t("notice-settings.text_622b117f29", { "seconds": seconds }) })].join("\n");
}

type NoticeStatusImage = { readonly type: "image"; readonly file: Uint8Array };
type NoticeStatusReply = string | NoticeStatusImage | readonly [string, NoticeStatusImage];

export function createNoticeSettings(
  root: URL, lockFile: Parameters<typeof createNoticeSettingsStore>[1], signal?: AbortSignal,
): (message: string, context: NoticeSettingsContext) => Promise<string | undefined>;
export function createNoticeSettings(
  root: URL, lockFile: Parameters<typeof createNoticeSettingsStore>[1], signal?: AbortSignal,
  render?: NoticeSettingsCardRenderer,
): (message: string, context: NoticeSettingsContext) => Promise<NoticeStatusReply | undefined>;
export function createNoticeSettings(
  root: URL, lockFile: Parameters<typeof createNoticeSettingsStore>[1], signal?: AbortSignal,
  render?: NoticeSettingsCardRenderer,
) {
  const store = createNoticeSettingsStore(root, lockFile, signal);
  async function display(config: Record<string, unknown>, botId: number, groupId?: number, result?: string): Promise<NoticeStatusReply | undefined> {
    if (signal?.aborted) return;
    if (render) {
      try {
        const file = await render(buildNoticeSettingsCard(config, botId, groupId), signal);
        if (signal?.aborted) return;
        if (file instanceof Uint8Array && file.byteLength) {
          const image: NoticeStatusImage = { type: "image", file };
          return result ? [result, image] : image;
        }
      } catch { /* The text overview is available if rendering fails. */ }
    }
    if (signal?.aborted) return;
    const overview = status(config, botId, groupId);
    return result ? result + "\n" + overview : overview;
  }
  return async (message: string, context: NoticeSettingsContext): Promise<NoticeStatusReply | undefined> => {
    const { self_id, user_id, group_id, isBotMaster, configureNoticeSettings } = context;
    if (signal?.aborted || context.message_type === "terminal" || !isNoticeSettingsCommand(message)) return;
    const group = context.message_type === "group" && positiveId(group_id) ? group_id : undefined;

    if (message === title) {
      if (context.isDelegated || !positiveId(self_id) || (context.message_type === "group" && group === undefined)) return;
      try {
        const config = await store.read();
        return display(config, self_id, group);
      } catch { if (!signal?.aborted) return $t("notice-settings.text_9b65a28f35"); }
      return;
    }
    if (context.isDelegated || !positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id) || !configureNoticeSettings) return denied;
    const batch = bulk.exec(message);
    const match = change.exec(message);
    const label = match?.[1] ?? "";
    if (!batch && (!match || (label !== "删除缓存时间" && !Object.hasOwn(fields, label)))) return;

    const scope = resolvedScope(match?.[2], group !== undefined);
    const scoped = scope === "group" || scope === "bot-group";
    if (scoped && group === undefined) return denied;
    const section = scope === "default" ? "default" : scope === "group" ? String(group) :
      scope === "bot" ? `bot:${self_id}` : `bot:${self_id}:${group}`;
    const authorize = async () => {
      try { return !signal?.aborted && isBotMaster(user_id) && await configureNoticeSettings(scope); }
      catch { return false; }
    };

    let save: () => Promise<boolean>;
    if (batch) {
      save = () => store.writeDefaults(eventFields, batch[1] === "启用", authorize);
    } else {
      let key: NoticeSettingsField;
      let value: boolean | number | undefined;
      if (label === "删除缓存时间") {
        if (scope !== "default") return $t("notice-settings.text_1f4181ac81");
        key = "msgSaveDeltime";
        value = match?.[4] === undefined ? undefined : recallRetentionSeconds(match[4]);
        if (value === undefined) return $t("notice-settings.text_96ac77392f");
      } else {
        const field = fields[label as keyof typeof fields];
        if (scope !== "default" && field.specific !== (scoped ? "group" : "bot")) return $t("notice-settings.text_664916a999");
        key = field.key;
        if (match?.[3] === "开启") value = true;
        else if (match?.[3] === "关闭") value = false;
        else if (match?.[3] !== "取消") return $t("notice-settings.text_270443ff14");
      }
      save = () => store.write(section, key, value, authorize);
    }

    let written: boolean;
    try { written = await save(); }
    catch (error) {
      return error instanceof NoticeSettingsPermissionError ? denied : $t("notice-settings.text_1b210521ba");
    }
    if (signal?.aborted) return;
    const result = !written ? $t("notice-settings.text_a43589c104") :
      batch ? $t("notice-settings.text_733aba6db6", { "value1": batch[1], "length": eventFields.length }) : $t("notice-settings.text_d283e288c6");
    try {
      const config = await store.read();
      return display(config, self_id, group, result);
    } catch { if (!signal?.aborted) return result + $t("notice-settings.text_33dae7bf2e"); }
  };
}
