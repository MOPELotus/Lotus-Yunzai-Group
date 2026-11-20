import { createPrivateNoticeSettings, type PrivateNoticeOptions } from "./private-notice-config.ts";

export interface GroupOwnerBanNoticeInput {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly operatorId: number;
  readonly duration: number;
}

export type GroupOwnerBanNoticePart = string | { readonly type: "image"; readonly file: string };
export type GroupOwnerBanNotice = (event: GroupOwnerBanNoticeInput, signal?: AbortSignal) =>
  Promise<readonly GroupOwnerBanNoticePart[] | undefined>;

export const groupOwnerBanNoticeFeature = "[group] 机器人禁言通知";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function banDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3_600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const repeating = [[hours, "小时"], [minutes, "分"], [seconds % 60, "秒"]] as const;
  const clock = repeating.filter(([amount]) => amount > 0)
    .map(([amount, unit]) => String(amount).padStart(2, "0") + unit).join("");
  return (days ? `${days}天` : "") + clock;
}

export function createGroupOwnerBanNotice(options: PrivateNoticeOptions): GroupOwnerBanNotice {
  const isEnabled = createPrivateNoticeSettings(options, "botBeenBanned");
  return async ({ botId, groupId, userId, operatorId, duration }, signal) => {
    if (!positiveId(botId) || !positiveId(groupId) || userId !== botId || !positiveId(operatorId) ||
        !Number.isSafeInteger(duration) || duration < 0 || !await isEnabled(botId, signal, groupId) ||
        options.signal?.aborted || signal?.aborted) return;

    const image = { type: "image", file: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100` } as const;
    if (duration === 0) {
      return [image, `[通知(${botId}) - 机器人被解除禁言]\n`, `处理人账号：${operatorId}\n`, `处理群号：${groupId}`];
    }
    return [
      image, `[通知(${botId}) - 机器人被禁言]\n`, `禁言人账号：${operatorId}\n`, `禁言群号：${groupId}\n`,
      `禁言时长：${banDuration(duration)}`,
    ];
  };
}
