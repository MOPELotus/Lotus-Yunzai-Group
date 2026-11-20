import { expect, test } from "bun:test";
import { createPrivateGroupMute, isPrivateGroupMuteCommand, type PrivateGroupMuteContext, type PrivateGroupMuteResult } from "./private-group-mute.ts";

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
  for (const invalid of ["#禁言77 510", "#禁言77 @510 10秒", "#解禁77 510 5", "#全体禁言77", "#踢77 510"]) {
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
  for (const other of ["#禁言", "#解禁510", "#全体解禁77", "#踢77 510", "#禁言77 510"]) {
    expect(isPrivateGroupMuteCommand(other)).toBe(false);
  }
});
