import { expect, test } from "bun:test";
import { createGroupPlugin } from "./likes.ts";

function settings() {
  return {
    enable: true, cloneAllThumbUp: false, strangeThumbUp: true, count: 10, recall: 0,
    closeTips: "", successMsg: "{{at}} 给{{userId}}{{doType}}了{{thumbUpNum}}次",
    failsMsg: "失败或已达上限", noFriendMsg: "仅好友",
  };
}

test("群聊和私聊的自赞别名使用协议确认的实际结果", async () => {
  const { commands, aliases } = createGroupPlugin(async () => settings());
  const calls: number[] = [];
  const likeSelf = async (count: number) => { calls.push(count); return 3; };
  expect(aliases["给我资料卡点赞"]).toBe("#给我资料卡点赞");
  expect(await commands["#赞我"]!("", { message_type: "group", user_id: 42, likeSelf }))
    .toEqual({ type: "quoted", message: [{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "3", "次"] });
  expect(await commands["#超我"]!("", { message_type: "private", user_id: 42, likeSelf }))
    .toEqual({ type: "quoted", message: " 给你超了3次" });
  expect(await commands["#全部赞我"]!("", { message_type: "private", user_id: 42, likeSelf }))
    .toEqual([]);
  expect(await commands["#全部赞我"]!("", { message_type: "group", user_id: 42, likeSelf }))
    .toEqual({ type: "quoted", message: [{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "3", "次"] });
  expect(calls).toEqual([10, 10, 10]);
});

test("开关及好友限制生效，拒绝、超限和无协议端时给出相应提示", async () => {
  const config = settings();
  const { commands } = createGroupPlugin(async () => config);
  let calls = 0;
  const ordinary = { message_type: "group" as const, user_id: 42, likeSelf: async () => ++calls };
  config.cloneAllThumbUp = true;
  expect(await commands["#全部赞我"]!("", ordinary)).toEqual([]);
  config.enable = false;
  config.closeTips = "已关闭";
  expect(await commands["#赞我"]!("", ordinary)).toEqual({ type: "quoted", message: "已关闭" });
  config.enable = true;
  config.strangeThumbUp = false;
  expect(await commands["#赞我"]!("", ordinary)).toEqual({ type: "quoted", message: "仅好友" });
  expect(await commands["#赞我"]!("", { ...ordinary, isFriend: async () => { throw new Error("不可查询"); } }))
    .toEqual({ type: "quoted", message: "仅好友" });
  expect(calls).toBe(0);
  expect(await commands["#赞我"]!("", { ...ordinary, isFriend: async () => true }))
    .toEqual({ type: "quoted", message: [{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "1", "次"] });
  config.strangeThumbUp = true;
  for (const likeSelf of [async () => 0, async () => 11, async () => { throw new Error("拒绝"); }]) {
    expect(await commands["#赞我"]!("", { ...ordinary, likeSelf })).toEqual({ type: "quoted", message: "失败或已达上限" });
  }
  expect(await commands["#赞我"]!("", { message_type: "terminal" })).toContain("协议端不支持");
});

test("同一发送者并发触发时只发一次协议请求", async () => {
  const { commands } = createGroupPlugin(async () => settings());
  const pending = Promise.withResolvers<number>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const context = {
    message_type: "group" as const, user_id: 42, self_id: 1,
    likeSelf: () => { calls++; started.resolve(); return pending.promise; },
  };
  const first = commands["#赞我"]!("", context);
  await started.promise;
  expect(await commands["#点赞"]!("", context)).toBe("正在处理你的点赞请求。");
  pending.resolve(10);
  await first;
  expect(calls).toBe(1);
});


test("只有真正发送的点赞结果使用配置的自动撤回", async () => {
  const config = settings();
  config.recall = 1.5;
  const { commands } = createGroupPlugin(async () => config);
  const calls: number[] = [];
  const context = { message_type: "group" as const, user_id: 42,
    likeSelf: async (count: number) => { calls.push(count); return 2; } };
  const success = { type: "quoted", message: [{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "2", "次"],
    options: { recallMsg: 1.5 } } as const;
  expect(await commands["#赞我"]!("", context)).toEqual(success);
  expect(await commands["#全部赞我"]!("", context)).toEqual(success);
  const refused = { ...context, async likeSelf(count: number) { calls.push(count); return 0; } };
  expect(await commands["#赞我"]!("", refused)).toEqual({
    type: "quoted", message: "失败或已达上限", options: { recallMsg: 1.5 },
  });
  expect(await commands["#全部赞我"]!("", refused)).toEqual([]);
  config.strangeThumbUp = false;
  expect(await commands["#赞我"]!("", { ...context, isFriend: async () => false })).toEqual({ type: "quoted", message: "仅好友" });
  config.enable = false;
  config.closeTips = "关闭";
  expect(await commands["#赞我"]!("", context)).toEqual({ type: "quoted", message: "关闭" });
  expect(calls).toEqual([10, 10, 10, 10]);
});

test("旧代赞及口语别名面向实际提及成员，保留模板变量和一次协议确认", async () => {
  const config = settings();
  config.recall = 2;
  const { commands, aliases } = createGroupPlugin(async () => config);
  const calls: number[] = [];
  const context = {
    message_type: "group" as const, user_id: 42, self_id: 99,
    async likeSelf() { throw new Error("must not like the sender"); },
    mentionLike: {
      userId: 43,
      async isFriend() { throw new Error("only queried in friend-only mode"); },
      async like(count: number) { calls.push(count); return 4; },
    },
  };
  for (const verb of ["赞", "超", "操", "草", "抄", "吵", "炒"]) {
    for (const pronoun of ["他", "她", "它", "TA", "ta", "Ta"]) {
      expect(aliases[verb + pronoun]).toBe(`#${verb}${pronoun}`);
      expect(typeof commands[`#${verb}${pronoun}`]).toBe("function");
    }
  }
  for (const [command, style] of [["#赞他", "赞"], ["#吵Ta", "超"]] as const) {
    expect(await commands[command]!("", context)).toEqual({ type: "quoted",
      message: [{ type: "at", qq: 43 }, " 给", "43", style, "了", "4", "次"], options: { recallMsg: 2 },
    });
  }
  expect(calls).toEqual([10, 10]);
});

test("代赞没有唯一合法群提及时只提示，绝不回退为自赞", async () => {
  const { commands } = createGroupPlugin(async () => settings());
  let calls = 0;
  const context = { message_type: "group" as const, self_id: 99, user_id: 42, async likeSelf() { return ++calls; } };
  const mentionLike = { userId: 43, async isFriend() { return true; }, async like() { return ++calls; } };
  for (const invalid of [context, { ...context, mentionLike, isDelegated: true },
    { ...context, mentionLike, message_type: "private" as const }, ...[42, 99, 0, -1, Number.NaN].map((userId) => ({
      ...context, mentionLike: { ...mentionLike, userId },
    }))]) {
    expect(await commands["#赞她"]!("", invalid)).toContain("@ 一位其他群成员");
  }
  expect(await commands["#赞她"]!("43", context)).toContain("@ 一位其他群成员");
  expect(calls).toBe(0);
});

test("代赞只检查目标好友关系，不确认点赞失败，也不并发点赞同一目标", async () => {
  const config = settings();
  config.strangeThumbUp = false;
  config.noFriendMsg = "{{at}} {{userId}} {{noFriend:请{userId}先添加好友}}";
  config.failsMsg = "{{at}} {{userId}}失败";
  const { commands } = createGroupPlugin(async () => config);
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<number>();
  let calls = 0;
  const target = { userId: 43, async isFriend() { return false; }, like() { calls++; started.resolve(); return pending.promise; } };
  const context = { message_type: "group" as const, user_id: 42, self_id: 99, async isFriend() { return true; } };
  expect(await commands["#赞TA"]!("", { ...context, mentionLike: target })).toEqual({
    type: "quoted", message: [{ type: "at", qq: 43 }, " ", "43", " 请43先添加好友"],
  });
  expect(calls).toBe(0);
  const eligible = { ...target, async isFriend() { return true; } };
  const first = commands["#赞TA"]!("", { ...context, mentionLike: eligible });
  await started.promise;
  expect(await commands["#赞他"]!("", { ...context, user_id: 44, mentionLike: eligible })).toContain("正在处理");
  expect(await commands["#赞我"]!("", { ...context, user_id: 43, async likeSelf() { return ++calls; } })).toContain("正在处理");
  pending.resolve(0);
  expect(await first).toEqual({ type: "quoted", message: [{ type: "at", qq: 43 }, " ", "43", "失败"] });
  expect(calls).toBe(1);
});

test("点赞出明确回执后才按实际对象渲染，同一模板的多个图片位置复用结果", async () => {
  const config = { ...settings(), recall: 2, successMsg: "{{img}}已赞{{userId}}{{thumbUpNum}}次{{ img }}", failsMsg: "失败{{img}}" };
  const signal = new AbortController().signal;
  const bytes = Uint8Array.of(2, 3);
  const requests: unknown[] = [];
  const { commands } = createGroupPlugin(async () => config, async (id, outcome, active) => {
    requests.push([id, outcome, active]);
    return bytes;
  });
  const started = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<number>();
  let submissions = 0;
  const mentionLike = { userId: 43, async isFriend() { return true; }, async like() {
    submissions++;
    started.resolve();
    return receipt.promise;
  } };
  const group = { message_type: "group" as const, user_id: 42, self_id: 99, mentionLike, profileLikeImageSignal: signal };
  const pending = commands["#赞她"]!("", group);
  await started.promise;
  expect(requests).toEqual([]);
  receipt.resolve(4);
  const image = { type: "image", file: bytes } as const;
  expect(await pending).toEqual({ type: "quoted", message: [image, "已赞", "43", "4", "次", image], options: { recallMsg: 2 } });
  expect(await commands["#赞我"]!("", { ...group, async likeSelf() { submissions++; return 0; } })).toEqual({
    type: "quoted", message: ["失败", image], options: { recallMsg: 2 },
  });
  expect(requests).toEqual([[43, "success", signal], [42, "failure", signal]]);
  expect(submissions).toBe(2);
});

test("未确认、全部赞我失败、好友限制和普通模板均不访问头像图片", async () => {
  const config = { ...settings(), successMsg: "成功", failsMsg: "失败{{img}}", noFriendMsg: "不是好友{{img}}", closeTips: "关闭{{img}}" };
  let renders = 0;
  const { commands } = createGroupPlugin(async () => config, async () => { renders++; return Uint8Array.of(1); });
  const context = { message_type: "group" as const, user_id: 42, profileLikeImageSignal: new AbortController().signal };
  expect(await commands["#点赞"]!("", { ...context, likeSelf: async () => 3 })).toEqual({ type: "quoted", message: "成功" });
  for (const likeSelf of [async () => { throw new Error("未确认"); }, async () => 11, async () => -1]) {
    expect(await commands["#赞我"]!("", { ...context, likeSelf })).toEqual({ type: "quoted", message: "失败" });
  }
  expect(await commands["#全部赞我"]!("", { ...context, likeSelf: async () => 0 })).toEqual([]);
  config.strangeThumbUp = false;
  expect(await commands["#赞我"]!("", { ...context, likeSelf: async () => 0 })).toEqual({ type: "quoted", message: "不是好友" });
  config.enable = false;
  expect(await commands["#赞我"]!("", { ...context, likeSelf: async () => 0 })).toEqual({ type: "quoted", message: "关闭" });
  expect(renders).toBe(0);
});

test("素材不可用、会话缺失、委托或中断时保留已确认的文字和撤回设置", async () => {
  const config = { ...settings(), recall: 2, successMsg: "点了{{thumbUpNum}}次{{img}}" };
  const expected = { type: "quoted", message: "点了2次", options: { recallMsg: 2 } } as const;
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const rendering = Promise.withResolvers<Uint8Array>();
  let renders = 0, likes = 0;
  const { commands } = createGroupPlugin(async () => config, async () => {
    renders++;
    started.resolve();
    return rendering.promise;
  });
  const context = { message_type: "private" as const, user_id: 42, async likeSelf() { likes++; return 2; } };
  expect(await commands["#赞我"]!("", context)).toEqual(expected);
  expect(await commands["#赞我"]!("", { ...context, isDelegated: true, profileLikeImageSignal: controller.signal })).toEqual(expected);
  expect(renders).toBe(0);
  const pending = commands["#赞我"]!("", { ...context, profileLikeImageSignal: controller.signal });
  await started.promise;
  controller.abort();
  expect(await pending).toEqual(expected);
  rendering.resolve(Uint8Array.of(3));
  expect(renders).toBe(1);
  expect(likes).toBe(3);

  const unavailable = createGroupPlugin(async () => config, async () => { throw new Error("素材缺失"); });
  expect(await unavailable.commands["#赞我"]!("", { ...context, profileLikeImageSignal: new AbortController().signal })).toEqual(expected);
});
