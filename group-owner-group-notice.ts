import { formatGroupNoticeTime } from "./group-owner-member-notice.ts";
import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerGroupNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly kind: "joined" | "left" | "removed" | "dissolved" | "departed";
  readonly operatorId?: number;
  readonly groupName?: string;
  readonly describe?: () => Promise<string | undefined>;
  readonly time: number;
}
export type GroupOwnerGroupNotice = (event: GroupOwnerGroupNoticeInput, signal?: AbortSignal) => Promise<string | undefined>;

export const groupOwnerGroupNoticeFeature = "[group] 群聊列表变动通知";
const titles = {
  joined: "🟢 机器人加入群聊",
  left: "⚪ 机器人退出群聊",
  removed: "🔴 机器人被移出",
  dissolved: "🔴 群聊已解散",
  departed: "⚪ 机器人已离开群聊",
} as const;

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerGroupNotice(options: PrivateNoticeOptions): GroupOwnerGroupNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupNumberChange");
  return async ({ botId, groupId, kind, operatorId, groupName, time, describe }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(time) || time > 8_640_000_000_000 ||
        !Object.hasOwn(titles, kind) || !await isEnabled(botId, signal, groupId) ||
        options.signal?.aborted || signal?.aborted) return;

    let name = displayRequestField(groupName, 128);
    if (!name && describe) {
      try { name = displayRequestField(await describe(), 128); } catch { /* The group number is still known. */ }
    }
    if (options.signal?.aborted || signal?.aborted) return;

    const lines = [
      titles[kind],
      "────────────",
      `群聊：${name || "群名称暂不可用"}`,
      `群号：${groupId}`,
    ];
    if ((kind === "removed" || kind === "dissolved") && positiveId(operatorId)) lines.push(`操作人：${operatorId}`);
    lines.push("", `时间：${formatGroupNoticeTime(time * 1_000)}`, `机器人：${botId}`);
    return lines.join("\n");
  };
}
