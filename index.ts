interface LikeContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly user_id?: number;
  readonly self_id?: number;
  readonly isFriend?: () => Promise<boolean>;
  readonly likeSelf?: (count: number) => Promise<number>;
}

interface LikeConfig {
  readonly enable: boolean;
  readonly cloneAllThumbUp: boolean;
  readonly strangeThumbUp: boolean;
  readonly count: number;
  readonly closeTips: string | false;
  readonly successMsg: string | false;
  readonly failsMsg: string | false;
  readonly noFriendMsg: string | false;
}

type MessagePart = string | { readonly type: "at"; readonly qq: number };
type Reply = string | readonly MessagePart[];
type Handler = (argument: string, context: LikeContext) => Promise<Reply>;

const defaults: LikeConfig = {
  enable: true,
  cloneAllThumbUp: false,
  strangeThumbUp: true,
  count: 10,
  closeTips: "",
  successMsg: "给你点了 {{thumbUpNum}} 下赞。",
  failsMsg: "点赞未成功，可能已达到平台次数上限或协议端暂不接受。",
  noFriendMsg: "当前仅向好友点赞。",
};

function readConfig(raw: unknown): LikeConfig {
  if (raw == null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("群功能配置须为映射。");
  const mapping = raw as Record<string, unknown>;

  function flag(name: "enable" | "cloneAllThumbUp" | "strangeThumbUp"): boolean {
    const value = mapping[name];
    if (value === undefined) return defaults[name];
    if (typeof value !== "boolean") throw new Error(`${name} 须为布尔值。`);
    return value;
  }

  function message(name: "closeTips" | "successMsg" | "failsMsg" | "noFriendMsg"): string | false {
    const value = mapping[name];
    if (value === undefined) return defaults[name];
    if (value === false || value === "false") return false;
    if (typeof value !== "string") throw new Error(`${name} 须为文本或 false。`);
    return value;
  }

  const count = mapping.count ?? defaults.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error("count 须为 1–10 的整数。");
  }
  return {
    enable: flag("enable"),
    cloneAllThumbUp: flag("cloneAllThumbUp"),
    strangeThumbUp: flag("strangeThumbUp"),
    count,
    closeTips: message("closeTips"),
    successMsg: message("successMsg"),
    failsMsg: message("failsMsg"),
    noFriendMsg: message("noFriendMsg"),
  };
}

const defaultConfig = new URL("../../config/group.yaml", import.meta.url);

async function loadConfig(): Promise<LikeConfig> {
  const configuredPath = Bun.env.LOTUS_GROUP_CONFIG;
  const file = Bun.file(configuredPath || defaultConfig);
  if (!configuredPath && !await file.exists()) return defaults;
  return readConfig(Bun.YAML.parse(await file.text()));
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

export function createGroupPlugin(config: () => Promise<LikeConfig> = loadConfig) {
  const inFlight = new Set<string>();

  function like(style: string, groupOnly = false): Handler {
    return async (argument, context) => {
      if (argument) return "请直接发送点赞指令。";
      if (groupOnly && context.message_type !== "group") return [];
      let current: LikeConfig;
      try {
        current = await config();
      } catch {
        return "点赞配置无法读取，请联系管理员。";
      }
      if (groupOnly && current.cloneAllThumbUp) return [];
      if (!current.enable) return reply(current.closeTips, context, style);
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
          if (friend !== true) return groupOnly ? [] : reply(current.noFriendMsg, context, style, undefined, friend);
        }
        const count = await likeSelf(current.count);
        if (Number.isInteger(count) && count >= 1 && count <= current.count) {
          return reply(current.successMsg, context, style, count);
        }
      } catch {
        // A gateway refusal is never reported as a successful like.
      } finally {
        inFlight.delete(key);
      }
      return groupOnly ? [] : reply(current.failsMsg, context, style);
    };
  }

  const commands: Record<string, Handler> = { "#全部赞我": like("赞", true) };
  for (const name of aliases) commands[`#${name}`] = like("赞");
  for (const name of colloquial) commands[`#${name}`] = like("超");
  const bareAliases = Object.fromEntries([...aliases, ...colloquial].map((name) => [name, `#${name}`]));
  return { commands, aliases: bareAliases };
}

export default createGroupPlugin();
