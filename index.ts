import group, { createGroupPlugin, type ProfileLikeImage } from "./likes.ts";
import { GroupDeparture, GroupNewcomer } from "./member-notices-v3.js";
import { apps as repeat } from "./repeat.js";
import { AutoRepeat, configureAutoRepeat } from "./auto-repeat-v3.js";
import { groupRequestReview } from "./request-review.ts";
import { ReviewGroupRequest } from "./request-review-v3.js";
import { GroupCard } from "./group-card-v3.js";
import { createAutoGroupCard, type AutoGroupCardSummary, type OwnGroupCardAccount } from "./auto-group-card.ts";
import { readGroupLeaveBlacklist, type GroupLeaveBlacklist, type GroupLeaveBlacklistIO } from "./group-leave-blacklist.ts";
import { createGroupMute, groupMuteFeature } from "./group-mute.ts";

export { createGroupPlugin };
export type { LikeContext, MentionLike, ProfileLikeImage } from "./likes.ts";
export * from "./group-leave-blacklist.ts";
export type { AutoGroupCardContext, AutoGroupCardSummary, OwnGroupCardAccount, OwnGroupCardResult } from "./auto-group-card.ts";
export { groupMuteFeature, maxGroupMuteSeconds, type GroupMuteContext, type GroupMuteResult, type GroupWholeMuteResult } from "./group-mute.ts";
export const apps = { ...repeat, GroupNewcomer, GroupDeparture, ReviewGroupRequest, GroupCard, AutoRepeat };
const manifest = {
  ...group,
  commands: { ...group.commands, ...groupRequestReview.commands },
  fallback: createGroupMute(),
  fallbackFeatures: () => [groupMuteFeature],
};
export default manifest;

export async function createModule({
  signal, ownGroupCardAccounts, registerAutoGroupCardTask, readAutoRepeatImage, autoRepeatSessionSignal, groupLeaveBlacklist, profileLikeImage,
}: {
  readonly signal: AbortSignal;
  readonly readAutoRepeatImage?: (url: unknown, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
  readonly autoRepeatSessionSignal?: (event: unknown) => AbortSignal | undefined;
  readonly ownGroupCardAccounts?: () => readonly OwnGroupCardAccount[];
  readonly registerAutoGroupCardTask?: (cron: string, run: () => Promise<AutoGroupCardSummary | undefined>) => (() => void | Promise<void>);
  readonly groupLeaveBlacklist?: { readonly io: GroupLeaveBlacklistIO; register(policy: GroupLeaveBlacklist): () => void };
  readonly profileLikeImage?: ProfileLikeImage;
}) {
  const updater = createAutoGroupCard({ signal, accounts: ownGroupCardAccounts ?? (() => []) });
  let stopTask: (() => void | Promise<void>) | undefined;
  if (registerAutoGroupCardTask) {
    try {
      const configuration = await updater.configuration();
      if (configuration && !signal.aborted) stopTask = registerAutoGroupCardTask(configuration.cron, updater.scheduled);
    } catch {
      console.warn("[group] 自动群名片配置无效，未启动定时更新。");
    }
  }
  const stopRepeat = configureAutoRepeat({
    signal, readImage: readAutoRepeatImage, sessionSignal: autoRepeatSessionSignal,
    isBot: (id: number) => ownGroupCardAccounts?.().some(({ botId }) => id === botId) ?? false,
  });
  let stopLeaveBlacklist: (() => void) | undefined;
  if (groupLeaveBlacklist && !signal.aborted) {
    const policy = await readGroupLeaveBlacklist(new URL("../../", import.meta.url), groupLeaveBlacklist.io);
    if (!signal.aborted) stopLeaveBlacklist = groupLeaveBlacklist.register(policy);
  }
  return {
    ...manifest,
    commands: {
      ...manifest.commands,
      ...(profileLikeImage ? createGroupPlugin(undefined, profileLikeImage).commands : {}),
      "#更新群名片": updater.command,
    },
    async dispose() {
      stopLeaveBlacklist?.();
      stopRepeat();
      await stopTask?.();
    },
  };
}
