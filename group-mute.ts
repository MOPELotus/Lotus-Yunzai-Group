import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { ManagedBlacklistPermissionError, readManagedWhitelist, type ManagedBlacklistStore } from "./managed-blacklist.ts";

export type GroupWholeMuteResult = "confirmed" | "rejected" | "unknown" | "unavailable";
export type GroupMuteResult = GroupWholeMuteResult | "protected";
export type GroupKickResult = GroupMuteResult;
export type GroupSetAdminResult = GroupMuteResult;
export type GroupEssenceResult = GroupWholeMuteResult | "invalid-quote";
export interface GroupMuteRosterEntry {
  readonly userId: number;
  readonly name?: string;
  readonly role?: "member" | "admin" | "owner";
  readonly until: number;
}
type RosterPart = string | { readonly type: "image"; readonly file: string };
type GroupMuteReply = string | readonly [] | { readonly type: "quoted"; readonly message: string } |
  { readonly type: "forward"; readonly nodes: readonly (readonly RosterPart[])[] };

export interface GroupMuteContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly group_id?: number;
  readonly user_id?: number;
  readonly self_id?: number;
  readonly message_id?: number | string;
  readonly reply_id?: number | string;
  readonly adapter?: "onebot" | "milky";
  readonly isDelegated?: boolean;
  readonly message?: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly normalizedMessage?: string;
  readonly isBotMaster: (userId: number) => boolean;
  readonly groupMute?: (userId: number, seconds: number) => Promise<GroupMuteResult>;
  readonly groupMuteSelf?: (seconds: number) => Promise<GroupMuteResult>;
  readonly groupMuteRoster?: () => Promise<readonly GroupMuteRosterEntry[] | undefined>;
  readonly groupWholeMute?: (enabled: boolean) => Promise<GroupWholeMuteResult>;
  readonly groupKick?: (userId: number, block: boolean, onConfirmedName?: (name: string) => void) => Promise<GroupKickResult>;
  readonly groupSetAdmin?: (userId: number, enabled: boolean, onConfirmedName?: (name: string) => void) => Promise<GroupSetAdminResult>;
  readonly groupSetQuotedEssence?: (enabled: boolean) => Promise<GroupEssenceResult>;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupManageWhitelistAutoUnmute?: () => Promise<boolean>;
}

export const groupMuteFeature = "[group] 群禁言";
export const groupMuteSelfFeature = "[group] 自助禁言";
export const groupMuteRosterFeature = "[group] 群禁言列表";
export const groupKickFeature = "[group] 群成员移出";
export const groupSetAdminFeature = "[group] 群管理员";
export const groupEssenceFeature = "[group] 群精华";
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
const selfMutePattern = new RegExp(String.raw`^#?我要(?:自闭|禅定)([零一壹二两三四五六七八九十百千万亿\d]+)?个?(${[...groupTimeUnits.keys()].join("|")})?$`, "iu");
const commandPattern = /^#(?:禁言|解禁)(?=$|[\s\d零一壹二两三四五六七八九十百千万亿])/u;
const wholeMutePattern = /^#全[体员](禁言|解禁)$/u;
const rosterPattern = /^#(?:(?:获取|查看)?禁言列表|解除全部禁言)$/u;
const kickPattern = /^#踢(黑)?(\d+)?$/u;
const adminPattern = /^#(设置|取消)管理(?:\s*(\d+))?$/u;
const essencePattern = /^#?(加|设|移)精$/u;
const listPattern = /^#?群管(加|删)(白|黑)(?:名单)?(?:\s*(\d+))?$/u;
const autoUnmutePattern = /^#?(开启|关闭)白名单(?:自动)?解禁$/u;

export function groupModerationFeature({ normalizedMessage }: { readonly normalizedMessage: string }): readonly string[] {
  const message = normalizedMessage.trim();
  const list = listPattern.exec(message);
  if (list?.[2] === "白" || autoUnmutePattern.test(message)) return [groupManagedWhitelistFeature];
  if (list) return [groupManagedBlacklistFeature];
  if (rosterPattern.test(message)) return [groupMuteRosterFeature];
  if (adminPattern.test(message)) return [groupSetAdminFeature];
  if (essencePattern.test(message)) return [groupEssenceFeature];
  if (selfMutePattern.test(message)) return [groupMuteSelfFeature];
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

export function parseGroupMuteDuration(value: string): number | undefined {
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
  const multiplier = groupTimeUnits.get((parts[2] ?? $t("group-mute.text_9dcdc2b289")).toUpperCase());
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
  const seconds = releasing ? (args ? undefined : 0) : parseGroupMuteDuration(args);
  if (seconds !== undefined && ids.every((id) => id !== botId)) return { ids, seconds };
}

export function groupModerationName(value: string | undefined): string | undefined {
  if (typeof value !== "string") return;
  const name = value.slice(0, 256).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim();
  return name && Array.from(name).slice(0, 80).join("");
}

export function formatGroupModerationMember(userId: number, value: string | undefined): string {
  const id = String(userId);
  const name = groupModerationName(value);
  return name && name !== id ? `${name}（${id}）` : id;
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
  if (!active.length) return $t("group-mute.text_a8ef62dfea");
  const nodes: RosterPart[][] = [];
  const perNode = Math.ceil(active.length / 100);
  const roles = { member: $t("group-mute.text_af43d2e34f"), admin: $t("group-mute.text_628153beb4"), owner: $t("group-mute.text_81d4acd17e") } as const;
  for (let start = 0; start < active.length; start += perNode) {
    const node: RosterPart[] = [];
    for (const { userId, name, role, until } of active.slice(start, start + perNode)) {
      const nickname = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 128).toWellFormed() : "";
      const remaining = until - now;
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor(remaining / 3600) % 24;
      const minutes = Math.floor(remaining / 60) % 60;
      const time = $t("group-mute.text_b9149928c9", { "value1": days ? $t("group-mute.text_12cebb1cf7", { "days": days }) : "", "value2": hours ? $t("group-mute.text_969e87756b", { "hours": hours }) : "", "value3": minutes ? $t("group-mute.text_b8a2da7e54", { "minutes": minutes }) : "", "value4": remaining % 60 });
      if (node.length) node.push("\n\n");
      node.push({ type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        $t("group-mute.text_6e17514698", { "value1": nickname || userId, "userId": userId, "value3": role && Object.hasOwn(roles, role) ? roles[role] : $t("group-mute.text_c098e854e6") }) +
        $t("group-mute.text_d5a096a521", { "time": time, "value2": new Date(until * 1000).toLocaleString("zh-CN") }));
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
    const essence = essencePattern.exec(command);
    const selfMute = selfMutePattern.exec(command);
    const editList = listPattern.exec(command);
    const toggle = autoUnmutePattern.exec(command);
    if (!whole && !roster && !kick && !admin && !essence && !selfMute && !editList && !toggle && !commandPattern.test(command) && !compactMuteUnit.test(command)) return;
    const { groupMute, groupMuteSelf, groupMuteRoster, groupWholeMute, groupKick, groupSetAdmin, groupSetQuotedEssence, user_id, self_id, group_id } = context;
    const issuer = positiveId(user_id), bot = positiveId(self_id);
    const list = editList?.[2] === "白" || toggle ? $t("group-mute.text_27e2d9e2d9") : $t("group-mute.text_174ec5a4ab");
    const listPermission = toggle ? $t("group-mute.text_83a76cffba") : $t("group-mute.text_5f0d545088", { "list": list });
    if (context.isDelegated || moduleSignal?.aborted || issuer === undefined || bot === undefined || positiveId(group_id) === undefined) {
      if (editList || toggle) return listPermission;
      if (admin) return $t("group-mute.text_33e9d2a303");
      if (essence) return $t("group-mute.text_74cd0a4734");
      if (selfMute) return $t("group-mute.text_78a692e9df");
      return kick ? $t("group-mute.text_3507d4ea03") : $t("group-mute.text_a6816ec207");
    }
    if (selfMute) {
      if (issuer === bot || context.isBotMaster(issuer)) return { type: "quoted", message: $t("group-mute.text_5913483e8c") };
      const amount = selfMute[1] === undefined ? 5 : parseGroupInteger(selfMute[1]);
      const multiplier = groupTimeUnits.get((selfMute[2] ?? $t("group-mute.text_b6a993c256")).toUpperCase());
      const seconds = amount !== undefined && multiplier !== undefined ? amount * multiplier : 0;
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxGroupMuteSeconds) return $t("group-mute.text_8b1440ae37");
      if (!groupMuteSelf) return $t("group-mute.text_78a692e9df");
      if (!claim(context, bot, issuer, true)) return [];
      let result: GroupMuteResult;
      try { result = await groupMuteSelf(seconds); } catch { result = "unknown"; }
      switch (result) {
        case "confirmed": return { type: "quoted", message: $t("group-mute.text_ee919b8c63") };
        case "protected": return { type: "quoted", message: $t("group-mute.text_5913483e8c") };
        case "rejected": return $t("group-mute.text_0ec4feb05f");
        case "unavailable": return $t("group-mute.text_78a692e9df");
        default: return $t("group-mute.text_7e6856229b");
      }
    }
    if (essence) {
      const enabled = essence[1] !== "移";
      const operation = enabled ? $t("group-mute.text_ac99962bb8") : $t("group-mute.text_6d15b2f370");
      const quoteRequired = $t("group-mute.text_b57491f340", { "operation": operation });
      const quote = context.reply_id;
      if (!(typeof quote === "number" && Number.isSafeInteger(quote) && quote !== 0) && !(typeof quote === "string" && quote.trim())) return quoteRequired;
      if (!groupSetQuotedEssence) return $t("group-mute.text_b0f39940d5");
      if (!claim(context, bot, issuer, true)) return [];
      let result: GroupEssenceResult;
      try { result = await groupSetQuotedEssence(enabled); } catch { result = "unknown"; }
      switch (result) {
        case "confirmed": return $t("group-mute.text_cb24c9668d", { "operation": operation });
        case "rejected": return $t("group-mute.text_7c0ca23df6", { "operation": operation });
        case "unavailable": return $t("group-mute.text_b0f39940d5");
        case "invalid-quote": return quoteRequired;
        default: return $t("group-mute.text_d573799815", { "operation": operation });
      }
    }
    if (editList || toggle) {
      if (!blacklist) return $t("group-mute.text_06d2ef3a2a", { "list": list });
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
          return changed ? $t("group-mute.text_56d590de58", { "value1": toggle[1] }) : $t("group-mute.text_6e97c77ee5", { "value1": toggle[1] });
        }
        const action = kickTargets(context, bot, editList?.[3], true);
        if (!action || action.length !== 1) return $t("group-mute.text_888d5cee57");
        const target = action[0]!;
        const add = editList?.[1] === "加";
        const changed = await (list === "白名单" ? blacklist.updateWhitelist : blacklist.update)([target], add, moduleSignal, authorize);
        if (add) return changed ? $t("group-mute.text_1e83fa613f", { "target": target, "list": list }) : $t("group-mute.text_48e6f60f02", { "target": target, "list": list });
        return changed ? $t("group-mute.text_2b5516117e", { "list": list, "target": target }) : $t("group-mute.text_8582eacd4c", { "target": target, "list": list });
      } catch (error) {
        if (error instanceof ManagedBlacklistPermissionError) return listPermission;
        return toggle ? $t("group-mute.text_faa625ff69") : $t("group-mute.text_a1778b97a8", { "list": list });
      }
    }
    if (whole) {
      if (!groupWholeMute) return $t("group-mute.text_a6816ec207");
      if (!claim(context, bot, issuer)) return [];
      const enabled = whole[1] === "禁言";
      let outcome: GroupWholeMuteResult;
      try { outcome = await groupWholeMute(enabled); }
      catch { outcome = "unknown"; }
      switch (outcome) {
        case "confirmed": return $t("group-mute.text_c70d091321", { "value1": enabled ? $t("group-mute.text_8da97ddda9") : $t("group-mute.text_3fd47edce4") });
        case "rejected": return $t("group-mute.text_52e0df1a8b");
        case "unavailable": return $t("group-mute.text_3ce1d4eb34");
        default: return $t("group-mute.text_727523782c");
      }
    }
    if (roster) {
      const release = command === "#解除全部禁言";
      if (release) {
        const denied = $t("group-mute.text_81cc7b9456");
        if (!groupMute || !context.groupManageBlacklist) return denied;
        if (!claim(context, bot, issuer, true)) return [];
        try {
          if (!await context.groupManageBlacklist() || moduleSignal?.aborted) return denied;
        } catch { return denied; }
      }
      if (!groupMuteRoster) return $t("group-mute.text_c751976359");
      const rows = await activeMuteRoster(groupMuteRoster);
      if (!rows || moduleSignal?.aborted) return $t("group-mute.text_c751976359");
      if (!release) return formatRoster(rows);
      if (!rows.length) return $t("group-mute.text_a8ef62dfea");
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
        $t("group-mute.text_f480ff4a82", { "confirmed": counts.confirmed }),
        counts.rejected && $t("group-mute.text_3a5db13677", { "rejected": counts.rejected }),
        counts.unknown && $t("group-mute.text_3b00179d07", { "unknown": counts.unknown }),
        counts.unavailable + counts.protected > 0 && $t("group-mute.text_ebc7be6f78", { "value1": counts.unavailable + counts.protected }),
        counts.expired && $t("group-mute.text_1a439dbea9", { "expired": counts.expired }),
        stopped > 0 && $t("group-mute.text_472710936f", { "stopped": stopped }),
      ].filter(Boolean).join("\n");
    }
    const issuerMaster = context.isBotMaster(issuer);
    let ids: number[];
    let perform: (id: number) => Promise<GroupMuteResult>;
    let operation: string;
    let checkWhitelist: boolean;
    const memberNames = new Map<number, string>();
    if (admin) {
      if (!groupSetAdmin || !issuerMaster) return $t("group-mute.text_33e9d2a303");
      const numeric = admin[2];
      const selected = numeric && numeric.length < 5 ? undefined : kickTargets(context, bot, numeric);
      if (!selected) return $t("group-mute.text_96acfa5626");
      ids = selected;
      const enabled = admin[1] === "设置";
      perform = (id) => groupSetAdmin(id, enabled, (name) => memberNames.set(id, name));
      operation = $t("group-mute.text_5c048fbdc5");
      checkWhitelist = false;
    } else if (kick) {
      if (!groupKick) return $t("group-mute.text_3507d4ea03");
      const selected = kickTargets(context, bot, kick[2]);
      if (!selected) return $t("group-mute.text_01f98325ed");
      ids = selected;
      const block = kick[1] === "黑";
      perform = (id) => groupKick(id, block, (name) => memberNames.set(id, name));
      operation = block ? $t("group-mute.text_6cf9dc4e39") : $t("group-mute.text_d5586c8693");
      checkWhitelist = true;
    } else {
      if (!groupMute) return $t("group-mute.text_a6816ec207");
      const action = targets(command, context, bot);
      if (!action) return $t("group-mute.text_affa132f94");
      const { seconds } = action;
      ids = action.ids;
      perform = (id) => groupMute(id, seconds);
      operation = seconds ? $t("group-mute.text_44cded3a5b", { "seconds": seconds }) : $t("group-mute.text_89972c2246");
      checkWhitelist = seconds > 0;
    }
    let whitelist: ReadonlySet<number> | undefined;
    if (checkWhitelist && !issuerMaster) {
      try { whitelist = await readManagedWhitelist(root); }
      catch { return kick ? $t("group-mute.text_08020476bd") : $t("group-mute.text_8a07d88ccf"); }
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
        persistence = $t("group-mute.text_697ac6031e", { "value1": confirmed.join("、") });
      } catch {
        persistence = $t("group-mute.text_12cc3d2f41", { "value1": confirmed.join("、") });
      }
    }
    const confirmedLabels = confirmed?.map(id => formatGroupModerationMember(id, memberNames.get(id))).join("、");
    return [
      confirmedLabels && (admin?.[1] === "取消" ? $t("group-mute.text_54f688e5f5", { "confirmedLabels": confirmedLabels }) : $t("group-mute.text_fdec810aac", { "confirmedLabels": confirmedLabels, "operation": operation })),
      persistence,
      rejected && $t("group-mute.text_b0d00fafb1", { "value1": rejected.join("、") }),
      unknown && $t("group-mute.text_20d90defe2", { "value1": unknown.join("、") }),
      protectedIds && `${protectedIds.join("、")} ${kick || admin ? $t("group-mute.text_22624520a4") : $t("group-mute.text_6e802272b0")}。`,
      unavailable && $t("group-mute.text_d4a68336b5", { "value1": unavailable.join("、") }),
    ].filter(Boolean).join("\n");
  };
}
