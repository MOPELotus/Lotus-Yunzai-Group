import { createNoticeSettingsStore, NoticeSettingsPermissionError, type NoticeSettingsField, type NoticeSettingsScope } from "./notice-settings-store.ts";
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
const title = "#椰奶通知设置";
const bulk = /^#椰奶(?:启用|禁用)全部通知$/u;
const change = /^#椰奶通知设置(好友消息|群消息|群临时消息|群撤回|好友撤回|好友申请|群邀请|加群申请|群管理变动|好友列表变动|群聊列表变动|群成员变动|禁言|删除缓存时间|全部通知)(群单独|bot单独|bot群单独|单独)?(开启|关闭|取消|(\d+)秒?)$/u;
const unsupported = "当前版本尚不支持此通知设置。";
const denied = "当前会话没有修改此通知设置的权限。";
const fields = {
  好友消息: { key: "privateMessage", specific: "bot", note: "（已核验的好友消息与戳一戳）" },
  群消息: { key: "groupMessage", specific: "group", note: "（当前支持文本、图片和表情）" },
  群临时消息: { key: "grouptemporaryMessage", specific: "group", note: "（当前仅文本）" },
  群撤回: { key: "groupRecall", specific: "group", note: "（当前仅文本）" },
  好友撤回: { key: "PrivateRecall", specific: "bot", note: "（当前仅文本）" },
  好友申请: { key: "friendRequest", specific: "bot", note: "" },
  群邀请: { key: "groupInviteRequest", specific: "bot", note: "（主人编号通知详情）" },
  加群申请: { key: "addGroupApplication", specific: "group", note: "（主人编号通知详情）" },
  好友列表变动: { key: "friendNumberChange", specific: "bot", note: "（当前仅 NapCat 新增）" },
  群管理变动: { key: "groupAdminChange", specific: "group", note: "" },
  群成员变动: { key: "groupMemberNumberChange", specific: "group", note: "" },
  群聊列表变动: { key: "groupNumberChange", specific: "group", note: "（机器人进退群、被移出及群解散）" },
  禁言: { key: "botBeenBanned", specific: "group", note: "（仅机器人本人）" },
} as const;

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
    const groupSetting = specific === "group";
    const source = groupSetting && groupId === undefined ? { default: config.default } : config;
    const enabled = configuredPrivateNotice(source, botId, key, groupSetting ? groupId : undefined);
    return `${label}：${enabled ? "开启" : "关闭"}${note}`;
  });
  const raw = privateNoticeSetting(config, botId, "msgSaveDeltime", groupId);
  const seconds = recallRetentionSeconds(raw);
  return ["【通知设置】", ...rows, `删除缓存时间：${seconds === undefined ? "无效" : `${seconds} 秒`}`].join("\n");
}

export function createNoticeSettings(root: URL, lockFile: Parameters<typeof createNoticeSettingsStore>[1], signal?: AbortSignal) {
  const store = createNoticeSettingsStore(root, lockFile, signal);
  return async (message: string, context: NoticeSettingsContext): Promise<string | undefined> => {
    const { self_id, user_id, group_id, isBotMaster, configureNoticeSettings } = context;
    if (signal?.aborted || context.message_type === "terminal" || !isNoticeSettingsCommand(message)) return;
    const group = context.message_type === "group" && positiveId(group_id) ? group_id : undefined;

    if (message === title) {
      if (context.isDelegated || !positiveId(self_id) || (context.message_type === "group" && group === undefined)) return;
      try {
        const config = await store.read();
        if (!signal?.aborted) return status(config, self_id, group);
      } catch { if (!signal?.aborted) return "当前无法读取通知设置。"; }
      return;
    }
    if (context.isDelegated || !positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id) || !configureNoticeSettings) return denied;
    if (bulk.test(message)) return unsupported;
    const match = change.exec(message);
    const label = match?.[1] ?? "";
    if (!match || (label !== "删除缓存时间" && !Object.hasOwn(fields, label))) return unsupported;

    const scope = resolvedScope(match[2], group !== undefined);
    const scoped = scope === "group" || scope === "bot-group";
    if (scoped && group === undefined) return denied;
    const section = scope === "default" ? "default" : scope === "group" ? String(group) :
      scope === "bot" ? `bot:${self_id}` : `bot:${self_id}:${group}`;
    const authorize = async () => {
      try { return !signal?.aborted && isBotMaster(user_id) && await configureNoticeSettings(scope); }
      catch { return false; }
    };

    let key: NoticeSettingsField;
    let value: boolean | number | undefined;
    if (label === "删除缓存时间") {
      if (scope !== "default") return "❎ 删除缓存时间仅支持默认设置。";
      key = "msgSaveDeltime";
      value = match[4] === undefined ? undefined : recallRetentionSeconds(match[4]);
      if (value === undefined) return "❎ 请填写有效的正整数秒数。";
    } else {
      const field = fields[label as keyof typeof fields];
      if (scope !== "default" && field.specific !== (scoped ? "group" : "bot")) return "❎ 该设置项不支持此作用域。";
      key = field.key;
      if (match[3] === "开启") value = true;
      else if (match[3] === "关闭") value = false;
      else if (match[3] !== "取消") return "❎ 请使用开启、关闭或取消。";
    }

    let written: boolean;
    try { written = await store.write(section, key, value, authorize); }
    catch (error) {
      return error instanceof NoticeSettingsPermissionError ? denied : "暂无法保存通知设置，配置未被本次操作覆盖。";
    }
    if (signal?.aborted) return;
    const result = written ? "✅ 已保存通知设置。" : "通知设置无变化。";
    try {
      const config = await store.read();
      if (!signal?.aborted) return result + "\n" + status(config, self_id, group);
    } catch { if (!signal?.aborted) return result + "\n当前无法读取通知设置。"; }
  };
}
