import { expect, test } from "bun:test";
import { isRequestOverviewCommand, requestOverviewCommand } from "./request-overview.ts";

const command = "#查看全部请求";
const owner = { message_type: "private" as const, self_id: 99, user_id: 42, isBotMaster: (id: number) => id === 42 };

test("原请求总览仅显示当前机器人账号窗口及未核实的单向好友", async () => {
  expect(isRequestOverviewCommand(command)).toBe(true);
  expect(isRequestOverviewCommand("查看全部请求")).toBe(true);
  expect(isRequestOverviewCommand("#查看请求")).toBe(false);
  const calls: string[] = [];
  expect(await requestOverviewCommand(command, {
    ...owner,
    async listPendingFriendRequests() {
      calls.push("friend");
      return { entries: [{ userId: 51 }, { userId: 51, risk: true }], complete: false };
    },
    async listPendingGroupInvitations() {
      calls.push("invitation");
      return { entries: [{ groupId: 77, inviterId: 51 }], complete: true };
    },
    async groupListPendingJoinRequests() { throw new Error("不得读取某群待审"); },
  })).toEqual({
    type: "forward", nodes: [["以下为暂未处理的请求"],
      ["好友申请：本次查到 2 条，未能核验完整列表\n可使用 #查看好友申请 查看详情"],
      ["群邀请：1 条\n可使用 #查看群邀请 查看详情"],
      ["单向好友：未核实"]],
  });
  expect(calls).toEqual(["friend", "invitation"]);
});

test("当前机器人主人群内仅能查看本群，不读取、计数或透露账号级窗口", async () => {
  let called = 0;
  const scope = {
    ...owner, message_type: "group" as const, group_id: 77,
    async groupListPendingJoinRequests() { called++; return { entries: [{ userId: 51 }], complete: true }; },
    async listPendingFriendRequests() { called++; return { entries: [], complete: true }; },
    async listPendingGroupInvitations() { called++; return { entries: [], complete: true }; },
  };
  expect(await requestOverviewCommand(command, scope)).toEqual({
    type: "forward", nodes: [["以下为暂未处理的请求"], ["当前群申请：1 条\n可使用 #查看加群申请 查看详情"]],
  });
  expect(await requestOverviewCommand(command, { ...scope, group_id: undefined })).toBeUndefined();
  expect(called).toBe(1);
});

test("窗口为空、完整空和失败各自展示，单项失败不丢另一项", async () => {
  expect(await requestOverviewCommand(command, { ...owner, async listPendingFriendRequests() { return { entries: [], complete: false }; },
    async listPendingGroupInvitations() { throw new Error("服务不可用"); } })).toEqual({
    type: "forward", nodes: [["以下为暂未处理的请求"], ["好友申请：本次查询范围内未发现，未能核验完整列表"],
      ["群邀请：未核实"], ["单向好友：未核实"]],
  });
  expect(await requestOverviewCommand(command, { ...owner, message_type: "group", group_id: 77,
    async groupListPendingJoinRequests() { return { entries: [], complete: true }; } })).toEqual({
    type: "forward", nodes: [["以下为暂未处理的请求"], ["当前群申请：0 条"]],
  });
  expect(await requestOverviewCommand(command, { ...owner, message_type: "group", group_id: 77 })).toEqual({
    type: "forward", nodes: [["以下为暂未处理的请求"], ["当前群申请：未核实"]],
  });
});

test("只接受当前机器人主人，委托、终端和查询期间撤权不会展示", async () => {
  let allowed = true;
  let called = 0;
  const scope = { ...owner, isBotMaster: () => allowed, async listPendingFriendRequests() {
    called++;
    allowed = false;
    return { entries: [{ userId: 51 }], complete: true };
  } };
  expect(await requestOverviewCommand(command, { ...scope, message_type: "terminal" })).toBeUndefined();
  expect(await requestOverviewCommand(command, { ...scope, isDelegated: true })).toBeUndefined();
  expect(await requestOverviewCommand(command, { ...scope, isBotMaster: () => false })).toContain("仅当前机器人的主人");
  expect(await requestOverviewCommand(command, scope, AbortSignal.abort())).toBeUndefined();
  expect(called).toBe(0);
  expect(await requestOverviewCommand(command, scope)).toBeUndefined();
  expect(called).toBe(1);
});
