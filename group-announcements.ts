import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
export interface GroupAnnouncement {
  readonly id: string;
  readonly text: string;
}

export interface GroupAnnouncementsContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly isDelegated?: boolean;
  readonly groupListAnnouncements?: () => Promise<readonly GroupAnnouncement[] | undefined>;
}

export type GroupAnnouncementPublishResult = "confirmed" | "rejected" | "unknown" | "unavailable" | "invalid-image";
export interface GroupAnnouncementDeleteResult {
  readonly status: "confirmed" | "rejected" | "unknown" | "unavailable" | "not-found";
  readonly text?: string;
}

interface GroupAnnouncementMutationContext extends GroupAnnouncementsContext {
  readonly adapter?: "onebot" | "milky";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_id?: number | string;
}

export interface GroupAnnouncementPublishContext extends GroupAnnouncementMutationContext {
  readonly groupPublishAnnouncement?: (text: string) => Promise<GroupAnnouncementPublishResult>;
}

export interface GroupAnnouncementDeleteContext extends GroupAnnouncementMutationContext {
  readonly groupDeleteAnnouncement?: (index: number) => Promise<GroupAnnouncementDeleteResult>;
}

export const groupAnnouncementsFeature = "[group] 群公告";
const commandPattern = /^#查群?公告$/u;
export const isGroupAnnouncementsCommand = (message: string) => commandPattern.test(message);
const publishPattern = /^#发群?公告/u;
export const isGroupAnnouncementPublishCommand = (message: string) => publishPattern.test(message);
const deletePattern = /^#删群?公告(\d+)$/u;
export const isGroupAnnouncementDeleteCommand = (message: string) => deletePattern.test(message);

const maxEntries = 20;
const summaryLength = 30;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const unavailable = $t("group-announcements.text_fb7cf31f5f");
const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function summary(text: string): string {
  // Keep joiners used by emoji, while removing controls and directional formatting.
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(directionControls, "").trim();
  if (!line) return $t("group-announcements.text_ed90d3f61e");
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(line.toWellFormed())) {
    if (parts.length === summaryLength) return parts.slice(0, summaryLength - 3).join("") + "...";
    parts.push(segment);
  }
  return parts.join("");
}

function deletedText(text: string): string {
  const cleaned = text.replace(/\r\n?|[\u2028\u2029]/gu, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "").replace(directionControls, "").toWellFormed();
  if (!cleaned.trim()) return $t("group-announcements.text_06891158b3");
  const maxLength = 4096;
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 1).replace(/[\ud800-\udbff]$/u, "") + "…";
}

export async function groupAnnouncementsCommand(message: string, context: GroupAnnouncementsContext, signal?: AbortSignal): Promise<string | undefined> {
  if (context.message_type !== "group" || !isGroupAnnouncementsCommand(message)) return;
  if (context.isDelegated || signal?.aborted || !context.groupListAnnouncements) return unavailable;
  try {
    const entries = await context.groupListAnnouncements();
    if (!entries || signal?.aborted) return unavailable;
    if (!entries.length) return $t("group-announcements.text_6628d29264");
    return entries.slice(0, maxEntries).map(({ text }, index) => `${index + 1}、${summary(text)}`).join("\n");
  } catch { return unavailable; }
}

function positiveId(value: number | undefined): value is number { return value !== undefined && Number.isSafeInteger(value) && value > 0; }

function groupAnnouncementMessageKey(context: GroupAnnouncementMutationContext, signal?: AbortSignal) {
  const { adapter, self_id, user_id, group_id, message_id } = context;
  const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
    typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
  if (context.isDelegated || signal?.aborted || !nativeId || !positiveId(self_id) || !positiveId(group_id) || !positiveId(user_id)) return;
  return JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
}

function createAnnouncementClaim() {
  const seen = new Set<string>();
  return (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 2048) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  };
}

export function createGroupAnnouncementPublisher(signal?: AbortSignal) {
  const claim = createAnnouncementClaim();
  return async (message: string, context: GroupAnnouncementPublishContext): Promise<string | readonly [] | undefined> => {
    const prefix = publishPattern.exec(message)?.[0];
    if (!prefix || context.message_type !== "group") return;
    const { groupPublishAnnouncement } = context;
    const key = groupAnnouncementMessageKey(context, signal);
    const unavailable = $t("group-announcements.text_34281e36c5");
    if (!key || !groupPublishAnnouncement) return unavailable;
    const content = message.slice(prefix.length).trim();
    if (!content) return $t("group-announcements.text_afe5787558");
    if (!claim(key)) return [];

    let result: GroupAnnouncementPublishResult;
    try { result = await groupPublishAnnouncement(content); } catch { result = "unknown"; }
    switch (result) {
      case "confirmed": return [];
      case "rejected": return $t("group-announcements.text_4fa8fa024e");
      case "unknown": return $t("group-announcements.text_60fa51d23e");
      case "unavailable": return unavailable;
      case "invalid-image": return $t("group-announcements.text_d577275507");
    }
  };
}

export function createGroupAnnouncementDeletion(signal?: AbortSignal) {
  const claim = createAnnouncementClaim();
  return async (message: string, context: GroupAnnouncementDeleteContext): Promise<string | readonly [] | undefined> => {
    const rawIndex = deletePattern.exec(message)?.[1];
    if (rawIndex === undefined || context.message_type !== "group") return;
    const { groupDeleteAnnouncement } = context;
    const key = groupAnnouncementMessageKey(context, signal);
    const unavailable = $t("group-announcements.text_04b1bd9302");
    if (!key || !groupDeleteAnnouncement) return unavailable;
    const index = Number(rawIndex);
    if (!positiveId(index)) return $t("group-announcements.text_85c90ad4fb");
    if (!claim(key)) return [];

    let result: GroupAnnouncementDeleteResult;
    try { result = await groupDeleteAnnouncement(index); } catch { result = { status: "unknown" }; }
    switch (result.status) {
      case "confirmed": return result.text === undefined ? $t("group-announcements.text_61b18b70fa", { "index": index }) : $t("group-announcements.text_1a0fc31c3b", { "value1": deletedText(result.text) });
      case "rejected": return $t("group-announcements.text_05f3714da2");
      case "unknown": return $t("group-announcements.text_a23217666d");
      case "not-found": return $t("group-announcements.text_cb8805ef97");
      case "unavailable": return unavailable;
    }
  };
}
