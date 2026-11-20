import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupOwnerAdminNotice } from "./group-owner-admin-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, userId: 42, set: true };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-owner-admin-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("普通成员与机器人管理授予撤销保留四个原标题、群头像和原字段", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupAdminChange: true }\n");
  const notice = createGroupOwnerAdminNotice(paths);
  const avatar = { type: "image", file: "https://p.qlogo.cn/gh/77/77/100" } as const;
  for (const [userId, set, title] of [
    [42, true, "新增群管理员"], [42, false, "取消群管理员"],
    [99, true, "机器人被设置管理"], [99, false, "机器人被取消管理"],
  ] as const) {
    expect(await notice({ ...event, userId, set })).toEqual([
      avatar, `[通知(99) - ${title}]\n`,
      ...(userId !== event.botId ? [`被操作账号：${userId}\n`] : []), "被操作群号：77",
    ]);
  }
});

test("groupAdminChange 独立默认关闭，四层覆盖按当前真实群和账号", async () => {
  const paths = await fixture();
  const notice = createGroupOwnerAdminNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { groupAdminChange: true }",
    "77: { groupAdminChange: false }",
    "'bot:99': { groupAdminChange: true }",
    "'bot:99:77': { groupAdminChange: false }",
  ].join("\n"));
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, botId: 100 })).toBeUndefined();
  expect(await notice({ ...event, groupId: 78 })).toBeDefined();
  await writeFile(paths.config, "default: { groupRecall: true, groupMemberNumberChange: true }\n");
  expect(await notice({ ...event, groupId: 78 })).toBeUndefined();
  await writeFile(paths.config, "default: { groupAdminChange: false }\n77: { groupAdminChange: true }\n");
  expect(await notice(event)).toBeDefined();
});

test("无效事件身份、伪布尔和中止信号不生成管理变动通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupAdminChange: true }\n");
  const controller = new AbortController();
  const notice = createGroupOwnerAdminNotice({ ...paths, signal: controller.signal });
  for (const invalid of [{ botId: 0 }, { groupId: Number.NaN }, { userId: -1 }, { set: "false" as unknown as boolean }]) {
    expect(await notice({ ...event, ...invalid })).toBeUndefined();
  }
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
});
