import { expect, test } from "bun:test";
import { createGroupInvitationReview, isGroupInvitationReviewCommand, type GroupInvitationReviewContext,
  type PendingGroupInvitationReviewResult } from "./group-invitation-review.ts";

import { createGroupRequestReview, type GroupRequestEvent } from "./request-review.ts";

const owner = {
  message_type: "private", adapter: "milky", self_id: 99, user_id: 42, message_id: 1, isBotMaster: (id: number) => id === 42,
} satisfies GroupInvitationReviewContext;
const command = "#同意群邀请77";

test("原群邀请单条按明确的紧连群号审核，确认后才回复已处理", async () => {
  const handle = createGroupInvitationReview();
  const calls: [number, boolean][] = [];
  const scope: GroupInvitationReviewContext = { ...owner, async reviewPendingGroupInvitation(group, approve) {
    calls.push([group, approve]);
    return { status: "confirmed" };
  } };
  for (const input of [command, "拒绝群邀请88"]) expect(isGroupInvitationReviewCommand(input)).toBe(true);
  for (const input of ["#同意", "拒绝", "#拒绝全部群邀请", "#同意群邀请 77", "#同意群邀请", "#同意群邀请@77",
    "#同意群邀请77 88", "#同意加群申请77", "#查看群邀请"]) {
    expect(isGroupInvitationReviewCommand(input)).toBe(false);
    expect(await handle(input, scope)).toBeUndefined();
  }
  expect(await handle("#同意群邀请0", scope)).toContain("填写有效");
  expect(await handle("#同意群邀请9007199254740993", scope)).toContain("填写有效");
  expect(await handle(command, scope)).toBe("✅ 已同意群 77 的邀请");
  expect(await handle("拒绝群邀请88", { ...scope, message_id: 2 })).toBe("✅ 已拒绝群 88 的邀请");
  expect(calls).toEqual([[77, true], [88, false]]);
});

test("非主人、缺少可信私聊能力与委托均不能写", async () => {
  const handle = createGroupInvitationReview();
  let calls = 0;
  const scope: GroupInvitationReviewContext = { ...owner, async reviewPendingGroupInvitation() {
    calls++;
    return { status: "confirmed" };
  } };
  expect(await handle(command, { ...scope, message_type: "group" })).toBeUndefined();
  expect(await handle(command, { ...scope, message_type: "terminal" })).toBeUndefined();
  expect(await handle(command, { ...scope, isDelegated: true })).toBeUndefined();
  expect(await handle(command, { ...scope, isBotMaster: () => false })).toContain("请由当前机器人的主人");
  expect(await handle(command, { ...scope, adapter: undefined, reviewPendingGroupInvitation: undefined })).toContain("请在 QQ 中处理");
  expect(await handle(command, { ...scope, message_id: undefined })).toContain("请在 QQ 中处理");
  expect(await createGroupInvitationReview(AbortSignal.abort())(command, scope)).toBeUndefined();
  expect(calls).toBe(0);
});

test("拒绝、未知、有限窗未找到和歧义分别提示，失败不冒充成功", async () => {
  for (const [status, expected] of [
    ["rejected", "协议端拒绝"], ["unknown", "处理结果未确认，请先在 QQ 中核对"], ["unavailable", "无法按群号核实"],
    ["not-found", "本次查询范围内未找到"], ["ambiguous", "多条待处理"],
  ] as const) {
    const handle = createGroupInvitationReview();
    const response = await handle(command, { ...owner, reviewPendingGroupInvitation: async () => ({ status }) });
    expect(response).toContain(expected);
    expect(response).not.toContain("已同意");
    expect(response).not.toContain("重试");
  }
});

test("同一原消息在途和未知均不重复提交，账号与协议独立", async () => {
  const handle = createGroupInvitationReview();
  let calls = 0;
  let finish!: (result: PendingGroupInvitationReviewResult) => void;
  const pending = new Promise<PendingGroupInvitationReviewResult>((resolve) => { finish = resolve; });
  const scope: GroupInvitationReviewContext = { ...owner, reviewPendingGroupInvitation() { calls++; return pending; } };
  const first = handle(command, scope);
  expect(await handle("拒绝群邀请77", scope)).toEqual([]);
  finish({ status: "unknown" });
  expect(await first).toContain("结果未确认");
  expect(await handle(command, scope)).toEqual([]);
  expect(await handle(command, { ...scope, adapter: undefined })).toContain("结果未确认");
  expect(await handle(command, { ...scope, self_id: 98 })).toContain("结果未确认");
  expect(calls).toBe(3);
});

test("按群号审核确认后只摘除当前 Milky 账号的真实邀请，已完成重放不会复活", async () => {
  const queue = createGroupRequestReview();
  const handle = createGroupInvitationReview(undefined, queue.completeMilkyInvitation);
  const event: GroupRequestEvent = { self_id: 99, user_id: 51, group_id: 77, groupRequestScope: "milky", sub_type: "invite", flag: "exact-opaque" };
  const scope = { ...owner, isMaster: true, groupRequestScope: "milky", canReviewGroupRequests: true } as const;
  const list = () => queue.commands["#入群申请"]("", scope);

  await queue.receive(event);
  await queue.receive({ ...event, flag: "other-opaque", user_id: 52 });
  await queue.receive({ ...event, sub_type: "add", user_id: 53 });
  await queue.receive({ ...event, self_id: 98, user_id: 54 });
  await queue.receive({ ...event, groupRequestScope: undefined, user_id: 55 });
  expect(list()).toContain("邀请者 51");

  expect(await handle("#拒绝群邀请77", { ...owner, reviewPendingGroupInvitation: async () => ({
    status: "confirmed", resolvedFlag: "exact-opaque",
  }) })).toBe("✅ 已拒绝群 77 的邀请");
  expect(list()).not.toContain("邀请者 51");
  expect(list()).not.toContain("exact-opaque");
  expect(list()).toContain("邀请者 52");
  expect(list()).toContain("申请人 53");
  expect(queue.commands["#入群申请"]("", { ...scope, self_id: 98 })).toContain("邀请者 54");
  expect(queue.commands["#入群申请"]("", { ...scope, groupRequestScope: undefined })).toContain("邀请者 55");

  await queue.receive(event);
  expect(list()).not.toContain("邀请者 51");
});

test("已确认的延后邀请不入队，非 Milky 或未知和失败不清现有队列", async () => {
  const queue = createGroupRequestReview();
  const handle = createGroupInvitationReview(undefined, queue.completeMilkyInvitation);
  const event: GroupRequestEvent = { self_id: 99, user_id: 51, group_id: 77, groupRequestScope: "milky", sub_type: "invite", flag: "exact-opaque" };
  const scope = { ...owner, isMaster: true, groupRequestScope: "milky", canReviewGroupRequests: true } as const;
  const list = () => queue.commands["#入群申请"]("", scope);

  await queue.receive(event);
  for (const [adapter, status, message_id] of [
    ["milky", "unknown", 1], ["milky", "rejected", 2], [undefined, "confirmed", 3],
  ] as const) {
    await handle(command, { ...owner, adapter, message_id, reviewPendingGroupInvitation: async () => ({
      status, resolvedFlag: "exact-opaque",
    }) });
    expect(list()).toContain("邀请者 51");
  }

  await handle(command, { ...owner, message_id: 4, reviewPendingGroupInvitation: async () => ({
    status: "confirmed", resolvedFlag: "late-opaque",
  }) });
  await queue.receive({ ...event, flag: "late-opaque", user_id: 52 });
  expect(list()).not.toContain("邀请者 52");
  expect(list()).toContain("邀请者 51");
});
