import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupOwnerBanNotice } from "./group-owner-ban-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, userId: 99, operatorId: 42, duration: 3665 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-owner-ban-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("机器人禁言和解禁保留原头像、标题、操作者、群号和补零时长", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { botBeenBanned: true }\n");
  const notice = createGroupOwnerBanNotice(paths);
  const avatar = { type: "image", file: "https://p.qlogo.cn/gh/77/77/100" } as const;
  expect(await notice(event)).toEqual([
    avatar, "[通知(99) - 机器人被禁言]\n", "禁言人账号：42\n", "禁言群号：77\n", "禁言时长：01小时01分05秒",
  ]);
  expect(await notice({ ...event, duration: 0 })).toEqual([
    avatar, "[通知(99) - 机器人被解除禁言]\n", "处理人账号：42\n", "处理群号：77",
  ]);
  for (const [duration, text] of [[5, "05秒"], [60, "01分"], [86_400, "1天"], [90_060, "1天01小时01分"]] as const) {
    expect(await notice({ ...event, duration })).toContain(`禁言时长：${text}`);
  }
});

test("botBeenBanned 独立默认关闭，沿旧四层的真实 Bot 和群作用域", async () => {
  const paths = await fixture();
  const notice = createGroupOwnerBanNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { botBeenBanned: true }",
    "77: { botBeenBanned: false }",
    "'bot:99': { botBeenBanned: true }",
    "'bot:99:77': { botBeenBanned: false }",
  ].join("\n"));
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, groupId: 78 })).toBeDefined();
  expect(await notice({ ...event, botId: 100, userId: 100 })).toBeUndefined();
  await writeFile(paths.config, "default: { groupAdminChange: true, groupMemberNumberChange: true }\n");
  expect(await notice({ ...event, groupId: 78 })).toBeUndefined();
  await writeFile(paths.config, "default: { botBeenBanned: false }\n77: { botBeenBanned: true }\n");
  expect(await notice(event)).toBeDefined();
});

test("他人、全员、伪秒数、错误原生账号、空操作者或中止不产出", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { botBeenBanned: true }\n");
  const controller = new AbortController();
  const notice = createGroupOwnerBanNotice({ ...paths, signal: controller.signal });
  for (const invalid of [{ userId: 42 }, { userId: 0 }, { groupId: 0 }, { botId: Number.NaN }, { operatorId: 0 }, { duration: -1 },
    { duration: 1.5 }, { duration: Number.MAX_SAFE_INTEGER + 1 }, { duration: "0" as unknown as number }]) {
    expect(await notice({ ...event, ...invalid })).toBeUndefined();
  }
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
});
