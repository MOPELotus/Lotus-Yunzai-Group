import { displayRequestField } from "./group-pending-join.ts";
import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type GroupOwnerMemberNoticePart = string | { readonly type: "image"; readonly file: string };

export interface GroupOwnerMemberNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly direction: "increase" | "decrease";
  readonly action?: string;
  readonly dismiss?: boolean;
  readonly time?: number;
  readonly groupName?: string;
  readonly nickname?: string;
  readonly card?: string;
}

export type GroupOwnerMemberNotice = (event: GroupOwnerMemberNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupOwnerMemberNoticePart[] | undefined>;

export const groupOwnerMemberNoticeFeature = "[group] 群成员变动通知";

const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createGroupOwnerMemberNotice(options: PrivateNoticeOptions): GroupOwnerMemberNotice {
  const isEnabled = createPrivateNoticeSettings(options, "groupMemberNumberChange");
  return async ({ botId, groupId, userId, direction, action, dismiss, time, groupName, nickname, card }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || !positiveId(userId) || botId === userId ||
        dismiss || action === "disband" || action === "kick_me" || (direction !== "increase" && direction !== "decrease") ||
        !await isEnabled(botId, signal, groupId) || options.signal?.aborted || signal?.aborted) return;

    const name = displayRequestField(nickname, 128);
    const displayCard = displayRequestField(card, 128);
    const timestamp = time !== undefined && positiveId(time) && time <= 8_640_000_000_000 ? time * 1_000 : Date.now();
    const lines = [
      direction === "increase" ? "🟢 新成员加入" : "⚪ 成员离开",
      "────────────",
      `群聊：${displayRequestField(groupName, 128) || "群名称暂不可用"}`,
      `群号：${groupId}`,
      `成员：${name ? `${name}（${userId}）` : userId}`,
    ];
    if (displayCard && displayCard !== name) lines.push(`名片：${displayCard}`);
    if (direction === "increase") {
      if (action === "invite") lines.push("方式：邀请入群");
      if (action === "approve") lines.push("方式：申请通过");
    }
    lines.push("", `时间：${shanghaiTime.format(timestamp)}`, `机器人：${botId}`);
    return [{ type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` }, lines.join("\n")];
  };
}
