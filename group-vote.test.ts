import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupVote, type GroupVoteContext, type GroupVotePart, type GroupVoteResult, type GroupVoteRoles } from "./group-vote.ts";
import { createManagedBlacklist, type GroupVoteSettings } from "./managed-blacklist.ts";

function fixture(overrides: Partial<GroupVoteSettings> = {}) {
  const module = new AbortController(), connection = new AbortController(), session = new AbortController();
  const timers = new Set<{ at: number; callback: () => void }>();
  const notices: { parts: readonly GroupVotePart[]; quote: boolean }[] = [];
  const actions: unknown[][] = [];
  let settings: GroupVoteSettings = { VoteBan: true, VoteKick: false, outTime: 70, minNum: 3, BanTime: 180, veto: true, voteAdmin: false, ...overrides };
  let now = 0, message_id = 0;
  async function advance(milliseconds: number) {
    now += milliseconds;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now && timers.delete(timer)) timer.callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  const vote = createGroupVote({
    async readGroupVoteSettings() { return settings; },
    async setGroupVoteSetting(field, value, _signal, authorize) {
      if (await authorize?.() !== true) return false;
      settings = { ...settings, [field]: value };
      return true;
    },
  }, module.signal, { now: () => now, schedule(ms, callback) {
    const timer = { at: now + ms, callback };
    timers.add(timer);
    return () => { timers.delete(timer); };
  } });
  function context(user = 41, roles: Partial<GroupVoteRoles> = {}, results: { send?: boolean; execute?: GroupVoteResult } = {}): GroupVoteContext {
    return { adapter: "onebot", message_type: "group", self_id: 99, group_id: 77, user_id: user, message_id: ++message_id,
      groupVote: { signal: session.signal, connection: connection.signal,
        async inspect() { return { actor: "member", bot: "admin", target: "member", protectedTarget: false, ...roles }; },
        async canConfigure() { return user === 55; },
        async execute(...args) { actions.push([user, ...args]); return results.execute ?? "confirmed"; },
        async reply(parts, quote = false) { notices.push({ parts, quote }); return results.send ?? true; },
      },
    };
  }
  return { vote, context, advance, notices, actions, timers, connection, session, module, settings: () => settings };
}

test("原群投票先确认通知、计发起者和唯一成员票，剩一分钟提示，到时按支持票门槛实际禁言", async () => {
  const f = fixture();
  expect(await f.vote.command("#发起投票禁言", { ...f.context(), message: [{ type: "at", qq: 99 }, { type: "at", qq: "50" }] })).toEqual([]);
  expect(f.notices[0]).toMatchObject({ quote: true, parts: [{ type: "at", qq: 50 }, expect.any(String), { type: "at", qq: 41 },
    expect.any(String), expect.any(String), expect.any(String), expect.any(String)] });
  expect(await f.vote.command("#投票踢人50", f.context(42))).toContain("已有相同投票");
  expect(await f.vote.command("#支持投票50", f.context(41))).toContain("已参与过");
  expect(await f.vote.command("#支持投票50", f.context(42))).toMatchObject({ type: "quoted", message: expect.stringContaining("支持：2") });
  expect(await f.vote.command("#反对投票50", f.context(43))).toMatchObject({ type: "quoted", message: expect.stringContaining("反对：1") });
  expect(await f.vote.command("#支持投票50", f.context(44))).toMatchObject({ type: "quoted", message: expect.stringContaining("支持：3") });
  await f.advance(9_999);
  expect(f.notices).toHaveLength(1);
  await f.advance(1);
  expect(f.notices[1]?.parts.join(" ")).toContain("仅剩一分钟");
  expect(f.actions).toEqual([]);
  await f.advance(60_000);
  expect(f.actions).toEqual([[41, 50, "mute", 180, false, false]]);
  expect(f.notices[2]?.parts).toEqual(["投票结束，投票结果：\n支持票数：3\n反对票数：1\n已禁言目标 50。"]);
  expect(f.timers.size).toBe(0);
});

test("群管理一票反对取消，一票支持也等真实回执，同一命令和定时不会双发", async () => {
  const f = fixture({ VoteKick: true, minNum: 8 });
  const start = "#投票踢人50";
  expect(await f.vote.command(start, f.context())).toEqual([]);
  expect(await f.vote.command("#反对投票50", f.context(42, { actor: "owner" }))).toMatchObject({ type: "quoted", message: expect.stringContaining("管理员介入") });
  await f.advance(80_000);
  expect(f.actions).toEqual([]);
  expect(await f.vote.command(start, f.context())).toEqual([]);
  const deciding = f.context(42, { actor: "admin" }, { execute: "unknown" });
  const decision = await Promise.all([f.vote.command("#支持投票50", deciding), f.vote.command("#支持投票50", deciding)]);
  expect(decision).toContainEqual([]);
  expect(decision).toContainEqual({ type: "quoted", message: "投票结束，管理员介入。操作结果未确认，请先在 QQ 核对。" });
  await f.advance(80_000);
  expect(f.actions).toEqual([[42, 50, "kick", 0, false, true]]);
});

test("连接、群和协议隔离，软关机、旧连接失效与未确认发起都清除活动", async () => {
  const f = fixture({ outTime: 10, minNum: 1 });
  expect(await f.vote.command("#投票禁言50", f.context(41, {}, { send: false }))).toContain("未启动计票");
  expect(f.timers.size).toBe(0);
  expect(await f.vote.command("#投票禁言50", f.context())).toEqual([]);
  expect(await f.vote.command("#支持投票50", { ...f.context(42), adapter: "milky" })).toContain("未找到");
  expect(await f.vote.command("#支持投票50", { ...f.context(42), group_id: 78 })).toContain("未找到");
  const connected = f.context(42);
  expect(await f.vote.command("#支持投票50", { ...connected, groupVote: { ...connected.groupVote!, connection: new AbortController().signal } })).toContain("未找到");
  f.session.abort();
  await f.advance(50_000);
  expect(f.actions).toEqual([]);
  expect(f.notices).toHaveLength(2);
  const resumed = f.context();
  expect(await f.vote.command("#投票禁言50", { ...resumed, groupVote: { ...resumed.groupVote!, signal: new AbortController().signal } })).toEqual([]);
  f.connection.abort();
  await f.advance(50_000);
  expect(f.timers.size).toBe(0);
  expect(f.actions).toEqual([]);
  await f.vote.stop();
});

test("普通人可发起和投票，设置限主人，管理员目标需配置且机器人为群主", async () => {
  const f = fixture({ VoteBan: false, voteAdmin: true, outTime: 10, minNum: 1 });
  expect(await f.vote.command("#投票禁言50", f.context())).toContain("已被禁用");
  expect(await f.vote.command("#启用投票禁言", f.context())).toContain("没有设置");
  expect(await f.vote.command("#启用投票禁言", f.context(55))).toContain("已启用");
  expect(await f.vote.command("#投票设置禁言时间42", f.context(55))).toContain("已将禁言时间设为42");
  expect(await f.vote.command("#投票禁言41", f.context())).toContain("不能对自己");
  expect(await f.vote.command("#投票禁言99", f.context())).toContain("对机器人无效");
  expect(await f.vote.command("#投票禁言50", f.context(41, { target: "owner" }))).toContain("对群主无效");
  expect(await f.vote.command("#投票禁言50", f.context(41, { protectedTarget: true }))).toContain("主人或机器人");
  expect(await f.vote.command("#投票禁言50", f.context(41, { target: "admin" }))).toContain("对管理员无效");
  expect(await f.vote.command("#投票禁言50", f.context(41, { target: "admin", bot: "owner" }))).toEqual([]);
  expect(await f.vote.command("#禁用投票禁言", f.context(55))).toContain("已禁用");
  await f.advance(20_000);
  expect(f.timers.size).toBe(0);
  expect(f.actions).toEqual([]);
});

test("新安装投票不默认开，旧默认和规范字段优先，写入只改变 YAML 目标字节", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-group-vote-"));
  try {
    const primary = join(directory, "config/groupAdmin.yaml"), legacy = join(directory, "plugins/yenai-plugin/config/config/groupAdmin.yaml");
    await mkdir(join(directory, "config"));
    await mkdir(join(directory, "plugins/yenai-plugin/config/config"), { recursive: true });
    const settings = createManagedBlacklist(pathToFileURL(directory + "/"), async () => ({ close() {} }));
    expect(await settings.readGroupVoteSettings()).toMatchObject({ VoteBan: false, VoteKick: false, outTime: 180, minNum: 4, BanTime: 3600 });
    const original = '\uFEFF# 旧配置\r\noutTime: "70" # 原值\r\nminNum: 8\r\nwhiteQQ: [21, 32] # 保留\r\n';
    await writeFile(legacy, original);
    const override = "VoteKick: true # 新路径明确配置\nother: [a,b]\n";
    await writeFile(primary, override);
    expect(await settings.readGroupVoteSettings()).toMatchObject({ VoteBan: true, VoteKick: true, outTime: 70, minNum: 8 });
    expect(await settings.setGroupVoteSetting("outTime", 10, undefined, async () => true)).toBe(true);
    expect(await settings.setGroupVoteSetting("VoteKick", false, undefined, async () => true)).toBe(true);
    expect(await readFile(legacy, "utf8")).toBe(original.replace('"70"', "10"));
    expect(await readFile(primary, "utf8")).toBe(override.replace("true", "false"));
    expect(await settings.readGroupVoteSettings()).toMatchObject({ VoteBan: true, VoteKick: false, outTime: 10 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
