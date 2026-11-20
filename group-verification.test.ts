import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupVerification, type GroupVerificationAnswer, type GroupVerificationContext, type GroupVerificationJoin } from "./group-verification.ts";
import { createManagedBlacklist, type GroupVerificationSettings } from "./managed-blacklist.ts";
import type { GroupVotePart, GroupVoteResult } from "./group-vote.ts";

function fixture(override: Partial<GroupVerificationSettings> = {}) {
  const module = new AbortController(), connection = new AbortController(), session = new AbortController();
  const sent: { source: "join" | "answer"; parts: readonly GroupVotePart[] }[] = [];
  const kicks: (number | undefined)[] = [];
  const recalls: (number | string)[] = [];
  const tasks = new Set<{ at: number; callback: () => void }>();
  let config: GroupVerificationSettings = { enabled: true, mode: "精确", times: 2, time: 120, delay: 2,
    min: 10, max: 11, remind: true, success: "本群验证成功", ...override };
  let now = 0, messageId = 100;
  let whitelist = new Set<number>();
  let roles: Awaited<ReturnType<GroupVerificationJoin["inspect"]>> = { botRole: "admin", targetRole: "member", protectedTarget: false, targetJoinTime: 99 };
  let gateway: GroupVoteResult = "confirmed";
  let promptAcknowledged = true;
  const waitTasks = () => new Promise<void>(done => setImmediate(done));
  const verify = createGroupVerification({
    async readGroupVerificationSettings() { return config; },
    async setGroupVerification(_group, enabled, _signal, authorize) {
      if (await authorize?.() !== true || config.enabled === enabled) return false;
      config = { ...config, enabled };
      return true;
    },
  }, async user => whitelist.has(user), module.signal, {
    random: min => min, now: () => now, schedule(delay, callback) {
      const entry = { at: now + delay, callback };
      tasks.add(entry);
      return () => { tasks.delete(entry); };
    },
  });
  const scope = { adapter: "onebot" as const, botId: 99, groupId: 77, userId: 43, connection: connection.signal, signal: session.signal };
  const event: GroupVerificationJoin = { ...scope, time: 100, async inspect() { return roles; },
    async reply(parts) { sent.push({ source: "join", parts }); return promptAcknowledged; },
    async kick(_signal, expectedJoin) { kicks.push(expectedJoin); return gateway; },
  };
  const answer = (text: string, overrides: Partial<GroupVerificationAnswer> = {}): GroupVerificationAnswer => {
    const id = overrides.messageId ?? ++messageId;
    return { ...scope, text, messageId: id, async canAnswer() { return true; }, async recall() { recalls.push(id); },
      async reply(parts) { sent.push({ source: "answer", parts }); return true; }, ...overrides };
  };
  const command = (changes: Partial<GroupVerificationContext> = {}): GroupVerificationContext => ({
    message_type: "group", adapter: "onebot", self_id: 99, user_id: 55, group_id: 77, message_id: ++messageId,
    groupVerification: scope, async groupManageBlacklist() { return true; }, ...changes,
  });
  async function advance(ms: number) {
    now += ms;
    for (const task of [...tasks].sort((a, b) => a.at - b.at)) if (task.at <= now && tasks.delete(task)) task.callback();
    await waitTasks();
  }
  return { verify, event, answer, command, advance, tasks, sent, recalls, kicks, session, connection,
    setRoles: (value: typeof roles) => { roles = value; }, setGateway: (value: GroupVoteResult) => { gateway = value; },
    setPrompt: (value: boolean) => { promptAcknowledged = value; }, setConfig: (value: Partial<GroupVerificationSettings>) => { config = { ...config, ...value }; },
    setWhitelist: (...users: number[]) => { whitelist = new Set(users); } };
}

test("按旧延迟、算式、严格 raw 答案、剩余次数与提醒运行，只处理原群原连接", async () => {
  const f = fixture();
  await f.verify.policy.join(f.event);
  await f.verify.policy.join({ ...f.event, adapter: "milky" });
  await f.advance(1_999);
  expect(f.sent).toEqual([]);
  await f.advance(1);
  expect(f.sent[0]?.parts).toEqual([{ type: "at", qq: 43 }, " 欢迎！\n请在「120」秒内发送\n「11 + 10」的运算结果\n否则将会被移出群聊"]);
  expect(await f.verify.policy.answer(f.answer("21", { adapter: "milky" }))).toBe(false);
  expect(await f.verify.policy.answer(f.answer("21", { userId: 45 }))).toBe(false);
  expect(await f.verify.policy.answer(f.answer("21", { groupId: 78 }))).toBe(false);
  expect(await f.verify.policy.answer(f.answer("21", { connection: new AbortController().signal }))).toBe(false);
  const wrong = f.answer(" 21 ");
  expect(await f.verify.policy.answer(wrong)).toBe(true);
  expect(await f.verify.policy.answer(wrong)).toBe(true);
  expect(f.recalls).toEqual([wrong.messageId]);
  expect(f.sent[1]).toMatchObject({ source: "answer", parts: [{ type: "at", qq: 43 }, expect.stringContaining("你还有「1」次机会")] });
  await f.advance(60_000);
  expect(f.sent[2]?.parts.join(" ")).toContain("仅剩最后一分钟");
  expect(await f.verify.policy.answer(f.answer("21"))).toBe(true);
  expect(f.sent.at(-1)).toEqual({ source: "answer", parts: ["本群验证成功"] });
  await f.advance(60_000);
  expect(f.kicks).toEqual([]);
  expect(f.tasks.size).toBe(0);
});

test("首题未确认或保护角色不设踢人计时，关闭和重新入群不会延续旧会话", async () => {
  const f = fixture({ delay: 0, time: 2 });
  f.setPrompt(false);
  await f.verify.policy.join(f.event);
  await f.advance(5);
  expect(f.sent).toHaveLength(1);
  expect(f.tasks.size).toBe(0);
  f.setPrompt(true);
  f.setRoles({ botRole: "admin", targetRole: "member", protectedTarget: false, inviterRole: "owner" });
  await f.verify.policy.join({ ...f.event, time: 101, inviterId: 55 });
  await f.advance(5);
  expect(f.sent).toHaveLength(1);
  f.setRoles({ botRole: "owner", targetRole: "member", protectedTarget: false, targetJoinTime: 102 });
  f.setWhitelist(43);
  await f.verify.policy.join({ ...f.event, time: 102 });
  await f.advance(5);
  expect(f.sent).toHaveLength(1);
  f.setWhitelist();
  await f.verify.policy.join({ ...f.event, time: 103 });
  await f.advance(5);
  expect(f.sent).toHaveLength(2);
  expect(await f.verify.command("#关闭验证", f.command())).toContain("已关闭");
  expect(f.tasks.size).toBe(0);
  expect(await f.verify.policy.answer(f.answer("解析21"))).toBe(false);
  await f.advance(5_000);
  expect(f.kicks).toEqual([]);
});

test("管理员绕过、模糊答题、离群 tombstone 和未知踢人回执保持各自边界", async () => {
  const f = fixture({ delay: 0, time: 3, mode: "模糊", times: 1 });
  await f.verify.policy.leave({ ...f.event, time: 101 });
  await f.verify.policy.join(f.event);
  await f.advance(5);
  expect(f.sent).toEqual([]);
  await f.verify.policy.join({ ...f.event, time: 102 });
  await f.advance(5);
  const command = "#绕过验证";
  const withMention = { message: [{ type: "at", qq: 43 }] };
  expect(await f.verify.command(command, f.command({ ...withMention, groupManageBlacklist: async () => false }))).toContain("没有管理");
  expect(await f.verify.command(command, f.command({ ...withMention, adapter: "milky" }))).toContain("当前无需验证");
  expect(await f.verify.command(command, f.command(withMention))).toBe("本群验证成功");
  await f.verify.policy.join({ ...f.event, time: 103 });
  await f.advance(5);
  expect(await f.verify.policy.answer(f.answer("答案是21哦"))).toBe(true);
  expect(f.kicks).toEqual([]);

  await f.verify.policy.join({ ...f.event, time: 104 });
  await f.advance(5);
  f.setGateway("unknown");
  const wrong = f.answer("错误");
  expect(await f.verify.policy.answer(wrong)).toBe(true);
  expect(f.kicks).toEqual([99]);
  expect(f.sent.at(-1)).toMatchObject({ source: "answer", parts: [{ type: "at", qq: 43 }, expect.stringContaining("移出结果未确认")] });
  await f.advance(5_000);
  expect(f.kicks).toEqual([99]);
});

test("同群新入群时间保护旧任务，离群/连接失效让待发定时全部清理", async () => {
  const f = fixture({ delay: 0, time: 1 });
  await f.verify.policy.join(f.event);
  await f.advance(5);
  f.setRoles({ botRole: "owner", targetRole: "member", protectedTarget: false, targetJoinTime: 102 });
  await f.advance(1000);
  expect(f.kicks).toEqual([]);
  await f.verify.policy.join({ ...f.event, time: 102 });
  await f.advance(5);
  await f.verify.policy.leave({ ...f.event, time: 101, voluntary: true });
  expect(f.tasks.size).toBe(1);
  await f.verify.policy.leave({ ...f.event, time: 103, voluntary: true });
  await f.advance(5);
  expect(f.sent.at(-1)?.parts).toEqual(["「43」主动退群，验证流程结束"]);
  await f.verify.policy.join({ ...f.event, time: 104 });
  await f.advance(5);
  f.session.abort();
  await f.advance(1500);
  expect(f.kicks).toEqual([]);
  expect(f.tasks.size).toBe(0);
  await f.verify.stop();
});

test("到期的确认回执才宣布移出，外部停用和机器人退群都清除计时", async () => {
  const f = fixture({ delay: 0, time: 1 });
  await f.verify.policy.join(f.event);
  await f.advance(5);
  await f.advance(1000);
  expect(f.kicks).toEqual([99]);
  expect(f.sent.at(-1)?.parts.join(" ")).toContain("验证超时，已移出群聊");

  await f.verify.policy.join({ ...f.event, time: 101 });
  await f.advance(5);
  f.setConfig({ enabled: false });
  await f.advance(1000);
  expect(f.kicks).toEqual([99]);
  f.setConfig({ enabled: true });
  await f.verify.policy.join({ ...f.event, time: 102 });
  await f.advance(5);
  await f.verify.policy.leave({ ...f.event, time: 103, userId: 99 });
  await f.verify.policy.join({ ...f.event, time: 101, userId: 45 });
  await f.advance(1000);
  expect(f.kicks).toEqual([99]);
  expect(f.tasks.size).toBe(0);
});

test("本机器人移除通知早于 RPC 回执时仍等待该次结果", async () => {
  const f = fixture({ delay: 0, time: 1 });
  const event = { ...f.event, async kick(signal: AbortSignal) {
    await f.verify.policy.leave({ ...f.event, operatorId: 99, time: 101 });
    expect(signal.aborted).toBe(false);
    return "confirmed" as const;
  } };
  await f.verify.policy.join(event);
  await f.advance(5);
  await f.advance(1000);
  expect(f.sent.at(-1)?.parts.join(" ")).toContain("验证超时，已移出群聊");
});

test("旧验证 YAML 深层配置与群成功语，启停只写原 openGroup 字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-group-verify-"));
  try {
    const legacy = join(directory, "plugins/yenai-plugin/config/config/groupAdmin.yaml");
    await mkdir(join(directory, "plugins/yenai-plugin/config/config"), { recursive: true });
    const store = createManagedBlacklist(pathToFileURL(directory + "/"), async () => ({ close() {} }));
    expect(await store.readGroupVerificationSettings(77)).toMatchObject({ enabled: false, delay: 2, time: 300, times: 7 });
    const original = '\uFEFF# 旧配置\r\ngroupVerify:\r\n  openGroup: [88] # 群列表\r\n  mode: 模糊\r\n  times: 2\r\n  time: "30"\r\n  DelayTime: 0\r\n  range: {min: 7,max: 10}\r\n  SuccessMsgs: {"77":"本群提示", 0: "默认提示"}\r\nother: [a,b]\r\n';
    await writeFile(legacy, original);
    expect((await store.readGroupVerificationSettings(88)).success).toBe("默认提示");
    expect(await store.setGroupVerification(77, true, undefined, async () => true)).toBe(true);
    expect(await store.readGroupVerificationSettings(77)).toEqual({ enabled: true, mode: "模糊", times: 2, time: 30, delay: 0, min: 7, max: 10,
      remind: true, success: "本群提示" });
    expect(await readFile(legacy, "utf8")).toBe(original.replace("[88]", "[88, 77]"));
    expect(await store.setGroupVerification(77, false, undefined, async () => true)).toBe(true);
    expect(await readFile(legacy, "utf8")).toBe(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
