import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
  readonly notifyInvitationRequestOwners?: (ordinaryMessage: string, actions: string) => Promise<number>;
  readonly notifyJoinRequestOwners?: (ordinaryMessage: string, actions: string) => Promise<number>;
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
  const kind = request.kind === "invite" ? $t("request-review.text_6d066daa0e") : $t("request-review.text_fb68301598");
  const user = request.kind === "invite" ? $t("request-review.text_a8292dcedc") : $t("request-review.text_0a2a5c33dd");
  return $t("request-review.text_afb4585d55", { "id": id, "kind": kind, "groupId": request.groupId, "user": user, "applicant": request.applicant }) +
    (request.inviter === undefined ? "" : $t("request-review.text_83ab0a608a", { "inviter": request.inviter })) +
    (request.comment ? $t("request-review.text_90b918255e", { "comment": request.comment }) : "");
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

  function completeInvitation(botId: number, flag: string, adapter: "milky" | "onebot" = "milky") {
    if (!isId(botId) || typeof flag !== "string" || !flag) return;
    const key = requestKey(adapter === "milky" ? "milky" : undefined, botId, "invite", flag);
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
      const quoted = event.notifyRequestOwners && groupRequestScope === "milky" && sub_type === "invite";
      const actions = $t("request-review.text_2a08d3e7f5", { "id": id, "value2": id }) +
        (quoted ? $t("request-review.text_4bd09e36eb") : "");
      const ordinaryMessage = $t("request-review.text_0d41259f66", { "value1": describe(id, request), "actions": actions });
      const notifyOwners = sub_type === "add" ? event.notifyJoinRequestOwners : event.notifyInvitationRequestOwners;
      if (notifyOwners) {
        await notifyOwners(ordinaryMessage, actions);
      } else {
        const notify = event.notifyRequestOwners ?? event.notifyMasters;
        await notify?.(ordinaryMessage);
      }
    } catch {
      // The owner can still review a request whose notification was not delivered.
    }
  }

  function list(argument: string, context: CommandContext): string {
    if (!authorised(context)) return $t("request-review.text_e07bb7e32e");
    const page = argument ? Number(argument) : 1;
    if (!Number.isSafeInteger(page) || page < 1) return $t("request-review.text_f2dd0eab36");

    const queue = [...pending.entries()].filter(([, request]) => belongsTo(request, context)).reverse();
    if (!queue.length) return $t("request-review.text_cb3a88ff02");
    const pages = Math.ceil(queue.length / pageSize);
    if (page > pages) return $t("request-review.text_ecac8180a9", { "pages": pages });
    return [$t("request-review.text_efccdc5fef", { "page": page, "pages": pages }),
      ...queue.slice((page - 1) * pageSize, page * pageSize).map(([id, request]) => describe(id, request)),
      $t("request-review.text_ff7233a90a"),
    ].join("\n\n");
  }

  async function review(argument: string, context: CommandContext, allow: boolean): Promise<string> {
    if (!authorised(context)) return $t("request-review.text_e07bb7e32e");

    const [input = "", ...rest] = argument.trim().split(/\s+/u);
    const id = input.toLowerCase();
    if (!/^[a-f0-9]{12}$/u.test(id) || (allow && rest.length)) {
      return allow ? $t("request-review.text_a358632b8f") : $t("request-review.text_7635bf24a4");
    }
    const request = pending.get(id);
    if (!request || !belongsTo(request, context)) return $t("request-review.text_bd86fc28b4");
    if (!context.reviewGroupRequest) return $t("request-review.text_95d3c03027");
    if (request.reviewing) return $t("request-review.text_de89a5b7d9");

    request.reviewing = true;
    try {
      if (await context.reviewGroupRequest(request.flag, request.kind, allow, rest.join(" ") || undefined) !== true) {
        return $t("request-review.text_0bc07b8c10");
      }
      pending.delete(id);
      rememberCompleted(request.eventKey);
      return allow ? $t("request-review.text_7bd74daa9a") : $t("request-review.text_90acc5dee7");
    } catch {
      return $t("request-review.text_6cf1c3cd12");
    } finally {
      request.reviewing = false;
    }
  }

  return {
    receive,
    completeInvitation,
    commands: {
      "#入群申请": list,
      "#同意入群": (argument: string, context: CommandContext) => review(argument, context, true),
      "#拒绝入群": (argument: string, context: CommandContext) => review(argument, context, false),
    },
  };
}

export const groupRequestReview = createGroupRequestReview();
