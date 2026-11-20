import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createNoticeSettings, isNoticeSettingsCommand, type NoticeSettingsContext, type NoticeSettingsScope } from "./notice-settings.ts";

const temporary: string[] = [];
const overview = "#椰奶通知设置";
const privateOwner = { self_id: 99, user_id: 42, isBotMaster: (id: number) => id === 42,
  message_type: "private", configureNoticeSettings: async () => true } satisfies NoticeSettingsContext;
const groupOwner = { ...privateOwner, message_type: "group", group_id: 77 } satisfies NoticeSettingsContext;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function lock(file: string) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error("通知设置锁须为普通文件。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new Database(file);
  const deadline = performance.now() + 2_000;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); return database; }
      catch (error) {
        if (!(error as NodeJS.ErrnoException).code?.startsWith("SQLITE_BUSY") || performance.now() >= deadline) throw error;
        await delay(20);
      }
    }
  } catch (error) { database.close(); throw error; }
}

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-notice-settings-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  const legacy = join(path, "plugins/yenai-plugin/config/config/notice.yaml");
  await mkdir(join(path, "plugins/yenai-plugin/config/config"), { recursive: true });
  return { command: createNoticeSettings(root, lock), legacy, primary: join(path, "config/group-notice.yaml") };
}

test("旧状态列当前生效值和已支持范围，普通群员可读，未实施字段不列", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, [
    "default: { privateMessage: false, groupRecall: false, groupInviteRequest: true }",
    "'bot:99': { privateMessage: true }",
    "77: { groupRecall: true, msgSaveDeltime: 150 }",
    "'bot:100': { privateMessage: false }",
  ].join("\n"));
  const result = await command(overview, { ...groupOwner, user_id: 43 });
  expect(result).toContain("【通知设置】");
  expect(result).toContain("好友消息：开启");
  expect(result).toContain("群撤回：开启（当前仅文本）");
  expect(result).toContain("删除缓存时间：150 秒");
  for (const privateDetails of ["群邀请", "bot:100", "notice.yaml"]) expect(result).not.toContain(privateDetails);
  expect(await command(overview, privateOwner)).toContain("群撤回：关闭");
  expect(await command(overview, { ...groupOwner, isDelegated: true })).toBeUndefined();
});

test("单项修改使用正确旧作用域，与实际来源保持一致且保留原字节注释", async () => {
  const { command, legacy, primary } = await fixture();
  const initial = "# 原注释\r\ndefault:\r\n  privateMessage: false # 保留\r\n  unrelated: [1,2]\r\n'bot:99': {privateMessage: false, other:  7}\r\n";
  await writeFile(legacy, initial);
  expect(await command("#椰奶通知设置好友消息开启", privateOwner)).toContain("已保存");
  expect(await readFile(legacy, "utf8")).toBe(initial.replace("false # 保留", "true # 保留"));
  expect(await command("#椰奶通知设置好友消息单独取消", privateOwner)).toContain("好友消息：开启");
  const current = await readFile(legacy, "utf8");
  expect(current).toContain("'bot:99': { other:  7}\r\n");
  expect(current).toContain("unrelated: [1,2]");
  expect(await stat(primary).catch(() => undefined)).toBeUndefined();
  expect(await command("#椰奶通知设置群撤回单独开启", groupOwner)).toContain("群撤回：开启");
  expect(await command("#椰奶通知设置群临时消息bot群单独开启", groupOwner)).toContain("群临时消息：开启");
  expect(await command("#椰奶通知设置好友申请bot单独开启", groupOwner)).toContain("好友申请：开启");
  expect(await command("#椰奶通知设置删除缓存时间123秒", groupOwner)).toContain("删除缓存时间：123 秒");
});

test("取消保留空作用域、行尾注释，当前源有锚点关联时拒绝改动其它字段", async () => {
  const { command, legacy } = await fixture();
  const raw = "default:\n  privateMessage: true # 保留行尾\nnext: [1,2]\n";
  await writeFile(legacy, raw);
  expect(await command("#椰奶通知设置好友消息取消", privateOwner)).toContain("好友消息：关闭");
  expect(await readFile(legacy, "utf8")).toBe("default:\n  {} # 保留行尾\nnext: [1,2]\n");
  const aliased = "default:\n  privateMessage: &shared false\nother: *shared\n";
  await writeFile(legacy, aliased);
  expect(await command("#椰奶通知设置好友消息开启", privateOwner)).toContain("暂无法保存");
  expect(await readFile(legacy, "utf8")).toBe(aliased);
});

test("权限按四种作用域传入，撤权、非法及未实现操作不写", async () => {
  const { command, legacy } = await fixture();
  const raw = "default: { privateMessage: false }\n";
  await writeFile(legacy, raw);
  const scopes: NoticeSettingsScope[] = [];
  let authority = true;
  const scope = { ...groupOwner, configureNoticeSettings: async (value: NoticeSettingsScope) => {
    scopes.push(value); const current = authority; authority = false; return current;
  } };
  expect(await command("#椰奶通知设置群撤回bot群单独开启", scope)).toContain("权限");
  expect(scopes).toEqual(["bot-group", "bot-group"]);
  expect(await readFile(legacy, "utf8")).toBe(raw);
  const denied = { ...privateOwner, configureNoticeSettings: undefined };
  expect(await command("#椰奶通知设置好友消息开启", denied)).toContain("权限");
  expect(await command("#椰奶通知设置好友消息开启", { ...privateOwner, isBotMaster: () => false })).toContain("权限");
  expect(await command("#椰奶通知设置好友消息开启", { ...privateOwner, isDelegated: true })).toContain("权限");
  expect(await command("#椰奶通知设置群撤回群单独开启", privateOwner)).toContain("权限");
  expect(await command("#椰奶通知设置好友消息群单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#椰奶通知设置删除缓存时间0", privateOwner)).toContain("正整数");
  expect(await command("#椰奶通知设置群邀请开启", privateOwner)).toContain("尚不支持");
  expect(await command("#椰奶启用全部通知", privateOwner)).toContain("尚不支持");
  expect(await readFile(legacy, "utf8")).toBe(raw);
  expect(isNoticeSettingsCommand("#椰奶通知设置群邀请开启")).toBe(true);
  expect(isNoticeSettingsCommand("椰奶通知设置群邀请开启")).toBe(false);
});

test("并发保存不丢修改，canonical 路径优先且保留真实符号链接目标", async () => {
  const { command, legacy, primary } = await fixture();
  const held = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let checks = 0;
  const first = command("#椰奶通知设置好友消息开启", { ...privateOwner, async configureNoticeSettings() {
    if (++checks === 2) {
      held.resolve();
      await proceed.promise;
    }
    return true;
  } });
  await held.promise;
  const second = command("#椰奶通知设置好友申请开启", privateOwner);
  try { await delay(350); } finally { proceed.resolve(); }
  const results = await Promise.all([first, second]);
  for (const result of results) expect(result).toContain("已保存通知设置");
  const saved = await readFile(primary, "utf8");
  expect(saved).toContain("privateMessage: true");
  expect(saved).toContain("friendRequest: true");
  await writeFile(legacy, "default: { groupRecall: true }\n");
  const live = primary + ".actual";
  const raw = "default: {groupRecall: false, untouched:[1,2]}\n";
  await writeFile(live, raw);
  await rm(primary);
  await symlink(live, primary);
  expect(await command("#椰奶通知设置群撤回开启", groupOwner)).toContain("群撤回：开启");
  expect(await readFile(live, "utf8")).toBe(raw.replace("false", "true"));
  expect(await readFile(legacy, "utf8")).toBe("default: { groupRecall: true }\n");
});

test("提交前发现配置由其他程序更改则保留外部修改", async () => {
  const { command, legacy } = await fixture();
  const external = "default: { privateMessage: false, externallyChanged: true }\n";
  await writeFile(legacy, "default: { privateMessage: false }\n");
  let checks = 0;
  const scope = { ...privateOwner, async configureNoticeSettings() {
    if (++checks === 2) await writeFile(legacy, external);
    return true;
  } };
  expect(await command("#椰奶通知设置好友消息开启", scope)).toContain("暂无法保存");
  expect(await readFile(legacy, "utf8")).toBe(external);
});

test("配置最终回读后权限仍须有效，最后一次复核拒绝时不得提交", async () => {
  const { command, legacy } = await fixture();
  const original = "default: { privateMessage: false }\n";
  await writeFile(legacy, original);
  let checks = 0;
  const context = { ...privateOwner, async configureNoticeSettings() { return ++checks < 3; } };
  expect(await command("#椰奶通知设置好友消息开启", context)).toContain("当前会话没有修改此通知设置的权限");
  expect(checks).toBe(3);
  expect(await readFile(legacy, "utf8")).toBe(original);
});

test("群管理变动状态及单项设置只允许旧真实群覆盖层", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { groupAdminChange: false, groupMemberNumberChange: true }\n");
  expect(await command(overview, groupOwner)).toContain("群管理变动：关闭");
  expect(await command("#椰奶通知设置群管理变动bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#椰奶通知设置群管理变动bot群单独开启", groupOwner)).toContain("群管理变动：开启");
  expect(await command(overview, privateOwner)).toContain("群管理变动：关闭");
  expect(await command("#椰奶通知设置群管理变动bot群单独取消", groupOwner)).toContain("群管理变动：关闭");
  expect(await readFile(legacy, "utf8")).toContain("groupMemberNumberChange: true");
});

test("禁言通知状态可按旧群或机器人群覆盖，仅面向机器人本人的事件范围", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { botBeenBanned: false, groupAdminChange: true }\n");
  expect(await command(overview, groupOwner)).toContain("禁言：关闭（仅机器人本人）");
  expect(await command("#椰奶通知设置禁言bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#椰奶通知设置禁言群单独开启", groupOwner)).toContain("禁言：开启（仅机器人本人）");
  expect(await command("#椰奶通知设置禁言bot群单独关闭", groupOwner)).toContain("禁言：关闭（仅机器人本人）");
  expect(await command("#椰奶通知设置禁言bot群单独取消", groupOwner)).toContain("禁言：开启（仅机器人本人）");
  expect(await readFile(legacy, "utf8")).toContain("groupAdminChange: true");
});

test("群聊列表变动设置含机器人入退群限定，并沿用旧群覆盖语法", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { groupNumberChange: false, groupMemberNumberChange: true }\n");
  expect(await command(overview, groupOwner)).toContain("群聊列表变动：关闭（机器人进退群、被移出及群解散）");
  expect(await command("#椰奶通知设置群聊列表变动bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#椰奶通知设置群聊列表变动群单独开启", groupOwner)).toContain("群聊列表变动：开启");
  expect(await command("#椰奶通知设置群聊列表变动bot群单独关闭", groupOwner)).toContain("群聊列表变动：关闭");
  expect(await command("#椰奶通知设置群聊列表变动bot群单独取消", groupOwner)).toContain("群聊列表变动：开启");
  expect(await readFile(legacy, "utf8")).toContain("groupMemberNumberChange: true");
});
