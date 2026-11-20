import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupTimedMute, isGroupTimedMuteCommand, type GroupTimedMuteBinding, type GroupTimedMuteServices } from "./group-timed-mute.ts";

async function fixture(old?: unknown) {
  const path = await mkdtemp(join(tmpdir(), "lotus-timed-mute-"));
  const root = pathToFileURL(`${path}/`);
  const state = new URL("data/group/mute-schedule.json", root);
  const jobs = new Map<string, { cron: string; run(): Promise<void> }>();
  const calls: GroupTimedMuteBinding[] = [];
  const reports: unknown[] = [];
  const lockFile = async () => ({ close() {} });
  const events = new AbortController();
  const services: GroupTimedMuteServices = {
    async readLegacy() { return old === undefined ? null : JSON.stringify(old); },
    validateCron: (cron) => !/[W]/u.test(cron) && cron !== "0 0 99 * * ?",
    register(name, cron, run) {
      jobs.set(name, { cron, run });
      return () => { jobs.delete(name); };
    },
    async execute(binding) {
      calls.push(binding);
      return "confirmed";
    },
    report(_binding, result) { reports.push(result); },
  };
  const create = () => createGroupTimedMute(root, lockFile, services, events.signal);
  const defaultGroup = { message_type: "group" as const, group_id: 77, self_id: 99, user_id: 42, isBotMaster: () => false,
    async groupManageBlacklist() { return true; } };
  let messageId = 0;
  const run = (module: Awaited<ReturnType<typeof create>>, normalizedMessage: string,
    scope: Partial<Parameters<typeof module.command>[0]> = {}) => module.command({
      ...defaultGroup, message_id: ++messageId, normalizedMessage, ...scope,
    });
  const cleanup = async () => { events.abort(); await rm(path, { recursive: true, force: true }); };
  return { root, state, jobs, calls, reports, services, create, run, cleanup };
}

test("旧定时禁言键只读取，待绑定只由同群原机器人明确认领，取消后旧记录不复活", async () => {
  const records = [{ group: "77", type: true, botId: "99", cron: "0 30 23 * * ?" },
    { group: 77, type: false, cron: "0 00 6 * * ? 2040" }, { group: 88, type: true, botId: 99, cron: "0 0 23 * * ?" }];
  const f = await fixture(records);
  try {
    let tasks = await f.create();
    expect(f.jobs.size).toBe(0);
    await expect(readFile(f.state)).rejects.toMatchObject({ code: "ENOENT" });
    const original = await f.services.readLegacy();
    const initial = await f.run(tasks, "#定时禁言任务");
    expect(JSON.stringify(initial)).toContain("待绑定");
    expect(JSON.stringify(initial)).toContain("旧 cron 无法调度");
    expect(JSON.stringify(initial)).toContain("https://p.qlogo.cn/gh/77/77/100");
    expect(JSON.stringify(initial)).not.toContain("/88/88");
    expect(await f.run(tasks, "#绑定旧定时禁言", { self_id: 100 })).toContain("没有可绑定");
    expect(await f.run(tasks, "#定时禁言22:00")).toContain("待绑定");
    expect(await f.run(tasks, "#绑定旧定时禁言", { adapter: "milky" })).toContain("已保存");
    expect([...f.jobs.values()].map(({ cron }) => cron)).toEqual(["0 30 23 * * ?"]);
    await [...f.jobs.values()][0]?.run();
    expect(f.calls[0]).toMatchObject({ adapter: "milky", groupId: 77, botId: 99, issuerId: 42, enabled: true });
    expect(await f.run(tasks, "#取消定时解禁")).toContain("已取消");
    expect(await f.run(tasks, "#取消定时禁言")).toContain("已取消");
    await tasks.stop();
    tasks = await f.create();
    expect(f.jobs.size).toBe(0);
    expect(await f.run(tasks, "#定时禁言任务")).toContain("没有定时禁言任务");
    expect(await f.services.readLegacy()).toBe(original);
    await tasks.stop();
  } finally { await f.cleanup(); }
});

test("合法旧快捷时间及六段 cron 重启恢复，重复、无权限和无效时间不上调度", async () => {
  const f = await fixture();
  try {
    let tasks = await f.create();
    expect(isGroupTimedMuteCommand("#设置定时解禁6：30")).toBe(true);
    expect(await f.run(tasks, "#定时禁言24:00")).toContain("有效的时间");
    expect(await f.run(tasks, "#定时禁言 0 0 7 1W * ?")).toContain("有效的时间");
    expect(await f.run(tasks, "#定时禁言 0 0 7 * * ? 2040")).toContain("有效的时间");
    expect(await f.run(tasks, "#定时禁言 0 0 7 1 * MON")).toContain("有效的时间");
    expect(await f.run(tasks, "#定时解禁6:30", { async groupManageBlacklist() { return false; } })).toContain("没有管理");
    expect(await f.run(tasks, "#定时解禁6:30", { isDelegated: true })).toBeUndefined();
    expect(await f.run(tasks, "#定时解禁6:30", { message_type: "private" })).toBeUndefined();
    expect(await f.run(tasks, "#设置定时解禁6：30", { message_id: 99 })).toContain("已保存");
    expect(await f.run(tasks, "#取消定时解禁", { message_id: 99 })).toEqual([]);
    expect(await f.run(tasks, "#定时禁言 0 0 22 ? * MON")).toContain("已保存");
    expect(await f.run(tasks, "#定时禁言21:30", { self_id: 100 })).toContain("已有");
    await tasks.stop();
    expect(f.jobs.size).toBe(0);
    tasks = await f.create();
    expect([...f.jobs.values()].map(({ cron }) => cron)).toEqual(["0 30 6 * * ?", "0 0 22 ? * MON"]);
    for (const job of f.jobs.values()) await job.run();
    expect(f.calls.map(({ enabled, issuerId }) => [enabled, issuerId])).toEqual([[false, 42], [true, 42]]);
    await tasks.stop();
  } finally { await f.cleanup(); }
});

test("已保存但注册失败可按原设置重试，取消停止在途信号且未知不重发", async () => {
  const f = await fixture();
  try {
    let registerFailures = 1;
    const register = f.services.register;
    f.services.register = (...args) => {
      if (registerFailures-- > 0) throw new Error("scheduler unavailable");
      return register(...args);
    };
    const started = Promise.withResolvers<AbortSignal>();
    f.services.execute = async (entry, signal) => {
      f.calls.push(entry);
      started.resolve(signal);
      await new Promise<void>((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
      return "unknown";
    };
    const tasks = await f.create();
    expect(await f.run(tasks, "#定时禁言21:30")).toContain("已保存，但暂未注册");
    expect(await f.run(tasks, "#定时禁言21:30", { self_id: 100 })).toContain("已有");
    expect(await f.run(tasks, "#定时禁言21:30")).toContain("已保存");
    const run = [...f.jobs.values()][0]!.run;
    const pending = run();
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    await run();
    expect(await f.run(tasks, "#取消定时禁言")).toContain("已取消");
    expect(signal.aborted).toBe(true);
    await pending;
    await run();
    expect(f.calls).toHaveLength(1);
    expect(f.reports).toEqual(["unavailable", "unknown"]);
    await tasks.stop();
  } finally { await f.cleanup(); }
});

test("更新提交前重新授权，拒绝覆盖锁外修改或损坏文件", async () => {
  const f = await fixture();
  try {
    const tasks = await f.create();
    let checks = 0;
    expect(await f.run(tasks, "#定时禁言21:30", { async groupManageBlacklist() { return ++checks === 1; } })).toContain("没有管理");
    await expect(readFile(f.state)).rejects.toMatchObject({ code: "ENOENT" });
    checks = 0;
    expect(await f.run(tasks, "#定时禁言21:30", { async groupManageBlacklist() {
      if (++checks === 2) await writeFile(f.state, "externally changed");
      return true;
    } })).toContain("配置暂不可用");
    expect(await readFile(f.state, "utf8")).toBe("externally changed");
    expect(await f.run(tasks, "#定时禁言21:30")).toContain("配置暂不可用");
    expect(f.jobs.size).toBe(0);
    await tasks.stop();
  } finally { await f.cleanup(); }
});
