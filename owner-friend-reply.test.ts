import { expect, test } from "bun:test";
import { createOwnerFriendReply, isOwnerFriendReplyCommand, type OwnerFriendReplyBody, type OwnerFriendReplyContext, type OwnerFriendReplyResult, type QuotedOwnerFriendReplyResult } from "./owner-friend-reply.ts";

const owner = {
  message_type: "private", self_id: 99, user_id: 42, message_id: 1, isBotMaster: (id: number) => id === 42,
} satisfies OwnerFriendReplyContext;
const command = "#回复51 你好";

test("沿用旧带井号与裸回复写法，精确识别 QQ，正文保留原空格换行", async () => {
  const handle = createOwnerFriendReply();
  const calls: [number, OwnerFriendReplyBody][] = [];
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
  expect(await handle(command, { ...scope, message: [{ type: "text", text: command }, { type: "video" }] })).toContain("整条消息未发送");
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

test("混排按第一个原文字段解析 QQ，保留相对次序且只传原图与表情索引", async () => {
  const handle = createOwnerFriendReply();
  const calls: [number, OwnerFriendReplyBody][] = [];
  const message = [
    { type: "text", text: "＃回复 51 开头  " },
    { type: "image", url: "https://example.test/untrusted" },
    { type: "text", text: "  图片之后\n继续" },
    { type: "face", id: 88 },
    { type: "text", text: " 末尾" },
  ];
  const scope: OwnerFriendReplyContext = { ...owner, message, async sendOwnerFriendReply(qq, body) {
    calls.push([qq, body]); return "confirmed";
  } };
  expect(await handle("#回复 51 开头    图片之后\n继续 末尾", scope)).toBe("✅ 已把消息发给它了哦~");

  const mediaOnly = [{ type: "text", text: "#回复52 " }, { type: "image" }, { type: "face" }];
  expect(await handle("#回复52", { ...scope, message_id: 2, message: mediaOnly })).toBe("✅ 已把消息发给它了哦~");
  const afterMedia = [{ type: "text", text: "#回复53" }, { type: "face" }, { type: "text", text: "4 后文" }];
  expect(isOwnerFriendReplyCommand("#回复534 后文", undefined, afterMedia)).toBe(true);
  expect(await handle("#回复534 后文", { ...scope, message_id: 3, message: afterMedia })).toBe("✅ 已把消息发给它了哦~");
  expect(isOwnerFriendReplyCommand("#回复53后文", undefined, afterMedia)).toBe(true);
  expect(calls).toEqual([
    [51, ["开头  ", { sourceIndex: 1 }, "  图片之后\n继续", { sourceIndex: 3 }, " 末尾"]],
    [52, [{ sourceIndex: 1 }, { sourceIndex: 2 }]],
    [53, [{ sourceIndex: 1 }, "4 后文"]],
  ]);
});

test("不支持的段或命令前有媒体时整条不发送，宿主媒体不可核验时独立回执", async () => {
  const handle = createOwnerFriendReply();
  let calls = 0;
  const scope: OwnerFriendReplyContext = { ...owner, async sendOwnerFriendReply() { calls++; return "unsupported"; } };
  for (const message of [
    [{ type: "text", text: command }, { type: "image" }, { type: "at" }],
    [{ type: "text", text: command }, { type: "record" }],
    [{ type: "image" }, { type: "text", text: command }],
    [{ type: "text", text: "#回复" }, { type: "text", text: "51 你好" }, { type: "face" }],
  ]) {
    expect(await handle(command, { ...scope, message })).toContain("整条消息未发送");
  }
  expect(await handle(command, { ...scope, message: [{ type: "text", text: command }, { type: "quote" }, { type: "image" }] })).toBeUndefined();
  expect(calls).toBe(0);

  const message = [{ type: "text", text: command }, { type: "image" }];
  expect(await handle(command, { ...scope, message })).toContain("无法核验原消息中的图片或 QQ 表情，整条消息未发送");
  expect(await handle(command, { ...scope, message })).toEqual([]);
  expect(calls).toBe(1);
});

test("真实引用只将本条正文交给宿主，包括开头数字与原图片/表情索引", async () => {
  const handle = createOwnerFriendReply();
  const bodies: OwnerFriendReplyBody[] = [];
  const scope: OwnerFriendReplyContext = { ...owner, reply_id: "17",
    async sendQuotedOwnerFriendReply(body) { bodies.push(body); return "confirmed"; },
    async sendOwnerFriendReply() { throw new Error("引用消息不能由命令文字选择目标"); },
  };
  expect(isOwnerFriendReplyCommand("回复 510 好友你好", "17")).toBe(true);
  expect(await handle("回复 510 好友你好", scope)).toBe("✅ 已把消息发给它了哦~");
  expect(await handle("#回复 前面  后面", { ...scope, message_id: 2, adapter: "milky",
    message: [{ type: "reply" }, { type: "text", text: "#回复 前面  " }, { type: "image" },
      { type: "text", text: "后面" }, { type: "face" }] })).toBe("✅ 已把消息发给它了哦~");
  expect(await handle("#回复", { ...scope, message_id: 3,
    message: [{ type: "text", text: "#回复 " }, { type: "face" }, { type: "reply" }] })).toBe("✅ 已把消息发给它了哦~");
  expect(bodies).toEqual(["510 好友你好", ["前面  ", { sourceIndex: 2 }, "后面", { sourceIndex: 4 }], [{ sourceIndex: 1 }]]);
  for (const invalid of [{ reply_id: undefined }, { reply_id: "" }, { message_type: "group" as const }, { isDelegated: true },
    { isBotMaster: () => false }, { sendQuotedOwnerFriendReply: undefined },
    { message: [{ type: "reply" }, { type: "text", text: "#回复 好友你好" }, { type: "video" }] },
    { message: [{ type: "reply" }, { type: "quote" }, { type: "text", text: "#回复 好友你好" }] }]) {
    expect(await handle("#回复 好友你好", { ...scope, ...invalid })).toBeUndefined();
  }
  expect(await handle("#回复510 好友你好", scope)).toBeUndefined();
  expect(bodies).toHaveLength(3);
});

test("引用与直接回复共享原消息去重，未知不重发，无关并发或重放继续派发", async () => {
  const handle = createOwnerFriendReply();
  let finish!: (result: QuotedOwnerFriendReplyResult) => void;
  const pending = new Promise<QuotedOwnerFriendReplyResult>((resolve) => { finish = resolve; });
  let calls = 0;
  const scope: OwnerFriendReplyContext = { ...owner, reply_id: 17, sendQuotedOwnerFriendReply() { calls++; return pending; } };
  const first = handle("#回复 一句", scope);
  const replay = handle("#回复 一句", scope);
  expect(await handle("#回复51 不该发送", { ...owner, sendOwnerFriendReply: async () => { calls++; return "confirmed"; } })).toEqual([]);
  finish("unknown");
  expect(await first).toContain("发送结果未确认");
  expect(await replay).toEqual([]);
  expect(await handle("#回复 一句", scope)).toEqual([]);
  expect(calls).toBe(1);

  const unrelated = { ...scope, message_id: 2, sendQuotedOwnerFriendReply: async () => "unrelated" as const };
  expect(await Promise.all([handle("回复 一句", unrelated), handle("回复 一句", unrelated)])).toEqual([undefined, undefined]);
  expect(await handle("回复 一句", unrelated)).toBeUndefined();
  expect(await handle("回复 一句", { ...scope, message_id: 3, sendQuotedOwnerFriendReply: async () => "expired" })).toContain("改用「回复 QQ号 <内容>」");
});
