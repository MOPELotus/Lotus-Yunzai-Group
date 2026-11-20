import { ManagedBlacklistPermissionError, type ManagedBlacklistStore } from "./managed-blacklist.ts";
import type { GroupMuteContext } from "./group-mute.ts";

export type GroupAddNoticePart = string | { readonly type: "image"; readonly file: string };

export interface GroupAddNoticeEvent {
  readonly sub_type: "add" | "invite";
  readonly self_id: number;
  readonly group_id: number;
  readonly user_id: number;
  readonly groupRequestScope?: "milky";
  readonly flag: string;
  readonly nickname?: string;
  readonly inviter_id?: number;
  readonly comment?: string;
  readonly signal: AbortSignal;
  readonly notifyGroup: (parts: readonly GroupAddNoticePart[]) => Promise<boolean>;
}

export interface GroupAddNotice {
  receive(event: GroupAddNoticeEvent): Promise<void>;
}

export const groupAddNoticeFeature = "[group] 加群申请通知";
const commandPattern = /^#?(开启|关闭)加群通知$/u;
export const isGroupAddNoticeCommand = (message: string) => commandPattern.test(message);
const repeatWindowMs = 60 * 60 * 1000;
const maxRecentRequests = 4096;

function isId(value: number | undefined): value is number { return value !== undefined && Number.isSafeInteger(value) && value > 0; }

function line(value: string | undefined) {
  return value?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 128).toWellFormed();
}

function paragraph(value: string, limit: number) {
  return value.replace(/\r\n?|\u2028|\u2029/gu, "\n").split("\n")
    .map((part) => part.replace(/[\p{Cc}\p{Cf}]/gu, " ")).join("\n").trim().slice(0, limit).toWellFormed();
}

export function createGroupAddNotice(store: Pick<ManagedBlacklistStore, "readGroupAddNotice" | "setGroupAddNotice">, signal: AbortSignal) {
  const seen = new Map<string, number>();

  const policy: GroupAddNotice = {
    async receive(event) {
      const { group_id: group, self_id: bot, user_id: user, groupRequestScope, flag } = event;
      if (event.sub_type !== "add" || !isId(group) || !isId(bot) || !isId(user) || bot === user ||
          !flag || flag.length > 2048 || signal.aborted || event.signal.aborted) return;
      try {
        const title = await store.readGroupAddNotice(group);
        if (title === undefined || signal.aborted || event.signal.aborted) return;
        const now = performance.now();
        const id = JSON.stringify([groupRequestScope ?? "onebot", bot, group, flag]);
        if ((seen.get(id) ?? -Infinity) > now) return;
        seen.delete(id);
        seen.set(id, now + repeatWindowMs);
        for (const [recent, expires] of seen) {
          if (expires > now && seen.size <= maxRecentRequests) break;
          seen.delete(recent);
        }
        const parts: GroupAddNoticePart[] = [
          `${paragraph(title, 2048)}\n`, { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${user}` },
          `QQ号：${user}\n`, `昵称：${line(event.nickname) || "未知"}\n`,
        ];
        const comment = paragraph(event.comment ?? "", 1024);
        if (comment) parts.push(comment);
        if (isId(event.inviter_id)) parts.push(`${comment ? "\n" : ""}邀请人：${event.inviter_id}`);
        if (!signal.aborted && !event.signal.aborted) await event.notifyGroup(parts);
      } catch { /* The existing private review is independent of group delivery. */ }
    },
  };

  async function command(message: string, context: GroupMuteContext): Promise<string | undefined> {
    const match = commandPattern.exec(message);
    if (!match || context.message_type !== "group") return;
    const { group_id: group, groupManageBlacklist } = context;
    const permission = "当前会话没有设置加群申请通知的权限。";
    if (signal.aborted || context.isDelegated || !isId(group) || !groupManageBlacklist) return permission;
    const authorize = async () => {
      try { return !signal.aborted && await groupManageBlacklist() === true && !signal.aborted; } catch { return false; }
    };
    if (!await authorize()) return permission;
    const enabled = match[1] === "开启";
    try {
      const changed = await store.setGroupAddNotice(group, enabled, signal, authorize);
      if (!changed) return enabled ? "❎ 本群加群申请通知已处于开启状态" : "❎ 本群暂未开启加群申请通知";
      return `✅ 已${match[1]}「${group}」的加群申请通知`;
    } catch (error) {
      return error instanceof ManagedBlacklistPermissionError ? permission : "暂无法保存加群申请通知配置。";
    }
  }

  return { policy, command };
}
