import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
  if (event.isDelegated || !contexts.set(event, repeatContext, false, 120, $t("repeat.text_d3bc98297a"))) {
    return event.reply($t("repeat.text_71bc7a4052"));
  }
  try {
    const sent = await event.reply($t("repeat.text_a15949957b"), false, { at: true });
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
