import { expect, test } from "bun:test";
import { createGroupQuotedReview, type GroupQuotedReviewContext, type GroupQuotedReviewResult } from "./group-quoted-review.ts";

function fixture() {
  const signal = new AbortController();
  const command = createGroupQuotedReview(signal.signal);
  const actions: boolean[] = [];
  const context: GroupQuotedReviewContext = {
    message_type: "group", group_id: 77, self_id: 99, user_id: 42, message_id: "101", reply_id: -888,
    isBotMaster: () => false,
    async groupReviewQuotedRequest(approve) {
      actions.push(approve);
      return { status: "confirmed", userId: 65, nickname: "申请人" };
    },
  };
  return { context, command, actions, signal };
}

test("旧引用同意和拒绝，精确消费当前群真实能力且保留旧确认格式", async () => {
  const { context, command, actions } = fixture();
  expect(await command("同意", context)).toBe("已同意申请人(65)的加群申请辣٩(๑^o^๑)۶");
  expect(await command("#拒绝", { ...context, message_id: "102" })).toBe("已拒绝申请人(65)的加群申请辣٩(๑^o^๑)۶");
  expect(await command("同意", context)).toEqual([]);
  expect(actions).toEqual([true, false]);
});

test("非群、缺真实引用、无来源能力或委托时留给其他入口", async () => {
  const { context, command, actions, signal } = fixture();
  expect(await command("同意入群", context)).toBeUndefined();
  expect(await command("同意", { ...context, message_type: "private" })).toBeUndefined();
  expect(await command("同意", { ...context, reply_id: undefined })).toBeUndefined();
  expect(await command("同意", { ...context, message_id: undefined })).toBeUndefined();
  expect(await command("同意", { ...context, groupReviewQuotedRequest: undefined })).toBeUndefined();
  expect(await command("同意", { ...context, isDelegated: true })).toBeUndefined();
  signal.abort();
  expect(await command("同意", context)).toBeUndefined();
  expect(actions).toEqual([]);
});

test("未知结果的原消息并发只尝试一次，互不影响不同协议或机器人", async () => {
  const { context, command } = fixture();
  const result = Promise.withResolvers<GroupQuotedReviewResult>();
  let calls = 0;
  const bound = { ...context, groupReviewQuotedRequest: () => { calls++; return result.promise; } };
  const attempts = [command("#同意", bound), command("#同意", bound)];
  expect(calls).toBe(1);
  result.reject(new Error("确认包丢失"));
  expect((await Promise.all(attempts))).toEqual(["加群申请处理结果未确认，请先在 QQ 核对。", []]);
  expect(await command("#同意", bound)).toEqual([]);
  expect(await command("#同意", { ...bound, adapter: "milky" })).toContain("未确认");
  expect(await command("#同意", { ...bound, self_id: 98 })).toContain("未确认");
  expect(calls).toBe(3);
});

test("无关消息继续派发，已过期、风险和明确失败各有正确提示", async () => {
  const { context, command } = fixture();
  const statuses = {
    unrelated: undefined, expired: "找不到原消息了，手动拒绝叭~",
    rejected: "呜呜呜，处理失败辣(இωஇ)", risk: "该账号为风险账号请手动处理哦ಠ~ಠ",
    unavailable: "当前无法核实并处理这条加群申请，请在 QQ 手动处理。",
  } as const;
  for (const [i, status] of (Object.keys(statuses) as (keyof typeof statuses)[]).entries()) {
    const bound = { ...context, message_id: i, groupReviewQuotedRequest: async () => ({ status }) };
    expect(await command("#拒绝", bound)).toBe(statuses[status]);
    expect(await command("#拒绝", bound)).toEqual(status === "unrelated" ? undefined : []);
  }
});
