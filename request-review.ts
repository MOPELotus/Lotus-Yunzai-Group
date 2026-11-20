import { createHash, randomBytes } from "node:crypto";

export type GroupRequestKind = "add" | "invite";
type GroupRequestScope = "milky";

export interface GroupRequestEvent {
  readonly self_id: number;
  readonly user_id: number;
  readonly inviter_id?: number;
  readonly group_id: number;
  readonly groupRequestScope?: GroupRequestScope;
  readonly sub_type: GroupRequestKind;
  readonly flag: string;
  readonly comment?: string;
  readonly notifyRequestOwners?: (message: string) => Promise<number>;
  readonly notifyMasters?: (message: string) => Promise<number>;
}

interface CommandContext {
  readonly message_type: "private" | "group" | "terminal";
  readonly isMaster: boolean;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly groupRequestScope?: GroupRequestScope;
  readonly canReviewGroupRequests?: boolean;
  readonly reviewGroupRequest?: (flag: string, subType: GroupRequestKind, approve: boolean, reason?: string) => Promise<boolean>;
}

interface PendingRequest {
  readonly botId: number;
  readonly applicant: number;
  readonly inviter?: number;
  readonly scope?: GroupRequestScope;
  readonly groupId: number;
  readonly kind: GroupRequestKind;
  readonly flag: string;
  readonly comment: string;
  readonly eventKey: string;
  reviewing: boolean;
}

const pageSize = 10;
const maxPending = 1024;
const maxCompleted = 1024;

function isId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function authorised(context: CommandContext): context is CommandContext & { readonly self_id: number } {
  if (context.message_type !== "private" || !isId(context.self_id) || !isId(context.user_id)) return false;
  if (context.groupRequestScope === "milky") return context.canReviewGroupRequests === true;
  return context.groupRequestScope === undefined && context.isMaster === true;
}

function preview(text: string | undefined): string {
  if (typeof text !== "string") return "";
  const line = text.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
  const chars = [...line];
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}…` : line;
}

function describe(id: string, request: PendingRequest): string {
  const kind = request.kind === "invite" ? "邀请机器人加入群聊" : "成员申请入群";
  const user = request.kind === "invite" ? "邀请者" : "申请人";
  return `${id} · ${kind} · 群 ${request.groupId} · ${user} ${request.applicant}` +
    (request.inviter === undefined ? "" : ` · 邀请者 ${request.inviter}`) +
    (request.comment ? `\n附言：${request.comment}` : "");
}

function belongsTo(request: PendingRequest, context: CommandContext): boolean {
  return request.botId === context.self_id && request.scope === context.groupRequestScope;
}

function requestKey(scope: GroupRequestScope | undefined, bot: number, kind: GroupRequestKind, flag: string): string {
  return createHash("sha256").update(JSON.stringify([scope, bot, kind, flag])).digest("hex");
}

export function createGroupRequestReview() {
  const pending = new Map<string, PendingRequest>();
  const known = new Set<string>();
  const completed = new Set<string>();

  function rememberCompleted(key: string) {
    known.delete(key);
    completed.add(key);
    if (completed.size > maxCompleted) completed.delete(completed.values().next().value!);
  }

  function completeMilkyInvitation(botId: number, flag: string) {
    if (!isId(botId) || typeof flag !== "string" || !flag) return;
    const key = requestKey("milky", botId, "invite", flag);
    for (const [id, request] of pending) {
      if (request.eventKey === key) {
        pending.delete(id);
        break;
      }
    }
    rememberCompleted(key);
  }

  async function receive(event: GroupRequestEvent): Promise<void> {
    const { self_id, user_id, inviter_id, group_id, groupRequestScope, sub_type, flag } = event;
    if (!isId(self_id) || !isId(user_id) || !isId(group_id) || self_id === user_id ||
        (sub_type !== "add" && sub_type !== "invite") || typeof flag !== "string" || !flag ||
        (groupRequestScope !== undefined && groupRequestScope !== "milky") ||
        pending.size >= maxPending) return;
    const eventKey = requestKey(groupRequestScope, self_id, sub_type, flag);
    if (known.has(eventKey) || completed.has(eventKey)) return;

    let id;
    do {
      id = randomBytes(6).toString("hex");
    } while (pending.has(id));
    const request: PendingRequest = {
      botId: self_id, applicant: user_id, inviter: sub_type === "add" && isId(inviter_id) ? inviter_id : undefined,
      scope: groupRequestScope, groupId: group_id, kind: sub_type,
      flag, comment: preview(event.comment), eventKey, reviewing: false,
    };
    known.add(eventKey);
    pending.set(id, request);

    try {
      const notify = event.notifyRequestOwners ?? event.notifyMasters;
      const quoted = event.notifyRequestOwners && groupRequestScope === "milky" && sub_type === "invite";
      await notify?.(
        `【待审核群请求】\n${describe(id, request)}\n#同意入群 ${id}\n#拒绝入群 ${id} [原因]` +
          (quoted ? "\n也可引用此通知回复「同意」或「拒绝」。" : ""),
      );
    } catch {
      // The owner can still review a request whose notification was not delivered.
    }
  }

  function list(argument: string, context: CommandContext): string {
    if (!authorised(context)) return "请由当前机器人的主人私聊处理群请求。";
    const page = argument ? Number(argument) : 1;
    if (!Number.isSafeInteger(page) || page < 1) return "用法：#入群申请 [页码]";

    const queue = [...pending.entries()].filter(([, request]) => belongsTo(request, context)).reverse();
    if (!queue.length) return "当前没有待审核的群请求。";
    const pages = Math.ceil(queue.length / pageSize);
    if (page > pages) return `待审核群请求共有 ${pages} 页。`;
    return [`【待审核群请求】第 ${page}/${pages} 页`,
      ...queue.slice((page - 1) * pageSize, page * pageSize).map(([id, request]) => describe(id, request)),
      "发送 #同意入群 <编号> 或 #拒绝入群 <编号> [原因]。",
    ].join("\n\n");
  }

  async function review(argument: string, context: CommandContext, allow: boolean): Promise<string> {
    if (!authorised(context)) return "请由当前机器人的主人私聊处理群请求。";

    const [input = "", ...rest] = argument.trim().split(/\s+/u);
    const id = input.toLowerCase();
    if (!/^[a-f0-9]{12}$/u.test(id) || (allow && rest.length)) {
      return allow ? "用法：#同意入群 <编号>" : "用法：#拒绝入群 <编号> [原因]";
    }
    const request = pending.get(id);
    if (!request || !belongsTo(request, context)) return "未找到当前机器人的待审核群请求。";
    if (!context.reviewGroupRequest) return "当前协议端不支持审核群请求。";
    if (request.reviewing) return "这个群请求正在处理。";

    request.reviewing = true;
    try {
      if (await context.reviewGroupRequest(request.flag, request.kind, allow, rest.join(" ") || undefined) !== true) {
        return "协议端没有接受这次操作，群请求仍待审核。";
      }
      pending.delete(id);
      rememberCompleted(request.eventKey);
      return allow ? "已同意群请求。" : "已拒绝群请求。";
    } catch {
      return "群请求处理结果未确认。请先在 QQ 核对，再决定是否重试。";
    } finally {
      request.reviewing = false;
    }
  }

  return {
    receive,
    completeMilkyInvitation,
    commands: {
      "#入群申请": list,
      "#同意入群": (argument: string, context: CommandContext) => review(argument, context, true),
      "#拒绝入群": (argument: string, context: CommandContext) => review(argument, context, false),
    },
  };
}

export const groupRequestReview = createGroupRequestReview();
