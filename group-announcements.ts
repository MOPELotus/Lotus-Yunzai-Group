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

export interface GroupAnnouncementPublishContext extends GroupAnnouncementsContext {
  readonly adapter?: "onebot" | "milky";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_id?: number | string;
  readonly groupPublishAnnouncement?: (text: string) => Promise<GroupAnnouncementPublishResult>;
}

export const groupAnnouncementsFeature = "[group] 群公告";
const commandPattern = /^#查群?公告$/u;
export const isGroupAnnouncementsCommand = (message: string) => commandPattern.test(message);
const publishPattern = /^#发群?公告/u;
export const isGroupAnnouncementPublishCommand = (message: string) => publishPattern.test(message);

const maxEntries = 20;
const summaryLength = 30;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const unavailable = "当前无法获取本群的 QQ 群公告，请在 QQ 中查看。";

function summary(text: string): string {
  // Keep joiners used by emoji, while removing controls and directional formatting.
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
  if (!line) return "（无文字）";
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(line.toWellFormed())) {
    if (parts.length === summaryLength) return parts.slice(0, summaryLength - 3).join("") + "...";
    parts.push(segment);
  }
  return parts.join("");
}

export async function groupAnnouncementsCommand(message: string, context: GroupAnnouncementsContext, signal?: AbortSignal): Promise<string | undefined> {
  if (context.message_type !== "group" || !isGroupAnnouncementsCommand(message)) return;
  if (context.isDelegated || signal?.aborted || !context.groupListAnnouncements) return unavailable;
  try {
    const entries = await context.groupListAnnouncements();
    if (!entries || signal?.aborted) return unavailable;
    if (!entries.length) return "本群暂无群公告。";
    return entries.slice(0, maxEntries).map(({ text }, index) => `${index + 1}、${summary(text)}`).join("\n");
  } catch { return unavailable; }
}

function positiveId(value: number | undefined): value is number { return value !== undefined && Number.isSafeInteger(value) && value > 0; }

export function createGroupAnnouncementPublisher(signal?: AbortSignal) {
  const seen = new Set<string>();
  return async (message: string, context: GroupAnnouncementPublishContext): Promise<string | readonly [] | undefined> => {
    const prefix = publishPattern.exec(message)?.[0];
    if (!prefix || context.message_type !== "group") return;
    const { adapter, self_id, user_id, group_id, message_id, groupPublishAnnouncement } = context;
    const nativeId = typeof message_id === "number" ? Number.isSafeInteger(message_id) :
      typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128;
    const unavailable = "当前无法发布 QQ 群公告，请核对群管理权限和网关连接。";
    if (context.isDelegated || signal?.aborted || !groupPublishAnnouncement || !nativeId ||
        !positiveId(self_id) || !positiveId(group_id) || !positiveId(user_id)) return unavailable;
    const content = message.slice(prefix.length).trim();
    if (!content) return "❎ 公告不能为空";

    const key = JSON.stringify([adapter ?? "onebot", self_id, group_id, user_id, String(message_id)]);
    if (seen.has(key)) return [];
    seen.add(key);
    if (seen.size > 2048) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    let result: GroupAnnouncementPublishResult;
    try { result = await groupPublishAnnouncement(content); } catch { result = "unknown"; }
    switch (result) {
      case "confirmed": return [];
      case "rejected": return "❎ 发送失败，协议端拒绝发布群公告。";
      case "unknown": return "群公告发布结果未确认，请先在 QQ 中核对。";
      case "unavailable": return unavailable;
      case "invalid-image": return "无法使用原消息的公告图片，请检查后重新发送。";
    }
  };
}
