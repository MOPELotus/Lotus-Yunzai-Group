import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
type NoticePart = string | { readonly type: "image"; readonly file: string } | {
  readonly type: "at";
  readonly qq: number;
};

interface MemberNames {
  readonly card?: string;
  readonly nickname?: string;
}

export interface GroupMemberNotice {
  readonly self_id: number;
  readonly user_id: number;
  readonly group_id: number;
  readonly operator_id?: number;
  readonly group_name?: string;
  readonly action_sub_type?: string;
  readonly dismiss?: boolean;
  readonly member?: MemberNames;
  readonly nickname?: string;
  readonly getGroupName?: () => Promise<string | undefined>;
  readonly reply: (content: readonly NoticePart[]) => boolean | Promise<boolean>;
}

interface WelcomeStorage {
  readonly set: (key: string, value: string, options: { NX: true; EX: number }) => Promise<string | null>;
}

const cooldownSeconds = 30;
const recentlyWelcomed = new Set<number>();

async function claimWelcome(groupId: number): Promise<boolean> {
  const { redis } = globalThis as { redis?: WelcomeStorage };
  if (redis) {
    return await redis.set(`Yz:newcomers:${groupId}`, "1", { NX: true, EX: cooldownSeconds }) === "OK";
  }
  if (recentlyWelcomed.has(groupId)) return false;
  recentlyWelcomed.add(groupId);
  setTimeout(() => recentlyWelcomed.delete(groupId), cooldownSeconds * 1000).unref();
  return true;
}

function displayText(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\u2028\u2029]+/gu, " ").trim() : "";
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canNotify(event: GroupMemberNotice): boolean {
  return positiveId(event.self_id) && positiveId(event.user_id) && positiveId(event.group_id) &&
    event.user_id !== event.self_id && event.dismiss !== true;
}

async function sendWithAvatar(event: GroupMemberNotice, content: readonly NoticePart[]): Promise<boolean> {
  const file = `https://q1.qlogo.cn/g?b=qq&nk=${event.user_id}&s=100`;
  if (await event.reply([{ type: "image", file }, "\n", ...content])) return true;
  return event.reply(content);
}

export async function welcomeMember(event: GroupMemberNotice, claim = claimWelcome): Promise<boolean> {
  if (!canNotify(event) || !await claim(event.group_id)) return false;

  let name = displayText(event.group_name);
  if (!name && event.getGroupName) {
    try {
      name = displayText(await event.getGroupName());
    } catch {
      // A welcome can still be sent if the adapter cannot look up the group.
    }
  }
  return sendWithAvatar(event, [
    $t("member-notices.text_8d7060efbf", { "value1": name ? `「${name}」` : $t("member-notices.text_0d5f4509dd") }),
    { type: "at", qq: event.user_id },
    $t("member-notices.text_764ebaf67d"),
  ]);
}

export async function announceDeparture(event: GroupMemberNotice): Promise<boolean> {
  if (!canNotify(event)) return false;

  const name = displayText(event.member?.card) || displayText(event.member?.nickname) || displayText(event.nickname);
  const who = name ? `${name}（${event.user_id}）` : `QQ ${event.user_id}`;
  const operator = event.operator_id;
  const kicked = operator && positiveId(operator)
    ? operator !== event.user_id : event.action_sub_type === "kick";
  const content = kicked
    ? $t("member-notices.text_335e0da8fc", { "who": who })
    : $t("member-notices.text_810bebfa4d", { "who": who });
  return sendWithAvatar(event, [content]);
}
