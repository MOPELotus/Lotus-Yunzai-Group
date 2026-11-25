import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
export const groupNameFeature = "[group] 修改群名称";

type GroupNameResult = "confirmed" | "rejected" | "unknown" | "unavailable";

export interface GroupNameContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly isDelegated?: boolean;
  readonly setGroupName?: (name: string, groupId?: number) => Promise<GroupNameResult>;
}

const commandPattern = /^#改群(?:昵称?|名(?!片)(?:称|字(?=\s|$))?)/u;

export function isGroupNameCommand(command: string, context: Pick<GroupNameContext, "message_type">) {
  return context.message_type !== "terminal" && commandPattern.test(command);
}

export async function changeGroupName(command: string, context: GroupNameContext) {
  if (context.isDelegated || (context.message_type === "private" && !context.setGroupName)) return;
  let name = command.replace(commandPattern, "").trim();
  let groupId: number | undefined;
  if (context.message_type === "private") {
    const input = /^([1-9]\d*)(?:\s+([\s\S]*))?$/u.exec(name);
    if (!input) return $t("group-name.text_60a5e102d8");
    groupId = Number(input[1]);
    if (!Number.isSafeInteger(groupId)) return $t("group-name.text_60a5e102d8");
    name = input[2]?.trim() ?? "";
  }
  if (!name) return $t("group-name.text_e26f7ceff2");
  if (!context.setGroupName) return $t("group-name.text_4e2ac318eb");
  const result = await context.setGroupName(name, groupId);
  switch (result) {
    case "confirmed": return $t("group-name.text_b6e6e2ad8c");
    case "rejected": return $t("group-name.text_9d0fb4eed4");
    case "unavailable": return $t("group-name.text_92154e412a");
    case "unknown": return $t("group-name.text_349b8a932e");
  }
}
