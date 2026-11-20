import { formatNoticeBodyText } from "./friend-message-notice.ts";
import { configuredPrivateNotice, createPrivateNoticeReader, privateNoticeSetting, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type FriendRecallNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRecallNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly time: number;
  readonly text: string;
}
export interface FriendRecallNotice {
  retention(botId: number, signal?: AbortSignal): Promise<number | undefined>;
  format(input: FriendRecallNoticeInput, signal?: AbortSignal): Promise<readonly FriendRecallNoticePart[] | undefined>;
}

export const friendRecallNoticeFeature = "[group] 好友撤回通知";
const defaultRetention = 600;
const maxRetention = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const shanghaiTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function retentionSeconds(value: unknown): number | undefined {
  if (value === undefined) return defaultRetention;
  const seconds = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= maxRetention) return seconds;
}

function formatTime(seconds: number): string {
  const parts = Object.fromEntries(shanghaiTime.formatToParts(seconds * 1_000).map(({ type, value }) => [type, value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function createFriendRecallNotice(options: PrivateNoticeOptions): FriendRecallNotice {
  const read = createPrivateNoticeReader(options);
  async function retention(botId: number, signal?: AbortSignal) {
    if (!positiveId(botId)) return;
    const settings = await read(signal);
    if (!options.signal?.aborted && !signal?.aborted && configuredPrivateNotice(settings, botId, "PrivateRecall")) {
      return retentionSeconds(privateNoticeSetting(settings, botId, "msgSaveDeltime"));
    }
  }

  return {
    retention,
    async format({ botId, userId, time, text }, signal) {
      if (!positiveId(userId) || botId === userId || !positiveId(time) || time > 8_640_000_000_000 || typeof text !== "string") return;
      const content = formatNoticeBodyText(text);
      if (!content.trim() || await retention(botId, signal) === undefined || options.signal?.aborted || signal?.aborted) return;
      return [
        { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
        `[消息(${botId}) - 好友撤回消息]\n`,
        `好友账号：${userId}\n`,
        `撤回时间：${formatTime(time)}\n`,
        "撤回消息：", content,
      ];
    },
  };
}
