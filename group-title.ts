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

function titleTarget(message: GroupTitleContext["message"], bot: number): number | undefined {
  if (!message || typeof message === "string") return;
  let target: number | undefined;
  for (const segment of message) {
    if (segment.type === "mention_all") return;
    if (segment.type !== "at") continue;
    const id = typeof segment.qq === "string" && /^[1-9]\d*$/u.test(segment.qq) ? Number(segment.qq) : segment.qq;
    if (id === bot) continue;
    if (!positive(id) || target !== undefined) return;
    target = id;
  }
  return target;
}

function titleWords(data: Data): readonly string[] {
  const words = data.TitleBannedWords;
  if (words == null) return [];
  if (!Array.isArray(words) || words.some((word) => word && (typeof word !== "string" || !word.isWellFormed() || controls.test(word)))) {
    throw new Error("头衔屏蔽词数据无效。");
  }
  return words.filter(Boolean);
}

function isSubstringMode(data: Data): boolean {
  const mode = data.TitleFilterModeChange;
  if (mode === 1 || mode === "1") return true;
  if (mode == null || mode === 0 || mode === "0") return false;
  throw new Error("头衔屏蔽词匹配模式无效。");
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
          return `现有的头衔屏蔽词如下：${words.length ? `\n${words.join("\n")}` : "无"}`;
        }
        const authorize = async () => !signal.aborted && await context.groupManageBlacklist?.() === true && !signal.aborted;
        if (!await authorize()) return "当前会话没有编辑头衔屏蔽词的权限。";
        if (!remember(context)) return [];
        if (toggle) return await store.update(group_id, authorize, (data) => {
          const substring = !isSubstringMode(data);
          data.TitleFilterModeChange = substring ? 1 : 0;
          return `已修改匹配模式为${substring ? "模糊" : "精确"}匹配。`;
        });
        const selected = [...new Set((edit?.[2] ?? "").split(/[,，]/u).map((item) => item.trim()).filter(Boolean))];
        if (!selected.length || selected.length > maxWords || selected.some((word) => word.length > maxTitleLength || !word.isWellFormed() || controls.test(word))) {
          return "请填写有效的头衔屏蔽词，多个词用逗号分隔。";
        }
        const adding = edit?.[1] === "增加";
        return await store.update(group_id, authorize, (data) => {
          const current = titleWords(data);
          const existing = selected.filter((word) => current.includes(word));
          const absent = selected.filter((word) => !current.includes(word));
          if (adding && current.length + absent.length > maxWords) return "本群头衔屏蔽词已达上限。";
          if (adding && absent.length) data.TitleBannedWords = [...current, ...absent];
          if (!adding && existing.length) data.TitleBannedWords = current.filter((word) => !existing.includes(word));
          return (adding ? [absent.length ? `成功添加：${absent.join("、")}` : "", existing.length ? `以下词已存在：${existing.join("、")}` : ""]
            : [existing.length ? `成功删除：${existing.join("、")}` : "", absent.length ? `以下词未在屏蔽词中：${absent.join("、")}` : ""])
            .filter(Boolean).join("\n");
        });
      } catch (error) {
        return error instanceof GroupRulesWritePermissionError ? "当前会话没有编辑头衔屏蔽词的权限。" : "头衔屏蔽词配置暂不可用。";
      }
    }

    const self = selfTitle.exec(message), other = otherTitle.exec(message);
    if (!self && !other) return;
    const target = self ? user_id : titleTarget(context.message, self_id);
    if (!target) return "请 @ 一位要修改头衔的群成员。";
    const requested = (self?.[1] ?? other?.[1] ?? "").trimStart();
    if (requested.length > maxTitleLength || !requested.isWellFormed() || controls.test(requested)) return "请输入有效的群头衔。";
    if (!context.groupSetSpecialTitle || other && !context.isBotMaster(user_id)) return "当前会话没有设置该群头衔的权限。";

    const verify = self ? async () => {
      if (signal.aborted) return false;
      if (!requested || context.isBotMaster(user_id)) return true;
      const current = await store.read(group_id);
      const substring = isSubstringMode(current);
      return !signal.aborted && !titleWords(current).some((word) => word && (substring ? requested.includes(word) : requested === word));
    } : undefined;
    if (!remember(context)) return [];
    try {
      if (verify && !await verify()) return "头衔包含屏蔽词。";
    } catch { return "头衔屏蔽词配置暂不可用。"; }
    if (signal.aborted) return;
    let result: GroupSpecialTitleResult;
    let name: string | undefined;
    try { result = await context.groupSetSpecialTitle(target, requested, verify, other ? value => { name = value; } : undefined); }
    catch { result = "unknown"; }
    switch (result) {
      case "confirmed": {
        if (self) return requested ? `已将你的头衔更换为「${requested}」。` : "已清空你的群头衔。";
        const member = formatGroupModerationMember(target, name);
        return requested ? `已将 ${member} 的头衔设置为「${requested}」。` : `已清空 ${member} 的群头衔。`;
      }
      case "protected": return self ? "头衔包含屏蔽词，或该成员受群管保护。" : "该成员受群管保护。";
      case "unavailable": return "当前无法设置群头衔，请核对群成员和群主权限。";
      case "rejected": return "协议端拒绝设置群头衔。";
      default: return "设置群头衔的结果未确认，请在群内核对。";
    }
  };
}
