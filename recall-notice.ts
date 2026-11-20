import { configuredPrivateNotice, createPrivateNoticeReader, privateNoticeSetting, type PrivateNoticeOptions } from "./private-notice-config.ts";

const defaultRetention = 600;
const maxRetention = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const shanghaiTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});

export function positiveRecallId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function recallRetentionSeconds(value: unknown): number | undefined {
  if (value === undefined) return defaultRetention;
  const seconds = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof seconds === "number" && positiveRecallId(seconds) && seconds <= maxRetention) return seconds;
}

export function formatRecallTime(seconds: number): string | undefined {
  if (!positiveRecallId(seconds) || seconds > 8_640_000_000_000) return;
  const parts = Object.fromEntries(shanghaiTime.formatToParts(seconds * 1_000).map(({ type, value }) => [type, value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function createRecallRetention(options: PrivateNoticeOptions, field: "PrivateRecall" | "groupRecall") {
  const read = createPrivateNoticeReader(options);
  return async (botId: number, groupId?: number, signal?: AbortSignal) => {
    if (!positiveRecallId(botId) || (field === "groupRecall" && !positiveRecallId(groupId))) return;
    const settings = await read(signal);
    if (!options.signal?.aborted && !signal?.aborted && configuredPrivateNotice(settings, botId, field, groupId)) {
      return recallRetentionSeconds(privateNoticeSetting(settings, botId, "msgSaveDeltime", groupId));
    }
  };
}
