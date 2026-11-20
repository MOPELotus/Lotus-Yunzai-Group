import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface PrivateNoticeOptions {
  readonly config?: URL;
  readonly legacyConfig?: URL;
  readonly signal?: AbortSignal;
}
type NoticeField = "friendRequest" | "privateMessage" | "grouptemporaryMessage" | "friendNumberChange" | "PrivateRecall" | "groupRecall" |
  "groupMemberNumberChange" | "groupAdminChange" | "botBeenBanned" | "groupNumberChange" | "addGroupApplication" | "groupInviteRequest";

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

export function privateNoticeSetting(value: unknown, botId: number, field: NoticeField | "msgSaveDeltime", groupId?: number): unknown {
  const config = record(value);
  if (!config) return;
  const bot = `bot:${botId}`;
  const group = groupId === undefined ? "" : String(groupId);
  // Unlike friend messages, a temporary message with no verified group must not use group overrides.
  const keys = field === "grouptemporaryMessage" && groupId === undefined
    ? ["default", bot] : ["default", group, bot, `${bot}:${group}`];
  let setting: unknown;
  for (const key of keys) {
    const section = Object.hasOwn(config, key) ? record(config[key]) : undefined;
    if (section && Object.hasOwn(section, field)) setting = section[field];
  }
  return setting;
}

export function configuredPrivateNotice(value: unknown, botId: number, field: NoticeField, groupId?: number): boolean {
  return privateNoticeSetting(value, botId, field, groupId) === true;
}

export function createPrivateNoticeReader({ config, legacyConfig, signal: moduleSignal }: PrivateNoticeOptions) {
  return async (signal?: AbortSignal): Promise<unknown> => {
    if (moduleSignal?.aborted || signal?.aborted) return;
    try {
      const text = await fileText(config) ?? await fileText(legacyConfig);
      if (text !== undefined && !moduleSignal?.aborted && !signal?.aborted) return parse(text, { merge: true, maxAliasCount: 50 });
    } catch { return; }
  };
}

export function createPrivateNoticeSettings(options: PrivateNoticeOptions, field: NoticeField) {
  const read = createPrivateNoticeReader(options);
  return async (botId: number, signal?: AbortSignal, groupId?: number): Promise<boolean> => {
    const config = await read(signal);
    return !options.signal?.aborted && !signal?.aborted && configuredPrivateNotice(config, botId, field, groupId);
  };
}
