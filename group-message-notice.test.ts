import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupMessageNotice } from "./group-message-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, userId: 42, text: "你好\r\n第二行" };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-message-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("群文本主人通知保留旧 /100 头像、标题和原正文行序", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupMessage: true }\n");
  const notice = createGroupMessageNotice(paths);
  expect(await notice({
    ...event, nickname: "发\u202e言人", describeGroup: async () => "本\n群",
  })).toEqual([
    { type: "image", file: "https://p.qlogo.cn/gh/77/77/100" },
    "[消息(99) - 群聊消息]\n", "来源群号：77\n", "来源群名：本 群\n",
    "发送人账号：42\n", "发送人昵称：发言人\n", "消息内容：", "你好\n第二行",
  ]);
  expect(await notice({
    ...event, describeGroup: async () => { throw new Error("offline"); },
  })).toContain("来源群名：未知\n");
  expect(await notice(event)).toContain("发送人昵称：未知\n");
});

test("群消息默认关闭，配置按旧四层且关闭时不查群名", async () => {
  const paths = await fixture();
  const notice = createGroupMessageNotice(paths);
  let lookups = 0;
  const input = { ...event, describeGroup: async () => { lookups++; return "测试群"; } };
  expect(await notice(input)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { groupMessage: true }",
    "77: { groupMessage: false }",
    "'bot:99': { groupMessage: true }",
    "'bot:99:77': { groupMessage: false }",
  ].join("\n"));
  expect(await notice(input)).toBeUndefined();
  expect(await notice({ ...input, botId: 100 })).toBeUndefined();
  expect(await notice({ ...input, groupId: 78 })).toBeDefined();
  expect(lookups).toBe(1);

  await writeFile(paths.config, "default: { privateMessage: true }\n");
  expect(await notice({ ...input, groupId: 78 })).toBeUndefined();
  expect(lookups).toBe(1);
  await writeFile(paths.config, "'bot:99:77': { groupMessage: true }\n");
  expect(await notice(input)).toBeDefined();
  expect(lookups).toBe(2);
});

test("无效输入不查名，连接或模块在查询中终止时无通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupMessage: true }\n");
  const module = new AbortController();
  const connection = new AbortController();
  const notice = createGroupMessageNotice({ ...paths, signal: module.signal });
  let lookups = 0;
  const describeGroup = async () => { lookups++; return "原群"; };
  for (const input of [
    { ...event, groupId: 0 },
    { ...event, userId: 99 },
    { ...event, text: "\u202e \r\n" },
  ]) expect(await notice({ ...input, describeGroup })).toBeUndefined();
  expect(await notice({ ...event, describeGroup }, AbortSignal.abort())).toBeUndefined();
  expect(lookups).toBe(0);

  expect(await notice({
    ...event, describeGroup: async () => { connection.abort(); return "原群"; },
  }, connection.signal)).toBeUndefined();
  expect(await notice({
    ...event, describeGroup: async () => { module.abort(); return "原群"; },
  })).toBeUndefined();
});
