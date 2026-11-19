import { expect, test } from "bun:test";
import { groupActivityCommand, isGroupActivityCommand, type GroupActivityContext, type GroupActivityMember } from "./group-activity.ts";

const time = 1_700_000_000;
const bot = { userId: 999, joinTime: time, lastSentTime: time, role: "member" } as const;
const context: GroupActivityContext = { message_type: "group", group_id: 77, user_id: 42, self_id: bot.userId, normalizedMessage: "#查看从未发言的人" };

test("从未发言旧分类保留普通成员、入群顺序、原头像和三十人分页", async () => {
  const members: GroupActivityMember[] = Array.from({ length: 31 }, (_, index) => ({
    userId: 10_001 + index, joinTime: time + index, lastSentTime: time + index, role: "member", name: `旧群名片${index + 1}`,
  }));
  members.reverse();
  members.push(bot, { ...bot, userId: 11_001, role: "admin" }, { ...bot, userId: 11_002, role: "owner" },
    { ...bot, userId: 11_003, lastSentTime: time + 50 }, { ...bot, userId: 11_004, lastSentTime: 0 });
  const scope = { ...context, async groupActivityRoster() { return members; } };
  const first = await groupActivityCommand(scope);
  if (typeof first !== "object") throw new Error("没有返回合并转发");
  expect(first.nodes).toHaveLength(31);
  expect(first.nodes[0]?.join("")).toContain("当前为第 1 页，共 2 页，本页共 30 人，总共 31 人");
  expect(first.nodes[0]?.join("")).toContain("#查看从未发言过的人第2页");
  expect(first.nodes[1]?.[0]).toEqual({ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=10001" });
  expect(first.nodes[1]?.[1]).toContain("昵称：旧群名片1");
  expect(first.nodes[1]?.[1]).toMatch(/进群时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u);
  expect(first.nodes[30]?.[1]).toContain("QQ：10030");
  const second = await groupActivityCommand({ ...scope, normalizedMessage: "#查看从未发言过的人第二页" });
  if (typeof second !== "object") throw new Error("没有返回第二页");
  expect(second.nodes).toHaveLength(2);
  expect(second.nodes[0]?.join("")).toContain("当前为第 2 页，共 2 页，本页共 1 人，总共 31 人");
  expect(second.nodes[1]?.[1]).toContain("QQ：10031");
  expect(await groupActivityCommand({ ...scope, normalizedMessage: "#查看从未发言的人第三页" })).toContain("本群共 2 页");
});

test("缺失数据或身份不完整须提示，合法空结果才可报无成员", async () => {
  const unavailable = "无法读取完整的群成员发言数据";
  expect(await groupActivityCommand(context)).toContain(unavailable);
  for (const rows of [undefined, [], [{ ...bot, userId: 10_001 }], [bot, bot], [bot, { ...bot, userId: 10_001, joinTime: 0 }],
    [bot, { ...bot, userId: 10_001, lastSentTime: undefined }], [bot, { ...bot, userId: 10_001, role: "unknown" }]]) {
    expect(await groupActivityCommand({ ...context, async groupActivityRoster() { return rows as readonly GroupActivityMember[] | undefined; } }))
      .toContain(unavailable);
  }
  expect(await groupActivityCommand({ ...context, async groupActivityRoster() { throw new Error("未确认"); } })).toContain(unavailable);
  expect(await groupActivityCommand({ ...context, async groupActivityRoster() { return [bot]; } })).toContain("暂无从未发言的成员");
});

test("只读入口不接管确认或清理，跨会话和无效页码不发查询", async () => {
  let reads = 0;
  const scope = { ...context, async groupActivityRoster() { reads++; return [bot]; } };
  for (const message of ["#清理从未发言的人", "#确认清理", "从未发言的人", "#查看从未发言的人第abc页"]) {
    expect(isGroupActivityCommand(message)).toBe(false);
    expect(await groupActivityCommand({ ...scope, normalizedMessage: message })).toBeUndefined();
  }
  expect(await groupActivityCommand({ ...scope, normalizedMessage: "#查看从未发言的人第零页" })).toContain("有效页码");
  expect(await groupActivityCommand({ ...scope, normalizedMessage: "#查看从未发言的人第999999999999999999999999页" })).toContain("有效页码");
  expect(await groupActivityCommand({ ...scope, isDelegated: true })).toBeUndefined();
  expect(await groupActivityCommand({ ...scope, message_type: "private" })).toBeUndefined();
  const stopped = new AbortController();
  stopped.abort();
  expect(await groupActivityCommand(scope, stopped.signal)).toBeUndefined();
  expect(reads).toBe(0);
});
