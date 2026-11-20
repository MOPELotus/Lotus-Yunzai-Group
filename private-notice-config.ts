import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface PrivateNoticeOptions {
  readonly config?: URL;
  readonly legacyConfig?: URL;
  readonly signal?: AbortSignal;
}
type NoticeField = "friendRequest" | "privateMessage" | "grouptemporaryMessage";

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

export function configuredPrivateNotice(value: unknown, botId: number, field: NoticeField, groupId?: number): boolean {
  const config = record(value);
  if (!config) return false;
  const bot = `bot:${botId}`;
  const group = groupId === undefined ? "" : String(groupId);
  // Unlike friend messages, a temporary message with no verified group must not use group overrides.
  const keys = field === "grouptemporaryMessage" && groupId === undefined
    ? ["default", bot] : ["default", group, bot, `${bot}:${group}`];
  let enabled = false;
  for (const key of keys) {
    const section = Object.hasOwn(config, key) ? record(config[key]) : undefined;
    if (section && Object.hasOwn(section, field)) enabled = section[field] === true;
  }
  return enabled;
}

export function createPrivateNoticeSettings({ config, legacyConfig, signal: moduleSignal }: PrivateNoticeOptions, field: NoticeField) {
  return async (botId: number, signal?: AbortSignal, groupId?: number): Promise<boolean> => {
    if (moduleSignal?.aborted || signal?.aborted) return false;
    try {
      const text = await fileText(config) ?? await fileText(legacyConfig);
      return text !== undefined && !moduleSignal?.aborted && !signal?.aborted &&
        configuredPrivateNotice(parse(text, { merge: true, maxAliasCount: 50 }), botId, field, groupId);
    } catch { return false; }
  };
}
