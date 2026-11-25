import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { groupTimeUnits, parseGroupInteger } from "./group-mute.ts";
import type { GroupKickResult } from "./group-mute.ts";
import { readManagedWhitelist } from "./managed-blacklist.ts";

export interface GroupActivityMember {
  readonly userId: number;
  readonly joinTime: number;
  readonly lastSentTime: number;
  readonly role: "member" | "admin" | "owner";
  readonly name?: string;
}

export type GroupActivityVisibility = "management" | "member";
type MemberActivity = Pick<GroupActivityMember, "joinTime" | "lastSentTime">;
type CleanupResult = GroupKickResult | "activity-changed";

export interface GroupActivityContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly adapter?: "onebot" | "milky";
  readonly message_id?: number | string;
  readonly isDelegated?: boolean;
  readonly normalizedMessage: string;
  readonly groupActivityRoster?: (visibility?: GroupActivityVisibility) => Promise<readonly GroupActivityMember[] | undefined>;
  readonly groupActivitySignal?: AbortSignal;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupKickInactive?: (userId: number, activity: MemberActivity) => Promise<CleanupResult>;
  readonly isBotMaster?: (userId: number) => boolean;
}

export const groupActivityFeature = "[group] 从未发言成员";
export const groupActivityRankFeature = "[group] 群成员活动排行";
const commandPattern = /^#查看从未发言过?的人(?:第([零一壹二两三四五六七八九十百千万亿\d]+)页)?$/u;
const rankPattern = /^#(?:查看|获取)?(不活跃排行榜|潜水排行榜|最近的?入群(?:情况|记录))([零一壹二两三四五六七八九十百千万亿\d]+)?$/u;
const cleanupPattern = /^#清理从未发言过?的人(?:第([零一壹二两三四五六七八九十百千万亿\d]+)页)?$/u;
const responsePattern = /^#?(确认|取消)清理$/u;
const inactivityUnits = [...groupTimeUnits.keys()].join("|");
const integerPattern = String.raw`[零一壹二两三四五六七八九十百千万亿\d]+`;
const timedPattern = new RegExp(`^#(查看|获取|清理)(${integerPattern})个?(${inactivityUnits})(?:没|未)发言的人(?:第(${integerPattern})页)?$`, "u");
const pageSize = 30;
const unavailable = $t("group-activity.text_e8ca51f84e");
const maxDateTimestamp = 8_640_000_000_000;

type Entry = string | { readonly type: "image"; readonly file: string };
type ActivityReply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Entry[])[] };

export function isGroupActivityCommand(message: string): boolean {
  const timed = timedPattern.exec(message);
  return commandPattern.test(message) || !!timed && timed[1] !== "清理";
}
export function isGroupActivityRankCommand(message: string): boolean { return rankPattern.test(message); }
export function isGroupActivityCleanupCommand(message: string): boolean {
  return cleanupPattern.test(message) || responsePattern.test(message) || timedPattern.exec(message)?.[1] === "清理";
}

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

function verifiedMembers(members: readonly GroupActivityMember[], bot: number): boolean {
  if (!Array.isArray(members)) return false;
  const identities = new Set<number>();
  for (const entry of members) {
    if (!entry || !positive(entry.userId) || identities.has(entry.userId) || !positive(entry.joinTime) ||
        entry.joinTime > maxDateTimestamp || !Number.isSafeInteger(entry.lastSentTime) || entry.lastSentTime < 0 ||
        entry.lastSentTime > maxDateTimestamp || !["member", "admin", "owner"].includes(entry.role)) return false;
    identities.add(entry.userId);
  }
  return identities.has(bot);
}

function formattedDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function memberAvatar(userId: number): Entry {
  return { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` };
}

function memberLabel({ userId, name }: GroupActivityMember): string {
  const nickname = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 128).toWellFormed() : "";
  return $t("group-activity.text_fdfcb48138", { "userId": userId, "value2": nickname || userId });
}

export async function readGroupActivityRoster(context: Pick<GroupActivityContext, "groupActivityRoster">, bot: number,
  visibility?: GroupActivityVisibility): Promise<readonly GroupActivityMember[] | undefined> {
  try {
    const roster = await context.groupActivityRoster?.(visibility);
    if (roster && verifiedMembers(roster, bot)) return roster;
  } catch { return; }
}

interface InactivityWindow { readonly label: string; readonly cutoff: number; readonly page: number }

function inactivityWindow(match: RegExpExecArray, epochMillis: number): InactivityWindow | string {
  const amount = parseGroupInteger(match[2] ?? "");
  const unit = match[3] ?? "";
  const unitSeconds = groupTimeUnits.get(unit);
  const seconds = amount !== undefined && unitSeconds !== undefined ? amount * unitSeconds : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxDateTimestamp) return $t("group-activity.text_54c9a615a8");
  const page = match[4] === undefined ? 1 : parseGroupInteger(match[4]);
  if (!page) return $t("group-activity.text_bab538b87f");
  return { label: `${amount}${unit}`, cutoff: Math.floor(epochMillis / 1000) - seconds, page };
}

async function readMembers(context: GroupActivityContext, bot: number, window?: InactivityWindow, forCleanup = false): Promise<GroupActivityMember[] | undefined> {
  const roster = await readGroupActivityRoster(context, bot);
  return roster?.filter((entry) => {
    if (entry.userId === bot || entry.role !== "member") return false;
    if (!window) return entry.joinTime === entry.lastSentTime;
    return entry.lastSentTime < window.cutoff && (!forCleanup || entry.lastSentTime > 0 && entry.joinTime < window.cutoff);
  }).sort(window ? (left, right) => left.lastSentTime - right.lastSentTime : (left, right) => left.joinTime - right.joinTime);
}

function activityRanking(roster: readonly GroupActivityMember[], recent: boolean, count: number): ActivityReply {
  const sorted = [...roster].sort(recent
    ? (left, right) => right.joinTime - left.joinTime
    : (left, right) => left.lastSentTime - right.lastSentTime).slice(0, count);
  const nodes: Entry[][] = [[recent ? $t("group-activity.text_7f9002261f", { "length": sorted.length }) : $t("group-activity.text_195d0c23ba", { "length": sorted.length })]];
  const perNode = Math.max(1, Math.ceil(sorted.length / 99));
  for (let start = 0; start < sorted.length; start += perNode) {
    const node: Entry[] = [];
    for (const [index, entry] of sorted.slice(start, start + perNode).entries()) {
      if (node.length) node.push("\n\n");
      if (!recent) node.push($t("group-activity.text_3ac49b343f", { "value1": start + index + 1 }));
      node.push(memberAvatar(entry.userId), memberLabel(entry));
      if (recent) node.push($t("group-activity.text_da6f627ab3", { "value1": formattedDate(entry.joinTime) }));
      node.push($t("group-activity.text_f2cdfe21b1", { "value1": entry.lastSentTime === 0 ? $t("group-activity.text_7450cc5b16") : formattedDate(entry.lastSentTime) }));
    }
    nodes.push(node);
  }
  return { type: "forward", nodes };
}

async function managementAllowed(context: GroupActivityContext): Promise<boolean> {
  try { return await context.groupManageBlacklist?.() === true; } catch { return false; }
}

function activityPage(members: readonly GroupActivityMember[], page: number, window?: InactivityWindow): ActivityReply {
  if (!members.length) return window ? $t("group-activity.text_0c88f66347", { "label": window.label }) : $t("group-activity.text_97a7a7cd47");
  const pages = Math.ceil(members.length / pageSize);
  if (page > pages) return $t("group-activity.text_8c42f26d5d", { "page": page, "pages": pages });
  const shown = members.slice((page - 1) * pageSize, page * pageSize);
  const nodes: Entry[][] = [[
    window ? $t("group-activity.text_98437fb742", { "label": window.label }) : $t("group-activity.text_c6cb9397aa"),
    $t("group-activity.text_461a50b127", { "page": page, "pages": pages, "length": shown.length, "value4": members.length }),
  ]];
  const next = window ? `#查看${window.label}没发言的人第${page + 1}页` : `#查看从未发言过的人第${page + 1}页`;
  if (page < pages) nodes[0]!.push($t("group-activity.text_9c24bfc568", { "next": next }));
  for (const entry of shown) {
    const time = window ? $t("group-activity.text_f2cdfe21b1", { "value1": entry.lastSentTime ? formattedDate(entry.lastSentTime) : $t("group-activity.text_7450cc5b16") }) : $t("group-activity.text_98d70da306", { "value1": formattedDate(entry.joinTime) });
    nodes.push([memberAvatar(entry.userId), memberLabel(entry) + time]);
  }
  return { type: "forward", nodes };
}

export async function groupActivityCommand(context: GroupActivityContext, signal?: AbortSignal, wallNow: () => number = Date.now): Promise<ActivityReply | undefined> {
  const command = context.normalizedMessage.trim();
  const match = commandPattern.exec(command), rank = rankPattern.exec(command);
  const timed = timedPattern.exec(command);
  if ((!match && !rank && (!timed || timed[1] === "清理")) || context.message_type !== "group" || context.isDelegated || signal?.aborted || context.groupActivitySignal?.aborted ||
      !positive(context.group_id) || !positive(context.user_id) || !positive(context.self_id)) return;
  if (rank) {
    const count = rank[2] === undefined ? 10 : parseGroupInteger(rank[2]);
    if (!count) return $t("group-activity.text_946b6fe8dd");
    const roster = await readGroupActivityRoster(context, context.self_id, "member");
    if (signal?.aborted || context.groupActivitySignal?.aborted) return;
    if (!roster) return $t("group-activity.text_9d921ef563");
    return activityRanking(roster, rank[1]?.startsWith("最近") === true, count);
  }
  if (timed) {
    const window = inactivityWindow(timed, wallNow());
    if (typeof window === "string") return window;
    if (timed[1] === "获取" && !await managementAllowed(context)) return $t("group-activity.text_432210226a");
    if (signal?.aborted || context.groupActivitySignal?.aborted) return;
    const members = await readMembers(context, context.self_id, window);
    if (signal?.aborted || context.groupActivitySignal?.aborted) return;
    return members ? activityPage(members, window.page, window) : unavailable;
  }
  if (!match) return;
  const page = match[1] === undefined ? 1 : parseGroupInteger(match[1]);
  if (!page) return $t("group-activity.text_bab538b87f");
  const members = await readMembers(context, context.self_id);
  if (signal?.aborted || context.groupActivitySignal?.aborted) return;
  return members ? activityPage(members, page) : unavailable;
}

interface PendingCleanup {
  readonly members: ReadonlyMap<number, MemberActivity>;
  readonly window?: InactivityWindow;
  readonly expires: number;
  readonly signal: AbortSignal;
}

function cleanupResult(outcomes: ReadonlyMap<GroupKickResult | "skipped", readonly number[]>): ActivityReply {
  const nodes: Entry[][] = [[$t("group-activity.text_d0abdaf029")]];
  const total = [...outcomes.values()].reduce((count, ids) => count + ids.length, 0);
  const perNode = Math.max(40, Math.ceil(total / 94));
  for (const [outcome, label] of [["confirmed", $t("group-activity.text_dd5f4239c3")], ["rejected", $t("group-activity.text_e5ffa04ac7")],
    ["unknown", $t("group-activity.text_6437e93806")], ["protected", $t("group-activity.text_3106a179e3")],
    ["unavailable", $t("group-activity.text_7dab13a1c4")], ["skipped", $t("group-activity.text_39c93849a3")]] as const) {
    const ids = outcomes.get(outcome);
    if (!ids?.length) continue;
    for (let start = 0; start < ids.length; start += perNode) {
      nodes.push([`${label}\n${ids.slice(start, start + perNode).map((id, index) => `${start + index + 1}、${id}`).join("\n")}`]);
    }
  }
  return { type: "forward", nodes };
}

export function createGroupActivityCleanup(root: URL, signal: AbortSignal, now: () => number = () => performance.now(), wallNow: () => number = Date.now) {
  const pending = new Map<string, PendingCleanup>();
  const preparing = new Set<string>();
  const seen = new Set<string>();
  const busy = new Set<number>();
  signal.addEventListener("abort", () => pending.clear(), { once: true });

  function claim(scope: string, messageId: number | string | undefined): boolean {
    if (!(typeof messageId === "number" && Number.isSafeInteger(messageId)) &&
        !(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 128)) return false;
    const key = JSON.stringify([scope, String(messageId)]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 2048) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  return async (context: GroupActivityContext): Promise<ActivityReply | readonly [] | undefined> => {
    const text = context.normalizedMessage.trim();
    const timed = timedPattern.exec(text);
    const never = cleanupPattern.exec(text);
    const preview = never || timed?.[1] === "清理";
    const response = responsePattern.exec(text);
    const { group_id, self_id, user_id, adapter, message_id, groupActivitySignal, groupKickInactive } = context;
    if ((!preview && !response) || context.message_type !== "group" || signal.aborted || context.isDelegated ||
        !groupActivitySignal || groupActivitySignal.aborted || !positive(group_id) || !positive(self_id) || !positive(user_id)) return;
    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id]);
    const time = now();
    for (const [scope, request] of pending) {
      if (request.expires <= time || request.signal.aborted) pending.delete(scope);
    }
    const current = pending.get(key);
    if (response && current?.signal !== groupActivitySignal) return;
    if (!claim(key, message_id)) return [];
    if (response?.[1] === "取消") {
      pending.delete(key);
      return $t("group-activity.text_d51fdbeb98");
    }
    if (busy.has(group_id)) return $t("group-activity.text_c6b25cf6eb");

    const active = () => !signal.aborted && !groupActivitySignal.aborted;
    const authorized = async () => !!groupKickInactive && active() && await managementAllowed(context) && active();
    const protectedId = (id: number, whitelist: ReadonlySet<number>) => id === user_id || context.isBotMaster?.(id) || whitelist.has(id);
    const denied = $t("group-activity.text_fae6a701c4");

    if (preview) {
      const window = timed ? inactivityWindow(timed, wallNow()) : undefined;
      if (typeof window === "string") return window;
      const paged = never?.[1];
      const page = paged === undefined ? window?.page : parseGroupInteger(paged);
      if (paged !== undefined && !page) return $t("group-activity.text_bab538b87f");
      if (preparing.has(key)) return $t("group-activity.text_a0e16a077a");
      pending.delete(key);
      preparing.add(key);
      try {
        if (!await authorized()) return denied;
        const members = await readMembers(context, self_id, window, true);
        if (!members || !active()) return unavailable;
        let whitelist: ReadonlySet<number>;
        try { whitelist = await readManagedWhitelist(root); } catch { return $t("group-activity.text_4f2209b12b"); }
        if (!active()) return;
        const eligible = members.filter(({ userId }) => !protectedId(userId, whitelist));
        if (!eligible.length) return window ? $t("group-activity.text_4995b77877", { "label": window.label }) : $t("group-activity.text_584770450a");
        const rosterPage = page === undefined ? undefined : activityPage(eligible, page, window);
        if (typeof rosterPage === "string") return rosterPage;
        const selected = new Map(eligible.map(({ userId, joinTime, lastSentTime }) => [userId, { joinTime, lastSentTime }]));
        if (pending.size >= 128) {
          const first = pending.keys().next();
          if (!first.done) pending.delete(first.value);
        }
        pending.set(key, { members: selected, window, expires: now() + 120_000, signal: groupActivitySignal });
        const prompt = $t("group-activity.text_45778d51bc", { "size": selected.size });
        return rosterPage ? { type: "forward", nodes: [[prompt + $t("group-activity.text_6f047dd795")], ...rosterPage.nodes] } : prompt;
      } finally {
        preparing.delete(key);
      }
    }

    if (!current) return;
    pending.delete(key);
    if (!groupKickInactive) return denied;
    busy.add(group_id);
    try {
      if (!await authorized()) return denied;
      const members = await readMembers(context, self_id, current.window, true);
      if (!members || !active()) return unavailable;
      if (!await authorized()) return denied;
      const stillEligible = new Map(members.map((member) => [member.userId, member]));
      const outcomes = new Map<GroupKickResult | "skipped", number[]>();
      for (const [id, initial] of current.members) {
        let result: GroupKickResult | "skipped" = "skipped";
        const fresh = stillEligible.get(id);
        if (active() && fresh?.joinTime === initial.joinTime && fresh.lastSentTime === initial.lastSentTime) {
          try {
            const whitelist = await readManagedWhitelist(root);
            if (protectedId(id, whitelist)) result = "protected";
            else if (active()) {
              try {
                const outcome = await groupKickInactive(id, initial);
                result = outcome === "activity-changed" ? "skipped" : outcome;
              } catch { result = "unknown"; }
            }
          } catch { result = "unavailable"; }
        }
        const ids = outcomes.get(result);
        if (ids) ids.push(id);
        else outcomes.set(result, [id]);
      }
      return cleanupResult(outcomes);
    } finally { busy.delete(group_id); }
  };
}
