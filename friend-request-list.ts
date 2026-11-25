import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
import { displayRequestField } from "./group-pending-join.ts";

export interface PendingFriendRequest {
  readonly userId: number;
  readonly nickname?: string;
  readonly source?: string;
  readonly time?: number;
  readonly comment?: string;
  readonly risk?: boolean;
}

export interface PendingFriendRequests {
  readonly entries: readonly PendingFriendRequest[];
  readonly complete: boolean;
}

export interface FriendRequestListContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly isDelegated?: boolean;
  readonly isBotMaster: (userId: number) => boolean;
  readonly listPendingFriendRequests?: () => Promise<PendingFriendRequests | undefined>;
}

type Part = string | { readonly type: "image"; readonly file: string };
type Reply = string | { readonly type: "forward"; readonly nodes: readonly (readonly Part[])[] };

export const friendRequestListFeature = "[group] 好友申请列表";
const lookup = /^#?查看(?:全部)?好友申请$/u;
const maxShown = 50;
const unavailable = $t("friend-request-list.text_ca241ed68e");
const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function isFriendRequestListCommand(command: string): boolean {
  return lookup.test(command);
}

function positiveId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requestTime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000) return $t("friend-request-list.text_4d8c1c5b42");
  return $t("friend-request-list.text_3c475b75db", { "value1": shanghaiTime.format(seconds * 1000) });
}

export async function friendRequestListCommand(command: string, context: FriendRequestListContext, signal?: AbortSignal): Promise<Reply | undefined> {
  if (context.message_type !== "private" || context.isDelegated || signal?.aborted || !isFriendRequestListCommand(command)) return;
  const { self_id, user_id, isBotMaster, listPendingFriendRequests } = context;
  if (!positiveId(self_id) || !positiveId(user_id) || !isBotMaster(user_id)) return $t("friend-request-list.text_f2ef22d907");
  if (!listPendingFriendRequests) return unavailable;

  try {
    const result = await listPendingFriendRequests();
    if (signal?.aborted || !isBotMaster(user_id)) return;
    if (!result || !Array.isArray(result.entries) || typeof result.complete !== "boolean" ||
        result.entries.some(entry => !entry || !positiveId(entry.userId))) return unavailable;

    const { complete } = result;
    const entries: readonly PendingFriendRequest[] = result.entries;
    if (!entries.length) {
      return complete ? $t("friend-request-list.text_a97550976a") : $t("friend-request-list.text_263504d056");
    }
    const shown = entries.slice(0, maxShown);
    const heading = complete ? $t("friend-request-list.text_261d1eb9bd", { "length": entries.length }) :
      $t("friend-request-list.text_3bdc06c4ce", { "length": entries.length });
    const summary = [
      heading,
      ...(shown.length < entries.length ? [$t("friend-request-list.text_8259da8992", { "length": shown.length })] : []),
    ];
    const nodes = shown.map(({ userId, nickname, source, time, comment, risk }): Part[] => [
      { type: "image", file: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}` },
      $t("friend-request-list.text_06fe686be4", { "userId": userId, "value2": displayRequestField(nickname, 128) || $t("friend-request-list.text_4d8c1c5b42") }) +
      $t("friend-request-list.text_44d7227b76", { "value1": displayRequestField(source, 256) || $t("friend-request-list.text_4d8c1c5b42"), "value2": requestTime(time) }) +
      $t("friend-request-list.text_8b328b830a", { "value1": displayRequestField(comment, 512) || $t("friend-request-list.text_d67cd0210e") }) +
      (risk === true ? $t("friend-request-list.text_fabdfd3ca1") : risk === false ? $t("friend-request-list.text_e9141ace8b") : ""),
    ]);
    return { type: "forward", nodes: [summary, ...nodes] };
  } catch {
    return signal?.aborted ? undefined : unavailable;
  }
}
