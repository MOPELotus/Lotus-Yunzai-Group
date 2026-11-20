import { expect, test } from "bun:test";
import { groupPendingJoinCommand, isGroupPendingJoinCommand, type GroupPendingJoinContext, type PendingGroupJoins } from "./group-pending-join.ts";

const current = { message_type: "group", self_id: 99, group_id: 77, user_id: 42 } satisfies GroupPendingJoinContext;
const command = "#查看加群申请";

function query(result: PendingGroupJoins | undefined) {
  return groupPendingJoinCommand(command, { ...current, groupListPendingJoinRequests: async () => result });
}

test("群内普通成员的旧列表入口与同名直接审核、总览保持独立", async () => {
  for (const input of ["#查看加群申请", "#查看入群申请", "查看群申请", "查看全部加群申请"]) {
    expect(isGroupPendingJoinCommand(input)).toBe(true);
  }
  for (const input of ["同意加群申请510", "#拒绝全部加群申请", "#查看全部请求", "#查看好友申请", "#查看群申请510"]) {
    expect(isGroupPendingJoinCommand(input)).toBe(false);
  }

  const reply = await query({ complete: true, entries: [
    { userId: 510, nickname: "申请人", comment: "你好群友", tip: "来自群名片" },
    { userId: 511, nickname: "风险\n\u202e账号", comment: "附言", risk: true },
    { userId: 510 },
  ] });
  expect(reply).toEqual({ type: "forward", nodes: [
    ["现有未处理的加群申请如下，共 3 条"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=510" }, "\nQQ：510\n昵称：申请人\nTips：来自群名片\n附加信息：你好群友"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=511" }, "\nQQ：511\n昵称：风险 账号\n风险申请，请在 QQ 中处理。\n附加信息：附言"],
    [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=510" }, "\nQQ：510\n昵称：未知\n附加信息：无附加信息"],
  ] });
});

test("只区分完整空快照、部分空快照和未核验的网关回执", async () => {
  expect(await query({ complete: true, entries: [] })).toContain("暂无加群申请");
  expect(await query({ complete: false, entries: [] })).toContain("未能核验完整列表");
  expect(await query(undefined)).toContain("当前无法核验");
  expect(await query({ complete: true, entries: [{ userId: Number.NaN }] })).toContain("当前无法核验");
  expect(await query({ complete: false, entries: [{ userId: 510 }] })).toMatchObject({
    type: "forward", nodes: [["本次查到 1 条待处理加群申请，未能核验完整列表"], expect.any(Array)],
  });
});

test("超长列表和附言有展示上限，不下发协议内部字段或旧审核指令", async () => {
  const reply = await query({ complete: true, entries: Array.from({ length: 55 }, (_, index) => ({
    userId: 1000 + index, nickname: "申请", comment: "测".repeat(600), flag: "opaque-id", notificationSeq: "secret-seq",
  })) });
  if (typeof reply !== "object") throw new Error("预期合并转发");
  expect(reply.nodes).toHaveLength(51);
  expect(reply.nodes[0]?.join("")).toContain("仅展示前 50 条");
  expect(reply.nodes[1]?.[1]).toContain("…");
  const rendered = JSON.stringify(reply);
  for (const internal of ["opaque-id", "secret-seq", "同意加群申请", "拒绝全部"]) expect(rendered).not.toContain(internal);
});

test("不从私聊、委托、无会话或卸载期间读取和展示同群请求", async () => {
  let called = 0;
  const scope = { ...current, groupListPendingJoinRequests: async () => { called++; return { entries: [], complete: true }; } };
  expect(await groupPendingJoinCommand(command, { ...scope, message_type: "private" })).toBeUndefined();
  expect(await groupPendingJoinCommand(command, { ...scope, isDelegated: true })).toContain("当前无法核验");
  expect(await groupPendingJoinCommand(command, { ...scope, group_id: undefined })).toContain("当前无法核验");
  expect(await groupPendingJoinCommand(command, { ...scope, groupListPendingJoinRequests: undefined })).toContain("当前无法核验");
  const controller = new AbortController();
  controller.abort();
  expect(await groupPendingJoinCommand(command, scope, controller.signal)).toContain("当前无法核验");
  expect(called).toBe(0);
  const live = new AbortController();
  expect(await groupPendingJoinCommand(command, { ...scope, groupListPendingJoinRequests: async () => {
    live.abort(); return { complete: true, entries: [{ userId: 510 }] };
  } }, live.signal)).toBeUndefined();
});
