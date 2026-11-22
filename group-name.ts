export const groupNameFeature = "[group] 修改群名称";

type GroupNameResult = "confirmed" | "rejected" | "unknown" | "unavailable";

export interface GroupNameContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly isDelegated?: boolean;
  readonly setGroupName?: (name: string, groupId?: number) => Promise<GroupNameResult>;
}

const commandPattern = /^#改群(?:昵称?|名称?|名(?!片))/u;

export function isGroupNameCommand(command: string, context: Pick<GroupNameContext, "message_type">) {
  return context.message_type !== "terminal" && commandPattern.test(command);
}

export async function changeGroupName(command: string, context: GroupNameContext) {
  if (context.isDelegated || (context.message_type === "private" && !context.setGroupName)) return;
  let name = command.replace(commandPattern, "").trim();
  let groupId: number | undefined;
  if (context.message_type === "private") {
    const input = /^([1-9]\d*)(?:\s+([\s\S]*))?$/u.exec(name);
    if (!input) return "请输入有效群号和群名称。";
    groupId = Number(input[1]);
    if (!Number.isSafeInteger(groupId)) return "请输入有效群号和群名称。";
    name = input[2]?.trim() ?? "";
  }
  if (!name) return "群名称不能为空。";
  if (!context.setGroupName) return "当前会话无法修改群名称。";
  const result = await context.setGroupName(name, groupId);
  switch (result) {
    case "confirmed": return "✅ 群昵称修改成功";
    case "rejected": return "❎ 群昵称修改失败";
    case "unavailable": return "当前账号或操作者没有修改该群名称的权限。";
    case "unknown": return "群名称修改结果未确认，请先查看群信息。";
  }
}
