import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { GroupRulesWritePermissionError } from "./banned-words.ts";
import { formatGroupModerationMember } from "./group-mute.ts";

export type GroupSpecialTitleResult = "confirmed" | "rejected" | "unknown" | "unavailable" | "protected";

export interface GroupTitleContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly group_id?: number;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly message_id?: number | string;
  readonly adapter?: "onebot" | "milky";
  readonly isDelegated?: boolean;
  readonly normalizedMessage: string;
  readonly message?: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly isBotMaster: (id: number) => boolean;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly groupSetSpecialTitle?: (target: number, title: string, verify?: () => Promise<boolean>, onConfirmedName?: (name: string) => void) => Promise<GroupSpecialTitleResult>;
}

type Data = Record<string, unknown>;
interface GroupTitleStore {
  read(groupId: number): Promise<Data>;
  update(groupId: number, authorize: () => Promise<boolean>, change: (data: Data) => string): Promise<string>;
}

export const groupTitleFeature = "[group] 群头衔";
export const groupTitleFilterFeature = "[group] 头衔屏蔽词";
const selfTitle = /^#(?:申请|我要)头衔([\s\S]*)$/u;
const otherTitle = /^#(?:设置|修改)头衔([\s\S]*)$/u;
const editWords = /^#(增加|减少|查看)头衔屏蔽词([\s\S]*)$/u;
const switchMode = /^#切换头衔屏蔽词匹配(?:模式)?$/u;
const maxTitleLength = 128;
const maxWords = 160;
const controls = /[\p{Cc}\u2028\u2029]/u;

export function groupTitleCommandFeature(message: string): string | undefined {
  if (editWords.test(message) || switchMode.test(message)) return groupTitleFilterFeature;
  if (selfTitle.test(message) || otherTitle.test(message)) return groupTitleFeature;
}

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

function titleTarget(message: GroupTitleContext["message"], bot: number): number | null | undefined {
  if (!message || typeof message === "string") return;
  let target: number | undefined;
  for (const segment of message) {
    if (segment.type === "mention_all") return null;
    if (segment.type !== "at") continue;
    const id = typeof segment.qq === "string" && /^[1-9]\d*$/u.test(segment.qq) ? Number(segment.qq) : segment.qq;
    if (id === bot) continue;
    if (!positive(id) || target !== undefined) return null;
    target = id;
  }
  return target;
}

function titleWords(data: Data): readonly string[] {
  const words = data.TitleBannedWords;
  if (words == null) return [];
  if (!Array.isArray(words) || words.some((word) => word && (typeof word !== "string" || !word.isWellFormed() || controls.test(word)))) {
    throw new Error($t("group-title.text_fc4cce2240"));
  }
  return words.filter(Boolean);
}

function isSubstringMode(data: Data): boolean {
  const mode = data.TitleFilterModeChange;
  if (mode === 1 || mode === "1") return true;
  if (mode == null || mode === 0 || mode === "0") return false;
  throw new Error($t("group-title.text_8efeafc478"));
}

export function createGroupTitle(store: GroupTitleStore, signal: AbortSignal) {
  const claimed = new Set<string>();

  function remember(context: GroupTitleContext): boolean {
    const id = context.message_id;
    if (!(typeof id === "number" && Number.isSafeInteger(id)) && !(typeof id === "string" && id.length > 0 && id.length <= 128)) return false;
    const key = JSON.stringify([context.adapter ?? "onebot", context.self_id, context.group_id, context.user_id, String(id)]);
    if (claimed.has(key)) return false;
    claimed.add(key);
    if (claimed.size > 2048) {
      const first = claimed.values().next();
      if (!first.done) claimed.delete(first.value);
    }
    return true;
  }

  return async (context: GroupTitleContext): Promise<string | readonly [] | undefined> => {
    const message = context.normalizedMessage.trim();
    const { group_id, self_id, user_id } = context;
    if (context.message_type !== "group" || context.isDelegated || signal.aborted ||
        !positive(group_id) || !positive(self_id) || !positive(user_id)) return;
    const edit = editWords.exec(message), toggle = switchMode.test(message);
    if (edit || toggle) {
      try {
        if (edit?.[1] === "查看") {
          const words = titleWords(await store.read(group_id));
          return $t("group-title.text_c4656f6d72", { "value1": words.length ? `\n${words.join("\n")}` : $t("group-title.text_484d556139") });
        }
        const authorize = async () => !signal.aborted && await context.groupManageBlacklist?.() === true && !signal.aborted;
        if (!await authorize()) return $t("group-title.text_546058c94e");
        if (!remember(context)) return [];
        if (toggle) return await store.update(group_id, authorize, (data) => {
          const substring = !isSubstringMode(data);
          data.TitleFilterModeChange = substring ? 1 : 0;
          return $t("group-title.text_eea3407ed7", { "value1": substring ? $t("group-title.text_36bab7a3de") : $t("group-title.text_235532a9c1") });
        });
        const selected = [...new Set((edit?.[2] ?? "").split(/[,，]/u).map((item) => item.trim()).filter(Boolean))];
        if (!selected.length || selected.length > maxWords || selected.some((word) => word.length > maxTitleLength || !word.isWellFormed() || controls.test(word))) {
          return $t("group-title.text_72aae60c79");
        }
        const adding = edit?.[1] === "增加";
        return await store.update(group_id, authorize, (data) => {
          const current = titleWords(data);
          const existing = selected.filter((word) => current.includes(word));
          const absent = selected.filter((word) => !current.includes(word));
          if (adding && current.length + absent.length > maxWords) return $t("group-title.text_a824fcae29");
          if (adding && absent.length) data.TitleBannedWords = [...current, ...absent];
          if (!adding && existing.length) data.TitleBannedWords = current.filter((word) => !existing.includes(word));
          return (adding ? [absent.length ? $t("group-title.text_cc6f47db46", { "value1": absent.join("、") }) : "", existing.length ? $t("group-title.text_555b7d4434", { "value1": existing.join("、") }) : ""]
            : [existing.length ? $t("group-title.text_74554e8fb2", { "value1": existing.join("、") }) : "", absent.length ? $t("group-title.text_fe8f13b0c6", { "value1": absent.join("、") }) : ""])
            .filter(Boolean).join("\n");
        });
      } catch (error) {
        return error instanceof GroupRulesWritePermissionError ? $t("group-title.text_546058c94e") : $t("group-title.text_1dc0552f31");
      }
    }

    const self = selfTitle.exec(message), other = otherTitle.exec(message);
    if (!self && !other) return;
    const mentioned = other ? titleTarget(context.message, self_id) : undefined;
    const legacySelf = mentioned === undefined && message.startsWith("#设置头衔");
    const changesOwnTitle = !!self || legacySelf;
    const target = changesOwnTitle ? user_id : mentioned;
    if (!target) return $t("group-title.text_cd1111c85e");
    const requested = (self?.[1] ?? other?.[1] ?? "").trimStart();
    if (legacySelf && !requested) return $t("group-title.text_939d5d690a");
    if (requested.length > maxTitleLength || !requested.isWellFormed() || controls.test(requested)) return $t("group-title.text_961b67d3da");
    if (!context.groupSetSpecialTitle || !changesOwnTitle && !context.isBotMaster(user_id)) return $t("group-title.text_2cf05441ba");

    const verify = changesOwnTitle ? async () => {
      if (signal.aborted) return false;
      if (!requested || context.isBotMaster(user_id)) return true;
      const current = await store.read(group_id);
      const substring = isSubstringMode(current);
      return !signal.aborted && !titleWords(current).some((word) => word && (substring ? requested.includes(word) : requested === word));
    } : undefined;
    if (!remember(context)) return [];
    try {
      if (verify && !await verify()) return $t("group-title.text_e002ad88e0");
    } catch { return $t("group-title.text_1dc0552f31"); }
    if (signal.aborted) return;
    let result: GroupSpecialTitleResult;
    let name: string | undefined;
    try { result = await context.groupSetSpecialTitle(target, requested, verify, changesOwnTitle ? undefined : value => { name = value; }); }
    catch { result = "unknown"; }
    switch (result) {
      case "confirmed": {
        if (changesOwnTitle) return requested ? $t("group-title.text_d92312ffc0", { "requested": requested }) : $t("group-title.text_de30dcf804");
        const member = formatGroupModerationMember(target, name);
        return requested ? $t("group-title.text_7d9e11d9cf", { "member": member, "requested": requested }) : $t("group-title.text_238746aae7", { "member": member });
      }
      case "protected": return changesOwnTitle ? $t("group-title.text_56fed14298") : $t("group-title.text_f540fa427a");
      case "unavailable": return $t("group-title.text_b3912f7c65");
      case "rejected": return $t("group-title.text_9cf4485104");
      default: return $t("group-title.text_95612fae08");
    }
  };
}
