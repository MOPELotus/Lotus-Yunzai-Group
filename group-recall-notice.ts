import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import type { MessageNoticePart } from "./message-notice-content.ts";
import { displayRequestField } from "./group-pending-join.ts";
import type { PrivateNoticeOptions } from "./private-notice-config.ts";
import { createRecallRetention, formatRecallBody, formatRecallTime, positiveRecallId, type RecallNoticeBodyPart } from "./recall-notice.ts";

export type GroupRecallPart = string | { readonly type: "image"; readonly file: string };
export interface GroupRecallNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly operatorId?: number;
  readonly special?: "[语音]" | "[视频]";
  readonly time: number;
  readonly text: string;
  readonly parts?: readonly MessageNoticePart[];
  readonly groupName?: string;
  readonly nickname?: string;
  readonly operatorName?: string;
}
export interface GroupRecallNoticeOutput {
  readonly summary: readonly GroupRecallPart[];
  readonly text: string;
  readonly parts?: readonly RecallNoticeBodyPart[];
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
    async format({ botId, groupId, userId, operatorId, special, time, text, parts, groupName, nickname, operatorName }, signal) {
      if (!positiveRecallId(userId) || botId === userId || botId === operatorId || typeof text !== "string") return;
      const when = formatRecallTime(time);
      const content = formatRecallBody(text, parts);
      if (!when || !content || await retention(botId, groupId, signal) === undefined || options.signal?.aborted || signal?.aborted) return;

      const name = displayRequestField(nickname, 128);
      const author = name ? `${name}(${userId})` : String(userId);
      const manager = positiveRecallId(operatorId) && operatorId !== userId ? operatorId : undefined;
      const summary: GroupRecallPart[] = [
        { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` },
        $t("group-recall-notice.text_80e54e7d6e", { "botId": botId, "value2": manager === undefined ? "" : $t("group-recall-notice.text_bb6d995724") }),
        $t("group-recall-notice.text_1c463fcb34", { "value1": displayRequestField(groupName, 128) || $t("group-recall-notice.text_4d8c1c5b42") }),
        $t("group-recall-notice.text_140d9d9ff5", { "groupId": groupId }),
      ];
      if (manager !== undefined) {
        const operator = displayRequestField(operatorName, 128);
        summary.push($t("group-recall-notice.text_144785d8f1", { "value1": operator ? `${operator}(${manager})` : manager }), $t("group-recall-notice.text_8dcd88315a", { "author": author }));
      } else summary.push($t("group-recall-notice.text_82a00d837b", { "author": author }));
      summary.push($t("group-recall-notice.text_e61802dc6c", { "when": when }));
      if (special === "[语音]" || special === "[视频]") summary.push($t("group-recall-notice.text_23cd2ec56d", { "special": special }));
      return { summary, ...content, ...(name && { nickname: name }) };
    },
  };
}
