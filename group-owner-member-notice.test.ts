import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupOwnerMemberNotice, type GroupOwnerMemberNoticeInput } from "./group-owner-member-notice.ts";

const event = { botId: 99, groupId: 77, userId: 42, direction: "increase", time: 1704038405 } satisfies GroupOwnerMemberNoticeInput;

async function fixture(run: (paths: { config: URL; legacyConfig: URL }) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-owner-member-notice-"));
  const root = pathToFileURL(path + "/");
  try {
    await run({ config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) });
  } finally {
    await rm(path, { force: true, recursive: true });
  }
}

test("主人收到旧成员加入标题、原群头像和字段顺序，离开只报告成员变动", () => fixture(async paths => {
  await writeFile(paths.config, "default: { groupMemberNumberChange: true }\n");
  const notice = createGroupOwnerMemberNotice(paths);
  expect(await notice({ ...event, action: "invite", groupName: "测\u202e试群", nickname: "原\n昵称", card: "群名片" })).toEqual([
    { type: "image", file: "https://p.qlogo.cn/gh/77/77/100" },
    ["🟢 新成员加入", "────────────", "群聊：测试群", "群号：77", "成员：原 昵称（42）", "名片：群名片",
      "方式：邀请入群", "", "时间：2024-01-01 00:00:05", "机器人：99"].join("\n"),
  ]);
  expect(await notice({ ...event, direction: "decrease", action: "kick", nickname: "同名", card: "同名" })).toEqual([
    { type: "image", file: "https://p.qlogo.cn/gh/77/77/100" },
    ["⚪ 成员离开", "────────────", "群聊：群名称暂不可用", "群号：77", "成员：同名（42）",
      "", "时间：2024-01-01 00:00:05", "机器人：99"].join("\n"),
  ]);
  expect((await notice({ ...event, action: "approve" }))?.[1]).toContain("方式：申请通过");
}));

test("默认关闭并按默认、群、机器人、机器人群四层覆盖，现配置优先于旧配置", () => fixture(async paths => {
  const notice = createGroupOwnerMemberNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { groupMemberNumberChange: true }",
    "77: { groupMemberNumberChange: false }",
    "'bot:98': { groupMemberNumberChange: true }",
    "'bot:99': { groupMemberNumberChange: true }",
    "'bot:99:77': { groupMemberNumberChange: false }",
  ].join("\n"));
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, botId: 98 })).toBeDefined();
  expect(await notice({ ...event, botId: 100 })).toBeUndefined();
  expect(await notice({ ...event, botId: 100, groupId: 78 })).toBeDefined();
  expect(await notice({ ...event, groupId: 78 })).toBeDefined();
  await writeFile(paths.config, "default: { groupNumberChange: true, groupAdminChange: true, welcome: true }\n");
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.config, "default: { groupMemberNumberChange: 'true' }\n");
  expect(await notice(event)).toBeUndefined();
}));

test("机器人自身、解散、无效身份和已取消的会话不产生通知", () => fixture(async paths => {
  await writeFile(paths.config, "default: { groupMemberNumberChange: true }\n");
  const controller = new AbortController();
  const notice = createGroupOwnerMemberNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...event, userId: event.botId })).toBeUndefined();
  expect(await notice({ ...event, dismiss: true })).toBeUndefined();
  expect(await notice({ ...event, direction: "decrease", action: "disband" })).toBeUndefined();
  expect(await notice({ ...event, direction: "decrease", action: "kick_me" })).toBeUndefined();
  expect(await notice({ ...event, groupId: 0 })).toBeUndefined();
  expect(await notice({ ...event, botId: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
  expect(await notice({ ...event, userId: -1 })).toBeUndefined();
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
}));
