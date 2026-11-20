import { createPrivateNoticeReader, privateNoticeSetting, type PrivateNoticeOptions } from "./private-notice-config.ts";

export type OwnerNoticeRecipients = (botId: number, signal?: AbortSignal) => Promise<boolean | undefined>;

export function configuredOwnerNoticeRecipients(config: unknown, botId: number): boolean | undefined {
  const setting = privateNoticeSetting(config, botId, "notificationsAll");
  return typeof setting === "boolean" ? setting : undefined;
}

export function createOwnerNoticeRecipients(options: PrivateNoticeOptions): OwnerNoticeRecipients {
  const read = createPrivateNoticeReader(options);
  return async (botId, signal) => {
    if (!Number.isSafeInteger(botId) || botId <= 0) return;
    const config = await read(signal);
    if (!options.signal?.aborted && !signal?.aborted) return configuredOwnerNoticeRecipients(config, botId);
  };
}
