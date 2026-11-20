import { expect, test } from "bun:test";
import { createPrivateGroupMute, isPrivateGroupMuteCommand, type PrivateGroupMuteContext, type PrivateGroupMuteResult, type PrivateGroupWholeMuteResult } from "./private-group-mute.ts";

function fixture(result?: () => Promise<PrivateGroupMuteResult>) {
  const calls: [number, number, number][] = [];
  const context = {
    adapter: "onebot",
    message_type: "private",
    self_id: 99,
    user_id: 42,
    message_id: 1,
    isBotMaster: (userId: number) => userId === 42,
    privateGroupMute: async (groupId, target, seconds) => {
      calls.push([groupId, target, seconds]);
      return result ? result() : { status: "confirmed", memberName: "群名片" };
    },
  } satisfies PrivateGroupMuteContext;
  return { calls, context, handle: createPrivateGroupMute() };
}

test("私聊旧格式解析群号、QQ、中文时长、默认单位和零时长", async () => {
  const { calls, context, handle } = fixture();
  expect(await handle("#禁言 77 510 三分钟", context)).toBe("✅ 已将群 77 的「群名片（510）」禁言 180 秒");
  await handle("#禁言77 510 300", { ...context, message_id: 2 });
  await handle("#禁言77 510 MINUTE", { ...context, message_id: 3 });
  await handle("#禁言77 510 1000毫秒", { ...context, message_id: 4 });
  await handle("#禁言77 510 0秒", { ...context, message_id: 5 });
  expect(await handle("#解禁77 42", { ...context, message_id: 6 })).toBe("✅ 已将群 77 的「群名片（42）」解除禁言");
  expect(calls).toEqual([[77, 510, 180], [77, 510, 300], [77, 510, 18000], [77, 510, 1], [77, 510, 0], [77, 42, 0]]);
});

test("私聊禁言不接群命令、非主人、委托、跨上下文、无来源消息或无效目标", async () => {
  const { calls, context, handle } = fixture();
  const command = "#禁言77 510 1秒";
  for (const invalid of ["#禁言77 510", "#禁言77 @510 10秒", "#解禁77 510 5", "#全体禁言", "#踢黑77 510"]) {
    expect(await handle(invalid, context)).toBeUndefined();
  }
  for (const invalid of [{ message_type: "group" }, { message_type: "terminal" }, { isDelegated: true },
    { message: [{ type: "at", qq: "510" }] } ] as const) {
    expect(await handle(command, { ...context, ...invalid })).toBeUndefined();
  }
  for (const invalid of [{ isBotMaster: () => false }, { privateGroupMute: undefined }, { message_id: undefined }]) {
    expect(await handle(command, { ...context, ...invalid })).toContain("没有");
  }
  expect(await handle("#禁言77 510 2147483648秒", context)).toContain("有效");
  expect(await handle("#禁言77 510 999毫秒", context)).toContain("有效");
  expect(await handle("#解禁0 510", context)).toContain("有效");
  expect(await handle("#解禁77 99", context)).toContain("受群禁言保护");
  const cancelled = new AbortController();
  cancelled.abort();
  expect(await createPrivateGroupMute(cancelled.signal)(command, context)).toBeUndefined();
  expect(calls).toEqual([]);
});

test("真实回执分别提示，未知和并发重放同一原消息不重送", async () => {
  let resolve!: (result: PrivateGroupMuteResult) => void;
  const pending = new Promise<PrivateGroupMuteResult>((settle) => { resolve = settle; });
  const { calls, context, handle } = fixture(() => pending);
  const command = "#解禁77 510";
  const first = handle(command, context);
  expect(await handle(command, context)).toEqual([]);
  resolve({ status: "unknown" });
  expect(await first).toContain("结果未确认");
  expect(await handle(command, context)).toEqual([]);
  expect(await handle(command, { ...context, adapter: "milky" })).toContain("结果未确认");
  expect(calls).toEqual([[77, 510, 0], [77, 510, 0]]);
  for (const [status, notice] of [["rejected", "协议端拒绝"], ["unavailable", "请核对成员身份与权限"],
    ["protected", "受群禁言保护"]] as const) {
    const f = fixture(async () => ({ status }));
    expect(await f.handle(command, f.context)).toContain(notice);
  }
  const failed = fixture(async () => { throw new Error("gateway response"); });
  expect(await failed.handle(command, failed.context)).toContain("结果未确认");
});

test("OneBot 兼容未标明 adapter 的可信宿主事件，和显式 OneBot 共用去重", async () => {
  const { calls, context, handle } = fixture();
  expect(await handle("#解禁77 510", { ...context, adapter: undefined, privateGroupMute: undefined })).toContain("没有群禁言权限");
  expect(await handle("#解禁77 510", { ...context, adapter: undefined })).toContain("解除禁言");
  expect(await handle("#解禁77 510", context)).toEqual([]);
  expect(calls).toEqual([[77, 510, 0]]);
});

test("私聊命令检测只认实际旧格式，不抢占同名群内入口", () => {
  expect(isPrivateGroupMuteCommand("#禁言77 510 两年")).toBe(true);
  expect(isPrivateGroupMuteCommand("#解禁 77 510")).toBe(true);
  expect(isPrivateGroupMuteCommand("#全体解禁77")).toBe(true);
  expect(isPrivateGroupMuteCommand("#踢77 510")).toBe(true);
  for (const other of ["#禁言", "#解禁510", "#全体解禁", "#全员解禁77", "#踢黑77 510", "#禁言77 510"]) {
    expect(isPrivateGroupMuteCommand(other)).toBe(false);
  }
});

test("旧私聊全体禁言和解禁只识别紧跟群号的全体语法，确认后带群名和群号", async () => {
  const { context, handle, calls: memberCalls } = fixture();
  const calls: [number, boolean][] = [];
  const wholeContext: PrivateGroupMuteContext = { ...context, async privateGroupWholeMute(groupId, enabled) {
    calls.push([groupId, enabled]);
    return { status: "confirmed", groupName: "测试群" };
  } };
  expect(await handle("#全体禁言77", { ...wholeContext, adapter: undefined })).toBe("✅ 已将群「测试群(77)」开启全体禁言");
  expect(await handle("#全体禁言77", wholeContext)).toEqual([]);
  expect(await handle("#全体解禁77", { ...wholeContext, adapter: "milky" })).toBe("✅ 已将群「测试群(77)」解除全体禁言");
  for (const other of ["#全体禁言", "#全体禁言 77", "#全员禁言77", "#全体禁言77 3分钟", "#定时全体禁言77"]) {
    expect(await handle(other, wholeContext)).toBeUndefined();
  }
  for (const group of ["0", "9007199254740993"]) {
    expect(await handle(`#全体禁言${group}`, wholeContext)).toContain("有效的群号");
  }
  expect(calls).toEqual([[77, true], [77, false]]);
  expect(memberCalls).toEqual([]);
});

test("全体禁言复用私聊主人和消息去重，未知不回退为单人操作", async () => {
  const { context, handle, calls: memberCalls } = fixture();
  let resolve!: (value: PrivateGroupWholeMuteResult) => void;
  const pending = new Promise<PrivateGroupWholeMuteResult>((settle) => { resolve = settle; });
  let calls = 0;
  const wholeContext: PrivateGroupMuteContext = { ...context, privateGroupWholeMute() { calls++; return pending; } };
  const command = "#全体解禁77";
  expect(await handle(command, context)).toContain("没有群禁言权限");
  expect(await handle(command, { ...wholeContext, isBotMaster: () => false })).toContain("没有群禁言权限");
  expect(await handle(command, { ...wholeContext, isDelegated: true })).toBeUndefined();
  expect(await handle(command, { ...wholeContext, message_type: "group" })).toBeUndefined();
  const first = handle(command, wholeContext);
  expect(await handle(command, wholeContext)).toEqual([]);
  expect(await handle("#解禁77 510", wholeContext)).toEqual([]);
  resolve({ status: "unknown", groupName: "不显示" });
  expect(await first).toBe("群 77 的解除全体禁言结果未确认，请核对当前禁言状态。");
  expect(await handle(command, wholeContext)).toEqual([]);
  expect(calls).toBe(1);
  expect(memberCalls).toEqual([]);
});

test("全体禁言区分明确拒绝、无法执行和回执异常", async () => {
  for (const [status, notice] of [["rejected", "协议端拒绝"], ["unavailable", "请核对群管理权限"]] as const) {
    const { handle, context } = fixture();
    expect(await handle("#全体禁言77", { ...context, privateGroupWholeMute: async () => ({ status }) })).toContain(notice);
  }
  const { handle, context } = fixture();
  expect(await handle("#全体禁言77", { ...context, privateGroupWholeMute: async () => { throw new Error("protocol"); } })).toContain("结果未确认");
});

test("私聊原踢人只用明确群号和 QQ，确认才报成功", async () => {
  const { context, handle, calls: muteCalls } = fixture();
  const calls: [number, number][] = [];
  const kickContext: PrivateGroupMuteContext = { ...context, adapter: undefined, async privateGroupKick(groupId, userId) {
    calls.push([groupId, userId]);
    return { status: "confirmed", memberName: "保持原 QQ 展示" };
  } };
  expect(await handle("#踢77 510", kickContext)).toBe("✅ 已将「510」踢出群聊（群 77）");
  expect(await handle("#踢 88 610", { ...kickContext, adapter: "milky" })).toContain("已将「610」");
  for (const other of ["#踢黑77 510", "#踢 510", "#踢77 @510", "#踢77 510 611", "#踢77 510 拒绝加群"]) {
    expect(await handle(other, kickContext)).toBeUndefined();
  }
  expect(await handle("#踢0 510", kickContext)).toContain("有效的群号和 QQ 号");
  expect(await handle("#踢77 9007199254740993", kickContext)).toContain("有效的群号和 QQ 号");
  expect(await handle("#踢77 99", kickContext)).toContain("受群管保护");
  expect(await handle("#踢77 42", kickContext)).toContain("受群管保护");
  expect(await handle("#踢77 510", { ...kickContext, adapter: "onebot" })).toEqual([]);
  expect(await handle("#解禁77 510", kickContext)).toEqual([]);
  expect(await handle("#踢77 510", { ...kickContext, isDelegated: true })).toBeUndefined();
  expect(await handle("#踢77 510", { ...kickContext, message: [{ type: "at", qq: 510 }] })).toBeUndefined();
  expect(await handle("#踢77 510", { ...kickContext, isBotMaster: () => false })).toContain("没有移出群成员的权限");
  expect(await handle("#踢77 510", context)).toContain("没有移出群成员的权限");
  expect(calls).toEqual([[77, 510], [88, 610]]);
  expect(muteCalls).toEqual([]);
});

test("私聊踢人保护与失败按会话回执，未知只提交原消息一次", async () => {
  for (const [status, notice] of [["rejected", "协议端拒绝"], ["protected", "受群管保护"],
    ["unavailable", "请核对成员身份与权限"], ["unknown", "结果未确认，请核对当前群成员状态"]] as const) {
    const { context, handle } = fixture();
    let calls = 0;
    const kickContext: PrivateGroupMuteContext = { ...context, async privateGroupKick() { calls++; return { status }; } };
    expect(await handle("#踢77 510", kickContext)).toContain(notice);
    expect(await handle("#踢77 510", kickContext)).toEqual([]);
    expect(calls).toBe(1);
  }
});
