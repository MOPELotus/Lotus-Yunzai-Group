import group, { createGroupPlugin, type ProfileLikeImage } from "./likes.ts";
import { groupRequestReview } from "./request-review.ts";
import { groupRuntimeEvents } from "./runtime-events.ts";
import type { ObserveAutoRepeat } from "./auto-repeat.ts";
import { createAutoGroupCard, type AutoGroupCardSummary, type OwnGroupCardAccount } from "./auto-group-card.ts";
import { readGroupLeaveBlacklist, type GroupLeaveBlacklist, type GroupLeaveBlacklistIO } from "./group-leave-blacklist.ts";
import { createGroupMute, groupModerationFeature } from "./group-mute.ts";
import { changeGroupName, groupNameFeature, isGroupNameCommand, type GroupNameContext } from "./group-name.ts";
import { createPrivateGroupMute, isPrivateGroupMuteCommand, privateGroupMuteFeature, type PrivateGroupMuteContext } from "./private-group-mute.ts";
import { createManagedBlacklist, readManagedWhitelist, type GroupManagedBlacklist } from "./managed-blacklist.ts";
import { createGroupBannedWords, groupBannedWordsFeature, isGroupBannedWordCommand, type GroupBannedWords } from "./banned-words.ts";
import { createGroupScreenedWords, groupScreenedWordsFeature, isGroupScreenedWordsCommand, type ScreenedWordsContext } from "./screened-words.ts";
import type { GroupMuteContext } from "./group-mute.ts";
import { createGroupTitle, groupTitleCommandFeature, type GroupTitleContext } from "./group-title.ts";
import { createGroupActivityCleanup, groupActivityCommand, groupActivityFeature, groupActivityRankFeature, isGroupActivityCleanupCommand,
  isGroupActivityCommand, isGroupActivityRankCommand, type GroupActivityContext } from "./group-activity.ts";
import { createGroupTimedMute, groupTimedMuteFeature, isGroupTimedMuteCommand, type GroupTimedMuteServices } from "./group-timed-mute.ts";
import { createGroupNotification, groupNotificationFeature, isGroupNotificationCommand, type GroupNotificationContext } from "./group-notify.ts";
import { createGroupAddNotice, groupAddNoticeFeature, isGroupAddNoticeCommand, type GroupAddNotice } from "./group-add-notice.ts";
import { createNoticeSettings, isNoticeSettingsCommand, noticeSettingsFeature, type NoticeSettingsContext } from "./notice-settings.ts";
import type { NoticeSettingsCardRenderer } from "./notice-settings-card-model.ts";
import { createGroupOwnerJoinRequestNotice, type GroupOwnerJoinRequestNotice } from "./group-owner-join-request-notice.ts";
import { createGroupOwnerInvitationNotice, type GroupOwnerInvitationNotice } from "./group-owner-invitation-notice.ts";
import { createGroupMessageNotice, type GroupMessageNotice } from "./group-message-notice.ts";
import { createOwnerNoticeRecipients, type OwnerNoticeRecipients } from "./owner-notice-recipients.ts";
import { createGroupOwnerGroupNotice, type GroupOwnerGroupNotice } from "./group-owner-group-notice.ts";
import { createGroupOwnerBanNotice, type GroupOwnerBanNotice } from "./group-owner-ban-notice.ts";
import { createGroupOwnerAdminNotice, type GroupOwnerAdminNotice } from "./group-owner-admin-notice.ts";
import { createGroupOwnerMemberNotice, type GroupOwnerMemberNotice } from "./group-owner-member-notice.ts";
import { createTemporaryMessageNotice, type TemporaryMessageNotice } from "./temporary-message-notice.ts";
import { createFriendRelationshipNotice, type FriendRelationshipNotice } from "./friend-relationship-notice.ts";
import { createGroupRecallNotice, type GroupRecallNotice } from "./group-recall-notice.ts";
import { createFriendRecallNotice, type FriendRecallNotice } from "./friend-recall-notice.ts";
import { createFriendPokeNotice, type FriendPokeNotice } from "./friend-poke-notice.ts";
import { createFriendMessageNotice, type FriendMessageNotice } from "./friend-message-notice.ts";
import { createFriendRequestNotice, type FriendRequestNotice } from "./friend-request-notice.ts";
import { createFriendRequestReview, friendRequestReviewFeature, isFriendRequestReviewCommand, type FriendRequestReviewContext } from "./friend-request-review.ts";
import { friendRequestListCommand, friendRequestListFeature, isFriendRequestListCommand, type FriendRequestListContext } from "./friend-request-list.ts";
import { createOwnerFriendReply, isOwnerFriendReplyCommand, ownerFriendReplyFeature, type OwnerFriendReplyContext } from "./owner-friend-reply.ts";
import { isRequestOverviewCommand, requestOverviewCommand, requestOverviewFeature } from "./request-overview.ts";
import { createGroupInvitationReview, groupInvitationReviewFeature, isGroupInvitationReviewCommand, isQuotedGroupInvitationReviewCommand, type GroupInvitationReviewContext } from "./group-invitation-review.ts";
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
export { groupBannedWordsFeature, type GroupBannedWords, type GroupBannedWordMatch, type GroupBannedWordPart, type GroupWordMatchScope } from "./banned-words.ts";
export { groupScreenedWordsFeature } from "./screened-words.ts";
export { groupTitleFeature, groupTitleFilterFeature, type GroupTitleContext, type GroupSpecialTitleResult } from "./group-title.ts";
export { groupActivityFeature, groupActivityRankFeature, type GroupActivityContext, type GroupActivityMember, type GroupActivityVisibility } from "./group-activity.ts";
export { groupTimedMuteFeature, type GroupTimedMuteBinding, type GroupTimedMuteServices } from "./group-timed-mute.ts";
export { groupNotificationFeature, type GroupNotificationContext, type GroupNotificationPart } from "./group-notify.ts";
export { groupAddNoticeFeature, type GroupAddNotice, type GroupAddNoticeEvent, type GroupAddNoticePart } from "./group-add-notice.ts";
export { createGroupOwnerJoinRequestNotice, groupOwnerJoinRequestNoticeFeature, type GroupOwnerJoinRequestNotice, type GroupOwnerJoinRequestNoticeInput, type GroupOwnerJoinRequestNoticePart } from "./group-owner-join-request-notice.ts";
export { createGroupOwnerInvitationNotice, groupOwnerInvitationNoticeFeature, type GroupOwnerInvitationNotice, type GroupOwnerInvitationNoticeInput, type GroupOwnerInvitationNoticePart } from "./group-owner-invitation-notice.ts";
export { createGroupMessageNotice, groupMessageNoticeFeature, type GroupMessageNotice, type GroupMessageNoticeInput, type GroupMessageNoticePart } from "./group-message-notice.ts";
export { createOwnerNoticeRecipients, type OwnerNoticeRecipients } from "./owner-notice-recipients.ts";
export { createGroupOwnerGroupNotice, groupOwnerGroupNoticeFeature, type GroupOwnerGroupNotice, type GroupOwnerGroupNoticeInput } from "./group-owner-group-notice.ts";
export { createGroupOwnerBanNotice, groupOwnerBanNoticeFeature, type GroupOwnerBanNotice, type GroupOwnerBanNoticeInput, type GroupOwnerBanNoticePart } from "./group-owner-ban-notice.ts";
export { createGroupOwnerAdminNotice, groupOwnerAdminNoticeFeature, type GroupOwnerAdminNotice, type GroupOwnerAdminNoticeInput, type GroupOwnerAdminNoticePart } from "./group-owner-admin-notice.ts";
export { noticeSettingsFeature, type NoticeSettingsContext, type NoticeSettingsScope } from "./notice-settings.ts";
export type { NoticeSettingsCardModel, NoticeSettingsCardRenderer } from "./notice-settings-card-model.ts";
export { createGroupNoticePanelSettings, GroupNoticePanelSettingsConflict, GroupNoticePanelSettingsInputError, GroupNoticePanelSettingsUnavailable,
  type GroupNoticePanelField, type GroupNoticePanelSettings, type GroupNoticePanelSettingsSnapshot } from "./group-notice-panel-settings.ts";
export { createTemporaryMessageNotice, temporaryMessageNoticeFeature, type TemporaryMessageNotice, type TemporaryMessageNoticeInput, type TemporaryMessageNoticePart } from "./temporary-message-notice.ts";
export { createFriendRelationshipNotice, friendRelationshipNoticeFeature, type FriendRelationshipNotice, type FriendRelationshipNoticeInput, type FriendRelationshipNoticePart } from "./friend-relationship-notice.ts";
export { createGroupRecallNotice, groupRecallNoticeFeature, type GroupRecallNotice, type GroupRecallNoticeInput, type GroupRecallNoticeOutput, type GroupRecallPart } from "./group-recall-notice.ts";
export type { MessageNoticePart } from "./message-notice-content.ts";
export type { RecallNoticeBodyPart } from "./recall-notice.ts";
export { createFriendRecallNotice, friendRecallNoticeFeature, type FriendRecallNotice, type FriendRecallNoticeInput, type FriendRecallNoticePart } from "./friend-recall-notice.ts";
export { createFriendPokeNotice, friendPokeNoticeFeature, type FriendPokeNotice, type FriendPokeNoticeInput, type FriendPokeNoticePart } from "./friend-poke-notice.ts";
export { createFriendMessageNotice, friendMessageNoticeFeature, type FriendMessageNotice, type FriendMessageNoticeInput, type FriendMessageNoticePart } from "./friend-message-notice.ts";
export { createFriendRequestNotice, friendRequestNoticeFeature, type FriendRequestNotice, type FriendRequestNoticeInput, type FriendRequestNoticeOptions, type FriendRequestNoticePart } from "./friend-request-notice.ts";
export { friendRequestReviewFeature, type FriendRequestReviewContext, type PendingFriendRequestReviewResult } from "./friend-request-review.ts";
export { friendRequestListFeature, type FriendRequestListContext, type PendingFriendRequest, type PendingFriendRequests } from "./friend-request-list.ts";
export { ownerFriendReplyFeature, type OwnerFriendReplyContext, type OwnerFriendReplyBody, type OwnerFriendReplyResult, type QuotedOwnerFriendReplyResult } from "./owner-friend-reply.ts";
export { requestOverviewFeature } from "./request-overview.ts";
export { groupInvitationReviewFeature, type GroupInvitationReviewContext, type PendingGroupInvitationReviewResult, type QuotedGroupInvitationReviewResult } from "./group-invitation-review.ts";
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

type ModerationContext = GroupMuteContext & PrivateGroupMuteContext & GroupPendingJoinContext & GroupInvitationListContext & FriendRequestListContext & FriendRequestReviewContext & GroupInvitationReviewContext & OwnerFriendReplyContext & GroupNameContext;
function privateInvitationReviewCommand(
  context: Pick<ModerationContext, "message_type" | "reply_id" | "adapter">, command: string,
) {
  return context.message_type === "private" && (isGroupInvitationReviewCommand(command) ||
    (context.adapter === "milky" && isQuotedGroupInvitationReviewCommand(command, context.reply_id)));
}

function privateMuteCommand(context: Pick<ModerationContext, "message_type">, command: string) {
  return context.message_type === "private" && isPrivateGroupMuteCommand(command);
}

const activeFriendRequestFeature = "[group] 主动好友申请提示";

function activeFriendRequestCommand(context: Pick<ModerationContext, "message_type">, command: string) {
  return context.message_type === "private" && /^#?(?:加为好友|添加好友)$/u.test(command);
}

function activeFriendRequestReply(context: ModerationContext) {
  if (!context.isDelegated && context.user_id !== undefined && context.isBotMaster(context.user_id)) {
    return "当前协议端不支持主动发送好友申请。";
  }
}

const defaultModeration = createGroupMute();
const defaultPrivateMute = createPrivateGroupMute();
const defaultPendingJoinReview = createGroupPendingJoinReview();
const defaultFriendRequestReview = createFriendRequestReview();
const defaultGroupInvitationReview = createGroupInvitationReview();
const defaultOwnerFriendReply = createOwnerFriendReply();

const manifest = {
  ...group,
  commands: { ...group.commands, ...groupRequestReview.commands },
  fallback(message: string, context: ModerationContext) {
    const normalized = (context.normalizedMessage ?? message).trim();
    if (context.message_type !== "terminal" && isRequestOverviewCommand(normalized)) return requestOverviewCommand(normalized, context);
    if (context.message_type === "private" && isGroupInvitationListCommand(normalized)) return groupInvitationListCommand(normalized, context);
    if (privateInvitationReviewCommand(context, normalized)) return defaultGroupInvitationReview(normalized, context);
    if (activeFriendRequestCommand(context, normalized)) return activeFriendRequestReply(context);
    if (isGroupNameCommand(normalized, context)) return changeGroupName(normalized, context);
    if (context.message_type === "private" && isOwnerFriendReplyCommand(normalized, context.reply_id, context.message)) return defaultOwnerFriendReply(normalized, context);
    if (context.message_type === "private" && isFriendRequestListCommand(normalized)) return friendRequestListCommand(normalized, context);
    if (context.message_type === "private" && isFriendRequestReviewCommand(normalized)) return defaultFriendRequestReview(normalized, context);
    if (context.message_type === "group" && isGroupPendingJoinCommand(normalized)) return groupPendingJoinCommand(normalized, context);
    if (context.message_type === "group" && isGroupPendingJoinReviewCommand(normalized)) return defaultPendingJoinReview(normalized, context);
    return privateMuteCommand(context, normalized) ? defaultPrivateMute(message, context) : defaultModeration(message, context);
  },
  fallbackFeatures(context: Pick<ModerationContext, "message_type" | "reply_id" | "adapter" | "message"> & { readonly normalizedMessage: string }) {
    const normalized = context.normalizedMessage.trim();
    if (context.message_type !== "terminal" && isRequestOverviewCommand(normalized)) return [requestOverviewFeature];
    if (context.message_type === "private" && isGroupInvitationListCommand(normalized)) return [groupInvitationListFeature];
    if (privateInvitationReviewCommand(context, normalized)) return [groupInvitationReviewFeature];
    if (activeFriendRequestCommand(context, normalized)) return [activeFriendRequestFeature];
    if (isGroupNameCommand(normalized, context)) return [groupNameFeature];
    if (context.message_type === "private" && isOwnerFriendReplyCommand(normalized, context.reply_id, context.message)) return [ownerFriendReplyFeature];
    if (context.message_type === "private" && isFriendRequestListCommand(normalized)) return [friendRequestListFeature];
    if (context.message_type === "private" && isFriendRequestReviewCommand(normalized)) return [friendRequestReviewFeature];
    if (context.message_type === "group" && isGroupPendingJoinCommand(normalized)) return [groupPendingJoinFeature];
    if (context.message_type === "group" && isGroupPendingJoinReviewCommand(normalized)) return [groupPendingJoinReviewFeature];
    return privateMuteCommand(context, normalized) ? [privateGroupMuteFeature] : groupModerationFeature(context);
  },
};
export default manifest;

export async function createModule({
  signal, ownGroupCardAccounts, registerAutoGroupCardTask, readAutoRepeatImage, autoRepeatSessionSignal, observeAutoRepeat, groupLeaveBlacklist, profileLikeImage,
  lockFile, noticeSettingsThemeDirectory, registerManagedBlacklist, registerGroupBannedWords, groupTimedMute, registerGroupAddNotice, registerGroupVerification,
  registerFriendRequestNotice, registerFriendMessageNotice, registerTemporaryMessageNotice, registerFriendRelationshipNotice,
  registerFriendPokeNotice, registerFriendRecallNotice, registerGroupRecallNotice, registerGroupOwnerMemberNotice, registerGroupOwnerAdminNotice, registerGroupOwnerBanNotice, registerGroupOwnerGroupNotice, registerGroupOwnerJoinRequestNotice, registerGroupOwnerInvitationNotice, registerGroupMessageNotice, registerOwnerNoticeRecipients,
}: {
  readonly signal: AbortSignal;
  readonly readAutoRepeatImage?: (url: unknown, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
  readonly autoRepeatSessionSignal?: (event: unknown) => AbortSignal | undefined;
  readonly observeAutoRepeat?: ObserveAutoRepeat;
  readonly ownGroupCardAccounts?: () => readonly OwnGroupCardAccount[];
  readonly registerAutoGroupCardTask?: (cron: string, run: () => Promise<AutoGroupCardSummary | undefined>) => (() => void | Promise<void>);
  readonly groupLeaveBlacklist?: { readonly io: GroupLeaveBlacklistIO; register(policy: GroupLeaveBlacklist): () => void };
  readonly profileLikeImage?: ProfileLikeImage;
  readonly noticeSettingsThemeDirectory?: string;
  readonly lockFile?: Parameters<typeof createManagedBlacklist>[1];
  readonly registerManagedBlacklist?: (policy: GroupManagedBlacklist) => () => void;
  readonly registerGroupBannedWords?: (policy: GroupBannedWords) => () => void;
  readonly groupTimedMute?: GroupTimedMuteServices;
  readonly registerGroupAddNotice?: (policy: GroupAddNotice) => () => void;
  readonly registerGroupRecallNotice?: (policy: GroupRecallNotice) => () => void;
  readonly registerGroupOwnerJoinRequestNotice?: (policy: GroupOwnerJoinRequestNotice) => () => void;
  readonly registerGroupOwnerInvitationNotice?: (policy: GroupOwnerInvitationNotice) => () => void;
  readonly registerGroupMessageNotice?: (policy: GroupMessageNotice) => () => void;
  readonly registerOwnerNoticeRecipients?: (policy: OwnerNoticeRecipients) => () => void;
  readonly registerGroupOwnerGroupNotice?: (policy: GroupOwnerGroupNotice) => () => void;
  readonly registerGroupOwnerBanNotice?: (policy: GroupOwnerBanNotice) => () => void;
  readonly registerGroupOwnerAdminNotice?: (policy: GroupOwnerAdminNotice) => () => void;
  readonly registerGroupOwnerMemberNotice?: (policy: GroupOwnerMemberNotice) => () => void;
  readonly registerFriendRecallNotice?: (policy: FriendRecallNotice) => () => void;
  readonly registerFriendPokeNotice?: (policy: FriendPokeNotice) => () => void;
  readonly registerFriendRelationshipNotice?: (policy: FriendRelationshipNotice) => () => void;
  readonly registerTemporaryMessageNotice?: (policy: TemporaryMessageNotice) => () => void;
  readonly registerFriendMessageNotice?: (policy: FriendMessageNotice) => () => void;
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
  const repeatLifetime = new AbortController();
  const nativeEvents = groupRuntimeEvents({
    signal: AbortSignal.any([signal, repeatLifetime.signal]), readImage: readAutoRepeatImage, sessionSignal: autoRepeatSessionSignal, observeAutoRepeat,
    isBot: (id: number) => ownGroupCardAccounts?.().some(({ botId }) => id === botId) ?? false,
  });
  let stopLeaveBlacklist: (() => void) | undefined;
  const root = new URL("../../", import.meta.url);
  const noticeOptions = {
    config: new URL("config/group-notice.yaml", root),
    legacyConfig: new URL("plugins/yenai-plugin/config/config/notice.yaml", root),
    signal,
  };
  const stopFriendRequestNotice = !signal.aborted && registerFriendRequestNotice?.(createFriendRequestNotice(noticeOptions));
  const stopFriendMessageNotice = !signal.aborted && registerFriendMessageNotice?.(createFriendMessageNotice(noticeOptions));
  const stopTemporaryMessageNotice = !signal.aborted && registerTemporaryMessageNotice?.(createTemporaryMessageNotice(noticeOptions));
  const stopFriendRelationshipNotice = !signal.aborted && registerFriendRelationshipNotice?.(createFriendRelationshipNotice(noticeOptions));
  const stopFriendPokeNotice = !signal.aborted && registerFriendPokeNotice?.(createFriendPokeNotice(noticeOptions));
  const stopFriendRecallNotice = !signal.aborted && registerFriendRecallNotice?.(createFriendRecallNotice(noticeOptions));
  const stopGroupRecallNotice = !signal.aborted && registerGroupRecallNotice?.(createGroupRecallNotice(noticeOptions));
  const stopGroupOwnerMemberNotice = !signal.aborted && registerGroupOwnerMemberNotice?.(createGroupOwnerMemberNotice(noticeOptions));
  const stopGroupOwnerAdminNotice = !signal.aborted && registerGroupOwnerAdminNotice?.(createGroupOwnerAdminNotice(noticeOptions));
  const stopGroupOwnerBanNotice = !signal.aborted && registerGroupOwnerBanNotice?.(createGroupOwnerBanNotice(noticeOptions));
  const stopGroupOwnerGroupNotice = !signal.aborted && registerGroupOwnerGroupNotice?.(createGroupOwnerGroupNotice(noticeOptions));
  const stopGroupOwnerJoinRequestNotice = !signal.aborted && registerGroupOwnerJoinRequestNotice?.(createGroupOwnerJoinRequestNotice(noticeOptions));
  const stopGroupOwnerInvitationNotice = !signal.aborted && registerGroupOwnerInvitationNotice?.(createGroupOwnerInvitationNotice(noticeOptions));
  const stopGroupMessageNotice = !signal.aborted && registerGroupMessageNotice?.(createGroupMessageNotice(noticeOptions));
  const stopOwnerNoticeRecipients = !signal.aborted && registerOwnerNoticeRecipients?.(createOwnerNoticeRecipients(noticeOptions));
  if (groupLeaveBlacklist && !signal.aborted) {
    const policy = await readGroupLeaveBlacklist(root, groupLeaveBlacklist.io);
    if (!signal.aborted) stopLeaveBlacklist = groupLeaveBlacklist.register(policy);
  }
  let noticeCard: Promise<NoticeSettingsCardRenderer> | undefined;
  const noticeSettings = lockFile && createNoticeSettings(root, lockFile, signal, noticeSettingsThemeDirectory
    ? async (model, signal) => {
      noticeCard ??= import("./notice-settings-card-renderer.ts").then(({ createNoticeSettingsCardRenderer }) =>
        createNoticeSettingsCardRenderer({ resourceDirectory: noticeSettingsThemeDirectory }));
      return (await noticeCard)(model, signal);
    }
    : undefined);
  const blacklist = lockFile && !signal.aborted ? createManagedBlacklist(root, lockFile) : undefined;
  const stopManagedBlacklist = blacklist && registerManagedBlacklist?.(blacklist);
  const screenedWords = lockFile && createGroupScreenedWords(root, lockFile, signal);
  const bannedWords = lockFile && blacklist ? createGroupBannedWords(root, lockFile, blacklist, signal, screenedWords?.match) : undefined;
  const stopBannedWords = bannedWords && registerGroupBannedWords?.(bannedWords.policy);
  const moderation = createGroupMute(root, blacklist, signal);
  const privateMute = createPrivateGroupMute(signal);
  const title = bannedWords && createGroupTitle(bannedWords.titleStore, signal);
  const activityCleanup = createGroupActivityCleanup(root, signal);
  const notify = createGroupNotification(signal);
  const quotedReview = createGroupQuotedReview(signal);
  const pendingJoinReview = createGroupPendingJoinReview(signal);
  const friendRequestReview = createFriendRequestReview(signal);
  const groupInvitationReview = createGroupInvitationReview(signal);
  const ownerFriendReply = createOwnerFriendReply(signal);
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
    nativeEvents,
    fallback(message: string, context: ModerationContext & NoticeSettingsContext & GroupTitleContext & GroupActivityContext & GroupNotificationContext &
      GroupQuotedReviewContext & GroupAnnouncementPublishContext & GroupAnnouncementDeleteContext & GroupVoteContext & GroupVerificationContext & ScreenedWordsContext) {
      const normalized = context.normalizedMessage.trim();
      if (noticeSettings && isNoticeSettingsCommand(normalized)) return noticeSettings(normalized, context);
      if (context.message_type !== "terminal" && isRequestOverviewCommand(normalized)) return requestOverviewCommand(normalized, context, signal);
      if (privateMuteCommand(context, normalized)) return privateMute(message, context);
      if (context.message_type === "private" && isGroupInvitationListCommand(normalized)) return groupInvitationListCommand(normalized, context, signal);
      if (privateInvitationReviewCommand(context, normalized)) return groupInvitationReview(normalized, context);
      if (activeFriendRequestCommand(context, normalized)) return signal.aborted ? undefined : activeFriendRequestReply(context);
      if (isGroupNameCommand(normalized, context)) return signal.aborted ? undefined : changeGroupName(normalized, context);
      if (context.message_type === "private" && isOwnerFriendReplyCommand(normalized, context.reply_id, context.message)) return ownerFriendReply(normalized, context);
      if (context.message_type === "private" && isFriendRequestListCommand(normalized)) return friendRequestListCommand(normalized, context, signal);
      if (context.message_type === "private" && isFriendRequestReviewCommand(normalized)) return friendRequestReview(normalized, context);
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
      if (screenedWords && isGroupScreenedWordsCommand(normalized)) return screenedWords.command(context);
      return bannedWords && isGroupBannedWordCommand(normalized)
        ? bannedWords.command(message, context) : moderation(message, context);
    },
    fallbackFeatures(context: Parameters<typeof manifest.fallbackFeatures>[0]) {
      const message = context.normalizedMessage.trim();
      if (isNoticeSettingsCommand(message)) return [noticeSettingsFeature];
      if (context.message_type !== "terminal" && isRequestOverviewCommand(message)) return [requestOverviewFeature];
      if (privateMuteCommand(context, message)) return [privateGroupMuteFeature];
      if (context.message_type === "private" && isGroupInvitationListCommand(message)) return [groupInvitationListFeature];
      if (privateInvitationReviewCommand(context, message)) return [groupInvitationReviewFeature];
      if (activeFriendRequestCommand(context, message)) return [activeFriendRequestFeature];
      if (isGroupNameCommand(message, context)) return [groupNameFeature];
      if (context.message_type === "private" && isOwnerFriendReplyCommand(message, context.reply_id, context.message)) return [ownerFriendReplyFeature];
      if (context.message_type === "private" && isFriendRequestListCommand(message)) return [friendRequestListFeature];
      if (context.message_type === "private" && isFriendRequestReviewCommand(message)) return [friendRequestReviewFeature];
      if (isGroupVerificationCommand(message)) return [groupVerificationFeature];
      if (isGroupVoteCommand(message)) return [groupVoteFeature];
      if (isGroupAnnouncementsCommand(message) || isGroupAnnouncementPublishCommand(message) || isGroupAnnouncementDeleteCommand(message)) return [groupAnnouncementsFeature];
      if (context.message_type === "group" && isGroupPendingJoinCommand(message)) return [groupPendingJoinFeature];
      if (context.message_type === "group" && isGroupPendingJoinReviewCommand(message)) return [groupPendingJoinReviewFeature];
      if (context.message_type === "group" && isGroupQuotedReviewCommand(message)) return [groupQuotedReviewFeature];
      if (isGroupAddNoticeCommand(message)) return [groupAddNoticeFeature];
      if (isGroupNotificationCommand(message)) return [groupNotificationFeature];
      if (isGroupTimedMuteCommand(message)) return [groupTimedMuteFeature];
      if (isGroupActivityRankCommand(message)) return [groupActivityRankFeature];
      if (isGroupActivityCommand(message) || isGroupActivityCleanupCommand(message)) return [groupActivityFeature];
      const feature = groupTitleCommandFeature(message);
      if (feature) return [feature];
      if (isGroupScreenedWordsCommand(message)) return [groupScreenedWordsFeature];
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
      if (stopFriendMessageNotice) stopFriendMessageNotice();
      if (stopTemporaryMessageNotice) stopTemporaryMessageNotice();
      if (stopFriendRelationshipNotice) stopFriendRelationshipNotice();
      if (stopFriendPokeNotice) stopFriendPokeNotice();
      if (stopFriendRecallNotice) stopFriendRecallNotice();
      if (stopGroupRecallNotice) stopGroupRecallNotice();
      if (stopGroupOwnerMemberNotice) stopGroupOwnerMemberNotice();
      if (stopGroupOwnerAdminNotice) stopGroupOwnerAdminNotice();
      if (stopGroupOwnerBanNotice) stopGroupOwnerBanNotice();
      if (stopGroupOwnerGroupNotice) stopGroupOwnerGroupNotice();
      if (stopGroupOwnerJoinRequestNotice) stopGroupOwnerJoinRequestNotice();
      if (stopGroupOwnerInvitationNotice) stopGroupOwnerInvitationNotice();
      if (stopGroupMessageNotice) stopGroupMessageNotice();
      if (stopOwnerNoticeRecipients) stopOwnerNoticeRecipients();
      stopManagedBlacklist?.();
      stopLeaveBlacklist?.();
      repeatLifetime.abort();
      await Promise.all([stopTask?.(), timedMute?.stop(), vote?.stop(), verification?.stop()]);
    },
  };
}
