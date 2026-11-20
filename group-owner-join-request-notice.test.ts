import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupOwnerJoinRequestNotice } from "./group-owner-join-request-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, userId: 42 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-owner-join-request-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("主人申请详情保留原 /0 头像、标题与来源，附言不能伪造字段", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { addGroupApplication: true }\n");
  const notice = createGroupOwnerJoinRequestNotice(paths);
  expect(await notice({ ...event, groupName: "本\n群", nickname: "申\u202e请人", comment: "你好\n这是一行附言" })).toEqual([
    { type: "image", file: "https://p.qlogo.cn/gh/77/77/0" },
    "[通知(99) - 加群申请]\n", "群号：77\n", "群名：本 群\n", "账号：42\n", "昵称：申请人", "\n附言：你好 这是一行附言",
  ]);
  expect(await notice(event)).toContain("群名：未知\n");
  expect(await notice(event)).toContain("昵称：未知");
  expect(await notice(event)).toContain("\n附言：无附加信息");
});

test("详情默认关闭且按旧四层，仅主人通知的开关生效", async () => {
  const paths = await fixture();
  const notice = createGroupOwnerJoinRequestNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { addGroupApplication: true }",
    "77: { addGroupApplication: false }",
    "'bot:99': { addGroupApplication: true }",
    "'bot:99:77': { addGroupApplication: false }",
  ].join("\n"));
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, groupId: 78 })).toBeDefined();
  expect(await notice({ ...event, botId: 100 })).toBeUndefined();
  await writeFile(paths.config, "default: { groupInviteRequest: true }\n");
  expect(await notice({ ...event, groupId: 78 })).toBeUndefined();
  await writeFile(paths.config, "77: { addGroupApplication: true }\n");
  expect(await notice(event)).toBeDefined();
});

test("无有效原身份、机器人自己或已终止时不生成主人详情", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { addGroupApplication: true }\n");
  const controller = new AbortController();
  const notice = createGroupOwnerJoinRequestNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...event, userId: 99 })).toBeUndefined();
  expect(await notice({ ...event, groupId: 0 })).toBeUndefined();
  expect(await notice({ ...event, botId: Number.NaN })).toBeUndefined();
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
});
