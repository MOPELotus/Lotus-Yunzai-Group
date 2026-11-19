type CardResult = "confirmed" | "rejected" | "unknown" | "missing-group" | "insufficient-role";

interface CardEvent {
  readonly msg: string;
  readonly message_type: "group" | "private" | "terminal";
  readonly message: string | readonly { readonly type: string; readonly qq?: unknown }[];
  readonly self_id?: number;
  readonly isMaster: boolean;
  readonly setGroupCard?: (card: string, groupId?: number, userId?: number) => Promise<CardResult>;
}

const command = "#改群名片";
const resultMessages: Readonly<Record<CardResult, string>> = {
  confirmed: "✅ 群名片修改成功",
  rejected: "❎ 群名片修改失败",
  unknown: "群名片修改结果未确认，请在群聊中核对。",
  "missing-group": "❎ 群聊列表查无此群",
  "insufficient-role": "❎ Bot权限不足，需要管理员权限",
};

function qq(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

export async function changeGroupCard(event: CardEvent): Promise<string> {
  if (!event.isMaster) return "❎ 该命令仅限主人可用";
  const { message_type: room, setGroupCard } = event;
  if (room === "terminal" || !setGroupCard) return "当前会话不支持修改群名片。";

  const argument = event.msg.slice(command.length).trim();
  let card = argument;
  let groupId: number | undefined;
  let userId: number | undefined;
  const mentions = typeof event.message === "string" ? [] : event.message.filter(({ type }) => type === "at");
  if (room === "group") {
    for (const { qq: value } of mentions) {
      const target = qq(value);
      if (!target) return "请只 @ 一位要修改群名片的成员。";
      if (target === event.self_id) continue;
      if (userId !== undefined && userId !== target) return "请只 @ 一位要修改群名片的成员。";
      userId = target;
    }
  } else {
    if (mentions.length) return "私聊仅能修改机器人的群名片。";
    if (!argument) return "❎ 群号不能为空";
    const match = /^([1-9]\d*)(?:\s+([\s\S]*))?$/u.exec(argument);
    groupId = qq(match?.[1]);
    if (!groupId) return "❎ 群号不合法";
    card = match?.[2] ?? "";
  }

  try {
    return resultMessages[await setGroupCard(card, groupId, userId)] ?? resultMessages.unknown;
  } catch {
    return resultMessages.unknown;
  }
}
