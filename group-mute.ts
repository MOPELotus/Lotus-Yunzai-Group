import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export type GroupWholeMuteResult = "confirmed" | "rejected" | "unknown" | "unavailable";
export type GroupMuteResult = GroupWholeMuteResult | "protected";

export interface GroupMuteContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly group_id?: number;
  readonly user_id?: number;
  readonly self_id?: number;
  readonly message_id?: number | string;
  readonly adapter?: "onebot" | "milky";
  readonly isDelegated?: boolean;
  readonly message?: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly normalizedMessage?: string;
  readonly isBotMaster: (userId: number) => boolean;
  readonly groupMute?: (userId: number, seconds: number) => Promise<GroupMuteResult>;
  readonly groupWholeMute?: (enabled: boolean) => Promise<GroupWholeMuteResult>;
}

export const groupMuteFeature = "[group] 群禁言";
export const maxGroupMuteSeconds = 2_147_483_647;
const defaultMuteSeconds = 300;
const maxRememberedMessages = 2048;
const defaultRoot = new URL("../../", import.meta.url);
const legacyConfig = "plugins/yenai-plugin/config/config/groupAdmin.yaml";
const amountPattern = /^([\d零一壹二两三四五六七八九十百千万亿]+)\s*(\S+)?$/u;
const digit: Readonly<Record<string, string>> = { 零: "0", 一: "1", 壹: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
const secondsByUnit = new Map(Object.entries({
  毫秒: 0.001, 秒: 1, S: 1, SECOND: 1,
  分: 60, 分钟: 60, M: 60, MIN: 60, MINUTE: 60,
  时: 3600, 小时: 3600, H: 3600, HOUR: 3600,
  天: 86400, 日: 86400, D: 86400, DAY: 86400,
  周: 604800, W: 604800, WEEK: 604800, 月: 2592000, MONTH: 2592000,
  年: 31536000, Y: 31536000, YEAR: 31536000,
}));
const compactMuteUnit = new RegExp(`^#禁言(?=(?:${[...secondsByUnit.keys()].join("|")})$)`, "iu");
const commandPattern = /^#(?:禁言|解禁)(?=$|[\s\d零一壹二两三四五六七八九十百千万亿])/u;
const wholeMutePattern = /^#全[体员](禁言|解禁)$/u;

function positiveId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

function amountSection(value: string): number {
  if (/^\d*$/u.test(value)) return Number(value);
  const section = /^(?:(\d)千)?(?:0*([1-9])百)?(?:0*([1-9]?)十)?(?:0*([1-9]))?0*$/u.exec(value);
  if (!section) return NaN;
  const [, thousand, hundred, ten, one] = section;
  return Number(thousand ?? 0) * 1000 + Number(hundred ?? 0) * 100 +
    Number(ten === "" ? 1 : ten ?? 0) * 10 + Number(one ?? 0);
}

function duration(value: string): number | undefined {
  if (!value) return defaultMuteSeconds;
  if (value.length > 64) return;
  const unitOnly = secondsByUnit.get(value.toUpperCase());
  if (unitOnly !== undefined) {
    const seconds = defaultMuteSeconds * unitOnly;
    if (Number.isSafeInteger(seconds) && seconds <= maxGroupMuteSeconds) return seconds;
    return;
  }
  const parts = amountPattern.exec(value);
  if (!parts?.[1]) return;
  const normalized = parts[1].replace(/[零一壹二两三四五六七八九]/gu, (character) => digit[character]!);
  const sections = /^(?:([^亿万]+)亿)?(?:([^亿万]+)万)?([^亿万]*)$/u.exec(normalized);
  if (!sections) return;
  const amount = amountSection(sections[1] ?? "") * 1e8 + amountSection(sections[2] ?? "") * 1e4 + amountSection(sections[3] ?? "");
  const multiplier = secondsByUnit.get((parts[2] ?? "秒").toUpperCase());
  if (multiplier === undefined) return;
  const seconds = amount * multiplier;
  if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= maxGroupMuteSeconds) return seconds;
}

function mentionedIds(message: GroupMuteContext["message"], botId: number): number[] | undefined {
  const ids = new Set<number>();
  if (message === undefined || typeof message === "string") return [];
  for (const part of message) {
    if (part.type === "mention_all") return;
    if (part.type !== "at") continue;
    const id = positiveId(part.qq);
    if (id === undefined) return;
    if (id !== botId) ids.add(id);
  }
  return [...ids];
}

function targets(message: string, group: GroupMuteContext, botId: number) {
  const ids = mentionedIds(group.message, botId);
  if (!ids) return;
  const releasing = message.startsWith("#解禁");
  let args = message.slice(3).trim();
  if (!ids.length) {
    const numeric = /^(\d+)(?:\s+(.+))?$/u.exec(args);
    const id = positiveId(numeric?.[1]);
    if (id === undefined) return;
    ids.push(id);
    args = numeric?.[2] ?? "";
  }
  const seconds = releasing ? (args ? undefined : 0) : duration(args);
  if (seconds !== undefined && ids.every((id) => id !== botId)) return { ids, seconds };
}

async function readWhitelist(root: URL): Promise<ReadonlySet<number>> {
  const source = await readFile(new URL(legacyConfig, root), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (source === undefined) return new Set();
  const config: unknown = parse(source);
  if (config == null) return new Set();
  if (typeof config !== "object" || Array.isArray(config)) throw new TypeError("群管配置须为映射。");
  const list = (config as Record<string, unknown>).whiteQQ;
  if (list == null) return new Set();
  if (!Array.isArray(list)) throw new TypeError("whiteQQ 须为 QQ 号列表。");
  const ids = new Set<number>();
  for (const entry of list) {
    const id = positiveId(entry);
    if (id === undefined) throw new TypeError("whiteQQ 包含无效的 QQ 号。");
    ids.add(id);
  }
  return ids;
}

export function createGroupMute(root: URL = defaultRoot) {
  const seen = new Set<string>();

  function claim(context: GroupMuteContext, bot: number, issuer: number): boolean {
    const { message_id, adapter, group_id } = context;
    if (!((typeof message_id === "number" && Number.isSafeInteger(message_id)) ||
          (typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128))) return true;
    const key = JSON.stringify([adapter ?? "onebot", bot, group_id, issuer, String(message_id)]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > maxRememberedMessages) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  return async (message: string, context: GroupMuteContext): Promise<string | readonly [] | undefined> => {
    const command = (context.normalizedMessage ?? message).trim();
    if (context.message_type !== "group") return;
    const whole = wholeMutePattern.exec(command);
    if (!whole && !commandPattern.test(command) && !compactMuteUnit.test(command)) return;
    const { groupMute, groupWholeMute, user_id, self_id, group_id } = context;
    const issuer = positiveId(user_id), bot = positiveId(self_id);
    if (context.isDelegated || issuer === undefined || bot === undefined || positiveId(group_id) === undefined) {
      return "当前会话没有群禁言权限。";
    }
    if (whole) {
      if (!groupWholeMute) return "当前会话没有群禁言权限。";
      if (!claim(context, bot, issuer)) return [];
      const enabled = whole[1] === "禁言";
      let outcome: GroupWholeMuteResult;
      try { outcome = await groupWholeMute(enabled); }
      catch { outcome = "unknown"; }
      switch (outcome) {
        case "confirmed": return `已${enabled ? "开启" : "关闭"}全体禁言。`;
        case "rejected": return "协议端拒绝全体禁言操作。";
        case "unavailable": return "无法设置全体禁言，请核对群管理权限。";
        default: return "全体禁言操作结果未确认，请在群内核对。";
      }
    }
    if (!groupMute) return "当前会话没有群禁言权限。";
    const action = targets(command, context, bot);
    if (!action) return "请 @ 群成员或输入 QQ 号，并填写有效的禁言时长（整数秒）。";
    const { ids, seconds } = action;
    const issuerMaster = context.isBotMaster(issuer);
    let whitelist: ReadonlySet<number> | undefined;
    if (seconds > 0 && !issuerMaster) {
      try { whitelist = await readWhitelist(root); }
      catch { return "群禁言保护配置暂不可用。"; }
    }

    if (!claim(context, bot, issuer)) return [];

    const outcomes = new Map<GroupMuteResult, number[]>();
    for (const id of ids) {
      let result: GroupMuteResult;
      try { result = whitelist?.has(id) ? "protected" : await groupMute(id, seconds); }
      catch { result = "unknown"; }
      if (result === "protected" && !issuerMaster) result = "unavailable";
      const handled = outcomes.get(result);
      if (handled) handled.push(id);
      else outcomes.set(result, [id]);
    }
    const operation = seconds ? `禁言 ${seconds} 秒` : "解除禁言";
    const confirmed = outcomes.get("confirmed");
    const rejected = outcomes.get("rejected");
    const unknown = outcomes.get("unknown");
    const protectedIds = outcomes.get("protected");
    const unavailable = outcomes.get("unavailable");
    return [
      confirmed && `已将 ${confirmed.join("、")} ${operation}。`,
      rejected && `协议端拒绝操作 ${rejected.join("、")}。`,
      unknown && `${unknown.join("、")} 的操作结果未确认，请在群内核对。`,
      protectedIds && `${protectedIds.join("、")} 受群禁言保护。`,
      unavailable && `无法操作 ${unavailable.join("、")}，请核对群成员和管理权限。`,
    ].filter(Boolean).join("\n");
  };
}
