import { ManagedBlacklistPermissionError, readManagedWhitelist, type ManagedBlacklistStore } from "./managed-blacklist.ts";

export type GroupWholeMuteResult = "confirmed" | "rejected" | "unknown" | "unavailable";
export type GroupMuteResult = GroupWholeMuteResult | "protected";
export type GroupKickResult = GroupMuteResult;
export type GroupSetAdminResult = GroupMuteResult;
export interface GroupMuteRosterEntry {
  readonly userId: number;
  readonly name?: string;
  readonly role?: "member" | "admin" | "owner";
  readonly until: number;
}
type RosterPart = string | { readonly type: "image"; readonly file: string };
type GroupMuteReply = string | readonly [] | { readonly type: "forward"; readonly nodes: readonly (readonly RosterPart[])[] };

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
  readonly groupMuteRoster?: () => Promise<readonly GroupMuteRosterEntry[] | undefined>;
  readonly groupWholeMute?: (enabled: boolean) => Promise<GroupWholeMuteResult>;
  readonly groupKick?: (userId: number, block: boolean) => Promise<GroupKickResult>;
  readonly groupSetAdmin?: (userId: number, enabled: boolean) => Promise<GroupSetAdminResult>;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupManageWhitelistAutoUnmute?: () => Promise<boolean>;
}

export const groupMuteFeature = "[group] 群禁言";
export const groupMuteRosterFeature = "[group] 群禁言列表";
export const groupKickFeature = "[group] 群成员移出";
export const groupSetAdminFeature = "[group] 群管理员";
export const groupManagedBlacklistFeature = "[group] 群管黑名单";
export const groupManagedWhitelistFeature = "[group] 群管白名单";
export const maxGroupMuteSeconds = 2_147_483_647;
const defaultMuteSeconds = 300;
const maxRememberedMessages = 2048;
const defaultRoot = new URL("../../", import.meta.url);
const amountPattern = /^([\d零一壹二两三四五六七八九十百千万亿]+)\s*(\S+)?$/u;
const digit: Readonly<Record<string, string>> = { 零: "0", 一: "1", 壹: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
export const groupTimeUnits: ReadonlyMap<string, number> = new Map(Object.entries({
  毫秒: 0.001, 秒: 1, S: 1, SECOND: 1,
  分: 60, 分钟: 60, M: 60, MIN: 60, MINUTE: 60,
  时: 3600, 小时: 3600, H: 3600, HOUR: 3600,
  天: 86400, 日: 86400, D: 86400, DAY: 86400,
  周: 604800, W: 604800, WEEK: 604800, 月: 2592000, MONTH: 2592000,
  年: 31536000, Y: 31536000, YEAR: 31536000,
}));
const compactMuteUnit = new RegExp(`^#禁言(?=(?:${[...groupTimeUnits.keys()].join("|")})$)`, "iu");
const commandPattern = /^#(?:禁言|解禁)(?=$|[\s\d零一壹二两三四五六七八九十百千万亿])/u;
const wholeMutePattern = /^#全[体员](禁言|解禁)$/u;
const rosterPattern = /^#(?:(?:获取|查看)?禁言列表|解除全部禁言)$/u;
const kickPattern = /^#踢(黑)?(\d+)?$/u;
const adminPattern = /^#(设置|取消)管理(?:\s*(\d+))?$/u;
const listPattern = /^#?群管(加|删)(白|黑)(?:名单)?(?:\s*(\d+))?$/u;
const autoUnmutePattern = /^#?(开启|关闭)白名单(?:自动)?解禁$/u;

export function groupModerationFeature({ normalizedMessage }: { readonly normalizedMessage: string }): readonly string[] {
  const message = normalizedMessage.trim();
  const list = listPattern.exec(message);
  if (list?.[2] === "白" || autoUnmutePattern.test(message)) return [groupManagedWhitelistFeature];
  if (list) return [groupManagedBlacklistFeature];
  if (rosterPattern.test(message)) return [groupMuteRosterFeature];
  if (adminPattern.test(message)) return [groupSetAdminFeature];
  return [kickPattern.test(message) ? groupKickFeature : groupMuteFeature];
}

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

export function parseGroupInteger(value: string): number | undefined {
  if (!value || value.length > 64) return;
  const normalized = value.replace(/[零一壹二两三四五六七八九]/gu, (character) => digit[character]!);
  const sections = /^(?:([^亿万]+)亿)?(?:([^亿万]+)万)?([^亿万]*)$/u.exec(normalized);
  if (!sections) return;
  const amount = amountSection(sections[1] ?? "") * 1e8 + amountSection(sections[2] ?? "") * 1e4 + amountSection(sections[3] ?? "");
  if (Number.isSafeInteger(amount) && amount >= 0) return amount;
}

function duration(value: string): number | undefined {
  if (!value) return defaultMuteSeconds;
  if (value.length > 64) return;
  const unitOnly = groupTimeUnits.get(value.toUpperCase());
  if (unitOnly !== undefined) {
    const seconds = defaultMuteSeconds * unitOnly;
    if (Number.isSafeInteger(seconds) && seconds <= maxGroupMuteSeconds) return seconds;
    return;
  }
  const parts = amountPattern.exec(value);
  if (!parts?.[1]) return;
  const amount = parseGroupInteger(parts[1]);
  const multiplier = groupTimeUnits.get((parts[2] ?? "秒").toUpperCase());
  if (amount === undefined || multiplier === undefined) return;
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

function kickTargets(context: GroupMuteContext, bot: number, numeric: string | undefined, allowBot = false): number[] | undefined {
  const ids = mentionedIds(context.message, bot);
  if (!ids || (ids.length && numeric !== undefined)) return;
  if (ids.length) return ids;
  const id = positiveId(numeric);
  if (id !== undefined && (allowBot || id !== bot)) return [id];
}

async function activeMuteRoster(load: NonNullable<GroupMuteContext["groupMuteRoster"]>): Promise<readonly GroupMuteRosterEntry[] | undefined> {
  let rows: readonly GroupMuteRosterEntry[] | undefined;
  try { rows = await load(); } catch { return; }
  if (!Array.isArray(rows)) return;
  const seen = new Set<number>();
  const now = Math.floor(Date.now() / 1000);
  const active: GroupMuteRosterEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row.userId !== "number" || positiveId(row.userId) === undefined || seen.has(row.userId) ||
        !Number.isSafeInteger(row.until) || row.until < 0 || row.until > 8_640_000_000_000) return;
    seen.add(row.userId);
    if (row.until > now) active.push(row);
  }
  return active;
}

function formatRoster(rows: readonly GroupMuteRosterEntry[]): GroupMuteReply {
  const now = Math.floor(Date.now() / 1000);
  const active = rows.filter((entry) => entry.until > now);
  if (!active.length) return "本群没有被禁言的成员。";
  const nodes: RosterPart[][] = [];
  const perNode = Math.ceil(active.length / 100);
  const roles = { member: "群员", admin: "群管理", owner: "群主" } as const;
  for (let start = 0; start < active.length; start += perNode) {
    const node: RosterPart[] = [];
    for (const { userId, name, role, until } of active.slice(start, start + perNode)) {
      const nickname = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 128).toWellFormed() : "";
      const remaining = until - now;
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor(remaining / 3600) % 24;
      const minutes = Math.floor(remaining / 60) % 60;
      const time = `${days ? `${days} 天 ` : ""}${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分 ` : ""}${remaining % 60} 秒`;
      if (node.length) node.push("\n\n");
      node.push({ type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        `\n昵称：${nickname || userId}\nQQ：${userId}\n群身份：${role && Object.hasOwn(roles, role) ? roles[role] : "未确认"}\n` +
        `禁言剩余时间：${time}\n禁言到期时间：${new Date(until * 1000).toLocaleString("zh-CN")}`);
    }
    nodes.push(node);
  }
  return { type: "forward", nodes };
}

export function createGroupMute(root: URL = defaultRoot, blacklist?: ManagedBlacklistStore, moduleSignal?: AbortSignal) {
  const seen = new Set<string>();

  function claim(context: GroupMuteContext, bot: number, issuer: number, requireId = false): boolean {
    const { message_id, adapter, group_id } = context;
    if (!((typeof message_id === "number" && Number.isSafeInteger(message_id)) ||
          (typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128))) return !requireId;
    const key = JSON.stringify([adapter ?? "onebot", bot, group_id, issuer, String(message_id)]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > maxRememberedMessages) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  return async (message: string, context: GroupMuteContext): Promise<GroupMuteReply | undefined> => {
    const command = (context.normalizedMessage ?? message).trim();
    if (context.message_type !== "group") return;
    const whole = wholeMutePattern.exec(command);
    const roster = rosterPattern.test(command);
    const kick = kickPattern.exec(command);
    const admin = adminPattern.exec(command);
    const editList = listPattern.exec(command);
    const toggle = autoUnmutePattern.exec(command);
    if (!whole && !roster && !kick && !admin && !editList && !toggle && !commandPattern.test(command) && !compactMuteUnit.test(command)) return;
    const { groupMute, groupMuteRoster, groupWholeMute, groupKick, groupSetAdmin, user_id, self_id, group_id } = context;
    const issuer = positiveId(user_id), bot = positiveId(self_id);
    const list = editList?.[2] === "白" || toggle ? "白名单" : "黑名单";
    const listPermission = toggle ? "当前会话没有设置白名单自动解禁的权限。" : `当前会话没有编辑群管${list}的权限。`;
    if (context.isDelegated || moduleSignal?.aborted || issuer === undefined || bot === undefined || positiveId(group_id) === undefined) {
      if (editList || toggle) return listPermission;
      if (admin) return "当前会话没有设置群管理员的权限。";
      return kick ? "当前会话没有移出群成员的权限。" : "当前会话没有群禁言权限。";
    }
    if (editList || toggle) {
      if (!blacklist) return `群管${list}暂不可用。`;
      const authorize = async () => {
        try { return await (toggle ? context.groupManageWhitelistAutoUnmute?.() : context.groupManageBlacklist?.()) === true; }
        catch { return false; }
      };
      if (!await authorize()) return listPermission;
      if (!claim(context, bot, issuer, true)) return [];
      try {
        if (toggle) {
          const enabled = toggle[1] === "开启";
          const changed = await blacklist.setAutoUnmute(enabled, moduleSignal, authorize);
          return changed ? `已${toggle[1]}白名单自动解禁。` : `白名单自动解禁已处于${toggle[1]}状态。`;
        }
        const action = kickTargets(context, bot, editList?.[3], true);
        if (!action || action.length !== 1) return "请 @ 一位群成员，或输入一个 QQ 号。";
        const target = action[0]!;
        const add = editList?.[1] === "加";
        const changed = await (list === "白名单" ? blacklist.updateWhitelist : blacklist.update)([target], add, moduleSignal, authorize);
        if (add) return changed ? `已将 ${target} 加入群管${list}。` : `${target} 已在群管${list}中。`;
        return changed ? `已从群管${list}移除 ${target}。` : `${target} 不在群管${list}中。`;
      } catch (error) {
        if (error instanceof ManagedBlacklistPermissionError) return listPermission;
        return toggle ? "白名单自动解禁设置保存失败。" : `群管${list}保存失败。`;
      }
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
    if (roster) {
      const release = command === "#解除全部禁言";
      if (release) {
        const denied = "当前会话没有解除群禁言的权限。";
        if (!groupMute || !context.groupManageBlacklist) return denied;
        if (!claim(context, bot, issuer, true)) return [];
        try {
          if (!await context.groupManageBlacklist() || moduleSignal?.aborted) return denied;
        } catch { return denied; }
      }
      if (!groupMuteRoster) return "当前协议端无法提供可靠的群禁言列表。";
      const rows = await activeMuteRoster(groupMuteRoster);
      if (!rows || moduleSignal?.aborted) return "当前协议端无法提供可靠的群禁言列表。";
      if (!release) return formatRoster(rows);
      if (!rows.length) return "本群没有被禁言的成员。";
      const counts = { confirmed: 0, rejected: 0, unknown: 0, unavailable: 0, protected: 0, expired: 0 };
      for (const { userId, until } of rows) {
        if (moduleSignal?.aborted) break;
        if (until <= Math.floor(Date.now() / 1000)) { counts.expired++; continue; }
        let result: GroupMuteResult;
        try { result = await groupMute!(userId, 0); } catch { result = "unknown"; }
        counts[result]++;
      }
      const stopped = rows.length - Object.values(counts).reduce((total, count) => total + count, 0);
      return [
        `已解除 ${counts.confirmed} 人的禁言。`,
        counts.rejected && `${counts.rejected} 人的解禁被协议端拒绝。`,
        counts.unknown && `${counts.unknown} 人的解禁结果未确认，请在群内核对。`,
        counts.unavailable + counts.protected > 0 && `${counts.unavailable + counts.protected} 人未能解禁，请核对群管理权限。`,
        counts.expired && `${counts.expired} 人的禁言已到期。`,
        stopped > 0 && `${stopped} 人尚未处理。`,
      ].filter(Boolean).join("\n");
    }
    const issuerMaster = context.isBotMaster(issuer);
    let ids: number[];
    let perform: (id: number) => Promise<GroupMuteResult>;
    let operation: string;
    let checkWhitelist: boolean;
    if (admin) {
      if (!groupSetAdmin || !issuerMaster) return "当前会话没有设置群管理员的权限。";
      const numeric = admin[2];
      const selected = numeric && numeric.length < 5 ? undefined : kickTargets(context, bot, numeric);
      if (!selected) return "请 @ 要操作的群成员，或输入一个有效 QQ 号。";
      ids = selected;
      const enabled = admin[1] === "设置";
      perform = (id) => groupSetAdmin(id, enabled);
      operation = "设置为群管理员";
      checkWhitelist = false;
    } else if (kick) {
      if (!groupKick) return "当前会话没有移出群成员的权限。";
      const selected = kickTargets(context, bot, kick[2]);
      if (!selected) return "请 @ 要移出的群成员，或直接在指令后填写一个 QQ 号。";
      ids = selected;
      const block = kick[1] === "黑";
      perform = (id) => groupKick(id, block);
      operation = block ? "踢出群聊，协议端已确认踢黑请求" : "踢出群聊";
      checkWhitelist = true;
    } else {
      if (!groupMute) return "当前会话没有群禁言权限。";
      const action = targets(command, context, bot);
      if (!action) return "请 @ 群成员或输入 QQ 号，并填写有效的禁言时长（整数秒）。";
      const { seconds } = action;
      ids = action.ids;
      perform = (id) => groupMute(id, seconds);
      operation = seconds ? `禁言 ${seconds} 秒` : "解除禁言";
      checkWhitelist = seconds > 0;
    }
    let whitelist: ReadonlySet<number> | undefined;
    if (checkWhitelist && !issuerMaster) {
      try { whitelist = await readManagedWhitelist(root); }
      catch { return kick ? "群管保护配置暂不可用。" : "群禁言保护配置暂不可用。"; }
    }

    if (!claim(context, bot, issuer, Boolean(kick || admin))) return [];

    const outcomes = new Map<GroupMuteResult, number[]>();
    for (const id of ids) {
      let result: GroupMuteResult;
      try { result = whitelist?.has(id) ? "protected" : await perform(id); }
      catch { result = "unknown"; }
      if (result === "protected" && !issuerMaster) result = "unavailable";
      const handled = outcomes.get(result);
      if (handled) handled.push(id);
      else outcomes.set(result, [id]);
    }
    const confirmed = outcomes.get("confirmed");
    const rejected = outcomes.get("rejected");
    const unknown = outcomes.get("unknown");
    const protectedIds = outcomes.get("protected");
    const unavailable = outcomes.get("unavailable");
    let persistence: string | undefined;
    if (confirmed && kick?.[1] === "黑" && blacklist) {
      try {
        await blacklist.update(confirmed, true, moduleSignal);
        persistence = `${confirmed.join("、")} 已列入跨群群管黑名单。`;
      } catch {
        persistence = `协议已确认踢黑，未能将 ${confirmed.join("、")} 保存到跨群群管黑名单。`;
      }
    }
    return [
      confirmed && (admin?.[1] === "取消" ? `已取消 ${confirmed.join("、")} 的群管理员权限。` : `已将 ${confirmed.join("、")} ${operation}。`),
      persistence,
      rejected && `协议端拒绝操作 ${rejected.join("、")}。`,
      unknown && `${unknown.join("、")} 的操作结果未确认，请在群内核对。`,
      protectedIds && `${protectedIds.join("、")} ${kick || admin ? "受群管保护" : "受群禁言保护"}。`,
      unavailable && `无法操作 ${unavailable.join("、")}，请核对群成员和管理权限。`,
    ].filter(Boolean).join("\n");
  };
}
