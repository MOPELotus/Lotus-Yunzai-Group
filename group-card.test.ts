import { expect, test } from "bun:test";
import { changeGroupCard } from "./group-card.ts";

type Event = Parameters<typeof changeGroupCard>[0];
type SetCard = NonNullable<Event["setGroupCard"]>;

function fixture(outcome: Awaited<ReturnType<SetCard>> = "confirmed") {
  const calls: Parameters<SetCard>[] = [];
  const event: Event = {
    msg: "#改群名片新 名片",
    message_type: "group",
    self_id: 99,
    message: [],
    isMaster: true,
    async setGroupCard(...args) {
      calls.push(args);
      return outcome;
    },
  };
  return { event, calls };
}

const at = (qq: string | number) => ({ type: "at", qq });

test("旧群名片命令支持紧跟文字、机器人 @ 和空名片清除", async () => {
  const { event, calls } = fixture();
  expect(await changeGroupCard({ ...event, message: [at(99)] })).toBe("✅ 群名片修改成功");
  expect(await changeGroupCard({ ...event, msg: "#改群名片" })).toBe("✅ 群名片修改成功");
  expect(await changeGroupCard({ ...event, message: [at("99"), at("42")] })).toBe("✅ 群名片修改成功");
  expect(calls).toEqual([["新 名片", undefined, undefined], ["", undefined, undefined], ["新 名片", undefined, 42]]);
});

test("旧群名片私聊使用明确群号和原机器人，保留卡片内空格", async () => {
  const { event, calls } = fixture();
  const privateEvent = { ...event, message_type: "private" as const };
  expect(await changeGroupCard({ ...privateEvent, msg: "#改群名片 123 新  卡片" })).toBe("✅ 群名片修改成功");
  expect(await changeGroupCard({ ...privateEvent, msg: "#改群名片 123" })).toBe("✅ 群名片修改成功");
  expect(await changeGroupCard({ ...privateEvent, msg: "#改群名片" })).toBe("❎ 群号不能为空");
  expect(await changeGroupCard({ ...privateEvent, msg: "#改群名片 123x 任意" })).toBe("❎ 群号不合法");
  expect(await changeGroupCard({ ...privateEvent, msg: "#改群名片 9007199254740992 任意" })).toBe("❎ 群号不合法");
  expect(await changeGroupCard({ ...privateEvent, msg: "#改群名片 123", message: [at(42)] })).toBe("私聊仅能修改机器人的群名片。");
  expect(calls).toEqual([["新  卡片", 123, undefined], ["", 123, undefined]]);
});

test("修改群名片仅允许主人和单个明确成员，并区分协议回执", async () => {
  const { event, calls } = fixture();
  expect(await changeGroupCard({ ...event, isMaster: false })).toContain("仅限主人");
  expect(await changeGroupCard({ ...event, message_type: "terminal" })).toContain("不支持");
  expect(await changeGroupCard({ ...event, setGroupCard: undefined })).toContain("不支持");
  expect(await changeGroupCard({ ...event, message: [at("all")] })).toContain("一位");
  expect(await changeGroupCard({ ...event, message: [at(12), at(34)] })).toContain("一位");
  expect(calls).toEqual([]);

  for (const [outcome, text] of [
    ["missing-group", "群聊列表查无此群"], ["insufficient-role", "需要管理员权限"],
    ["rejected", "修改失败"], ["unknown", "结果未确认"],
  ] as const) {
    const { event, calls } = fixture(outcome);
    expect(await changeGroupCard({ ...event, message: [at(42)] })).toContain(text);
    expect(calls).toEqual([["新 名片", undefined, 42]]);
  }
  expect(await changeGroupCard({ ...event, async setGroupCard() { throw new Error("模拟连接已断开"); } })).toContain("结果未确认");
});
