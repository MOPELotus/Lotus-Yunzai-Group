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
  { title: "消息相关", rows: [
    ["privateMessage", "好友消息", "已核验的文本、图片、表情和戳一戳，语音原音限已核验的 QQ SILK"],
    ["groupMessage", "群消息", "转发文本、图片和表情，语音原音限已核验的 QQ SILK"],
    ["grouptemporaryMessage", "群临时消息", "转发已核验的群临时文本，语音原音限已核验的 QQ SILK"],
    ["groupRecall", "群撤回", "群撤回与好友撤回均支持已核验的文本和表情"],
    ["PrivateRecall", "好友撤回"],
  ] },
  { title: "申请通知", rows: [
    ["friendRequest", "好友申请", "通知主人有新的好友申请"],
    ["addGroupApplication", "加群申请", "在原编号通知内展示申请详情"],
    ["groupInviteRequest", "群邀请", undefined, "群聊邀请"],
  ] },
  { title: "列表变动", rows: [
    ["friendNumberChange", "好友列表变动", "目前支持 NapCat 好友新增"],
    ["groupNumberChange", "群聊列表变动", "机器人进退群、被移出及群解散"],
    ["groupMemberNumberChange", "群成员变动", "向主人通知群成员的增减"],
    ["groupAdminChange", "群管理变动"],
  ] },
  { title: "其他通知", rows: [["botBeenBanned", "禁言", undefined, "Bot被禁言"]] },
] as const;
type EventRow = (typeof eventGroups)[number]["rows"][number];
const accountEvents = new Set(["privateMessage", "PrivateRecall", "friendRequest", "friendNumberChange"]);
const eventRows: readonly EventRow[] = eventGroups.flatMap(({ rows }): readonly EventRow[] => rows);

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function booleanValue(enabled: boolean): Pick<NoticeSettingsCardRow, "value" | "off"> {
  return { value: enabled ? "已开启" : "已关闭", off: !enabled };
}

function recipientValue(all: boolean | undefined): string {
  return all === false ? "首位主人" : all === true ? "全部主人" : "全部主人（默认）";
}

function retentionValue(raw: unknown): string {
  const seconds = recallRetentionSeconds(raw);
  return seconds === undefined ? "无效" : `${seconds} 秒`;
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
    rows.push({ label: "通知收件人", value: recipientValue(values.notificationsAll) });
  }
  if (Object.hasOwn(values, "msgSaveDeltime") && values.msgSaveDeltime !== undefined) {
    rows.push({ label: "删除缓存时间", value: retentionValue(values.msgSaveDeltime) });
  }
  return rows;
}

export function buildNoticeSettingsCard(config: Record<string, unknown>, botId: number, groupId?: number): NoticeSettingsCardModel {
  const defaults = { default: config.default };
  const groups: NoticeSettingsCardGroup[] = [];
  for (const { title, rows } of eventGroups) {
    groups.push({ title, rows: rows.map(([field, command, description, label]) => ({
      label: label ?? command, hint: `#椰奶通知设置${command} + 开启/关闭`, description,
      ...booleanValue(configuredPrivateNotice(defaults, botId, field)),
    })) });
  }
  groups.push({
    title: "系统设置", rows: [
      { label: "通知全部主人", hint: "#椰奶通知设置全部通知 + 开启/关闭",
        value: recipientValue(configuredOwnerNoticeRecipients(defaults, botId)),
        description: "开启通知全部主人，关闭只通知配置中的首位主人" },
      { label: "删除缓存时间", hint: "#椰奶通知设置删除缓存时间 + 时间(秒)",
        value: retentionValue(privateNoticeSetting(defaults, botId, "msgSaveDeltime")),
        description: "好友和群撤回消息的缓存保留时间" },
    ],
  });
  const bot = `bot:${botId}`;
  const sections: [string, string][] = [[bot, `Bot:${botId} 单独配置`]];
  if (groupId !== undefined) {
    sections.push([String(groupId), `群:${groupId} 单独配置`], [`${bot}:${groupId}`, `Bot:${botId} & 群:${groupId} 单独配置`]);
  }
  for (const [scope, title] of sections) {
    const rows = overrideRows(Object.hasOwn(config, scope) ? config[scope] : undefined, scope !== bot);
    if (rows.length) groups.push({ title, rows, override: true });
  }
  return { groups };
}
