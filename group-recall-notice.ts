import { formatNoticeBodyText } from "./friend-message-notice.ts";
import { displayRequestField } from "./group-pending-join.ts";
import type { PrivateNoticeOptions } from "./private-notice-config.ts";
import { createRecallRetention, formatRecallTime, positiveRecallId } from "./recall-notice.ts";

export type GroupRecallPart = string | { readonly type: "image"; readonly file: string };
export interface GroupRecallNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly operatorId?: number;
  readonly time: number;
  readonly text: string;
  readonly groupName?: string;
  readonly nickname?: string;
  readonly operatorName?: string;
}
export interface GroupRecallNoticeOutput {
  readonly summary: readonly GroupRecallPart[];
  readonly text: string;
  readonly nickname?: string;
}
export interface GroupRecallNotice {
  retention(botId: number, groupId: number, signal?: AbortSignal): Promise<number | undefined>;
  format(input: GroupRecallNoticeInput, signal?: AbortSignal): Promise<GroupRecallNoticeOutput | undefined>;
}

export const groupRecallNoticeFeature = "[group] 群撤回通知";

export function createGroupRecallNotice(options: PrivateNoticeOptions): GroupRecallNotice {
  const retention = createRecallRetention(options, "groupRecall");
  return {
    retention,
    async format({ botId, groupId, userId, operatorId, time, text, groupName, nickname, operatorName }, signal) {
      if (!positiveRecallId(userId) || botId === userId || botId === operatorId || typeof text !== "string") return;
      const when = formatRecallTime(time);
      const content = formatNoticeBodyText(text);
      if (!when || !content.trim() || await retention(botId, groupId, signal) === undefined || options.signal?.aborted || signal?.aborted) return;

      const name = displayRequestField(nickname, 128);
      const author = name ? `${name}(${userId})` : String(userId);
      const manager = positiveRecallId(operatorId) && operatorId !== userId ? operatorId : undefined;
      const summary: GroupRecallPart[] = [
        { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
        `[通知(${botId}) - 群聊${manager === undefined ? "" : "管理"}撤回]\n`,
        `撤回群名：${displayRequestField(groupName, 128) || "未知"}\n`,
        `撤回群号：${groupId}\n`,
      ];
      if (manager !== undefined) {
        const operator = displayRequestField(operatorName, 128);
        summary.push(`撤回管理：${operator ? `${operator}(${manager})` : manager}\n`, `被撤回人：${author}\n`);
      } else summary.push(`撤回人员：${author}\n`);
      summary.push(`撤回时间：${when}`);
      return { summary, text: content, ...(name && { nickname: name }) };
    },
  };
}
