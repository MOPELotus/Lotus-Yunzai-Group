import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { createGroupNoticePanelSettings } from "./group-notice-panel-settings.ts";
import type { NoticeSettingsCardModel, NoticeSettingsCardRenderer } from "./notice-settings-card-model.ts";
import { createNoticeSettings, isNoticeSettingsCommand, type NoticeSettingsContext, type NoticeSettingsScope } from "./notice-settings.ts";

const temporary: string[] = [];
const overview = "#通知设置";
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
  return {
    command: createNoticeSettings(root, lock),
    panel: createGroupNoticePanelSettings(root, lock),
    withRenderer: (render: NoticeSettingsCardRenderer, signal?: AbortSignal) => createNoticeSettings(root, lock, signal, render),
    legacy, primary: join(path, "config/group-notice.yaml"),
  };
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
  expect(result).toContain("好友消息：开启（已核验的文本、图片、表情和戳一戳，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4）");
  expect(result).toContain("群撤回：开启（支持文本、表情和已核验原图混排）");
  expect(result).toContain("好友撤回：关闭（支持文本、表情和已核验原图混排，原音限已核验的独立 QQ SILK）");
  expect(result).toContain("删除缓存时间：150 秒");
  expect(result).toContain("群邀请：开启（主人编号通知详情）");
  for (const privateDetails of ["bot:100", "notice.yaml"]) expect(result).not.toContain(privateDetails);
  expect(await command(overview, privateOwner)).toContain("群撤回：关闭（支持文本、表情和已核验原图混排）");
  expect(await command(overview, { ...groupOwner, isDelegated: true })).toBeUndefined();
});

test("单项修改使用正确旧作用域，与实际来源保持一致且保留原字节注释", async () => {
  const { command, legacy, primary } = await fixture();
  const initial = "# 原注释\r\ndefault:\r\n  privateMessage: false # 保留\r\n  unrelated: [1,2]\r\n'bot:99': {privateMessage: false, other:  7}\r\n";
  await writeFile(legacy, initial);
  expect(await command("#通知设置好友消息开启", privateOwner)).toContain("已保存");
  expect(await readFile(legacy, "utf8")).toBe(initial.replace("false # 保留", "true # 保留"));
  expect(await command("#通知设置好友消息单独取消", privateOwner)).toContain("好友消息：开启");
  const current = await readFile(legacy, "utf8");
  expect(current).toContain("'bot:99': { other:  7}\r\n");
  expect(current).toContain("unrelated: [1,2]");
  expect(await stat(primary).catch(() => undefined)).toBeUndefined();
  expect(await command("#通知设置群撤回单独开启", groupOwner)).toContain("群撤回：开启");
  expect(await command("#通知设置群临时消息bot群单独开启", groupOwner)).toContain("群临时消息：开启（支持已核验的文本、图片和表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4）");
  expect(await command("#通知设置好友申请bot单独开启", groupOwner)).toContain("好友申请：开启");
  expect(await command("#通知设置删除缓存时间123秒", groupOwner)).toContain("删除缓存时间：123 秒");
});

test("取消保留空作用域、行尾注释，当前源有锚点关联时拒绝改动其它字段", async () => {
  const { command, legacy } = await fixture();
  const raw = "default:\n  privateMessage: true # 保留行尾\nnext: [1,2]\n";
  await writeFile(legacy, raw);
  expect(await command("#通知设置好友消息取消", privateOwner)).toContain("好友消息：关闭");
  expect(await readFile(legacy, "utf8")).toBe("default:\n  {} # 保留行尾\nnext: [1,2]\n");
  const aliased = "default:\n  privateMessage: &shared false\nother: *shared\n";
  await writeFile(legacy, aliased);
  expect(await command("#通知设置好友消息开启", privateOwner)).toContain("暂无法保存");
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
  expect(await command("#通知设置群撤回bot群单独开启", scope)).toContain("权限");
  expect(scopes).toEqual(["bot-group", "bot-group"]);
  expect(await readFile(legacy, "utf8")).toBe(raw);
  const denied = { ...privateOwner, configureNoticeSettings: undefined };
  expect(await command("#通知设置好友消息开启", denied)).toContain("权限");
  expect(await command("#通知设置好友消息开启", { ...privateOwner, isBotMaster: () => false })).toContain("权限");
  expect(await command("#通知设置好友消息开启", { ...privateOwner, isDelegated: true })).toContain("权限");
  expect(await command("#通知设置群撤回群单独开启", privateOwner)).toContain("权限");
  expect(await command("#通知设置好友消息群单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置删除缓存时间0", privateOwner)).toContain("正整数");
  expect(await readFile(legacy, "utf8")).toBe(raw);
  expect(isNoticeSettingsCommand("#通知设置群邀请开启")).toBe(true);
  expect(isNoticeSettingsCommand("通知设置群邀请开启")).toBe(false);
});

test("并发保存不丢修改，canonical 路径优先且保留真实符号链接目标", async () => {
  const { command, legacy, primary } = await fixture();
  const held = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let checks = 0;
  const first = command("#通知设置好友消息开启", { ...privateOwner, async configureNoticeSettings() {
    if (++checks === 2) {
      held.resolve();
      await proceed.promise;
    }
    return true;
  } });
  await held.promise;
  const second = command("#通知设置好友申请开启", privateOwner);
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
  expect(await command("#通知设置群撤回开启", groupOwner)).toContain("群撤回：开启");
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
  expect(await command("#通知设置好友消息开启", scope)).toContain("暂无法保存");
  expect(await readFile(legacy, "utf8")).toBe(external);
});

test("配置最终回读后权限仍须有效，最后一次复核拒绝时不得提交", async () => {
  const { command, legacy } = await fixture();
  const original = "default: { privateMessage: false }\n";
  await writeFile(legacy, original);
  let checks = 0;
  const context = { ...privateOwner, async configureNoticeSettings() { return ++checks < 3; } };
  expect(await command("#通知设置好友消息开启", context)).toContain("当前会话没有修改此通知设置的权限");
  expect(checks).toBe(3);
  expect(await readFile(legacy, "utf8")).toBe(original);
});

test("群管理变动状态及单项设置只允许旧真实群覆盖层", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { groupAdminChange: false, groupMemberNumberChange: true }\n");
  expect(await command(overview, groupOwner)).toContain("群管理变动：关闭");
  expect(await command("#通知设置群管理变动bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置群管理变动bot群单独开启", groupOwner)).toContain("群管理变动：开启");
  expect(await command(overview, privateOwner)).toContain("群管理变动：关闭");
  expect(await command("#通知设置群管理变动bot群单独取消", groupOwner)).toContain("群管理变动：关闭");
  expect(await readFile(legacy, "utf8")).toContain("groupMemberNumberChange: true");
});

test("禁言通知状态可按旧群或机器人群覆盖，仅面向机器人本人的事件范围", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { botBeenBanned: false, groupAdminChange: true }\n");
  expect(await command(overview, groupOwner)).toContain("禁言：关闭（仅机器人本人）");
  expect(await command("#通知设置禁言bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置禁言群单独开启", groupOwner)).toContain("禁言：开启（仅机器人本人）");
  expect(await command("#通知设置禁言bot群单独关闭", groupOwner)).toContain("禁言：关闭（仅机器人本人）");
  expect(await command("#通知设置禁言bot群单独取消", groupOwner)).toContain("禁言：开启（仅机器人本人）");
  expect(await readFile(legacy, "utf8")).toContain("groupAdminChange: true");
});

test("群聊列表变动设置含机器人入退群限定，并沿用旧群覆盖语法", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { groupNumberChange: false, groupMemberNumberChange: true }\n");
  expect(await command(overview, groupOwner)).toContain("群聊列表变动：关闭（机器人进退群、被移出及群解散）");
  expect(await command("#通知设置群聊列表变动bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置群聊列表变动群单独开启", groupOwner)).toContain("群聊列表变动：开启");
  expect(await command("#通知设置群聊列表变动bot群单独关闭", groupOwner)).toContain("群聊列表变动：关闭");
  expect(await command("#通知设置群聊列表变动bot群单独取消", groupOwner)).toContain("群聊列表变动：开启");
  expect(await readFile(legacy, "utf8")).toContain("groupMemberNumberChange: true");
});

test("加群申请设置仅管理主人编号通知详情及旧群覆盖", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { addGroupApplication: false, groupInviteRequest: true }\n");
  expect(await command(overview, groupOwner)).toContain("加群申请：关闭（主人编号通知详情）");
  expect(await command("#通知设置加群申请bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置加群申请群单独开启", groupOwner)).toContain("加群申请：开启");
  expect(await command("#通知设置加群申请bot群单独关闭", groupOwner)).toContain("加群申请：关闭");
  expect(await command("#通知设置加群申请bot群单独取消", groupOwner)).toContain("加群申请：开启");
  expect(await readFile(legacy, "utf8")).toContain("groupInviteRequest: true");
});

test("群邀请仅开放旧默认和当前 bot 设置", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { addGroupApplication: true, groupInviteRequest: false }\n");
  expect(await command(overview, groupOwner)).toContain("群邀请：关闭（主人编号通知详情）");
  expect(await command("#通知设置群邀请群单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置群邀请bot群单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置群邀请开启", groupOwner)).toContain("群邀请：开启");
  expect(await command("#通知设置群邀请bot单独关闭", groupOwner)).toContain("群邀请：关闭");
  expect(await command("#通知设置群邀请bot单独取消", groupOwner)).toContain("群邀请：开启");
  expect(await readFile(legacy, "utf8")).toContain("addGroupApplication: true");
});

test("群消息主人通知沿用旧群作用域且列明支持的正文类型", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { groupMessage: false, privateMessage: true }\n");
  expect(await command(overview, groupOwner)).toContain("群消息：关闭（当前支持文本、图片、表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4）");
  expect(await command("#通知设置群消息bot单独开启", groupOwner)).toContain("不支持此作用域");
  expect(await command("#通知设置群消息群单独开启", groupOwner)).toContain("群消息：开启（当前支持文本、图片、表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4）");
  expect(await command("#通知设置群消息bot群单独关闭", groupOwner)).toContain("群消息：关闭（当前支持文本、图片、表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4）");
  expect(await command("#通知设置群消息bot群单独取消", groupOwner)).toContain("群消息：开启（当前支持文本、图片、表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4）");
  expect(await readFile(legacy, "utf8")).toContain("privateMessage: true");
});

test("全部通知只改默认收件人策略，取消还原 Lotus 缺省行为", async () => {
  const { command, legacy } = await fixture();
  const before = "# 原注释\ndefault: { friendRequest: true, groupMessage: false }\n'bot:100': { notificationsAll: false }\n";
  await writeFile(legacy, before);
  const scopes: NoticeSettingsScope[] = [];
  const owner = { ...groupOwner, configureNoticeSettings: async (scope: NoticeSettingsScope) => { scopes.push(scope); return true; } };
  expect(await command(overview, owner)).toContain("全部通知：当前机器人的所有主人（未设置）");
  for (const suffix of ["群单独", "bot单独", "bot群单独", "单独"]) {
    expect(await command(`#通知设置全部通知${suffix}开启`, owner)).toContain("不支持此作用域");
  }
  expect(await command("#通知设置全部通知关闭", { ...owner, isDelegated: true })).toContain("权限");
  expect(await command("#通知设置全部通知10秒", owner)).toContain("请使用开启、关闭或取消");
  expect(scopes).toEqual([]);
  expect(await readFile(legacy, "utf8")).toBe(before);

  expect(await command("#通知设置全部通知关闭", owner)).toContain("全部通知：当前机器人的首位主人");
  expect((await command("#通知设置全部通知开启", owner))?.split("\n")).toContain("全部通知：当前机器人的所有主人");
  expect(await command("#通知设置全部通知取消", owner)).toContain("全部通知：当前机器人的所有主人（未设置）");
  expect(scopes.length).toBeGreaterThan(0);
  expect(new Set(scopes)).toEqual(new Set(["default"]));
  const after = await readFile(legacy, "utf8");
  expect(after).toContain("friendRequest: true");
  expect(after).toContain("groupMessage: false");
  expect(after).toContain("'bot:100': { notificationsAll: false }");
});

const eventKeys = [
  "privateMessage", "groupMessage", "grouptemporaryMessage", "groupRecall", "PrivateRecall",
  "friendRequest", "groupInviteRequest", "addGroupApplication", "friendNumberChange",
  "groupAdminChange", "groupMemberNumberChange", "groupNumberChange", "botBeenBanned",
] as const;

test("旧两条批量命令只改全部 13 个默认事件开关，保留收件配置、覆盖与原注释", async () => {
  const { command, legacy } = await fixture();
  const before = [
    "# 原注释   ",
    "default:",
    "  notificationsAll: false # 说明",
    "  msgSaveDeltime: 450  ",
    "  privateMessage: false # 事件说明",
    "  unrelated: [1,2]",
    "  friendRequest:",
    "77: {groupMessage: false} # 群覆盖",
    "'bot:99': { privateMessage: true }",
    "'bot:99:77': { groupRecall: false }",
    "",
  ].join("\r\n");
  await writeFile(legacy, before);
  expect(await command("#启用全部通知", groupOwner)).toContain("已启用全部 13 项默认事件通知");
  const enabled = await readFile(legacy, "utf8");
  const config = parse(enabled);
  for (const key of eventKeys) expect(config.default[key]).toBe(true);
  expect(config.default.notificationsAll).toBe(false);
  expect(config.default.msgSaveDeltime).toBe(450);
  expect(enabled).toContain("  privateMessage: true # 事件说明\r\n");
  expect(enabled).toContain("  friendRequest: true\r\n");
  expect(enabled).toContain("  unrelated: [1,2]\r\n");
  expect(enabled).toContain(before.slice(before.indexOf("77: {groupMessage")));
  expect(enabled).toStartWith("# 原注释   \r\ndefault:\r\n  notificationsAll: false # 说明\r\n  msgSaveDeltime: 450  \r\n");

  const firstInode = (await stat(legacy)).ino;
  expect(await command("#启用全部通知", groupOwner)).toContain("无变化");
  expect((await stat(legacy)).ino).toBe(firstInode);
  expect(await readFile(legacy, "utf8")).toBe(enabled);

  expect(await command("#禁用全部通知", groupOwner)).toContain("已禁用全部 13 项默认事件通知");
  const disabled = parse(await readFile(legacy, "utf8"));
  for (const key of eventKeys) expect(disabled.default[key]).toBe(false);
  expect(disabled["bot:99"].privateMessage).toBe(true);
  expect(disabled.default.notificationsAll).toBe(false);
  expect(disabled.default.msgSaveDeltime).toBe(450);
});

test("批量与单项并发各自存储，且批量复核只要求默认作用域", async () => {
  const { command, legacy } = await fixture();
  await writeFile(legacy, "default: { msgSaveDeltime: 600, notificationsAll: false, extra: [1,2] }\n");
  const scopes: NoticeSettingsScope[] = [];
  const owner = { ...groupOwner, configureNoticeSettings: async (scope: NoticeSettingsScope) => {
    scopes.push(scope);
    return scope === "default";
  } };
  const [batch, single] = await Promise.all([
    command("#启用全部通知", owner),
    command("#通知设置删除缓存时间90秒", privateOwner),
  ]);
  expect(batch).toContain("已启用全部 13 项");
  expect(single).toContain("已保存");
  expect(scopes).toEqual(["default", "default", "default"]);
  const after = await readFile(legacy, "utf8");
  const config = parse(after);
  for (const key of eventKeys) expect(config.default[key]).toBe(true);
  expect(config.default.msgSaveDeltime).toBe(90);
  expect(after).toContain("extra: [1,2]");
});

test("批量在无权限、最终权限撤销和任一字段不安全时整体保留原文件", async () => {
  const { command, legacy } = await fixture();
  const baseline = "default: { privateMessage: false, unrelated: [1,2] }\n";
  await writeFile(legacy, baseline);
  const denied = { ...groupOwner, configureNoticeSettings: async () => false };
  expect(await command("#启用全部通知", denied)).toContain("权限");
  let checks = 0;
  expect(await command("#启用全部通知", {
    ...groupOwner, configureNoticeSettings: async () => ++checks < 3,
  })).toContain("权限");
  expect(await readFile(legacy, "utf8")).toBe(baseline);
  for (const unsafe of [
    "default: { privateMessage: false, botBeenBanned: [false] }\n",
    "default: { privateMessage: false, botBeenBanned: &enabled false }\n77: { other: *enabled }\n",
  ]) {
    await writeFile(legacy, unsafe);
    const before = await stat(legacy);
    expect(await command("#启用全部通知", groupOwner)).toContain("暂无法保存");
    expect(await readFile(legacy, "utf8")).toBe(unsafe);
    expect((await stat(legacy)).ino).toBe(before.ino);
  }
});

test("原状态卡结构和覆盖仅来自当前已核对机器人及当前群，写入回执保留实情", async () => {
  const { withRenderer, legacy } = await fixture();
  await writeFile(legacy, [
    "default: { groupMessage: true, notificationsAll: false, msgSaveDeltime: 600 }",
    "'bot:99': { privateMessage: true }",
    "77: { groupMessage: false, notificationsAll: true, friendRequest: true, secret: abc }",
    "'bot:99:77': { groupRecall: false }",
    "'bot:100': { groupMessage: true }",
    "'bot:99:78': { groupRecall: true }",
  ].join("\n"));
  const models: NoticeSettingsCardModel[] = [];
  const bytes = new Uint8Array([1, 2]);
  const command = withRenderer(async model => { models.push(model); return bytes; });
  const image = { type: "image", file: bytes } as const;
  expect(await command(overview, groupOwner)).toEqual(image);
  expect(models[0]?.groups.map(({ title }) => title)).toEqual([
    "消息相关", "申请通知", "列表变动", "其他通知", "系统设置",
    "Bot:99 单独配置", "群:77 单独配置", "Bot:99 & 群:77 单独配置",
  ]);
  expect(models[0]?.groups[0]?.rows.find(row => row.label === "好友消息")?.description)
    .toBe("已核验的文本、图片、表情和戳一戳，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4");
  expect(models[0]?.groups[0]?.rows.find(row => row.label === "群临时消息")?.description)
    .toBe("转发已核验的文本、图片和表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4");
  expect(models[0]?.groups[0]?.rows.find(row => row.label === "群撤回")?.description)
    .toBe("群撤回与好友撤回均支持文本、表情和已核验原图混排");
  expect(models[0]?.groups[0]?.rows.find(row => row.label === "好友撤回")?.description)
    .toBe("原音限已核验的独立 QQ SILK");
  const groupMessage = models[0]?.groups[0]?.rows.find(row => row.label === "群消息");
  expect(groupMessage?.value).toBe("已开启");
  expect(groupMessage?.hint).toBe("#通知设置群消息 + 开启/关闭");
  expect(models[0]?.groups[4]?.rows.map(row => row.hint)).toEqual([
    "#通知设置全部通知 + 开启/关闭", "#通知设置删除缓存时间 + 时间(秒)",
  ]);
  expect(groupMessage?.description).toBe("转发文本、图片、表情，语音原音限已核验的 QQ SILK，视频限已核验的独立 MP4");
  expect(models[0]?.groups[6]).toEqual({
    title: "群:77 单独配置", override: true, rows: [{ label: "群消息", value: "已关闭", off: true }],
  });
  expect(await command(overview, privateOwner)).toEqual(image);
  expect(models[1]?.groups.map(({ title }) => title).slice(5)).toEqual(["Bot:99 单独配置"]);

  expect(await command("#通知设置群消息群单独开启", groupOwner)).toEqual(["✅ 已保存通知设置。", image]);
  expect(models[2]?.groups[6]?.rows[0]?.value).toBe("已开启");
  expect(await command("#通知设置群消息群单独开启", groupOwner)).toEqual(["通知设置无变化。", image]);
  expect(await command("#通知设置群消息关闭", { ...groupOwner, isDelegated: true })).toContain("权限");
  expect(models).toHaveLength(4);
});

test("未配置原主题、渲染失败或连接已结束时保留既有文字与停止行为", async () => {
  const { withRenderer, command, legacy } = await fixture();
  await writeFile(legacy, "default: { groupMessage: true }\n");
  const expected = await command(overview, groupOwner);
  const fallback = withRenderer(async () => { throw new Error("无可用主题"); });
  expect(await fallback(overview, groupOwner)).toBe(expected);
  const unavailable = withRenderer(async () => undefined);
  expect(await unavailable(overview, groupOwner)).toBe(expected);
  const failedWriteCard = await fallback("#通知设置群消息关闭", groupOwner);
  expect(failedWriteCard).toContain("已保存通知设置");
  expect(failedWriteCard).toContain("群消息：关闭");
  const stopped = new AbortController();
  const aborted = withRenderer(async () => { stopped.abort(); return new Uint8Array([1]); }, stopped.signal);
  expect(await aborted(overview, groupOwner)).toBeUndefined();
});

test("通知设置三条规范化入口接管，旧品牌指令不读取或修改设置", async () => {
  const { withRenderer, legacy } = await fixture();
  const before = "default: { groupMessage: true }\n";
  await writeFile(legacy, before);
  let authorizations = 0;
  let renders = 0;
  const command = withRenderer(async () => { renders++; return undefined; });
  const owner = { ...groupOwner, configureNoticeSettings: async () => { authorizations++; return true; } };
  for (const message of ["#椰奶通知设置", "#椰奶通知设置群消息关闭", "#椰奶启用全部通知", "#椰奶禁用全部通知"]) {
    expect(isNoticeSettingsCommand(message)).toBe(false);
    expect(await command(message, owner)).toBeUndefined();
  }
  for (const message of ["#通知设置", "#通知设置群消息关闭", "#启用全部通知", "#禁用全部通知"]) {
    expect(isNoticeSettingsCommand(message)).toBe(true);
  }
  expect(authorizations).toBe(0);
  expect(renders).toBe(0);
  expect(await readFile(legacy, "utf8")).toBe(before);
});

test("面板只读写八个默认群通知开关并保留旧文件字节、覆盖和值", async () => {
  const { panel, command, legacy } = await fixture();
  const before = "# 原文件\r\ndefault: {groupMessage: false, privateMessage: true, misc: [1,2]}\r\n77: {groupRecall: true} # 原覆盖\r\n";
  await writeFile(legacy, before);
  const initial = await panel.read();
  expect(initial).toEqual({ settings: {
    groupMessage: false, grouptemporaryMessage: false, groupRecall: false, addGroupApplication: false,
    groupNumberChange: false, groupMemberNumberChange: false, groupAdminChange: false, botBeenBanned: false,
  }, revision: expect.stringMatching(/^[a-f0-9]{64}$/u), writable: true });
  expect(JSON.stringify(initial)).not.toContain(legacy);
  const after = await panel.write(initial.revision, { groupMessage: true, groupAdminChange: true });
  expect(after.settings).toEqual({ ...initial.settings, groupMessage: true, groupAdminChange: true });
  expect(after.revision).not.toBe(initial.revision);
  expect(await panel.read()).toEqual(after);
  expect(await command(overview, groupOwner)).toContain("群管理变动：开启");
  expect(await readFile(legacy, "utf8")).toBe(before.replace("{groupMessage: false", "{groupAdminChange: true, groupMessage: true"));
  const inode = (await stat(legacy)).ino;
  expect(await panel.write(after.revision, { groupMessage: true })).toEqual(after);
  expect((await stat(legacy)).ino).toBe(inode);
});

test("面板比较有效来源、真实符号链接目标和原字节，保护新来源及聊天修改", async () => {
  const { panel, command, legacy, primary } = await fixture();
  const original = "default: {groupRecall: false}\n";
  await writeFile(legacy, original);
  const old = await panel.read();
  await mkdir(join(primary, ".."), { recursive: true });
  await symlink(legacy, primary);
  const linked = await panel.read();
  expect(linked.revision).not.toBe(old.revision);
  await expect(panel.write(old.revision, { groupRecall: true })).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_CONFLICT" });
  await writeFile(legacy, original + "# 外部备注\n");
  const changed = await panel.read();
  await expect(panel.write(linked.revision, { groupRecall: true })).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_CONFLICT" });
  expect(changed.revision).not.toBe(linked.revision);

  const clock = await panel.write(changed.revision, { groupRecall: true });
  expect((await lstat(primary)).isSymbolicLink()).toBe(true);
  expect(await readFile(legacy, "utf8")).toBe("default: {groupRecall: true}\n# 外部备注\n");
  expect(await command("#通知设置群消息开启", groupOwner)).toContain("已保存");
  await expect(panel.write(clock.revision, { groupRecall: false })).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_CONFLICT" });
  expect((await panel.read()).settings).toMatchObject({ groupRecall: true, groupMessage: true });
});

test("同一旧版本的并发面板补丁只成功一次且共享聊天写锁", async () => {
  const { panel, command, legacy } = await fixture();
  const original = await panel.read();
  expect(original.writable).toBe(true);
  expect(await panel.write(original.revision, {})).toEqual(original);
  const results = await Promise.allSettled([
    panel.write(original.revision, { groupRecall: true }),
    panel.write(original.revision, { groupMessage: true }),
  ]);
  const conflicts = results.filter(result => result.status === "rejected");
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.reason).toMatchObject({ code: "GROUP_NOTICE_SETTINGS_CONFLICT" });
  const updated = await panel.read();
  expect(Number(updated.settings.groupRecall) + Number(updated.settings.groupMessage)).toBe(1);
  expect(await command("#通知设置好友消息开启", privateOwner)).toContain("已保存");
  await expect(panel.write(updated.revision, { groupAdminChange: true })).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_CONFLICT" });
  const final = await panel.write((await panel.read()).revision, { groupAdminChange: true });
  expect(final.settings.groupAdminChange).toBe(true);
  const [panelWrite, chatWrite] = await Promise.allSettled([
    panel.write(final.revision, { groupNumberChange: true }),
    command("#通知设置好友申请开启", groupOwner),
  ]);
  expect(chatWrite.status === "fulfilled" && chatWrite.value).toContain("已保存");
  if (panelWrite.status === "rejected") {
    expect(panelWrite.reason).toMatchObject({ code: "GROUP_NOTICE_SETTINGS_CONFLICT" });
    await panel.write((await panel.read()).revision, { groupNumberChange: true });
  }
  expect((await panel.read()).settings.groupNumberChange).toBe(true);
  expect(await command(overview, groupOwner)).toContain("好友申请：开启");
  await expect(readFile(legacy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("面板拒绝其它字段和非法配置，异常来源原样保留", async () => {
  const { panel, legacy } = await fixture();
  const good = "default: {groupMessage: false, privateMessage: true}\n";
  await writeFile(legacy, good);
  const { revision } = await panel.read();
  for (const patch of [
    { groupMessage: "true" }, { botId: 99 }, { 77: false }, { path: "/tmp/notice.yaml" },
    { notificationsAll: false }, { privateMessage: true }, { msgSaveDeltime: 600 },
    ["groupMessage"], JSON.parse('{"__proto__":true}'), { get groupMessage() { throw new Error("不得调用"); } },
  ]) await expect(panel.write(revision, patch)).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_INPUT" });
  await expect(panel.write(revision + "\n", {})).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_INPUT" });
  expect(await readFile(legacy, "utf8")).toBe(good);

  for (const invalid of ["default: [\n", "default: false\n", "default: {groupMessage: []}\n"]) {
    await writeFile(legacy, invalid);
    const broken = await panel.read();
    expect(broken.writable).toBe(false);
    expect(broken.revision).not.toBe(revision);
    await expect(panel.write(broken.revision, { groupRecall: true })).rejects.toMatchObject({ code: "GROUP_NOTICE_SETTINGS_UNAVAILABLE" });
    expect(await readFile(legacy, "utf8")).toBe(invalid);
  }
});
