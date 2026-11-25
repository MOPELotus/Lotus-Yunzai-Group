import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
type CardResult = "confirmed" | "rejected" | "unknown" | "missing-group" | "insufficient-role";

export interface CardEvent {
  readonly msg: string;
  readonly message_type: "group" | "private" | "terminal";
  readonly message: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly self_id?: number;
  readonly isMaster: boolean;
  readonly setGroupCard?: (card: string, groupId?: number, userId?: number) => Promise<CardResult>;
}

const command = "#改群名片";
const resultMessages: Readonly<Record<CardResult, string>> = {
  confirmed: $t("group-card.text_8ec38fa9f5"),
  rejected: $t("group-card.text_47682ae0cd"),
  unknown: $t("group-card.text_82c5205230"),
  "missing-group": $t("group-card.text_d76007fb01"),
  "insufficient-role": $t("group-card.text_2b79b928ee"),
};

function qq(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

export async function changeGroupCard(event: CardEvent): Promise<string> {
  if (!event.isMaster) return $t("group-card.text_d46f6afc9a");
  const { message_type: room, setGroupCard } = event;
  if (room === "terminal" || !setGroupCard) return $t("group-card.text_24090ffb17");

  const argument = event.msg.slice(command.length).trim();
  let card = argument;
  let groupId: number | undefined;
  let userId: number | undefined;
  const mentions = typeof event.message === "string" ? [] : event.message.filter(({ type }) => type === "at");
  if (room === "group") {
    for (const { qq: value } of mentions) {
      const target = qq(value);
      if (!target) return $t("group-card.text_4c568a4cdb");
      if (target === event.self_id) continue;
      if (userId !== undefined && userId !== target) return $t("group-card.text_4c568a4cdb");
      userId = target;
    }
  } else {
    if (mentions.length) return $t("group-card.text_0219f8cf2e");
    if (!argument) return $t("group-card.text_05551f1fa4");
    const match = /^([1-9]\d*)(?:\s+([\s\S]*))?$/u.exec(argument);
    groupId = qq(match?.[1]);
    if (!groupId) return $t("group-card.text_2fb35621ad");
    card = match?.[2] ?? "";
  }

  try {
    return resultMessages[await setGroupCard(card, groupId, userId)] ?? resultMessages.unknown;
  } catch {
    return resultMessages.unknown;
  }
}
