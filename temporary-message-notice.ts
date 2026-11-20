import { formatNoticeBodyText } from "./message-notice-content.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type TemporaryMessageNoticePart = string | { readonly type: "image"; readonly file: string };
export interface TemporaryMessageNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly text?: string;
  readonly readText?: () => Promise<string | undefined>;
  readonly groupId?: number;
  readonly reportedGroupId?: number;
}
export type TemporaryMessageNotice = (message: TemporaryMessageNoticeInput, signal?: AbortSignal) =>
  Promise<readonly TemporaryMessageNoticePart[] | undefined>;

export const temporaryMessageNoticeFeature = "[group] 群临时消息通知";

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createTemporaryMessageNotice(options: PrivateNoticeOptions): TemporaryMessageNotice {
  const isEnabled = createPrivateNoticeSettings(options, "grouptemporaryMessage");
  return async ({ botId, userId, text, readText, groupId, reportedGroupId }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId) return;
    let content = !readText && typeof text === "string" ? formatNoticeBodyText(text) : "";
    const group = positiveId(groupId) ? groupId : undefined;
    if ((!readText && !content.trim()) || !await isEnabled(botId, signal, group) || options.signal?.aborted || signal?.aborted) return;
    if (readText) {
      try {
        const value = await readText();
        if (typeof value !== "string" || options.signal?.aborted || signal?.aborted) return;
        content = formatNoticeBodyText(value);
      } catch { return; }
      if (!content.trim()) return;
    }

    const source = group ?? (positiveId(reportedGroupId) ? `未核实（协议报告 ${reportedGroupId}）` : "未核实");
    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `[消息(${botId}) - 群临时消息]\n`,
      `来源群号：${source}\n`,
      `发送人账号：${userId}\n`,
      "消息内容：", content,
    ];
  };
}
