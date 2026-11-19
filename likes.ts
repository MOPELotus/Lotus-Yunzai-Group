import { readLikeSettings, type LikeSettings } from "./like-settings.ts";

interface LikeContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly user_id?: number;
  readonly self_id?: number;
  readonly isFriend?: () => Promise<boolean>;
  readonly likeSelf?: (count: number) => Promise<number>;
}

type MessagePart = string | { readonly type: "at"; readonly qq: number };
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

function reply(template: string | false, context: LikeContext, style: string, count?: number, friend?: boolean): Reply {
  if (!template) return [];
  const fragments: MessagePart[] = [];
  const expanded = template.replace(/\{\{\s*noFriend:([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\}/gu,
    (_whole, body: string) => friend === false ? body.replace(/\{\s*(doType|userId|thumbUpNum)\s*\}/gu,
      (_match, key: string) => key === "doType" ? style : key === "userId" ? "你" : String(count ?? 0)) : "");
  for (const [index, part] of expanded.split(/\{\{\s*(at|userId|doType|thumbUpNum|img)\s*\}\}/gu).entries()) {
    if (index % 2 === 0) {
      if (part) fragments.push(part);
      continue;
    }
    if (part === "at" && context.message_type === "group" && context.user_id !== undefined) {
      fragments.push({ type: "at", qq: context.user_id });
    } else if (part === "userId") {
      fragments.push("你");
    } else if (part === "doType") {
      fragments.push(style);
    } else if (part === "thumbUpNum") {
      fragments.push(String(count ?? 0));
    }
  }
  return fragments.every((part) => typeof part === "string") && fragments.length
    ? fragments.join("") : fragments;
}

const aliases = ["赞我", "点赞", "资料卡点赞", "我要点赞", "给我点赞", "我要资料卡点赞", "给我资料卡点赞"];
const colloquial = ["超我", "操我", "草我", "抄我", "吵我", "炒我"];

export function createGroupPlugin(config: () => Promise<LikeSettings> = async () => (await readLikeSettings()).settings) {
  const inFlight = new Set<string>();

  function like(style: string, groupOnly = false): Handler {
    return async (argument, context) => {
      if (argument) return "请直接发送点赞指令。";
      if (groupOnly && context.message_type !== "group") return [];
      let current: LikeSettings;
      try {
        current = await config();
      } catch {
        return "点赞配置无法读取，请联系管理员。";
      }
      if (groupOnly && current.cloneAllThumbUp) return [];
      if (!current.enable) return quoted(reply(current.closeTips, context, style));
      const { likeSelf, user_id } = context;
      if (!likeSelf || user_id === undefined || context.message_type === "terminal") {
        return "当前协议端不支持资料卡点赞。";
      }
      const key = `${context.self_id ?? "unknown"}:${user_id}`;
      if (inFlight.has(key)) return groupOnly ? [] : "正在处理你的点赞请求。";
      inFlight.add(key);
      try {
        if (!current.strangeThumbUp) {
          const friend = await context.isFriend?.().catch(() => undefined);
          if (friend !== true) return groupOnly ? [] : quoted(reply(current.noFriendMsg, context, style, undefined, friend));
        }
        const count = await likeSelf(current.count);
        if (Number.isInteger(count) && count >= 1 && count <= current.count) {
          return quoted(reply(current.successMsg, context, style, count), current.recall);
        }
      } catch {
        // A gateway refusal is never reported as a successful like.
      } finally {
        inFlight.delete(key);
      }
      return groupOnly ? [] : quoted(reply(current.failsMsg, context, style), current.recall);
    };
  }

  const commands: Record<string, Handler> = { "#全部赞我": like("赞", true) };
  for (const name of aliases) commands[`#${name}`] = like("赞");
  for (const name of colloquial) commands[`#${name}`] = like("超");
  const bareAliases = Object.fromEntries([...aliases, ...colloquial].map((name) => [name, `#${name}`]));
  return { commands, aliases: bareAliases };
}

export default createGroupPlugin();
