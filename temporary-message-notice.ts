import { formatNoticeBodyText } from "./message-notice-content.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type TemporaryMessageNoticePart = string | { readonly type: "image"; readonly file: string };
export interface TemporaryMessageNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly text: string;
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
  return async ({ botId, userId, text, groupId, reportedGroupId }, signal) => {
    if (!positiveId(botId) || !positiveId(userId) || botId === userId || typeof text !== "string") return;
    const content = formatNoticeBodyText(text);
    const group = positiveId(groupId) ? groupId : undefined;
    if (!content.trim() || !await isEnabled(botId, signal, group) || options.signal?.aborted || signal?.aborted) return;

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
