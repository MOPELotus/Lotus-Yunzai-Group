import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupBannedWords, isGroupBannedWordCommand } from "./banned-words.ts";
import { createManagedBlacklist } from "./managed-blacklist.ts";
import { createGroupTitle, groupTitleCommandFeature, type GroupTitleContext } from "./group-title.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lotus-banned-words-"));
  temporary.push(directory);
  await mkdir(join(directory, "plugins/yenai-plugin/config/group"), { recursive: true });
  await mkdir(join(directory, "config"));
  const root = pathToFileURL(`${directory}/`);
  const canonical = new URL("data/group/banned-words/77.json", root);
  const legacy = new URL("plugins/yenai-plugin/config/group/77.json", root);
  const whitelist = new URL("config/groupAdmin.yaml", root);
  const queues = new Map<string, Promise<void>>();
  async function lockFile(path: string) {
    const waiting = queues.get(path) ?? Promise.resolve();
    const held = Promise.withResolvers<void>();
    queues.set(path, waiting.then(() => held.promise));
    await waiting;
    return { close: () => held.resolve() };
  }
  const controller = new AbortController();
  const blacklist = createManagedBlacklist(root, lockFile);
  const { policy, command, titleStore } = createGroupBannedWords(root, lockFile, blacklist, controller.signal);
  const scope = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 77, async groupManageBlacklist() { return true; } };
  let message_id = 0;
  const run = (message: string, overrides = {}) => command(message, { ...scope, normalizedMessage: message, message_id: ++message_id, ...overrides });
  const title = createGroupTitle(titleStore, controller.signal);
  const runTitle = (normalizedMessage: string, overrides: Partial<GroupTitleContext> = {}) => title({
    ...scope, normalizedMessage, message_id: ++message_id, isBotMaster: () => false, ...overrides,
  });
  return { policy, run, runTitle, canonical, legacy, whitelist, controller, blacklist };
}

test("旧违禁词按第一条精确、模糊、正则规则执行并保护群间隔离和白名单", async () => {
  const { policy, canonical, legacy, whitelist } = await fixture();
  const original = JSON.stringify({ muteTime: 120, TitleBannedWords: ["旧头衔"], bannedWords: {
    "^Foo": { matchType: 3, penaltyType: 5 },
    FooBar: { matchType: 1, penaltyType: 1 },
    "敏感短语": { matchType: 2, penaltyType: 3 },
    "严格": { matchType: 1, penaltyType: 6 },
  } });
  await writeFile(legacy, original);
  expect(await policy.match(77, 43, "FooBar")).toEqual({ action: "mute-recall", seconds: 120, preview: "^F**" });
  expect(await policy.match(77, 43, "甲敏感短语乙")).toEqual({ action: "recall", seconds: 120, preview: "敏感**" });
  expect(await policy.match(77, 43, "严格")).toEqual({ action: "kick-blacklist", seconds: 120, preview: "严格" });
  expect(await policy.match(77, 43, "不严格")).toBeUndefined();
  expect(await policy.match(78, 43, "严格")).toBeUndefined();
  await writeFile(whitelist, 'whiteQQ: ["43"]\n');
  expect(await policy.match(77, 43, "严格")).toBeUndefined();
  expect(await policy.match(77, 44, "严格")).toMatchObject({ action: "kick-blacklist" });
  await expect(readFile(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(legacy, "utf8")).toBe(original);
});

test("旧单图精确指纹按群和原规则顺序匹配，纯文字不能假冒图片", async () => {
  const { policy, canonical, legacy, whitelist } = await fixture();
  const digest = "7e461ff4387de0cd2f227d0440e9bbe3";
  const underscore = `{image_${digest.toUpperCase()}}`;
  const colon = `{image:${digest}}`;
  const original = JSON.stringify({ muteTime: 120, bannedWords: {
    差异: { matchType: 1, penaltyType: 1 },
    [underscore]: { matchType: 1, penaltyType: 5 },
    [colon]: { matchType: 1, penaltyType: 1 },
  } });
  await writeFile(legacy, original);
  let reads = 0;
  const readDigest = async () => { reads++; return digest; };
  expect(await policy.match(77, 43, colon, undefined, readDigest)).toBeUndefined();
  expect(await policy.match(77, 43, underscore)).toBeUndefined();
  expect(await policy.match(77, 43, "差异", undefined, readDigest)).toMatchObject({ action: "kick" });
  expect(await policy.match(78, 43, "", undefined, readDigest)).toBeUndefined();
  expect(await policy.match(77, 43, "")).toBeUndefined();
  expect(reads).toBe(0);
  expect(await policy.match(77, 43, "", undefined, readDigest)).toEqual({ action: "mute-recall", preview: "[图片]", seconds: 120 });
  expect(reads).toBe(1);
  await writeFile(whitelist, "whiteQQ: [43]\n");
  expect(await policy.match(77, 43, "", undefined, readDigest)).toBeUndefined();
  expect(reads).toBe(1);
  await expect(readFile(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(legacy, "utf8")).toBe(original);
});

test("图指纹惰性读取只用于精确规则，配置更新、连接结束和读取未确认均跳过", async () => {
  const { policy, legacy, whitelist } = await fixture();
  const digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const key = `{image:${digest}}`;
  const rules = (matchType: number) => JSON.stringify({ bannedWords: { [key]: { matchType, penaltyType: 3 } } });
  await writeFile(legacy, rules(2));
  let reads = 0;
  const readDigest = async () => { reads++; return digest; };
  expect(await policy.match(77, 43, "", undefined, readDigest)).toBeUndefined();
  expect(await policy.match(77, 43, key)).toBeUndefined();
  expect(reads).toBe(0);
  await writeFile(legacy, rules(1));
  expect(await policy.match(77, 43, "", undefined, async () => "错误的摘要")).toBeUndefined();
  expect(await policy.match(77, 43, "", undefined, async () => { throw new Error("网络中断"); })).toBeUndefined();
  expect(await policy.match(77, 43, "", undefined, async () => {
    await writeFile(legacy, rules(2));
    return digest;
  })).toBeUndefined();
  await writeFile(legacy, rules(1));
  expect(await policy.match(77, 43, "", undefined, async () => {
    await writeFile(whitelist, "whiteQQ: [43]\n");
    return digest;
  })).toBeUndefined();
  const session = new AbortController();
  expect(await policy.match(77, 44, "", session.signal, async (active) => {
    session.abort();
    expect(active.aborted).toBe(true);
    return digest;
  })).toBeUndefined();
});

test("增加和删除沿用旧命令、原始列表和编辑权限，首次保存只写新文件", async () => {
  const { policy, run, canonical, legacy } = await fixture();
  const original = JSON.stringify({ TitleFilterModeChange: 1, bannedWords: { "{face_12}": { matchType: 1, penaltyType: 3 } } });
  await writeFile(legacy, original);
  expect(await run("#违禁词帮助", { groupManageBlacklist: undefined })).toContain("正则2");
  expect(await run("#违禁词列表", { groupManageBlacklist: undefined })).toMatchObject({ type: "forward",
    nodes: [["屏蔽词：", { type: "face", id: "12" }, expect.any(String)]] });
  expect(await run("#违禁词列表raw")).toMatchObject({ type: "forward", nodes: [["屏蔽词：", "{face_12}", expect.any(String)]] });
  expect(await run("新增模糊撤违禁词 验证", { groupManageBlacklist: undefined })).toContain("没有编辑");
  expect(await run("新增模糊撤违禁词 验证", { isDelegated: true })).toBeUndefined();
  expect(await run("新增模糊撤违禁词 验证", { message_type: "private" })).toBeUndefined();
  expect(await run("新增模糊撤违禁词 验证", { message_id: 10 })).toContain("已添加违禁词。\n");
  expect(await run("#删除违禁词 验证", { message_id: 10 })).toEqual([]);
  expect(await policy.match(77, 43, "待验证中")).toMatchObject({ action: "recall" });
  const saved = JSON.parse(await readFile(canonical, "utf8"));
  expect(saved.TitleFilterModeChange).toBe(1);
  expect(saved.bannedWords.验证).toMatchObject({ matchType: 2, penaltyType: 3, addedBy: 42 });
  expect(await readFile(legacy, "utf8")).toBe(original);
  expect(await run("#删除违禁词 验证")).toBe("已删除违禁词。");
  expect(await policy.match(77, 43, "验证")).toBeUndefined();
  expect(isGroupBannedWordCommand("#查看违禁词 测试")).toBe(true);
  expect(isGroupBannedWordCommand("#增加头衔屏蔽词")).toBe(false);
});

test("隔离执行正则字面值，原始 JavaScript 字符串不执行，复杂规则可终止", async () => {
  const { policy, run, legacy } = await fixture();
  await writeFile(legacy, JSON.stringify({ bannedWords: { "(() => { throw 'old code'; })()": { matchType: 3, penaltyType: 1 } } }));
  expect(await policy.match(77, 43, "无关消息")).toBeUndefined();
  expect(await run("#新增正则2禁违禁词 非字面值")).toBe("正则表达式无效。");
  expect(await run("#新增正则2踢黑违禁词 /^MiXeD$/i")).toContain("已添加违禁词。\n");
  expect(await policy.match(77, 43, "mixed")).toMatchObject({ action: "kick-blacklist" });
  expect(await run("#新增正则1禁违禁词 ^(a|aa)+$")).toContain("已添加违禁词。\n");
  const start = performance.now();
  expect(await policy.match(77, 43, "a".repeat(3_000) + "!" )).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(1_000);
  const interrupted = new AbortController();
  interrupted.abort();
  expect(await policy.match(77, 43, "mixed", interrupted.signal)).toBeUndefined();
});

test("并发配置迁移不丢数据，提交前复核权限，已确认踢人的跨群记录同锁持久化", async () => {
  const { policy, run, canonical, blacklist, controller } = await fixture();
  const reports = await Promise.all([run("#新增违禁词 第一"), run("#新增禁撤违禁词 第二"), run("#设置违禁词禁言时间30")]);
  expect(reports).toHaveLength(3);
  expect(await policy.match(77, 43, "第一")).toMatchObject({ action: "mute", seconds: 30 });
  expect(await policy.match(77, 43, "第二")).toMatchObject({ action: "mute-recall", seconds: 30 });
  const saved = await readFile(canonical, "utf8");
  let auth = 0;
  expect(await run("#删除违禁词 第二", { async groupManageBlacklist() { return ++auth === 1; } })).toContain("没有编辑");
  expect(await readFile(canonical, "utf8")).toBe(saved);
  await expect(policy.recordConfirmedKick(43, controller.signal, async () => false)).rejects.toThrow();
  expect(await blacklist.blocked(43)).toBe(false);
  await policy.recordConfirmedKick(43, controller.signal, async () => true);
  expect(await blacklist.blocked(43)).toBe(true);
  await writeFile(canonical, "broken json");
  expect(await run("#新增违禁词 内容")).toBe("违禁词配置暂不可用。");
  expect(await readFile(canonical, "utf8")).toBe("broken json");
});

test("自助群头衔按旧模式匹配，1 使用字面包含，现有违禁词 JSON 保留", async () => {
  const { runTitle, canonical, legacy } = await fixture();
  const original = JSON.stringify({ TitleBannedWords: ["a.b", "原名"], TitleFilterModeChange: 1, bannedWords: { "例": { matchType: 1, penaltyType: 2 } } });
  await writeFile(legacy, original);
  const calls: [number, string][] = [];
  const ordinary: Partial<GroupTitleContext> = { async groupSetSpecialTitle(id, title, verify) {
    calls.push([id, title]);
    return await verify?.() ? "confirmed" : "protected";
  } };
  expect(await runTitle("#我要头衔xxa.byy", ordinary)).toContain("包含屏蔽词");
  expect(await runTitle("#我要头衔xxaxbyy", ordinary)).toContain("xxaxbyy");
  expect(await runTitle("#申请头衔", ordinary)).toBe("已清空你的群头衔。");
  expect(await runTitle("#切换头衔屏蔽词匹配", ordinary)).toContain("精确匹配");
  expect(await runTitle("#申请头衔包含原名", ordinary)).toContain("包含原名");
  expect(await runTitle("#申请头衔原名", ordinary)).toContain("包含屏蔽词");
  expect(await runTitle("#申请头衔原名", { ...ordinary, isBotMaster: () => true })).toContain("更换");
  expect(calls).toEqual([[42, "xxaxbyy"], [42, ""], [42, "包含原名"], [42, "原名"]]);
  expect(await readFile(legacy, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(canonical, "utf8"))).toMatchObject({ TitleFilterModeChange: 0, bannedWords: { "例": { matchType: 1, penaltyType: 2 } } });
});

test("主人给真实 @ 目标设置或清空头衔，拒绝委托、歧义及重放", async () => {
  const { runTitle } = await fixture();
  const calls: [number, string][] = [];
  const mention = { type: "at", qq: 43 };
  const owner: Partial<GroupTitleContext> = { isBotMaster: () => true, message: [mention], async groupSetSpecialTitle(id, title, verify) {
    expect(verify).toBeUndefined();
    calls.push([id, title]);
    return title ? "unknown" : "confirmed";
  } };
  expect(await runTitle("#修改头衔 头衔", { ...owner, isBotMaster: () => false })).toContain("没有设置");
  expect(await runTitle("#修改头衔 头衔", { ...owner, message: [mention, { type: "at", qq: 44 }] })).toContain("@ 一位");
  expect(await runTitle("#修改头衔 头衔", { ...owner, isDelegated: true })).toBeUndefined();
  expect(await runTitle("#修改头衔 头衔", { ...owner, message_type: "private" })).toBeUndefined();
  expect(await runTitle("#设置头衔 甲 乙", { ...owner, message_id: 100 })).toContain("未确认");
  expect(await runTitle("#设置头衔 甲 乙", { ...owner, message_id: 100 })).toEqual([]);
  expect(await runTitle("#设置头衔", { ...owner, message: [{ type: "at", qq: 99 }, mention] })).toContain("清空 43");
  expect(calls).toEqual([[43, "甲 乙"], [43, ""]]);
});

test("头衔词表可同群公开查询，写入需复核，协议提交前重查新屏蔽词", async () => {
  const { runTitle, run, canonical } = await fixture();
  expect(groupTitleCommandFeature("#查看头衔屏蔽词")).toBe("[group] 头衔屏蔽词");
  expect(groupTitleCommandFeature("#我要头衔")).toBe("[group] 群头衔");
  expect(await runTitle("#查看头衔屏蔽词", { groupManageBlacklist: undefined })).toContain("如下：无");
  expect(await runTitle("#增加头衔屏蔽词甲", { groupManageBlacklist: undefined })).toContain("没有编辑");
  const first = await Promise.all([runTitle("#增加头衔屏蔽词甲,乙，乙"), run("#新增违禁词 测试")]);
  expect(first[0]).toContain("成功添加：甲、乙");
  expect(await runTitle("#查看头衔屏蔽词", { groupManageBlacklist: undefined })).toContain("甲\n乙");
  let auth = 0;
  expect(await runTitle("#减少头衔屏蔽词乙", { async groupManageBlacklist() { return ++auth === 1; } })).toContain("没有编辑");
  expect(await runTitle("#减少头衔屏蔽词乙,不存在")).toContain("以下词未在屏蔽词中：不存在");
  expect(await runTitle("#申请头衔新词", { async groupSetSpecialTitle(_id, _title, verify) {
    expect(verify).toBeDefined();
    expect(await runTitle("#增加头衔屏蔽词新词")).toContain("成功添加");
    return await verify?.() ? "confirmed" : "protected";
  } })).toContain("包含屏蔽词");
  expect(JSON.parse(await readFile(canonical, "utf8"))).toMatchObject({ TitleBannedWords: ["甲", "新词"], bannedWords: { "测试": { matchType: 1 } } });
});
