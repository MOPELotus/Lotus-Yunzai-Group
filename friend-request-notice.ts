import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { displayRequestField } from "./group-pending-join.ts";

export type FriendRequestNoticePart = string | { readonly type: "image"; readonly file: string };
export interface FriendRequestNoticeInput {
  readonly botId: number;
  readonly userId: number;
  readonly nickname?: string;
  readonly source?: string;
  readonly comment?: string;
  readonly autoResult?: "confirmed" | "rejected" | "unknown";
}
export interface FriendRequestNoticeOptions {
  readonly config?: URL;
  readonly legacyConfig?: URL;
  readonly signal?: AbortSignal;
}

export type FriendRequestNotice = (request: FriendRequestNoticeInput, signal?: AbortSignal) => Promise<readonly FriendRequestNoticePart[] | undefined>;

export const friendRequestNoticeFeature = "[group] 好友申请通知";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

async function fileText(path: URL | undefined): Promise<string | undefined> {
  if (!path) return;
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function configuredFriendRequestNotice(value: unknown, botId: number): boolean {
  const config = record(value);
  if (!config) return false;
  let enabled = false;
  for (const key of ["default", "", `bot:${botId}`, `bot:${botId}:`]) {
    const section = Object.hasOwn(config, key) ? record(config[key]) : undefined;
    if (section && Object.hasOwn(section, "friendRequest")) enabled = section.friendRequest === true;
  }
  return enabled;
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function status(result: FriendRequestNoticeInput["autoResult"]): string | undefined {
  switch (result) {
    case "confirmed": return "Tip：自动审批请求已获协议端确认。";
    case "rejected": return "Tip：协议端未接受自动审批，请在 QQ 中处理。";
    case "unknown": return "Tip：自动审批结果未确认，请先在 QQ 核对。";
  }
}

export function createFriendRequestNotice({ config, legacyConfig, signal: moduleSignal }: FriendRequestNoticeOptions): FriendRequestNotice {
  return async (request, signal) => {
    const { botId, userId, nickname, source, comment, autoResult } = request;
    if (moduleSignal?.aborted || signal?.aborted || !positiveId(botId) || !positiveId(userId) || botId === userId) return;
    try {
      const text = await fileText(config) ?? await fileText(legacyConfig);
      if (text === undefined || moduleSignal?.aborted || signal?.aborted || !configuredFriendRequestNotice(parse(text, { merge: true, maxAliasCount: 50 }), botId)) return;
    } catch { return; }

    const result = status(autoResult);
    return [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      `[通知(${botId}) - 添加好友申请]\n`,
      `申请人账号：${userId}\n`,
      `申请人昵称：${displayRequestField(nickname, 128) || "未知"}\n`,
      `申请来源：${displayRequestField(source, 256) || "未知"}\n`,
      `附加信息：${displayRequestField(comment, 512) || "无附加信息"}\n`,
      ...(result ? [`${result}\n`] : []),
      "-------------\n可回复：#查看好友申请",
    ];
  };
}
