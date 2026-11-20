import { expect, test } from "bun:test";
import { createOwnerFriendReply, isOwnerFriendReplyCommand, type OwnerFriendReplyContext, type OwnerFriendReplyResult } from "./owner-friend-reply.ts";

const owner = {
  message_type: "private", self_id: 99, user_id: 42, message_id: 1, isBotMaster: (id: number) => id === 42,
} satisfies OwnerFriendReplyContext;
const command = "#回复51 你好";

test("沿用旧带井号与裸回复写法，精确识别 QQ，正文保留原空格换行", async () => {
  const handle = createOwnerFriendReply();
  const calls: [number, string][] = [];
  const scope: OwnerFriendReplyContext = { ...owner, async sendOwnerFriendReply(qq, text) {
    calls.push([qq, text]); return "confirmed";
  } };
  for (const [index, input] of [command, "#回复 51 你好", "回复51 你好", "回复 51 你好 朋友\n第二行   原空格"].entries()) {
    expect(isOwnerFriendReplyCommand(input)).toBe(true);
    expect(await handle(input, { ...scope, message_id: index + 1 })).toBe("✅ 已把消息发给它了哦~");
  }
  for (const input of ["回复群友", "#回复@51 你好", "#回复+51 你好", "#回复51你好", "#回复 51\n你好"]) {
    expect(isOwnerFriendReplyCommand(input)).toBe(false);
    expect(await handle(input, scope)).toBeUndefined();
  }
  expect(await handle("#回复51", scope)).toContain("消息不能为空");
  expect(await handle("#回复0 你好", scope)).toContain("QQ号不正确");
  expect(await handle("#回复9007199254740993 内容", scope)).toContain("QQ号不正确");
  expect(await handle("#回复99 你好", scope)).toContain("机器人自己");
  expect(calls).toEqual([[51, "你好"], [51, "你好"], [51, "你好"], [51, "你好 朋友\n第二行   原空格"]]);
});

test("带引用保留给后续处理，群聊、非主人、委托和非原生能力均不发送", async () => {
  const handle = createOwnerFriendReply();
  let calls = 0;
  const scope: OwnerFriendReplyContext = { ...owner, async sendOwnerFriendReply() { calls++; return "confirmed"; } };
  expect(isOwnerFriendReplyCommand(command, 7)).toBe(false);
  for (const invalid of [{ reply_id: 7 }, { message: [{ type: "reply" }] }, { message_type: "group" as const },
    { message_type: "terminal" as const }, { isDelegated: true }]) {
    expect(await handle(command, { ...scope, ...invalid })).toBeUndefined();
  }
  expect(await handle(command, { ...scope, message: [{ type: "text" }, { type: "image" }] })).toContain("只支持发送纯文本");
  expect(await handle(command, { ...scope, isBotMaster: () => false })).toContain("请由当前机器人的主人");
  expect(await handle(command, { ...scope, sendOwnerFriendReply: undefined })).toContain("当前无法");
  expect(await handle(command, { ...scope, message_id: undefined })).toContain("当前无法");
  expect(await createOwnerFriendReply(AbortSignal.abort())(command, scope)).toBeUndefined();
  expect(calls).toBe(0);
});

test("真实好友、网关拒绝和未知回执分开，未知后不重复拨送", async () => {
  for (const [result, expected] of [
    ["not-friend", "好友列表查无此人"], ["rejected", "协议端拒绝"], ["unknown", "发送结果未确认"], ["unavailable", "当前无法"],
  ] as const) {
    const handle = createOwnerFriendReply();
    const response = await handle(command, { ...owner, async sendOwnerFriendReply() { return result; } });
    expect(response).toContain(expected);
    expect(response).not.toContain("已把消息发给");
  }

  const handle = createOwnerFriendReply();
  let calls = 0;
  let resolve!: (result: OwnerFriendReplyResult) => void;
  const pending = new Promise<OwnerFriendReplyResult>((settle) => { resolve = settle; });
  const scope: OwnerFriendReplyContext = { ...owner, sendOwnerFriendReply() { calls++; return pending; } };
  const first = handle(command, scope);
  expect(await handle(command, { ...scope, adapter: "onebot" })).toEqual([]);
  resolve("unknown");
  expect(await first).toContain("发送结果未确认");
  expect(await handle(command, scope)).toEqual([]);
  expect(await handle(command, { ...scope, adapter: "milky" })).toContain("发送结果未确认");
  expect(await handle(command, { ...scope, self_id: 98 })).toContain("发送结果未确认");
  expect(calls).toBe(3);
});
