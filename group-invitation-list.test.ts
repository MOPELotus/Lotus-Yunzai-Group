import { expect, test } from "bun:test";
import { groupInvitationListCommand, isGroupInvitationListCommand, type GroupInvitationListContext, type PendingGroupInvitations } from "./group-invitation-list.ts";

const current = {
  message_type: "private", self_id: 99, user_id: 42, isBotMaster: (id: number) => id === 42,
} satisfies GroupInvitationListContext;
const command = "#查看群邀请";

function query(result: PendingGroupInvitations | undefined) {
  return groupInvitationListCommand(command, { ...current, listPendingGroupInvitations: async () => result });
}

test("旧群邀请列表保留群头像和已确认的邀请者资料", async () => {
  for (const input of ["#查看群邀请", "查看全部群邀请"]) expect(isGroupInvitationListCommand(input)).toBe(true);
  for (const input of ["#查看群邀请77", "#查看加群申请", "#同意群邀请77", "#查看全部请求"]) {
    expect(isGroupInvitationListCommand(input)).toBe(false);
  }
  expect(await query({ complete: false, entries: [
    { groupId: 77, groupName: "群\n\u202e名", inviterId: 51, nickname: "邀请人", role: "admin" },
    { groupId: 88, inviterId: 52 },
  ] })).toEqual({ type: "forward", nodes: [
    ["本次查到 2 条待处理群邀请，未能核验完整列表"],
    [{ type: "image", file: "https://p.qlogo.cn/gh/77/77/100" },
      "\n邀请群号：77\n邀请群名：群 名\n邀请人QQ：51\n邀请人昵称：邀请人\n邀请人身份：群管理"],
    [{ type: "image", file: "https://p.qlogo.cn/gh/88/88/100" },
      "\n邀请群号：88\n邀请群名：未知\n邀请人QQ：52\n邀请人昵称：未知"],
  ] });
});

test("只允许当前机器人的原生主人私聊读取，不在群内泄露邀请", async () => {
  let calls = 0;
  const scope: GroupInvitationListContext = { ...current, listPendingGroupInvitations: async () => {
    calls++; return { entries: [], complete: false };
  } };
  expect(await groupInvitationListCommand(command, { ...scope, message_type: "group" })).toBeUndefined();
  expect(await groupInvitationListCommand(command, { ...scope, message_type: "terminal" })).toBeUndefined();
  expect(await groupInvitationListCommand(command, { ...scope, isDelegated: true })).toBeUndefined();
  expect(await groupInvitationListCommand(command, { ...scope, user_id: 43 })).toContain("请由当前机器人的主人");
  expect(await groupInvitationListCommand(command, { ...scope, self_id: undefined })).toContain("请由当前机器人的主人");
  expect(await groupInvitationListCommand(command, current)).toContain("当前无法核验");
  const signal = new AbortController();
  signal.abort();
  expect(await groupInvitationListCommand(command, scope, signal.signal)).toBeUndefined();
  expect(calls).toBe(0);
});

test("区分完整空、有限空和不可核验，缩短过长结果且不展示原序号", async () => {
  expect(await query({ complete: true, entries: [] })).toContain("暂无群邀请");
  expect(await query({ complete: false, entries: [] })).toContain("未能核验完整列表");
  expect(await query(undefined)).toContain("当前无法核验");
  expect(await query({ complete: true, entries: [{ groupId: 77, inviterId: Number.NaN }] })).toContain("当前无法核验");
  const reply = await query({ complete: false, entries: Array.from({ length: 51 }, (_, index) =>
    ({ groupId: 200 + index, inviterId: 100, requestId: "opaque", comment: "不披露网关原字段" })) });
  if (typeof reply !== "object") throw new Error("预期合并转发");
  expect(reply.nodes).toHaveLength(51);
  expect(reply.nodes[0]?.join("")).toContain("仅展示前 50 条");
  expect(JSON.stringify(reply)).not.toContain("opaque");
  expect(JSON.stringify(reply)).not.toContain("不披露网关原字段");
});

test("模块卸载期间收到网关快照后不再展示", async () => {
  const signal = new AbortController();
  expect(await groupInvitationListCommand(command, { ...current, async listPendingGroupInvitations() {
    signal.abort();
    return { entries: [{ groupId: 77, inviterId: 51 }], complete: false };
  } }, signal.signal)).toBeUndefined();
});
