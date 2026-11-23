import { createHash } from "node:crypto";

type Text = { readonly type: "text"; readonly text: string };
type Face = { readonly type: "face"; readonly id: string | number; readonly is_large?: boolean };
type Image = { readonly type: "image"; readonly file: Uint8Array };
type ReplyPart = Text | Face | Image;
type Signature = ["text", string] | ["face", string, boolean] | ["image", ...string[]];
type ImageSource = {
  readonly type: "image";
  readonly url?: string;
  readonly resolve?: () => Promise<unknown>;
};

export interface AutoRepeatEvent {
  readonly self_id?: number;
  readonly group_id?: number;
  readonly user_id?: number;
  readonly sender?: Readonly<Record<string, unknown>>;
  readonly message: unknown;
  readonly adapter?: "milky";
  readonly isDelegated?: boolean;
  readonly reply: (content: readonly ReplyPart[]) => boolean | Promise<boolean>;
}

export interface AutoRepeatOptions {
  readonly signal?: AbortSignal;
  readonly isBot?: (userId: number) => boolean;
  readonly readImage?: (url: unknown, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
  readonly now?: () => number;
}

interface Round {
  readonly hash: string;
  readonly first: number;
  last: number;
  repeated: boolean;
}

const windowMs = 120_000;
const maxGroups = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function imageSource(data: Record<string, unknown>, adapter?: "milky") {
  const file = typeof data.file === "string" ? data.file : undefined;
  const url = typeof data.url === "string" && data.url ? data.url
    : adapter !== "milky" && file && /^https:\/\//iu.test(file) ? file : undefined;
  if (adapter === "milky") {
    const resource = data.resource_id;
    const resolve = typeof data.getDownloadUrl === "function" ? data.getDownloadUrl as ImageSource["resolve"] : undefined;
    if (typeof resource === "string" && resource && resource.length <= 4_096 && !/\s/u.test(resource) && (url || resolve)) {
      return { identity: ["milky", resource], url, resolve };
    }
  } else if (url && file) {
    const md5 = /(?:^|[/\\])([a-f\d]{32})(?:\.[a-z\d]+)?$/iu.exec(file)?.[1];
    if (md5) return { identity: ["md5", md5.toLowerCase()], url, resolve: undefined };
  }
  if (url) return { identity: ["url", url], url, resolve: undefined };
}

function prepare(message: unknown, adapter: AutoRepeatEvent["adapter"], withImages: boolean) {
  if (!Array.isArray(message)) return;
  const signature: Signature[] = [];
  const payload: (Text | Face | ImageSource)[] = [];
  let text = "";
  for (const part of message) {
    if (!isRecord(part)) return;
    const data = isRecord(part.data) ? part.data : part;
    switch (part.type) {
      case "text": {
        if (typeof data.text !== "string") return;
        const value = data.text.replaceAll("\r\n", "\n");
        text += value;
        const previous = signature.at(-1);
        if (previous?.[0] === "text") previous[1] += value;
        else signature.push(["text", value]);
        payload.push({ type: "text", text: value });
        break;
      }
      case "face": {
        const id = data.id;
        if (typeof id !== "number" && typeof id !== "string") return;
        if (typeof id === "number" ? !Number.isSafeInteger(id) || id < 0 : !/^\d+$/u.test(id)) return;
        const is_large = data.is_large === true;
        signature.push(["face", String(id), is_large]);
        payload.push({ type: "face", id, ...(is_large && { is_large }) });
        break;
      }
      case "image": {
        const image = withImages && imageSource(data, adapter);
        if (!image) return;
        signature.push(["image", ...image.identity]);
        payload.push({ type: "image", url: image.url, resolve: image.resolve });
        break;
      }
      default: return;
    }
  }
  if (!signature.length || /^[#＃/*＊%％]/u.test(text.trimStart())) return;
  if (!text.trim() && signature.every(([type]) => type === "text")) return;
  return { hash: createHash("sha256").update(JSON.stringify(signature)).digest("hex"), payload };
}

export function createAutoRepeat({ signal, isBot, readImage, now = () => performance.now() }: AutoRepeatOptions = {}) {
  const rounds = new Map<number, Round>();

  return async (event: AutoRepeatEvent, session?: AbortSignal): Promise<void> => {
    const { group_id: group, user_id: user } = event;
    if (!session || session.aborted || signal?.aborted || event.isDelegated || !positiveId(group) || !positiveId(user) || event.self_id === user ||
        event.sender?.is_bot === true || isBot?.(user)) return;

    const message = prepare(event.message, event.adapter, !!readImage);
    if (!message) {
      rounds.delete(group);
      return;
    }
    const timestamp = now();
    const prior = rounds.get(group);
    const round = prior?.hash === message.hash && timestamp - prior.last <= windowMs
      ? prior : { hash: message.hash, first: user, repeated: false, last: timestamp };
    round.last = timestamp;
    rounds.delete(group);
    rounds.set(group, round);
    if (rounds.size > maxGroups) rounds.delete(rounds.keys().next().value!);
    if (round.repeated || round.first === user) return;
    round.repeated = true;

    const active = signal ? AbortSignal.any([signal, session]) : session;
    async function read(url: unknown) {
      if (active.aborted || typeof url !== "string") return;
      try { return await readImage?.(url, active); }
      catch { return; }
    }
    const result: ReplyPart[] = [];
    for (const part of message.payload) {
      if (active.aborted) return;
      if (part.type !== "image") {
        result.push(part);
        continue;
      }
      let file = await read(part.url);
      if (!file?.byteLength && !active.aborted && part.resolve) {
        const renewed = await Promise.resolve().then(part.resolve).catch(() => undefined);
        if (renewed !== part.url) file = await read(renewed);
      }
      if (!file?.byteLength) return;
      result.push({ type: "image", file });
    }
    if (active.aborted) return;
    try {
      if (!await event.reply(result)) console.warn("[group] 自动复读发送失败。");
    } catch {
      console.warn("[group] 自动复读发送结果未确认。");
    }
  };
}
