import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFriendMessageNotice } from "./friend-message-notice.ts";

const temporary: string[] = [];
const message = { botId: 99, userId: 42, nickname: "朋\n\u202e友", text: " 第一行\r\n第二\u0000行 " };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-friend-message-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("好友消息沿旧头像、字段和原正文布局，可展示直接回复而不提示引用", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { privateMessage: true }\n");
  const notice = createFriendMessageNotice(paths);
  expect(await notice({ ...message, showHint: true })).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[消息(99) - 好友消息]\n", "好友账号：42\n", "好友昵称：朋 友\n",
    "消息内容：", " 第一行\n第二行 ", "\n-------------\n可发送：回复 42 <内容>",
  ]);
  const noHint = await notice({ ...message, nickname: undefined });
  expect(noHint?.join("")).toContain("好友昵称：未知");
  expect(noHint?.join("")).not.toContain("可发送");
  expect(noHint?.join("")).not.toContain("引用");
});

test("privateMessage 按旧四层继承，默认关闭并与好友申请设置分开", async () => {
  const paths = await fixture();
  const notice = createFriendMessageNotice(paths);
  expect(await notice(message)).toBeUndefined();
  await writeFile(paths.legacyConfig,
    "default: { privateMessage: true }\n'': { privateMessage: false }\n'bot:99': { privateMessage: true }\n'bot:100:': { privateMessage: true }\n");
  expect(await notice(message)).toBeDefined();
  expect(await notice({ ...message, botId: 100 })).toBeDefined();
  expect(await notice({ ...message, botId: 101 })).toBeUndefined();
  await writeFile(paths.config, "default: { friendRequest: true }\n'bot:99': { privateMessage: true }\n'bot:99:': { privateMessage: false }\n");
  expect(await notice(message)).toBeUndefined();
  await writeFile(paths.config, "default: { privateMessage: 'true' }\n");
  expect(await notice(message)).toBeUndefined();
  await writeFile(paths.config, "default: [\n");
  expect(await notice(message)).toBeUndefined();
  await rm(paths.config);
  expect(await notice(message)).toBeDefined();
});

test("只在启用且正文有效时请求宿主提示占用，失败仍可发主体", async () => {
  const paths = await fixture();
  const notice = createFriendMessageNotice(paths);
  let calls = 0;
  const showHint = async () => { calls++; return true; };
  expect(await notice({ ...message, showHint })).toBeUndefined();
  expect(calls).toBe(0);
  await writeFile(paths.config, "default: { privateMessage: true }\n");
  expect(await notice({ ...message, text: " \u0000\r\n", showHint })).toBeUndefined();
  expect(await notice({ ...message, userId: 99, showHint })).toBeUndefined();
  expect(calls).toBe(0);
  expect((await notice({ ...message, showHint }))?.join("")).toContain("可发送：回复 42 <内容>");
  expect(calls).toBe(1);
  const output = await notice({ ...message, showHint: async () => { throw new Error("提示存储不可用"); } });
  expect(output?.join("")).toContain("消息内容：");
  expect(output?.join("")).not.toContain("可发送");
});

test("模块生命周期或事件中止后不再输出好友通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { privateMessage: true }\n");
  const controller = new AbortController();
  const notice = createFriendMessageNotice({ ...paths, signal: controller.signal });
  expect(await notice(message, AbortSignal.abort())).toBeUndefined();
  expect(await notice({ ...message, showHint: async () => { controller.abort(); return true; } })).toBeUndefined();
  expect(await notice(message)).toBeUndefined();
});

test("只有真实可引用且本次允许提示时才展示引用回复与直接 QQ 指令", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { privateMessage: true }\n");
  const notice = createFriendMessageNotice(paths);
  const quote = await notice({ ...message, canQuote: true, showHint: async () => true });
  expect(quote?.join("")).toContain("引用该消息：回复 <内容>\n可发送：回复 42 <内容>");
  expect((await notice({ ...message, canQuote: true, showHint: false }))?.join("")).not.toContain("引用该消息");
  expect((await notice({ ...message, canQuote: false, showHint: true }))?.join("")).not.toContain("引用该消息");
});
