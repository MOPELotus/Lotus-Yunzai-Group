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
import { createPrivateGroupMute, isPrivateGroupMuteCommand, privateGroupMuteFeature, type PrivateGroupMuteContext } from "./private-group-mute.ts";
import { createManagedBlacklist, readManagedWhitelist, type GroupManagedBlacklist } from "./managed-blacklist.ts";
import { createGroupBannedWords, groupBannedWordsFeature, isGroupBannedWordCommand, type GroupBannedWords } from "./banned-words.ts";
import type { GroupMuteContext } from "./group-mute.ts";
import { createGroupTitle, groupTitleCommandFeature, type GroupTitleContext } from "./group-title.ts";
import { createGroupActivityCleanup, groupActivityCommand, groupActivityFeature, groupActivityRankFeature, isGroupActivityCleanupCommand,
  isGroupActivityCommand, isGroupActivityRankCommand, type GroupActivityContext } from "./group-activity.ts";
import { createGroupTimedMute, groupTimedMuteFeature, isGroupTimedMuteCommand, type GroupTimedMuteServices } from "./group-timed-mute.ts";
import { createGroupNotification, groupNotificationFeature, isGroupNotificationCommand, type GroupNotificationContext } from "./group-notify.ts";
import { createGroupAddNotice, groupAddNoticeFeature, isGroupAddNoticeCommand, type GroupAddNotice } from "./group-add-notice.ts";
import { createFriendRequestNotice, type FriendRequestNotice } from "./friend-request-notice.ts";
import { friendRequestListCommand, friendRequestListFeature, isFriendRequestListCommand, type FriendRequestListContext } from "./friend-request-list.ts";
import { groupInvitationListCommand, groupInvitationListFeature, isGroupInvitationListCommand, type GroupInvitationListContext } from "./group-invitation-list.ts";
import { createGroupPendingJoinReview, groupPendingJoinCommand, groupPendingJoinFeature, groupPendingJoinReviewFeature,
  isGroupPendingJoinCommand, isGroupPendingJoinReviewCommand, type GroupPendingJoinContext } from "./group-pending-join.ts";
import { createGroupQuotedReview, groupQuotedReviewFeature, isGroupQuotedReviewCommand, type GroupQuotedReviewContext } from "./group-quoted-review.ts";
import { createGroupAnnouncementDeletion, createGroupAnnouncementPublisher, groupAnnouncementsCommand, groupAnnouncementsFeature,
  isGroupAnnouncementDeleteCommand, isGroupAnnouncementPublishCommand, isGroupAnnouncementsCommand, type GroupAnnouncementDeleteContext,
  type GroupAnnouncementPublishContext } from "./group-announcements.ts";
import { createGroupVote, groupVoteFeature, isGroupVoteCommand, type GroupVoteContext } from "./group-vote.ts";
import { createGroupVerification, groupVerificationFeature, isGroupVerificationCommand,
  type GroupVerificationContext, type GroupVerification } from "./group-verification.ts";

export { createGroupPlugin };
export type { LikeContext, MentionLike, ProfileLikeImage } from "./likes.ts";
export * from "./group-leave-blacklist.ts";
export type { GroupManagedBlacklist } from "./managed-blacklist.ts";
export { groupBannedWordsFeature, type GroupBannedWords, type GroupBannedWordMatch, type GroupBannedWordPart } from "./banned-words.ts";
export { groupTitleFeature, groupTitleFilterFeature, type GroupTitleContext, type GroupSpecialTitleResult } from "./group-title.ts";
export { groupActivityFeature, groupActivityRankFeature, type GroupActivityContext, type GroupActivityMember, type GroupActivityVisibility } from "./group-activity.ts";
export { groupTimedMuteFeature, type GroupTimedMuteBinding, type GroupTimedMuteServices } from "./group-timed-mute.ts";
export { groupNotificationFeature, type GroupNotificationContext, type GroupNotificationPart } from "./group-notify.ts";
export { groupAddNoticeFeature, type GroupAddNotice, type GroupAddNoticeEvent, type GroupAddNoticePart } from "./group-add-notice.ts";
export { createFriendRequestNotice, friendRequestNoticeFeature, type FriendRequestNotice, type FriendRequestNoticeInput, type FriendRequestNoticeOptions, type FriendRequestNoticePart } from "./friend-request-notice.ts";
export { friendRequestListFeature, type FriendRequestListContext, type PendingFriendRequest, type PendingFriendRequests } from "./friend-request-list.ts";
export { groupInvitationListFeature, type GroupInvitationListContext, type PendingGroupInvitation, type PendingGroupInvitations } from "./group-invitation-list.ts";
export { groupPendingJoinFeature, groupPendingJoinReviewFeature, type PendingGroupJoin, type PendingGroupJoins, type PendingGroupJoinReviewResult, type PendingGroupJoinBatchResult, type GroupPendingJoinContext } from "./group-pending-join.ts";
export { groupQuotedReviewFeature, type GroupQuotedReviewContext, type GroupQuotedReviewResult } from "./group-quoted-review.ts";
export { groupAnnouncementsFeature, type GroupAnnouncement, type GroupAnnouncementDeleteContext, type GroupAnnouncementDeleteResult,
  type GroupAnnouncementPublishContext, type GroupAnnouncementPublishResult, type GroupAnnouncementsContext } from "./group-announcements.ts";
export { groupVoteFeature, type GroupVoteCapability, type GroupVoteResult, type GroupVoteRoles, type GroupVotePart } from "./group-vote.ts";
export { groupVerificationFeature, type GroupVerification, type GroupVerificationJoin, type GroupVerificationLeave,
  type GroupVerificationAnswer, type GroupVerificationContext, type GroupVerificationExpectedActivity } from "./group-verification.ts";
export type { AutoGroupCardContext, AutoGroupCardSummary, OwnGroupCardAccount, OwnGroupCardResult } from "./auto-group-card.ts";
export { groupEssenceFeature, groupKickFeature, groupManagedBlacklistFeature, groupManagedWhitelistFeature, groupMuteFeature, groupMuteSelfFeature, groupMuteRosterFeature, groupSetAdminFeature,
  maxGroupMuteSeconds, type GroupEssenceResult, type GroupKickResult, type GroupMuteContext, type GroupMuteResult, type GroupMuteRosterEntry,
  type GroupSetAdminResult, type GroupWholeMuteResult } from "./group-mute.ts";
export { privateGroupMuteFeature, type PrivateGroupMuteContext, type PrivateGroupMuteResult, type PrivateGroupWholeMuteResult } from "./private-group-mute.ts";

type ModerationContext = GroupMuteContext & PrivateGroupMuteContext & GroupPendingJoinContext & GroupInvitationListContext & FriendRequestListContext;
function privateMuteCommand(context: Pick<ModerationContext, "message_type">, command: string) {
  return context.message_type === "private" && isPrivateGroupMuteCommand(command);
}

const defaultModeration = createGroupMute();
const defaultPrivateMute = createPrivateGroupMute();
const defaultPendingJoinReview = createGroupPendingJoinReview();

export const apps = { ...repeat, GroupNewcomer, GroupDeparture, ReviewGroupRequest, GroupCard, AutoRepeat };
const manifest = {
  ...group,
  commands: { ...group.commands, ...groupRequestReview.commands },
  fallback(message: string, context: ModerationContext) {
    const normalized = (context.normalizedMessage ?? message).trim();
    if (context.message_type === "private" && isGroupInvitationListCommand(normalized)) return groupInvitationListCommand(normalized, context);
    if (context.message_type === "private" && isFriendRequestListCommand(normalized)) return friendRequestListCommand(normalized, context);
    if (context.message_type === "group" && isGroupPendingJoinCommand(normalized)) return groupPendingJoinCommand(normalized, context);
    if (context.message_type === "group" && isGroupPendingJoinReviewCommand(normalized)) return defaultPendingJoinReview(normalized, context);
    return privateMuteCommand(context, normalized) ? defaultPrivateMute(message, context) : defaultModeration(message, context);
  },
  fallbackFeatures(context: { readonly normalizedMessage: string; readonly message_type: ModerationContext["message_type"] }) {
    const normalized = context.normalizedMessage.trim();
    if (context.message_type === "private" && isGroupInvitationListCommand(normalized)) return [groupInvitationListFeature];
    if (context.message_type === "private" && isFriendRequestListCommand(normalized)) return [friendRequestListFeature];
    if (context.message_type === "group" && isGroupPendingJoinCommand(normalized)) return [groupPendingJoinFeature];
    if (context.message_type === "group" && isGroupPendingJoinReviewCommand(normalized)) return [groupPendingJoinReviewFeature];
    return privateMuteCommand(context, normalized) ? [privateGroupMuteFeature] : groupModerationFeature(context);
  },
};
export default manifest;

export async function createModule({
  signal, ownGroupCardAccounts, registerAutoGroupCardTask, readAutoRepeatImage, autoRepeatSessionSignal, groupLeaveBlacklist, profileLikeImage,
  lockFile, registerManagedBlacklist, registerGroupBannedWords, groupTimedMute, registerGroupAddNotice, registerGroupVerification, registerFriendRequestNotice,
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
  readonly groupTimedMute?: GroupTimedMuteServices;
  readonly registerGroupAddNotice?: (policy: GroupAddNotice) => () => void;
  readonly registerFriendRequestNotice?: (policy: FriendRequestNotice) => () => void;
  readonly registerGroupVerification?: (policy: GroupVerification) => () => void;
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
  const stopFriendRequestNotice = !signal.aborted && registerFriendRequestNotice?.(createFriendRequestNotice({
    config: new URL("config/group-notice.yaml", root),
    legacyConfig: new URL("plugins/yenai-plugin/config/config/notice.yaml", root),
    signal,
  }));
  if (groupLeaveBlacklist && !signal.aborted) {
    const policy = await readGroupLeaveBlacklist(root, groupLeaveBlacklist.io);
    if (!signal.aborted) stopLeaveBlacklist = groupLeaveBlacklist.register(policy);
  }
  const blacklist = lockFile && !signal.aborted ? createManagedBlacklist(root, lockFile) : undefined;
  const stopManagedBlacklist = blacklist && registerManagedBlacklist?.(blacklist);
  const bannedWords = lockFile && blacklist ? createGroupBannedWords(root, lockFile, blacklist, signal) : undefined;
  const stopBannedWords = bannedWords && registerGroupBannedWords?.(bannedWords.policy);
  const moderation = createGroupMute(root, blacklist, signal);
  const privateMute = createPrivateGroupMute(signal);
  const title = bannedWords && createGroupTitle(bannedWords.titleStore, signal);
  const activityCleanup = createGroupActivityCleanup(root, signal);
  const notify = createGroupNotification(signal);
  const quotedReview = createGroupQuotedReview(signal);
  const pendingJoinReview = createGroupPendingJoinReview(signal);
  const publishAnnouncement = createGroupAnnouncementPublisher(signal);
  const deleteAnnouncement = createGroupAnnouncementDeletion(signal);
  const groupAddNotice = blacklist && createGroupAddNotice(blacklist, signal);
  const vote = blacklist && createGroupVote(blacklist, signal);
  const verification = blacklist && createGroupVerification(blacklist, async user => (await readManagedWhitelist(root)).has(user), signal);
  const stopVerification = verification && registerGroupVerification?.(verification.policy);
  const stopGroupAddNotice = groupAddNotice && registerGroupAddNotice?.(groupAddNotice.policy);
  const timedMute = lockFile && groupTimedMute && !signal.aborted ? await createGroupTimedMute(root, lockFile, groupTimedMute, signal) : undefined;
  return {
    ...manifest,
    fallback(message: string, context: ModerationContext & GroupTitleContext & GroupActivityContext & GroupNotificationContext &
      GroupQuotedReviewContext & GroupAnnouncementPublishContext & GroupAnnouncementDeleteContext & GroupVoteContext & GroupVerificationContext) {
      const normalized = context.normalizedMessage.trim();
      if (privateMuteCommand(context, normalized)) return privateMute(message, context);
      if (context.message_type === "private" && isGroupInvitationListCommand(normalized)) return groupInvitationListCommand(normalized, context, signal);
      if (context.message_type === "private" && isFriendRequestListCommand(normalized)) return friendRequestListCommand(normalized, context, signal);
      if (verification && isGroupVerificationCommand(normalized)) return verification.command(normalized, context);
      if (vote && isGroupVoteCommand(normalized)) return vote.command(normalized, context);
      if (isGroupAnnouncementsCommand(normalized)) return groupAnnouncementsCommand(normalized, context, signal);
      if (isGroupAnnouncementPublishCommand(normalized)) return publishAnnouncement(normalized, context);
      if (isGroupAnnouncementDeleteCommand(normalized)) return deleteAnnouncement(normalized, context);
      if (context.message_type === "group" && isGroupPendingJoinCommand(normalized)) return groupPendingJoinCommand(normalized, context, signal);
      if (context.message_type === "group" && isGroupPendingJoinReviewCommand(normalized)) return pendingJoinReview(normalized, context);
      if (isGroupQuotedReviewCommand(normalized)) return quotedReview(normalized, context);
      if (groupAddNotice && isGroupAddNoticeCommand(normalized)) return groupAddNotice.command(normalized, context);
      if (isGroupNotificationCommand(normalized)) return notify(context);
      if (timedMute && isGroupTimedMuteCommand(normalized)) return timedMute.command(context);
      if (isGroupActivityCommand(normalized) || isGroupActivityRankCommand(normalized)) return groupActivityCommand(context, signal);
      if (isGroupActivityCleanupCommand(normalized)) return activityCleanup(context);
      if (title && groupTitleCommandFeature(normalized)) return title(context);
      return bannedWords && isGroupBannedWordCommand(normalized)
        ? bannedWords.command(message, context) : moderation(message, context);
    },
    fallbackFeatures(context: Parameters<typeof manifest.fallbackFeatures>[0]) {
      const message = context.normalizedMessage.trim();
      if (privateMuteCommand(context, message)) return [privateGroupMuteFeature];
      if (context.message_type === "private" && isGroupInvitationListCommand(message)) return [groupInvitationListFeature];
      if (context.message_type === "private" && isFriendRequestListCommand(message)) return [friendRequestListFeature];
      if (isGroupVerificationCommand(message)) return [groupVerificationFeature];
      if (isGroupVoteCommand(message)) return [groupVoteFeature];
      if (isGroupAnnouncementsCommand(message) || isGroupAnnouncementPublishCommand(message) || isGroupAnnouncementDeleteCommand(message)) return [groupAnnouncementsFeature];
      if (context.message_type === "group" && isGroupPendingJoinCommand(message)) return [groupPendingJoinFeature];
      if (context.message_type === "group" && isGroupPendingJoinReviewCommand(message)) return [groupPendingJoinReviewFeature];
      if (isGroupQuotedReviewCommand(message)) return [groupQuotedReviewFeature];
      if (isGroupAddNoticeCommand(message)) return [groupAddNoticeFeature];
      if (isGroupNotificationCommand(message)) return [groupNotificationFeature];
      if (isGroupTimedMuteCommand(message)) return [groupTimedMuteFeature];
      if (isGroupActivityRankCommand(message)) return [groupActivityRankFeature];
      if (isGroupActivityCommand(message) || isGroupActivityCleanupCommand(message)) return [groupActivityFeature];
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
      stopVerification?.();
      stopGroupAddNotice?.();
      if (stopFriendRequestNotice) stopFriendRequestNotice();
      stopManagedBlacklist?.();
      stopLeaveBlacklist?.();
      stopRepeat();
      await Promise.all([stopTask?.(), timedMute?.stop(), vote?.stop(), verification?.stop()]);
    },
  };
}
