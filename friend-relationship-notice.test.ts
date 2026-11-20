import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFriendRelationshipNotice, type FriendRelationshipNoticeInput } from "./friend-relationship-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, userId: 42, kind: "increase", nickname: "朋\n\u202e友" } satisfies FriendRelationshipNoticeInput;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-friend-relationship-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("好友增减保留原标题与头像，只使用事件给出的昵称", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { friendNumberChange: true }\n");
  const notice = createFriendRelationshipNotice(paths);
  expect(await notice(event)).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[通知(99) - 新增好友]\n", "好友账号：42\n", "好友昵称：朋 友",
  ]);
  expect(await notice({ ...event, nickname: undefined, kind: "decrease" })).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[通知(99) - 好友减少]\n", "好友账号：42\n", "好友昵称：未知",
  ]);
});

test("默认关闭，依旧配置逐层覆盖且不被好友消息/申请开关打开", async () => {
  const paths = await fixture();
  const notice = createFriendRelationshipNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { friendNumberChange: true }",
    "'': { friendNumberChange: false }",
    "'bot:99': { friendNumberChange: true }",
    "'bot:100:': { friendNumberChange: true }",
  ].join("\n"));
  expect(await notice(event)).toBeDefined();
  expect(await notice({ ...event, botId: 100 })).toBeDefined();
  expect(await notice({ ...event, botId: 101 })).toBeUndefined();
  await writeFile(paths.config, "default: { privateMessage: true, friendRequest: true }\n");
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.config, "default: { friendNumberChange: true }\n'bot:99:': { friendNumberChange: false }\n");
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, botId: 100 })).toBeDefined();
});

test("无有效身份证据、戳一戳或已中止时不生成好友增减通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { friendNumberChange: true }\n");
  const controller = new AbortController();
  const notice = createFriendRelationshipNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...event, userId: 99 })).toBeUndefined();
  expect(await notice({ ...event, botId: 0 })).toBeUndefined();
  expect(await notice({ ...event, kind: "poke" as "increase" })).toBeUndefined();
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
});
