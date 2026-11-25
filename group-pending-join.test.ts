import { expect, test } from "bun:test";
import { createGroupPendingJoinReview, groupPendingJoinCommand, isGroupPendingJoinCommand, isGroupPendingJoinReviewCommand,
  type GroupPendingJoinContext, type PendingGroupJoinBatchResult, type PendingGroupJoinReviewResult, type PendingGroupJoins } from "./group-pending-join.ts";

const current = { message_type: "group", self_id: 99, group_id: 77, user_id: 42 } satisfies GroupPendingJoinContext;
const command = "#查看加群申请";

function query(result: PendingGroupJoins | undefined) {
  return groupPendingJoinCommand(command, { ...current, groupListPendingJoinRequests: async () => result });
}

test("群内普通成员的旧列表入口与同名直接审核、总览保持独立", async () => {
  for (const input of ["#查看加群申请", "#查看入群申请", "查看群申请", "查看全部加群申请"]) {
    expect(isGroupPendingJoinCommand(input)).toBe(true);
  }
  for (const input of ["同意加群申请510", "#拒绝全部加群申请", "#查看全部请求", "#查看好友申请", "#查看群申请510"]) {
    expect(isGroupPendingJoinCommand(input)).toBe(false);
  }

  const reply = await query({ complete: true, entries: [
    { userId: 510, nickname: "申请人", comment: "你好群友", tip: "来自群名片" },
    { userId: 511, nickname: "风险\n\u202e账号", comment: "附言", risk: true },
    { userId: 510 },
  ] });
  expect(reply).toEqual({ type: "forward", nodes: [
    ["现有未处理的加群申请如下，共 3 条"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=510" }, "\nQQ：510\n昵称：申请人\nTips：来自群名片\n附加信息：你好群友"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=511" }, "\nQQ：511\n昵称：风险 账号\n风险申请，请在 QQ 中处理。\n附加信息：附言"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=510" }, "\nQQ：510\n昵称：未知\n附加信息：无附加信息"],
  ] });
});

test("只区分完整空快照、部分空快照和未核验的网关回执", async () => {
  expect(await query({ complete: true, entries: [] })).toContain("暂无加群申请");
  expect(await query({ complete: false, entries: [] })).toContain("未能核验完整列表");
  expect(await query(undefined)).toContain("当前无法核验");
  expect(await query({ complete: true, entries: [{ userId: Number.NaN }] })).toContain("当前无法核验");
  expect(await query({ complete: false, entries: [{ userId: 510 }] })).toMatchObject({
    type: "forward", nodes: [["本次查到 1 条待处理加群申请，未能核验完整列表"], expect.any(Array)],
  });
});

test("超长列表和附言有展示上限，不下发协议内部字段或旧审核指令", async () => {
  const reply = await query({ complete: true, entries: Array.from({ length: 55 }, (_, index) => ({
    userId: 1000 + index, nickname: "申请", comment: "测".repeat(600), flag: "opaque-id", notificationSeq: "secret-seq",
  })) });
  if (typeof reply !== "object") throw new Error("预期合并转发");
  expect(reply.nodes).toHaveLength(51);
  expect(reply.nodes[0]?.join("")).toContain("仅展示前 50 条");
  expect(reply.nodes[1]?.[1]).toContain("…");
  const rendered = JSON.stringify(reply);
  for (const internal of ["opaque-id", "secret-seq", "同意加群申请", "拒绝全部"]) expect(rendered).not.toContain(internal);
});

test("不从私聊、委托、无会话或卸载期间读取和展示同群请求", async () => {
  let called = 0;
  const scope = { ...current, groupListPendingJoinRequests: async () => { called++; return { entries: [], complete: true }; } };
  expect(await groupPendingJoinCommand(command, { ...scope, message_type: "private" })).toBeUndefined();
  expect(await groupPendingJoinCommand(command, { ...scope, isDelegated: true })).toContain("当前无法核验");
  expect(await groupPendingJoinCommand(command, { ...scope, group_id: undefined })).toContain("当前无法核验");
  expect(await groupPendingJoinCommand(command, { ...scope, groupListPendingJoinRequests: undefined })).toContain("当前无法核验");
  const controller = new AbortController();
  controller.abort();
  expect(await groupPendingJoinCommand(command, scope, controller.signal)).toContain("当前无法核验");
  expect(called).toBe(0);
  const live = new AbortController();
  expect(await groupPendingJoinCommand(command, { ...scope, groupListPendingJoinRequests: async () => {
    live.abort(); return { complete: true, entries: [{ userId: 510 }] };
  } }, live.signal)).toBeUndefined();
});

test("旧按 QQ 审核保持同群真消息和单个安全 QQ，清晰回执确认的人", async () => {
  const handle = createGroupPendingJoinReview();
  const calls: [number, boolean][] = [];
  const scope: GroupPendingJoinContext = { ...current, message_id: 1, adapter: "milky",
    async groupReviewPendingJoin(qq, approve) {
      calls.push([qq, approve]);
      return { status: "confirmed", nickname: "花\n\u202e名" };
    } };
  for (const input of ["#同意加群申请510", "拒绝入群申请510", "#同意群申请511"]) {
    expect(isGroupPendingJoinReviewCommand(input)).toBe(true);
  }
  for (const input of ["#同意", "#拒绝入群 10", "#同意加群申请", "#拒绝好友申请510",
    "#同意加群申请@510", "#拒绝群申请510 511"]) {
    expect(isGroupPendingJoinReviewCommand(input)).toBe(false);
    expect(await handle(input, scope)).toBeUndefined();
  }
  expect(await handle("#同意加群申请510", { ...scope, message_type: "private" })).toBeUndefined();
  expect(await handle("#同意加群申请510", { ...scope, isDelegated: true })).toBeUndefined();
  expect(await handle("#同意加群申请510", { ...scope, message_id: undefined })).toContain("请引用原加群通知");
  expect(await handle("#同意加群申请510", { ...scope, group_id: undefined })).toContain("请引用原加群通知");
  expect(await handle("#同意加群申请0", scope)).toContain("有效的申请人 QQ 号");
  expect(await handle("#同意加群申请9007199254740993", scope)).toContain("有效的申请人 QQ 号");
  expect(await handle("#同意加群申请510", scope)).toContain("已同意花 名(510)");
  expect(await handle("拒绝入群申请511", { ...scope, message_id: 2 })).toContain("已拒绝花 名(511)");
  expect(calls).toEqual([[510, true], [511, false]]);
});

test("审核按真实拒绝、未知、身份歧义、风险和过期分别处理", async () => {
  for (const [status, expected] of [
    ["rejected", "协议端拒绝"], ["unknown", "结果未确认"], ["unavailable", "请引用原加群通知"],
    ["not-found", "未找到该用户的加群申请"], ["ambiguous", "多条待处理"], ["risk", "风险账号"], ["expired", "已过期或已处理"],
  ] as const) {
    const handle = createGroupPendingJoinReview();
    const result = await handle("#拒绝入群申请510", { ...current, message_id: 1,
      groupReviewPendingJoin: async () => ({ status, nickname: "无需展示" }) });
    expect(result).toContain(expected);
    expect(result).not.toContain("已拒绝");
    expect(result).not.toContain("无需展示");
  }
});

test("原消息并发和回执未知不重复提交，同号不同群或协议各自独立", async () => {
  const handle = createGroupPendingJoinReview();
  const command = "#同意群申请510";
  let resolve!: (value: PendingGroupJoinReviewResult) => void;
  const pending = new Promise<PendingGroupJoinReviewResult>((settle) => { resolve = settle; });
  let calls = 0;
  const scope: GroupPendingJoinContext = { ...current, message_id: -10, groupReviewPendingJoin() { calls++; return pending; } };
  const first = handle(command, scope);
  expect(await handle(command, { ...scope, adapter: "onebot" })).toEqual([]);
  resolve({ status: "unknown" });
  expect(await first).toContain("结果未确认");
  expect(await handle(command, scope)).toEqual([]);
  expect(await handle(command, { ...scope, adapter: "milky" })).toContain("结果未确认");
  expect(await handle(command, { ...scope, group_id: 88 })).toContain("结果未确认");
  expect(calls).toBe(3);

  const controller = new AbortController();
  controller.abort();
  expect(await createGroupPendingJoinReview(controller.signal)(command, scope)).toBeUndefined();
  expect(calls).toBe(3);
});

test("原批量审核汇总逐条回执，同 QQ 两条分别计数", async () => {
  const handle = createGroupPendingJoinReview();
  const calls: boolean[] = [];
  const context: GroupPendingJoinContext = { ...current, message_id: 1, adapter: "milky",
    async groupReviewAllPendingJoins(approve) {
      calls.push(approve);
      return { status: "processed", entries: [
        { userId: 510, status: "confirmed" }, { userId: 510, status: "rejected" }, { userId: 511, status: "confirmed" },
        { userId: 512, status: "risk" }, { userId: 513, status: "unknown" }, { userId: 514, status: "unavailable" },
        { userId: 515, status: "expired" },
      ] };
    },
  };
  expect(await handle("#同意全部加群申请", context)).toEqual({
    type: "forward", nodes: [
      ["本次共核对 7 条加群申请\n已同意：2 条\n失败：1 条\n风险：1 条\n结果未知：1 条\n未处理：2 条"],
      ["已同意名单\n1、510\n2、511"], ["失败名单\n1、510"], ["风险名单\n1、512"],
      ["结果未知名单\n1、513"], ["未处理名单\n1、514\n2、515（已过期或已处理）"],
    ],
  });
  expect(await handle("拒绝全部入群申请", { ...context, message_id: 2 })).toMatchObject({ type: "forward" });
  expect(isGroupPendingJoinReviewCommand("#拒绝全部群申请")).toBe(true);
  expect(await handle("#拒绝全部群申请", { ...context, message_id: 3 })).toMatchObject({ type: "forward" });
  expect(calls).toEqual([true, false, false]);
  for (const input of ["#同意全部加群申请510", "#同意全部好友申请"]) {
    expect(isGroupPendingJoinReviewCommand(input)).toBe(false);
    expect(await handle(input, context)).toBeUndefined();
  }
});

test("批量审核同单条共享原消息屏障，不越群且未知永不重复提交", async () => {
  const handle = createGroupPendingJoinReview();
  let resolve!: (value: PendingGroupJoinBatchResult) => void;
  const pending = new Promise<PendingGroupJoinBatchResult>((settle) => { resolve = settle; });
  let batchCalls = 0;
  let singleCalls = 0;
  const context: GroupPendingJoinContext = { ...current, message_id: 1, adapter: "milky",
    groupReviewAllPendingJoins() { batchCalls++; return pending; },
    async groupReviewPendingJoin() { singleCalls++; return { status: "confirmed" }; },
  };
  const command = "#同意全部加群申请";
  expect(await handle(command, { ...context, message_type: "private" })).toBeUndefined();
  expect(await handle(command, { ...context, isDelegated: true })).toBeUndefined();
  expect(await handle(command, { ...context, group_id: undefined })).toContain("无法核验本群的完整待审列表");
  expect(await handle(command, { ...context, groupReviewAllPendingJoins: undefined })).toContain("请引用原加群通知");
  expect(batchCalls).toBe(0);
  const first = handle(command, context);
  expect(await handle(command, context)).toEqual([]);
  expect(await handle("#同意加群申请510", context)).toEqual([]);
  resolve({ status: "processed", entries: [] });
  expect(await first).toContain("结果未确认");
  expect(await handle(command, context)).toEqual([]);
  expect(batchCalls).toBe(1);
  expect(singleCalls).toBe(0);
});

test("批量审核仅在宿主明确确认真空时报告暂无申请", async () => {
  const handle = createGroupPendingJoinReview();
  const run = (result: PendingGroupJoinBatchResult, message_id: number) => handle("#拒绝全部入群申请", {
    ...current, message_id, groupReviewAllPendingJoins: async () => result,
  });
  expect(await run({ status: "not-found" }, 1)).toContain("暂无加群申请");
  expect(await run({ status: "unavailable" }, 2)).toContain("请引用原加群通知或在 QQ 中处理");
  expect(await run({ status: "processed", entries: [{ userId: 0, status: "confirmed" }] }, 3)).toContain("结果未确认");
});
