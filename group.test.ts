import { expect, test } from "bun:test";
import { createGroupPlugin } from "./index.ts";

function settings() {
  return {
    enable: true, cloneAllThumbUp: false, strangeThumbUp: true, count: 10,
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
    .toEqual([{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "3", "次"]);
  expect(await commands["#超我"]!("", { message_type: "private", user_id: 42, likeSelf }))
    .toBe(" 给你超了3次");
  expect(await commands["#全部赞我"]!("", { message_type: "private", user_id: 42, likeSelf }))
    .toEqual([]);
  expect(await commands["#全部赞我"]!("", { message_type: "group", user_id: 42, likeSelf }))
    .toEqual([{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "3", "次"]);
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
  expect(await commands["#赞我"]!("", ordinary)).toBe("已关闭");
  config.enable = true;
  config.strangeThumbUp = false;
  expect(await commands["#赞我"]!("", ordinary)).toBe("仅好友");
  expect(await commands["#赞我"]!("", { ...ordinary, isFriend: async () => { throw new Error("不可查询"); } }))
    .toBe("仅好友");
  expect(calls).toBe(0);
  expect(await commands["#赞我"]!("", { ...ordinary, isFriend: async () => true }))
    .toEqual([{ type: "at", qq: 42 }, " 给", "你", "赞", "了", "1", "次"]);
  config.strangeThumbUp = true;
  for (const likeSelf of [async () => 0, async () => 11, async () => { throw new Error("拒绝"); }]) {
    expect(await commands["#赞我"]!("", { ...ordinary, likeSelf })).toBe("失败或已达上限");
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
