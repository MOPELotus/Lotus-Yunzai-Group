import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredFriendRequestNotice, createFriendRequestNotice } from "./friend-request-notice.ts";

const temporary: string[] = [];
const request = { botId: 99, userId: 42 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-friend-request-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("旧通知设置按默认、空群、机器人和机器人空群依次覆盖，仅显式 true 开启", () => {
  const defaults = { default: { friendRequest: true } };
  const emptyGroup = { ...defaults, "": { friendRequest: false } };
  const bot = { ...emptyGroup, "bot:99": { friendRequest: true } };
  expect(configuredFriendRequestNotice(undefined, 99)).toBe(false);
  expect(configuredFriendRequestNotice({ default: { notificationsAll: true } }, 99)).toBe(false);
  expect(configuredFriendRequestNotice(defaults, 99)).toBe(true);
  expect(configuredFriendRequestNotice(emptyGroup, 99)).toBe(false);
  expect(configuredFriendRequestNotice(bot, 99)).toBe(true);
  expect(configuredFriendRequestNotice(bot, 100)).toBe(false);
  expect(configuredFriendRequestNotice({ ...bot, "bot:99:": { friendRequest: false } }, 99)).toBe(false);
  expect(configuredFriendRequestNotice({ ...bot, "bot:99:": { friendRequest: "true" } }, 99)).toBe(false);
  expect(configuredFriendRequestNotice({ ...bot, "bot:99:": { otherFlag: true }, "bot:99:77": { friendRequest: false } }, 99)).toBe(true);
});

test("新配置优先，缺失时读旧 YAML，错误文件或默认空不启用通知", async () => {
  const paths = await fixture();
  const notice = createFriendRequestNotice(paths);
  expect(await notice(request)).toBeUndefined();
  await writeFile(paths.legacyConfig, "default: { friendRequest: false }\n'': { friendRequest: true }\n'bot:99:': { friendRequest: true }\n");
  expect(await notice(request)).toBeDefined();
  await writeFile(paths.config, "default: { friendRequest: true }\n'bot:99:': { friendRequest: false }\n");
  expect(await notice(request)).toBeUndefined();
  expect(await notice({ ...request, botId: 100 })).toBeDefined();
  await writeFile(paths.config, "default: [\n");
  expect(await notice(request)).toBeUndefined();
  await rm(paths.config);
  expect(await notice(request)).toBeDefined();
});

test("旧头像和申请字段保留，仅有列表引导，自动审批状态按实际回执展示", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { friendRequest: true }\n");
  const notice = createFriendRequestNotice(paths);
  const event = { ...request, nickname: "朋\n\u202e友", source: "群搜索", comment: "附言", flag: "opaque", uid: "opaque-uid" };
  expect(await notice(event)).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[通知(99) - 添加好友申请]\n", "申请人账号：42\n", "申请人昵称：朋 友\n",
    "申请来源：群搜索\n", "附加信息：附言\n", "-------------\n可回复：#查看好友申请",
  ]);
  for (const [autoResult, expected] of [["confirmed", "Tip：自动审批请求已获协议端确认。"], ["rejected", "Tip：协议端未接受自动审批"],
    ["unknown", "Tip：自动审批结果未确认"]] as const) {
    const message = JSON.stringify(await notice({ ...event, autoResult }));
    expect(message).toContain(expected);
    expect(message).not.toContain("已通过");
    expect(message).not.toContain("同意好友申请");
    expect(message).not.toContain("opaque");
  }
  expect(JSON.stringify(await notice(request))).toContain("申请人昵称：未知");
});

test("拒绝无效原账号、已停模块或已终止请求", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { friendRequest: true }\n");
  const controller = new AbortController();
  const notice = createFriendRequestNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...request, userId: 99 })).toBeUndefined();
  expect(await notice({ ...request, userId: Number.NaN })).toBeUndefined();
  const event = AbortSignal.abort();
  expect(await notice(request, event)).toBeUndefined();
  controller.abort();
  expect(await notice(request)).toBeUndefined();
});
