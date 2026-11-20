import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFriendPokeNotice } from "./friend-poke-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, userId: 42 };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-friend-poke-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("好友戳一戳只输出旧头像、标题和来源账号", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { privateMessage: true }\n");
  expect(await createFriendPokeNotice(paths)(event)).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[消息(99) - 戳一戳]\n", "来源账号：42",
  ]);
});

test("使用已有好友消息开关和旧机器人配置优先级，缺失或无效时不启用", async () => {
  const paths = await fixture();
  const notice = createFriendPokeNotice(paths);
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { privateMessage: true }",
    "'': { privateMessage: false }",
    "'bot:99': { privateMessage: true }",
    "'bot:100:': { privateMessage: true }",
  ].join("\n"));
  expect(await notice(event)).toBeDefined();
  expect(await notice({ ...event, botId: 100 })).toBeDefined();
  expect(await notice({ ...event, botId: 101 })).toBeUndefined();
  await writeFile(paths.config, "default: { grouptemporaryMessage: true, friendNumberChange: true }\n");
  expect(await notice(event)).toBeUndefined();
  await writeFile(paths.config, "default: { privateMessage: true }\n'bot:99:': { privateMessage: false }\n");
  expect(await notice(event)).toBeUndefined();
  expect(await notice({ ...event, botId: 100 })).toBeDefined();
  await writeFile(paths.config, "default: [\n");
  expect(await notice({ ...event, botId: 100 })).toBeUndefined();
});

test("自己、无有效账号或已中止都不能生成通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { privateMessage: true }\n");
  const controller = new AbortController();
  const notice = createFriendPokeNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...event, userId: 99 })).toBeUndefined();
  expect(await notice({ ...event, userId: 0 })).toBeUndefined();
  expect(await notice({ ...event, botId: Number.NaN })).toBeUndefined();
  expect(await notice(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(event)).toBeUndefined();
});
