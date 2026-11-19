import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupActivityCleanup, groupActivityCommand, isGroupActivityCleanupCommand, isGroupActivityCommand,
  type GroupActivityContext, type GroupActivityMember } from "./group-activity.ts";

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

test("清理按同群确认且重读完整名单，只操作首次选中仍符合条件的成员", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-cleanup-"));
  try {
    await mkdir(join(directory, "config"));
    const config = join(directory, "config/groupAdmin.yaml");
    await writeFile(config, "whiteQQ: [49]\n");
    const lifetime = new AbortController();
    const groupSession = new AbortController();
    const command = createGroupActivityCleanup(pathToFileURL(`${directory}/`), lifetime.signal);
    const member = (userId: number, overrides: Partial<GroupActivityMember> = {}) => ({ ...bot, userId, ...overrides });
    let rows = [bot, ...[43, 44, 45, 46, 47, 48, 49, 50].map((id) => member(id))];
    let reads = 0, permissionChecks = 0;
    const calls: [number, boolean][] = [];
    const scope: GroupActivityContext = { ...context, groupActivitySignal: groupSession.signal,
      isBotMaster: (id) => id === 50,
      async groupManageBlacklist() { permissionChecks++; return true; },
      async groupActivityRoster() { reads++; return rows; },
      async groupKick(id, block) { calls.push([id, block]);
        if (id === 47) return "unknown";
        if (id === 48) return "rejected";
        return "confirmed";
      },
    };
    const plan = { ...scope, normalizedMessage: "#清理从未发言过的人", message_id: 1 };
    expect(await command(plan)).toContain("清理 6 人");
    expect(await command(plan)).toEqual([]);
    expect(calls).toEqual([]);
    const confirm = { ...scope, normalizedMessage: "确认清理", message_id: 2 };
    for (const mismatch of [{ group_id: 78 }, { self_id: 99 }, { user_id: 45 }, { adapter: "milky" as const }, { isDelegated: true },
      { groupActivitySignal: new AbortController().signal }]) {
      expect(await command({ ...confirm, ...mismatch })).toBeUndefined();
    }
    expect(reads).toBe(1);
    await writeFile(config, "whiteQQ: [46,49]\n");
    rows = [bot, member(43), member(44, { lastSentTime: time + 60 }), member(45, { joinTime: time + 2, lastSentTime: time + 2 }),
      member(46), member(47), member(48), member(51)];
    const [result, duplicate] = await Promise.all([command(confirm), command(confirm)]);
    expect(duplicate).toBeUndefined();
    if (typeof result !== "object" || !("nodes" in result)) throw new Error("未返回清理合并回执");
    const details = result.nodes.flat().join("\n");
    expect(details).toContain("成功清理如下人员\n1、43");
    expect(details).toContain("清理结果未确认，请在群内核对\n1、47");
    expect(details).toContain("协议端拒绝清理\n1、48");
    expect(details).toContain("以下成员受保护\n1、46");
    expect(details).toContain("1、44\n2、45");
    expect(await command(confirm)).toBeUndefined();
    expect(calls).toEqual([[43, false], [47, false], [48, false]]);
    expect(reads).toBe(2);
    expect(permissionChecks).toBe(3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("清理待确认有效 120 秒，明确取消、撤销权限或换连接时不执行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-cleanup-signal-"));
  try {
    let now = 0, reads = 0, kicks = 0;
    const lifetime = new AbortController();
    const original = new AbortController();
    const command = createGroupActivityCleanup(pathToFileURL(`${directory}/`), lifetime.signal, () => now);
    const scope: GroupActivityContext = { ...context, groupActivitySignal: original.signal,
      async groupManageBlacklist() { return true; },
      async groupActivityRoster() { reads++; return [bot, { ...bot, userId: 43 }]; },
      async groupKick() { kicks++; return "confirmed"; },
    };
    const plan = { ...scope, normalizedMessage: "#清理从未发言的人", message_id: 1 };
    const confirm = { ...scope, normalizedMessage: "#确认清理", message_id: 2 };
    expect(isGroupActivityCleanupCommand("取消清理")).toBe(true);
    expect(await command({ ...plan, groupActivitySignal: undefined })).toBeUndefined();
    expect(await command(plan)).toContain("120 秒");
    expect(await command({ ...scope, normalizedMessage: "普通群消息", message_id: 3 })).toBeUndefined();
    expect(await command({ ...scope, normalizedMessage: "取消清理", message_id: 4 })).toBe("已取消清理。");
    expect(await command(confirm)).toBeUndefined();
    expect(await command({ ...plan, message_id: 5 })).toContain("确认清理");
    now = 120_000;
    expect(await command(confirm)).toBeUndefined();
    expect(await command({ ...plan, message_id: 6 })).toContain("确认清理");
    expect(await command({ ...confirm, message_id: 7, async groupManageBlacklist() { return false; } })).toContain("没有清理群成员");
    expect(await command({ ...plan, message_id: 8 })).toContain("确认清理");
    original.abort();
    expect(await command({ ...confirm, message_id: 9, groupActivitySignal: new AbortController().signal })).toBeUndefined();
    expect(reads).toBe(4);
    expect(kicks).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
