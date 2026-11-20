import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupOwnerInvitationNotice } from "./group-owner-invitation-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, userId: 42 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-owner-invitation-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("主人邀请详情保留旧群头像、标题与字段，只显示已核资料", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupInviteRequest: true }\n");
  const notice = createGroupOwnerInvitationNotice(paths);
  expect(await notice({ ...event, groupName: "本\n群", nickname: "邀\u202e请人" })).toEqual([
    { type: "image", file: "https://p.qlogo.cn/gh/77/77/0" },
    "[通知(99) - 邀请机器人进群]\n", "目标群号：77\n", "目标群名：本 群\n",
    "邀请人账号：42\n", "邀请人昵称：邀请人\n", "邀请人群身份：未知\n",
  ]);
  expect(await notice(event)).toContain("目标群名：未知\n");
  expect(await notice(event)).toContain("邀请人昵称：未知\n");
});

test("邀请默认关闭；目标群在旧四层按顺序覆盖", async () => {
  const paths = await fixture();
  const notice = createGroupOwnerInvitationNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { groupInviteRequest: true }",
    "77: { groupInviteRequest: false }",
    "'bot:99': { groupInviteRequest: true }",
    "'bot:99:77': { groupInviteRequest: false }",
  ].join("\n"));
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, botId: 100 })).toBeUndefined();
  expect(await notice({ ...event, groupId: 78 })).toBeDefined();
  await writeFile(paths.config, "default: { addGroupApplication: true }\n");
  expect(await notice({ ...event, groupId: 78 })).toBeUndefined();
  await writeFile(paths.config, "'bot:99:77': { groupInviteRequest: true }\n");
  expect(await notice(event)).toBeDefined();
});

test("无效邀请人、目标群或已终止事件不输出详情", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupInviteRequest: true }\n");
  const controller = new AbortController();
  const notice = createGroupOwnerInvitationNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...event, userId: 99 })).toBeUndefined();
  expect(await notice({ ...event, groupId: 0 })).toBeUndefined();
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
});
