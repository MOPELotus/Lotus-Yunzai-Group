import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { groupLeaveBlacklistKey, matchesGroupLeaveBlacklistCommand, readGroupLeaveBlacklist,
  type GroupLeaveBlacklistEvent, type GroupLeaveBlacklistIO } from "./group-leave-blacklist.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(overrides?: Partial<GroupLeaveBlacklistIO>) {
  const dir = await mkdtemp(join(tmpdir(), "group-leave-blacklist-"));
  temporary.push(dir);
  await mkdir(join(dir, "config/config"), { recursive: true });
  const root = pathToFileURL(dir + "/");
  const legacy = new URL("config/config/group-leave-blacklist.yaml", root);
  const canonical = new URL("config/group-leave-blacklist.yaml", root);
  const stored = new Map<string, string>();
  const blocked = new Set<number>();
  const protectedIds = new Set<number>();
  const reports: [string, string][] = [];
  const io: GroupLeaveBlacklistIO = {
    async get(groupId, userId) { return stored.get(`${groupId}:${userId}`) ?? null; },
    async set(groupId, userId, json) { stored.set(`${groupId}:${userId}`, json); },
    async remove(groupId, userId) { return stored.delete(`${groupId}:${userId}`); },
    async appendGlobal(userId) {
      if (blocked.has(userId)) return "existing";
      blocked.add(userId);
      return "added";
    },
    isProtected(userId) { return protectedIds.has(userId); },
    report(stage, outcome) { reports.push([stage, outcome]); },
    ...overrides,
  };
  const session = new AbortController();
  const owner = { groupId: 77, signal: session.signal };
  const event = (kind: GroupLeaveBlacklistEvent["kind"], fields: Partial<GroupLeaveBlacklistEvent> = {}): GroupLeaveBlacklistEvent => ({
    kind, botId: 99, userId: 42, groupId: 77, session: session.signal, ...fields,
  });
  const read = () => readGroupLeaveBlacklist(root, io);
  const enable = async () => {
    await writeFile(legacy, "enable: true\ngroups: [77, '78']\n");
    return read();
  };
  return { root, io, legacy, canonical, stored, blocked, protectedIds, reports, session, owner, event, read, enable };
}

test("仅显式启用的群生效，兼容旧路径并尊重新路径关闭", async () => {
  const f = await fixture();
  expect((await f.read()).isEnabled(77)).toBe(false);
  const legacy = await f.enable();
  expect([77, 78, 79].map(legacy.isEnabled)).toEqual([true, true, false]);
  await writeFile(f.canonical, "enable: 'true'\ngroups: [77]\n");
  expect((await f.read()).isEnabled(77)).toBe(false);
  await legacy.handle(f.event("leave"));
  expect(f.stored.size).toBe(0);
  await writeFile(f.canonical, "enable: true\ngroups: [invalid]\n");
  await legacy.handle(f.event("leave"));
  await legacy.handle(f.event("leave"));
  expect(f.reports).toEqual([["config", "rejected"]]);
  await writeFile(f.canonical, "enable: true\ngroups: [77]\n");
  await legacy.handle(f.event("leave"));
  expect(f.stored.has("77:42")).toBe(true);
  await expect(readGroupLeaveBlacklist(f.root, f.io, { configName: "../other.yaml" })).rejects.toThrow("文件名");
  expect(groupLeaveBlacklistKey(77)).toBe("Yz:group-leave-blacklist:77");
});

test("退群保留旧记录形状，解除只删除当前群记录且提示全局仍生效", async () => {
  const f = await fixture();
  const policy = await f.enable();
  f.protectedIds.add(100);
  for (const invalid of [{ groupId: 79 }, { userId: 99 }, { userId: 100 }, { dismissed: true }]) {
    expect(await policy.handle(f.event("leave", invalid))).toBe(false);
  }
  expect(f.stored.size).toBe(0);
  await policy.handle(f.event("leave", { time: 1700000000, name: "旧群名片", id: "notice-1" }));
  await policy.handle(f.event("leave", { groupId: 78 }));
  expect(JSON.parse(f.stored.get("77:42")!)).toEqual({ time: 1700000000, self_id: 99, name: "旧群名片" });
  expect([...f.blocked]).toEqual([42]);
  expect(matchesGroupLeaveBlacklistCommand("#退群拉黑查询 42")).toBe(true);
  expect(matchesGroupLeaveBlacklistCommand("#退群拉黑查询 42 43")).toBe(false);
  expect(await policy.manage("#退群拉黑查询42", f.owner)).toBe("42 在本群退群黑名单中。");
  expect(await policy.manage("#退群拉黑解除 42", f.owner)).toContain("全局黑名单如有记录");
  expect(await policy.manage("#退群拉黑查询42", f.owner)).toBe("42 不在本群退群黑名单中。");
  expect(await policy.manage("#退群拉黑解除 42", { ...f.owner, groupId: 79 })).toBeUndefined();
  expect(f.stored.has("78:42")).toBe(true);
  expect(f.blocked.has(42)).toBe(true);
  await policy.handle(f.event("leave", { id: "notice-1" }));
  expect(f.stored.has("77:42")).toBe(false);
});

test("重入和申请共享群黑名单，协议失败未确认不重发，已有主人受保护", async () => {
  const f = await fixture();
  const policy = await f.enable();
  let kicks = 0, declines = 0;
  const join = f.event("join", { id: "join", async act() { kicks++; return "confirmed"; } });
  const apply = f.event("apply", { id: "apply", async act() { declines++; throw new Error("未确认"); } });
  expect(await policy.handle(join)).toBe(false);
  f.stored.set("77:42", "旧记录");
  f.protectedIds.add(42);
  expect(await policy.handle(join)).toBe(false);
  f.protectedIds.delete(42);
  expect(await Promise.all([policy.handle(join), policy.handle(join)])).toEqual([true, true]);
  expect(await Promise.all([policy.handle(apply), policy.handle(apply)])).toEqual([true, true]);
  expect(await policy.handle({ ...apply, session: new AbortController().signal })).toBe(true);
  expect(await policy.handle(f.event("apply", { async act() { return "rejected"; } }))).toBe(false);
  expect([kicks, declines]).toEqual([1, 1]);
  expect(f.reports).toEqual([["kick", "confirmed"], ["decline", "unknown"], ["decline", "rejected"]]);
});

test("Redis 不可用时不写全局，已完成的旧记录在全局写入失败后仍保留", async () => {
  let attempts = 0;
  const cannotRecord = await fixture({ async set() { attempts++; throw new Error(); } });
  const denied = await cannotRecord.enable();
  const leave = cannotRecord.event("leave", { id: "exit" });
  await Promise.all([denied.handle(leave), denied.handle(leave)]);
  expect(attempts).toBe(1);
  expect(cannotRecord.blocked.size).toBe(0);
  expect(cannotRecord.reports).toEqual([["record", "unknown"]]);

  const partial = await fixture({ async appendGlobal() { return "unavailable"; } });
  const recorded = await partial.enable();
  await recorded.handle(partial.event("leave"));
  expect(partial.stored.has("77:42")).toBe(true);
  expect(partial.reports).toEqual([["global", "unknown"]]);
  const cannotRead = await fixture({ async get() { throw new Error(); } });
  expect(await (await cannotRead.enable()).manage("#退群拉黑查询42", cannotRead.owner)).toBe("退群黑名单暂不可用。");
});

test("等待存储期间换线或成为主人会停止后续写入和协议动作", async () => {
  const switched = await fixture();
  const originalSet = switched.io.set;
  switched.io.set = async (...args) => {
    await originalSet(...args);
    switched.session.abort();
  };
  const policy = await switched.enable();
  await policy.handle(switched.event("leave"));
  expect(switched.stored.has("77:42")).toBe(true);
  expect(switched.blocked.size).toBe(0);
  expect(await policy.manage("#退群拉黑解除42", switched.owner)).toBeUndefined();

  const changed = await fixture();
  changed.io.get = async () => {
    changed.protectedIds.add(42);
    return "record";
  };
  let writes = 0;
  const join = changed.event("join", { async act() { writes++; return "confirmed"; } });
  expect(await (await changed.enable()).handle(join)).toBe(false);
  expect(writes).toBe(0);
});

test("管理员解除后，由策略自身触发的退群通知不会重建记录", async () => {
  const f = await fixture();
  const policy = await f.enable();
  f.stored.set("77:42", "existing");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const join = policy.handle(f.event("join", { async act() {
    started.resolve();
    await finish.promise;
    return "confirmed";
  } }));
  await started.promise;
  const remove = policy.manage("#退群拉黑解除42", f.owner);
  const observe = policy.handle(f.event("leave", { botId: 98, operatorId: 99 }));
  finish.resolve();
  expect(await join).toBe(true);
  expect(await remove).toContain("已解除");
  await observe;
  expect(f.stored.has("77:42")).toBe(false);
  await policy.handle(f.event("leave", { operatorId: 101 }));
  expect(f.stored.has("77:42")).toBe(true);
});
