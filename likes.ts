import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { readLikeSettings, type LikeSettings } from "./like-settings.ts";

export interface MentionLike {
  readonly userId: number;
  isFriend(): Promise<boolean>;
  friendship?(): Promise<boolean | undefined>;
  /** Return the confirmed count, zero on a definitive refusal, or throw if the result is uncertain. */
  like(count: number): Promise<number>;
}

export type ProfileLikeImage = (
  avatarId: number, outcome: "success" | "failure", signal: AbortSignal,
) => Promise<Uint8Array | undefined>;

export interface LikeContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly user_id?: number;
  readonly self_id?: number;
  readonly isDelegated?: boolean;
  readonly isFriend?: () => Promise<boolean>;
  readonly profileLikeFriendship?: () => Promise<boolean | undefined>;
  /** Same receipt semantics as MentionLike.like. */
  readonly likeSelf?: (count: number) => Promise<number>;
  readonly mentionLike?: MentionLike;
  readonly profileLikeImageSignal?: AbortSignal;
}

type ImagePart = { readonly type: "image"; readonly file: Uint8Array };
type MessagePart = string | { readonly type: "at"; readonly qq: number } | ImagePart;
type Reply = string | readonly MessagePart[];
type QuotedReply = {
  readonly type: "quoted";
  readonly message: Reply;
  readonly options?: { readonly recallMsg: number };
};
type Handler = (argument: string, context: LikeContext) => Promise<Reply | QuotedReply>;

function quoted(message: Reply, recall = 0): Reply | QuotedReply {
  return message.length ? { type: "quoted", message, ...(recall > 0 && { options: { recallMsg: recall } }) } : message;
}

function reply(template: string | false, context: LikeContext, style: string, count?: number, friend?: boolean,
  mention?: MentionLike, image?: ImagePart): Reply {
  if (!template) return [];
  const target = mention?.userId ?? context.user_id;
  const userLabel = mention ? String(mention.userId) : $t("likes.text_a0c7716669");
  const fragments: MessagePart[] = [];
  const expanded = template.replace(/\{\{\s*noFriend:([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\}/gu,
    (_whole, body: string) => friend === false ? body.replace(/\{\s*(doType|userId|thumbUpNum)\s*\}/gu,
      (_match, key: string) => key === "doType" ? style : key === "userId" ? userLabel : String(count ?? 0)) : "");
  for (const [index, part] of expanded.split(/\{\{\s*(at|userId|doType|thumbUpNum|img)\s*\}\}/gu).entries()) {
    if (index % 2 === 0) {
      if (part) fragments.push(part);
      continue;
    }
    if (part === "at" && context.message_type === "group" && target !== undefined) {
      fragments.push({ type: "at", qq: target });
    } else if (part === "userId") {
      fragments.push(userLabel);
    } else if (part === "doType") {
      fragments.push(style);
    } else if (part === "thumbUpNum") {
      fragments.push(String(count ?? 0));
    } else if (part === "img" && image) {
      fragments.push(image);
    }
  }
  return fragments.every((part) => typeof part === "string") && fragments.length
    ? fragments.join("") : fragments;
}

const aliases = ["赞我", "点赞", "资料卡点赞", "我要点赞", "给我点赞", "我要资料卡点赞", "给我资料卡点赞"];
const colloquial = ["超", "操", "草", "抄", "吵", "炒"];
const mentionPronouns = ["他", "她", "它", "TA", "ta", "Ta"];
const mentionPrompt = $t("likes.text_dfab485394");

function otherMention(context: LikeContext): MentionLike | undefined {
  const { message_type, isDelegated, mentionLike, user_id, self_id } = context;
  if (message_type !== "group" || isDelegated || !mentionLike) return;
  const { userId } = mentionLike;
  if (Number.isSafeInteger(userId) && userId > 0 && userId !== self_id && userId !== user_id) return mentionLike;
}

export function createGroupPlugin(config: () => Promise<LikeSettings> = async () => (await readLikeSettings()).settings,
  profileLikeImage?: ProfileLikeImage) {
  const inFlight = new Set<string>();

  async function renderImage(template: string | false, context: LikeContext, avatarId: number,
    outcome: "success" | "failure"): Promise<ImagePart | undefined> {
    const signal = context.profileLikeImageSignal;
    if (!profileLikeImage || !signal || signal.aborted || context.isDelegated ||
        !Number.isSafeInteger(avatarId) || avatarId < 1 || !template || !/\{\{\s*img\s*\}\}/u.test(template)) return;
    const result = Promise.withResolvers<Uint8Array | undefined>();
    const abort = () => result.resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      void profileLikeImage(avatarId, outcome, signal).then(result.resolve, abort);
      const bytes = await result.promise;
      if (!signal.aborted && bytes instanceof Uint8Array && bytes.byteLength) return { type: "image", file: bytes };
    } catch {
      // The text reply remains usable when the optional renderer fails.
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  function like(style: string, mode: "self" | "all" | "mention" = "self"): Handler {
    return async (argument, context) => {
      if (argument) return mode === "mention" ? mentionPrompt : $t("likes.text_ec4a104b5a");
      if (mode === "all" && context.message_type !== "group") return [];
      let current: LikeSettings;
      try {
        current = await config();
      } catch {
        return $t("likes.text_9b6fb6c426");
      }
      if (mode === "all" && current.cloneAllThumbUp) return [];
      const mention = mode === "mention" ? otherMention(context) : undefined;
      if (!current.enable) return quoted(reply(current.closeTips, context, style, undefined, undefined, mention));
      if (mode === "mention" && !mention) return mentionPrompt;
      const { likeSelf, user_id } = context;
      const submit = mention ? (count: number) => mention.like(count) : likeSelf;
      if (!submit || user_id === undefined || context.message_type === "terminal") return $t("likes.text_bd80d5cbf9");
      const botId = context.self_id ?? "unknown";
      const requesterKey = `${botId}:${user_id}`;
      const targetKey = `${botId}:${mention?.userId ?? user_id}`;
      if (inFlight.has(requesterKey) || inFlight.has(targetKey)) return mode === "all" ? [] : $t("likes.text_6751e96036");
      inFlight.add(requesterKey);
      inFlight.add(targetKey);
      try {
        let friend: boolean | undefined;
        if (!current.strangeThumbUp) {
          friend = await (mention ? mention.isFriend() : context.isFriend?.())?.catch(() => undefined);
          if (friend !== true) return mode === "all" ? [] : quoted(reply(current.noFriendMsg, context, style, undefined, friend, mention));
        }
        const count = await submit(current.count);
        const avatarId = mention?.userId ?? user_id;
        if (Number.isInteger(count) && count >= 1 && count <= current.count) {
          if (current.strangeThumbUp && current.successMsg && /\{\{\s*noFriend:/u.test(current.successMsg)) {
            friend = await (mention ? mention.friendship?.() : context.profileLikeFriendship?.())?.catch(() => undefined);
          }
          const image = await renderImage(current.successMsg, context, avatarId, "success");
          return quoted(reply(current.successMsg, context, style, count, friend, mention, image), current.recall);
        }
        if (count === 0 && mode !== "all") {
          const image = await renderImage(current.failsMsg, context, avatarId, "failure");
          return quoted(reply(current.failsMsg, context, style, undefined, undefined, mention, image), current.recall);
        }
      } catch {
        // A gateway refusal is never reported as a successful like.
      } finally {
        inFlight.delete(requesterKey);
        inFlight.delete(targetKey);
      }
      return mode === "all" ? [] : quoted(reply(current.failsMsg, context, style, undefined, undefined, mention), current.recall);
    };
  }

  const commands: Record<string, Handler> = { "#全部赞我": like($t("likes.text_9c0d90f768"), "all") };
  for (const name of aliases) commands[`#${name}`] = like($t("likes.text_9c0d90f768"));
  for (const verb of colloquial) commands[`#${verb}我`] = like($t("likes.text_c92686569d"));
  for (const verb of ["赞", ...colloquial]) {
    for (const pronoun of mentionPronouns) commands[`#${verb}${pronoun}`] = like(verb === "赞" ? $t("likes.text_9c0d90f768") : $t("likes.text_c92686569d"), "mention");
  }
  const bareAliases = Object.fromEntries(Object.keys(commands).filter((name) => name !== "#全部赞我").map((name) => [name.slice(1), name]));
  return { commands, aliases: bareAliases };
}

export default createGroupPlugin();
