import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFriendRecallNotice } from "./friend-recall-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, userId: 42, time: 1704038405, text: "原\r\n撤回\u0000消息" };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-friend-recall-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("好友撤回保持旧头像、标题和原文，时间按北京时间跨日", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { PrivateRecall: true }\n");
  const notice = createFriendRecallNotice(paths);
  expect(await notice.retention(99)).toBe(600);
  expect(await notice.format(event)).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[消息(99) - 好友撤回消息]\n", "好友账号：42\n",
    "撤回时间：01-01 00:00:05\n", "撤回消息：", "原\n撤回消息",
  ]);
});

test("旧撤回开关与 TTL 逐层覆盖，接受实际 Redis 有效的正整秒", async () => {
  const paths = await fixture();
  const notice = createFriendRecallNotice(paths);
  expect(await notice.retention(99)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { PrivateRecall: true, msgSaveDeltime: 30 }",
    "'': { PrivateRecall: false, msgSaveDeltime: 60 }",
    "'bot:99': { PrivateRecall: true, msgSaveDeltime: '90' }",
    "'bot:99:': { msgSaveDeltime: 120 }",
    "'bot:100:': { PrivateRecall: true }",
  ].join("\n"));
  expect(await notice.retention(99)).toBe(120);
  expect(await notice.retention(100)).toBe(60);
  expect(await notice.retention(101)).toBeUndefined();
  await writeFile(paths.config, "default: { privateMessage: true, msgSaveDeltime: 600 }\n");
  expect(await notice.retention(99)).toBeUndefined();
  await writeFile(paths.config, "default: { PrivateRecall: true, msgSaveDeltime: 1 }\n");
  expect(await notice.retention(99)).toBe(1);
});

test("显式零、负数、小数、非整秒和非法配置不缓存也不通知", async () => {
  const paths = await fixture();
  const notice = createFriendRecallNotice(paths);
  for (const value of ["0", "-1", "1.5", "'1.5'", "'bad'", "null", "true", "9007199254740991"]) {
    await writeFile(paths.config, `default: { PrivateRecall: true, msgSaveDeltime: ${value} }\n`);
    expect(await notice.retention(99)).toBeUndefined();
    expect(await notice.format(event)).toBeUndefined();
  }
  await writeFile(paths.config, "default: [\n");
  expect(await notice.retention(99)).toBeUndefined();
});

test("无有效账号、原文或时刻，不生成通知，事件和模块中止不保留资格", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { PrivateRecall: true }\n");
  const controller = new AbortController();
  const notice = createFriendRecallNotice({ ...paths, signal: controller.signal });
  expect(await notice.format({ ...event, botId: 42 })).toBeUndefined();
  expect(await notice.format({ ...event, userId: 0 })).toBeUndefined();
  expect(await notice.format({ ...event, time: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  expect(await notice.format({ ...event, text: " \u0000\r\n" })).toBeUndefined();
  expect(await notice.format(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice.retention(99)).toBeUndefined();
});

test("好友撤回在原正文标签后保留文本及真实 QQ 表情顺序，支持纯表情", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { PrivateRecall: true }\n");
  const notice = createFriendRecallNotice(paths);
  const face = { type: "face", data: { id: 21, is_large: true } } as const;
  const original = await notice.format(event);
  const rich = await notice.format({ ...event, parts: ["第一\r\n行", face, "第二行"] });
  expect(rich).toEqual([...original!.slice(0, -1), "第一\n行", face, "第二行"]);
  expect(await notice.format({ ...event, text: "", parts: [face] })).toEqual([...original!.slice(0, -1), face]);
  expect(await notice.format({ ...event, parts: [
    "勿发送前半段", { type: "image", file: "https://example.invalid/picture" },
  ] })).toBeUndefined();
});
