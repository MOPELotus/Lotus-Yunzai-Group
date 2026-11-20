export interface GroupAnnouncement {
  readonly id: string;
  readonly text: string;
}

export interface GroupAnnouncementsContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly isDelegated?: boolean;
  readonly groupListAnnouncements?: () => Promise<readonly GroupAnnouncement[] | undefined>;
}

export const groupAnnouncementsFeature = "[group] 群公告";
const commandPattern = /^#查群?公告$/u;
export const isGroupAnnouncementsCommand = (message: string) => commandPattern.test(message);

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
