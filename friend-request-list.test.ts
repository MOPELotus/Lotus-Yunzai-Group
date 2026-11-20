import { expect, test } from "bun:test";
import { friendRequestListCommand, isFriendRequestListCommand, type FriendRequestListContext, type PendingFriendRequests } from "./friend-request-list.ts";

const current = {
  message_type: "private", self_id: 99, user_id: 42, isBotMaster: (id: number) => id === 42,
} satisfies FriendRequestListContext;
const command = "#查看好友申请";

function query(result: PendingFriendRequests | undefined) {
  return friendRequestListCommand(command, { ...current, listPendingFriendRequests: async () => result });
}

test("旧查看入口保留好友申请资料、原头像和北京时间，并区分风险", async () => {
  for (const input of ["#查看好友申请", "查看好友申请", "查看全部好友申请", "#查看全部好友申请"]) {
    expect(isFriendRequestListCommand(input)).toBe(true);
  }
  for (const input of ["#同意好友申请51", "#拒绝全部好友申请", "#添加好友", "#查看群邀请", "#查看好友申请51"]) {
    expect(isFriendRequestListCommand(input)).toBe(false);
  }
  const danger = { userId: 51, nickname: "风\n\u202e险", risk: true, time: Number.MAX_SAFE_INTEGER,
    flag: "opaque-flag", uid: "opaque-uid" };
  expect(await query({ complete: false, entries: [
    { userId: 51, nickname: "申请者", source: "群内搜索", time: 1704038405, comment: "你好", risk: false },
    danger,
  ] })).toEqual({ type: "forward", nodes: [
    ["本次查到 2 条待处理好友申请，未能核验完整列表"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=51" },
      "\n申请人QQ：51\n申请人昵称：申请者\n申请来源：群内搜索\n申请时间：2024-01-01 00:00:05（北京时间）\n附加信息：你好\n普通申请"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=51" },
      "\n申请人QQ：51\n申请人昵称：风 险\n申请来源：未知\n申请时间：未知\n附加信息：无附加信息\n风险申请，请在 QQ 中查看。"],
  ] });
});

test("只由当前机器人主人私聊使用，其他消息不会读取好友请求", async () => {
  let calls = 0;
  const scope: FriendRequestListContext = { ...current, async listPendingFriendRequests() {
    calls++;
    return { entries: [], complete: false };
  } };
  expect(await friendRequestListCommand(command, { ...scope, message_type: "group" })).toBeUndefined();
  expect(await friendRequestListCommand(command, { ...scope, message_type: "terminal" })).toBeUndefined();
  expect(await friendRequestListCommand(command, { ...scope, isDelegated: true })).toBeUndefined();
  expect(await friendRequestListCommand(command, { ...scope, user_id: 43 })).toContain("请由当前机器人的主人");
  expect(await friendRequestListCommand(command, current)).toContain("当前无法核验");
  const signal = new AbortController();
  signal.abort();
  expect(await friendRequestListCommand(command, scope, signal.signal)).toBeUndefined();
  expect(calls).toBe(0);
});

test("有限窗口为空不声称无请求，不可核验独立提示，限制合并转发长度", async () => {
  expect(await query({ complete: true, entries: [] })).toContain("暂无好友申请");
  expect(await query({ complete: false, entries: [] })).toContain("未能核验完整列表");
  expect(await query(undefined)).toContain("当前无法核验");
  expect(await query({ complete: false, entries: [{ userId: 0 }] })).toContain("当前无法核验");
  const reply = await query({ complete: false, entries: Array.from({ length: 51 }, (_, index) => ({ userId: index + 100,
    comment: "长".repeat(520) })) });
  if (typeof reply !== "object") throw new Error("预期好友申请列表合并转发");
  expect(reply.nodes).toHaveLength(51);
  expect(reply.nodes[0]?.join("")).toContain("仅展示前 50 条");
  expect(reply.nodes[1]?.[1]).toContain("…");
});

test("模块卸载时不会展示刚取得的好友申请", async () => {
  const signal = new AbortController();
  expect(await friendRequestListCommand(command, { ...current, async listPendingFriendRequests() {
    signal.abort();
    return { entries: [{ userId: 51 }], complete: false };
  } }, signal.signal)).toBeUndefined();
});

test("查询期间失去当前机器人主人权限时不展示快照", async () => {
  let owner = true;
  expect(await friendRequestListCommand(command, { ...current, isBotMaster: () => owner, async listPendingFriendRequests() {
    owner = false;
    return { entries: [{ userId: 51 }], complete: false };
  } })).toBeUndefined();
});
