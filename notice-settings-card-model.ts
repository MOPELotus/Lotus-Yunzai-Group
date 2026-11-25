import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { configuredOwnerNoticeRecipients } from "./owner-notice-recipients.ts";
import { configuredPrivateNotice, privateNoticeSetting } from "./private-notice-config.ts";
import { recallRetentionSeconds } from "./recall-notice.ts";

export interface NoticeSettingsCardRow {
  readonly label: string;
  readonly value: string;
  readonly off?: boolean;
  readonly hint?: string;
  readonly description?: string;
}
export interface NoticeSettingsCardGroup {
  readonly title: string;
  readonly override?: boolean;
  readonly rows: readonly NoticeSettingsCardRow[];
}
export interface NoticeSettingsCardModel {
  readonly groups: readonly NoticeSettingsCardGroup[];
}
export type NoticeSettingsCardRenderer = (model: NoticeSettingsCardModel, signal?: AbortSignal) =>
  Promise<Uint8Array | undefined>;

const eventGroups = [
  { title: $t("notice-settings-card-model.text_39611933bd"), rows: [
    ["privateMessage", $t("notice-settings-card-model.text_fc0b8c0305"), $t("notice-settings-card-model.text_5b7b0b6660")],
    ["groupMessage", $t("notice-settings-card-model.text_9a82c8965f"), $t("notice-settings-card-model.text_39e190a823")],
    ["grouptemporaryMessage", $t("notice-settings-card-model.text_0d3b7c33ec"), $t("notice-settings-card-model.text_2230f0c4ce")],
    ["groupRecall", $t("notice-settings-card-model.text_607c6db0f1"), $t("notice-settings-card-model.text_c36946d1cf")],
    ["PrivateRecall", $t("notice-settings-card-model.text_12accaff01"), $t("notice-settings-card-model.text_c36946d1cf")],
  ] },
  { title: $t("notice-settings-card-model.text_9944b52ac0"), rows: [
    ["friendRequest", $t("notice-settings-card-model.text_74d9ad48d6"), $t("notice-settings-card-model.text_50da84eb96")],
    ["addGroupApplication", $t("notice-settings-card-model.text_e4a8f9e3f9"), $t("notice-settings-card-model.text_deaef003cb")],
    ["groupInviteRequest", $t("notice-settings-card-model.text_ad3e7e8fd5"), undefined, $t("notice-settings-card-model.text_79b8844595")],
  ] },
  { title: $t("notice-settings-card-model.text_b5cf3ca16f"), rows: [
    ["friendNumberChange", $t("notice-settings-card-model.text_59201b4531"), $t("notice-settings-card-model.text_84b70f61fe")],
    ["groupNumberChange", $t("notice-settings-card-model.text_c3afaed55e"), $t("notice-settings-card-model.text_87cc45deac")],
    ["groupMemberNumberChange", $t("notice-settings-card-model.text_9db9d0d6ea"), $t("notice-settings-card-model.text_19e250f99e")],
    ["groupAdminChange", $t("notice-settings-card-model.text_17a8c31791")],
  ] },
  { title: $t("notice-settings-card-model.text_9488665fb4"), rows: [["botBeenBanned", $t("notice-settings-card-model.text_f76935bcd9"), undefined, $t("notice-settings-card-model.text_0e0138610a")]] },
] as const;
type EventRow = (typeof eventGroups)[number]["rows"][number];
const accountEvents = new Set(["privateMessage", "PrivateRecall", "friendRequest", "friendNumberChange"]);
const eventRows: readonly EventRow[] = eventGroups.flatMap(({ rows }): readonly EventRow[] => rows);

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function booleanValue(enabled: boolean): Pick<NoticeSettingsCardRow, "value" | "off"> {
  return { value: enabled ? $t("notice-settings-card-model.text_8a4ef3e48e") : $t("notice-settings-card-model.text_6744b4c6a9"), off: !enabled };
}

function recipientValue(all: boolean | undefined): string {
  return all === false ? $t("notice-settings-card-model.text_5fa03850e5") : all === true ? $t("notice-settings-card-model.text_0515a3fbfc") : $t("notice-settings-card-model.text_50fe8a519c");
}

function retentionValue(raw: unknown): string {
  const seconds = recallRetentionSeconds(raw);
  return seconds === undefined ? $t("notice-settings-card-model.text_2c1bdb2ae6") : $t("notice-settings-card-model.text_622b117f29", { "seconds": seconds });
}

function overrideRows(section: unknown, groupScope: boolean): NoticeSettingsCardRow[] {
  const values = object(section);
  if (!values) return [];
  const rows: NoticeSettingsCardRow[] = [];
  for (const [field, command, , label] of eventRows) {
    if (groupScope && accountEvents.has(field)) continue;
    const enabled = Object.hasOwn(values, field) ? values[field] : undefined;
    if (typeof enabled === "boolean") rows.push({ label: label ?? command, ...booleanValue(enabled) });
  }
  if (!groupScope && Object.hasOwn(values, "notificationsAll") && typeof values.notificationsAll === "boolean") {
    rows.push({ label: $t("notice-settings-card-model.text_b836608abe"), value: recipientValue(values.notificationsAll) });
  }
  if (Object.hasOwn(values, "msgSaveDeltime") && values.msgSaveDeltime !== undefined) {
    rows.push({ label: $t("notice-settings-card-model.text_2f971f0a42"), value: retentionValue(values.msgSaveDeltime) });
  }
  return rows;
}

export function buildNoticeSettingsCard(config: Record<string, unknown>, botId: number, groupId?: number): NoticeSettingsCardModel {
  const defaults = { default: config.default };
  const groups: NoticeSettingsCardGroup[] = [];
  for (const { title, rows } of eventGroups) {
    groups.push({ title, rows: rows.map(([field, command, description, label]) => ({
      label: label ?? command, hint: $t("notice-settings-card-model.text_bb69cc6e13", { "command": command }), description,
      ...booleanValue(configuredPrivateNotice(defaults, botId, field)),
    })) });
  }
  groups.push({
    title: $t("notice-settings-card-model.text_68ea5dd4d7"), rows: [
      { label: $t("notice-settings-card-model.text_ca167017c5"), hint: $t("notice-settings-card-model.text_be4344dee7"),
        value: recipientValue(configuredOwnerNoticeRecipients(defaults, botId)),
        description: $t("notice-settings-card-model.text_2a70cd3b6b") },
      { label: $t("notice-settings-card-model.text_2f971f0a42"), hint: $t("notice-settings-card-model.text_103aee1983"),
        value: retentionValue(privateNoticeSetting(defaults, botId, "msgSaveDeltime")),
        description: $t("notice-settings-card-model.text_32e1d0b4cd") },
    ],
  });
  const bot = `bot:${botId}`;
  const sections: [string, string][] = [[bot, $t("notice-settings-card-model.text_b26f5571c3", { "botId": botId })]];
  if (groupId !== undefined) {
    sections.push([String(groupId), $t("notice-settings-card-model.text_7b00210c8e", { "groupId": groupId })], [`${bot}:${groupId}`, $t("notice-settings-card-model.text_d1fdf073e6", { "botId": botId, "groupId": groupId })]);
  }
  for (const [scope, title] of sections) {
    const rows = overrideRows(Object.hasOwn(config, scope) ? config[scope] : undefined, scope !== bot);
    if (rows.length) groups.push({ title, rows, override: true });
  }
  return { groups };
}
