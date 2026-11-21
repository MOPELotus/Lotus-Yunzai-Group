interface ReplyOptions {
  readonly at?: true;
  readonly recallMsg?: number;
}

export interface RepeatEvent {
  readonly message: unknown;
  readonly isMaster: boolean;
  readonly isDelegated?: boolean;
  reply(message: unknown, quote?: boolean, options?: ReplyOptions): boolean | Promise<boolean>;
}

export interface RepeatContexts {
  set(event: RepeatEvent, method: string, group: boolean, seconds: number, timeout: string): unknown;
  get(event: RepeatEvent, group: boolean): Record<string, unknown>;
  finish(event: RepeatEvent, method: string, group: boolean): void;
}

const repeatContext = "repeatMessage";

export async function startRepeat(event: RepeatEvent, contexts: RepeatContexts) {
  if (event.isDelegated || !contexts.set(event, repeatContext, false, 120, "操作超时已取消")) {
    return event.reply("无法建立复读会话。");
  }
  try {
    const sent = await event.reply("请发送要复读的内容", false, { at: true });
    if (sent === false) contexts.finish(event, repeatContext, false);
    return sent;
  } catch (error) {
    contexts.finish(event, repeatContext, false);
    throw error;
  }
}

export async function continueRepeat(event: RepeatEvent, contexts: RepeatContexts) {
  if (event.isDelegated || !Object.hasOwn(contexts.get(event, false), repeatContext)) return false;
  contexts.finish(event, repeatContext, false);
  if (event.isMaster) await event.reply(event.message, false, { recallMsg: 5 });
  return true;
}
