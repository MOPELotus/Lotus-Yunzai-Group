import { expect, test } from "bun:test";
import { createFriendRequestReview, isFriendRequestReviewCommand, type FriendRequestReviewContext,
  type PendingFriendRequestReviewResult } from "./friend-request-review.ts";

const owner = {
  message_type: "private", adapter: "milky", self_id: 99, user_id: 42, message_id: 1, isBotMaster: (id: number) => id === 42,
} satisfies FriendRequestReviewContext;
const command = "#同意好友申请51";

test("仅原紧连 QQ 单条好友审核语法，当前主人收到确切回执", async () => {
  const handle = createFriendRequestReview();
  const calls: [number, boolean][] = [];
  const scope: FriendRequestReviewContext = { ...owner, async reviewPendingFriendRequest(qq, approve) {
    calls.push([qq, approve]);
    return { status: "confirmed" };
  } };
  for (const input of [command, "拒绝好友申请52"]) expect(isFriendRequestReviewCommand(input)).toBe(true);
  for (const input of ["#同意", "拒绝", "#拒绝全部好友申请", "#同意好友申请 51", "#同意好友申请", "#同意好友申请@51",
    "#同意好友申请51 52", "#同意加群申请51"]) {
    expect(isFriendRequestReviewCommand(input)).toBe(false);
    expect(await handle(input, scope)).toBeUndefined();
  }
  expect(await handle("#同意好友申请0", scope)).toContain("填写有效");
  expect(await handle("#同意好友申请9007199254740993", scope)).toContain("填写有效");
  expect(await handle(command, scope)).toBe("✅ 已同意 51 的好友申请");
  expect(await handle("拒绝好友申请52", { ...scope, message_id: 2 })).toBe("✅ 已拒绝 52 的好友申请");
  expect(calls).toEqual([[51, true], [52, false]]);
});

test("未获得可信原生私聊能力、非主人和委托均不会写", async () => {
  const handle = createFriendRequestReview();
  let calls = 0;
  const scope: FriendRequestReviewContext = { ...owner, async reviewPendingFriendRequest() {
    calls++;
    return { status: "confirmed" };
  } };
  expect(await handle(command, { ...scope, message_type: "group" })).toBeUndefined();
  expect(await handle(command, { ...scope, message_type: "terminal" })).toBeUndefined();
  expect(await handle(command, { ...scope, isDelegated: true })).toBeUndefined();
  expect(await handle(command, { ...scope, isBotMaster: () => false })).toContain("请由当前机器人的主人");
  expect(await handle(command, { ...scope, adapter: undefined, reviewPendingFriendRequest: undefined })).toContain("请在 QQ 中处理");
  expect(await handle(command, { ...scope, message_id: undefined })).toContain("请在 QQ 中处理");
  expect(await createFriendRequestReview(AbortSignal.abort())(command, scope)).toBeUndefined();
  expect(calls).toBe(0);
});

test("受理、未知、拒绝、风险、范围内无和歧义均不声称已处理", async () => {
  for (const [status, expected] of [
    ["submitted", "协议端已受理同意 51 的好友申请，请在 QQ 中核对处理结果。"], ["rejected", "协议端拒绝"],
    ["unknown", "处理结果未确认"], ["unavailable", "无法按 QQ 核实"], ["not-found", "本次查询范围内未找到"],
    ["ambiguous", "多条待处理"], ["risk", "风险账号"],
  ] as const) {
    const handle = createFriendRequestReview();
    const response = await handle(command, { ...owner, reviewPendingFriendRequest: async () => ({ status }) });
    expect(response).toContain(expected);
    expect(response).not.toContain("✅ 已同意");
  }
});

test("在途、回执未知和跨动词的原消息重放只调用一次，账号与协议彼此隔离", async () => {
  const handle = createFriendRequestReview();
  let calls = 0;
  let finish!: (result: PendingFriendRequestReviewResult) => void;
  const pending = new Promise<PendingFriendRequestReviewResult>((resolve) => { finish = resolve; });
  const scope: FriendRequestReviewContext = { ...owner, reviewPendingFriendRequest() { calls++; return pending; } };
  const first = handle(command, scope);
  expect(await handle("拒绝好友申请51", scope)).toEqual([]);
  finish({ status: "unknown" });
  expect(await first).toContain("结果未确认");
  expect(await handle(command, scope)).toEqual([]);
  expect(await handle(command, { ...scope, adapter: undefined })).toContain("结果未确认");
  expect(await handle(command, { ...scope, self_id: 98 })).toContain("结果未确认");
  expect(calls).toBe(3);
});
