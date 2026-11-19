import group, { createGroupPlugin, type ProfileLikeImage } from "./likes.ts";
import { GroupDeparture, GroupNewcomer } from "./member-notices-v3.js";
import { apps as repeat } from "./repeat.js";
import { AutoRepeat, configureAutoRepeat } from "./auto-repeat-v3.js";
import { groupRequestReview } from "./request-review.ts";
import { ReviewGroupRequest } from "./request-review-v3.js";
import { GroupCard } from "./group-card-v3.js";
import { createAutoGroupCard, type AutoGroupCardSummary, type OwnGroupCardAccount } from "./auto-group-card.ts";
import { readGroupLeaveBlacklist, type GroupLeaveBlacklist, type GroupLeaveBlacklistIO } from "./group-leave-blacklist.ts";
import { createGroupMute, groupModerationFeature } from "./group-mute.ts";
import { createManagedBlacklist, type GroupManagedBlacklist } from "./managed-blacklist.ts";
import { createGroupBannedWords, groupBannedWordsFeature, isGroupBannedWordCommand, type GroupBannedWords } from "./banned-words.ts";
import type { GroupMuteContext } from "./group-mute.ts";
import { createGroupTitle, groupTitleCommandFeature, type GroupTitleContext } from "./group-title.ts";

export { createGroupPlugin };
export type { LikeContext, MentionLike, ProfileLikeImage } from "./likes.ts";
export * from "./group-leave-blacklist.ts";
export type { GroupManagedBlacklist } from "./managed-blacklist.ts";
export { groupBannedWordsFeature, type GroupBannedWords, type GroupBannedWordMatch } from "./banned-words.ts";
export { groupTitleFeature, groupTitleFilterFeature, type GroupTitleContext, type GroupSpecialTitleResult } from "./group-title.ts";
export type { AutoGroupCardContext, AutoGroupCardSummary, OwnGroupCardAccount, OwnGroupCardResult } from "./auto-group-card.ts";
export { groupKickFeature, groupManagedBlacklistFeature, groupManagedWhitelistFeature, groupMuteFeature, groupMuteRosterFeature, groupSetAdminFeature,
  maxGroupMuteSeconds, type GroupKickResult, type GroupMuteContext, type GroupMuteResult, type GroupMuteRosterEntry,
  type GroupSetAdminResult, type GroupWholeMuteResult } from "./group-mute.ts";
export const apps = { ...repeat, GroupNewcomer, GroupDeparture, ReviewGroupRequest, GroupCard, AutoRepeat };
const manifest = {
  ...group,
  commands: { ...group.commands, ...groupRequestReview.commands },
  fallback: createGroupMute(),
  fallbackFeatures: groupModerationFeature,
};
export default manifest;

export async function createModule({
  signal, ownGroupCardAccounts, registerAutoGroupCardTask, readAutoRepeatImage, autoRepeatSessionSignal, groupLeaveBlacklist, profileLikeImage,
  lockFile, registerManagedBlacklist, registerGroupBannedWords,
}: {
  readonly signal: AbortSignal;
  readonly readAutoRepeatImage?: (url: unknown, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
  readonly autoRepeatSessionSignal?: (event: unknown) => AbortSignal | undefined;
  readonly ownGroupCardAccounts?: () => readonly OwnGroupCardAccount[];
  readonly registerAutoGroupCardTask?: (cron: string, run: () => Promise<AutoGroupCardSummary | undefined>) => (() => void | Promise<void>);
  readonly groupLeaveBlacklist?: { readonly io: GroupLeaveBlacklistIO; register(policy: GroupLeaveBlacklist): () => void };
  readonly profileLikeImage?: ProfileLikeImage;
  readonly lockFile?: Parameters<typeof createManagedBlacklist>[1];
  readonly registerManagedBlacklist?: (policy: GroupManagedBlacklist) => () => void;
  readonly registerGroupBannedWords?: (policy: GroupBannedWords) => () => void;
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
  const root = new URL("../../", import.meta.url);
  if (groupLeaveBlacklist && !signal.aborted) {
    const policy = await readGroupLeaveBlacklist(root, groupLeaveBlacklist.io);
    if (!signal.aborted) stopLeaveBlacklist = groupLeaveBlacklist.register(policy);
  }
  const blacklist = lockFile && !signal.aborted ? createManagedBlacklist(root, lockFile) : undefined;
  const stopManagedBlacklist = blacklist && registerManagedBlacklist?.(blacklist);
  const bannedWords = lockFile && blacklist ? createGroupBannedWords(root, lockFile, blacklist, signal) : undefined;
  const stopBannedWords = bannedWords && registerGroupBannedWords?.(bannedWords.policy);
  const moderation = createGroupMute(root, blacklist, signal);
  const title = bannedWords && createGroupTitle(bannedWords.titleStore, signal);
  return {
    ...manifest,
    fallback(message: string, context: GroupMuteContext & GroupTitleContext) {
      if (title && groupTitleCommandFeature(context.normalizedMessage.trim())) return title(context);
      return bannedWords && isGroupBannedWordCommand(context.normalizedMessage.trim())
        ? bannedWords.command(message, context) : moderation(message, context);
    },
    fallbackFeatures(context: { readonly normalizedMessage: string }) {
      const message = context.normalizedMessage.trim();
      const feature = groupTitleCommandFeature(message);
      if (feature) return [feature];
      return isGroupBannedWordCommand(message) ? [groupBannedWordsFeature] : groupModerationFeature(context);
    },
    commands: {
      ...manifest.commands,
      ...(profileLikeImage ? createGroupPlugin(undefined, profileLikeImage).commands : {}),
      "#更新群名片": updater.command,
    },
    async dispose() {
      stopBannedWords?.();
      stopManagedBlacklist?.();
      stopLeaveBlacklist?.();
      stopRepeat();
      await stopTask?.();
    },
  };
}
