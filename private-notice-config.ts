import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface PrivateNoticeOptions {
  readonly config?: URL;
  readonly legacyConfig?: URL;
  readonly signal?: AbortSignal;
}
type NoticeField = "friendRequest" | "privateMessage";

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

export function configuredPrivateNotice(value: unknown, botId: number, field: NoticeField): boolean {
  const config = record(value);
  if (!config) return false;
  let enabled = false;
  for (const key of ["default", "", `bot:${botId}`, `bot:${botId}:`]) {
    const section = Object.hasOwn(config, key) ? record(config[key]) : undefined;
    if (section && Object.hasOwn(section, field)) enabled = section[field] === true;
  }
  return enabled;
}

export function createPrivateNoticeSettings({ config, legacyConfig, signal: moduleSignal }: PrivateNoticeOptions, field: NoticeField) {
  return async (botId: number, signal?: AbortSignal): Promise<boolean> => {
    if (moduleSignal?.aborted || signal?.aborted) return false;
    try {
      const text = await fileText(config) ?? await fileText(legacyConfig);
      return text !== undefined && !moduleSignal?.aborted && !signal?.aborted &&
        configuredPrivateNotice(parse(text, { merge: true, maxAliasCount: 50 }), botId, field);
    } catch { return false; }
  };
}
