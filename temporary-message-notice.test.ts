import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTemporaryMessageNotice } from "./temporary-message-notice.ts";

const temporary: string[] = [];
const message = { botId: 99, userId: 42, text: " 第一行\r\n第二\u0000行 " };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-temporary-message-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("旧临时通知保留头像和正文，对未核实群号明确标注并省略动作提示", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { grouptemporaryMessage: true }\n");
  const notice = createTemporaryMessageNotice(paths);
  expect(await notice({ ...message, groupId: 77, reportedGroupId: 88 })).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[消息(99) - 群临时消息]\n", "来源群号：77\n", "发送人账号：42\n", "消息内容：", " 第一行\n第二行 ",
  ]);
  expect(await notice({ ...message, reportedGroupId: 88 })).toContain("来源群号：未核实（协议报告 88）\n");
  expect(await notice(message)).toContain("来源群号：未核实\n");
  expect(await notice({ ...message, reportedGroupId: 0 })).toContain("来源群号：未核实\n");
});

test("默认关闭，只有核实原群参加默认、群、机器人、机器人原群四层", async () => {
  const paths = await fixture();
  const notice = createTemporaryMessageNotice(paths);
  expect(await notice({ ...message, groupId: 77 })).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { grouptemporaryMessage: false, privateMessage: true }",
    "77: { grouptemporaryMessage: true }",
    "88: { grouptemporaryMessage: true }",
    "'': { grouptemporaryMessage: true }",
    "'bot:99:': { grouptemporaryMessage: true }",
    "'bot:99:88': { grouptemporaryMessage: false }",
  ].join("\n"));
  expect(await notice({ ...message, groupId: 77 })).toBeDefined();
  expect(await notice({ ...message, groupId: 88 })).toBeUndefined();
  expect(await notice({ ...message, reportedGroupId: 77 })).toBeUndefined();
  expect(await notice(message)).toBeUndefined();
  await writeFile(paths.config, [
    "default: { grouptemporaryMessage: true }",
    "77: { grouptemporaryMessage: false }",
    "'bot:99': { grouptemporaryMessage: true }",
    "'bot:99:77': { grouptemporaryMessage: false }",
  ].join("\n"));
  expect(await notice({ ...message, groupId: 77 })).toBeUndefined();
  expect(await notice({ ...message, reportedGroupId: 77 })).toBeDefined();
  expect(await notice({ ...message, botId: 100, groupId: 77 })).toBeUndefined();
  await writeFile(paths.config, "default: [\n");
  expect(await notice({ ...message, groupId: 77 })).toBeUndefined();
});

test("非法账号、空正文或关闭的通知生命周期不产出消息", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { grouptemporaryMessage: true }\n");
  const controller = new AbortController();
  const notice = createTemporaryMessageNotice({ ...paths, signal: controller.signal });
  expect(await notice({ ...message, userId: 99 })).toBeUndefined();
  expect(await notice({ ...message, botId: Number.NaN })).toBeUndefined();
  expect(await notice({ ...message, text: " \u0000" })).toBeUndefined();
  expect(await notice(message, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice(message)).toBeUndefined();
});

test("临时正文仅在启用且会话有效时惰性读取，语音摘要保留原通知布局", async () => {
  const paths = await fixture();
  const controller = new AbortController();
  const notice = createTemporaryMessageNotice({ ...paths, signal: controller.signal });
  let reads = 0;
  const input = {
    botId: 99, userId: 42, groupId: 77,
    readParts: async () => { reads++; return ["[语音]（原音不可用）"]; },
  };
  expect(await notice(input)).toBeUndefined();
  expect(reads).toBe(0);
  await writeFile(paths.config, "77: { grouptemporaryMessage: true }\n");
  expect(await notice({ ...input, groupId: undefined, reportedGroupId: 77 })).toBeUndefined();
  expect(await notice({ ...input, userId: 99 })).toBeUndefined();
  expect(await notice(input, AbortSignal.abort())).toBeUndefined();
  expect(reads).toBe(0);

  expect(await notice(input)).toEqual([
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[消息(99) - 群临时消息]\n", "来源群号：77\n", "发送人账号：42\n", "消息内容：", "[语音]（原音不可用）",
  ]);
  expect(reads).toBe(1);
  expect(await notice({ ...input, text: "[语音]", readParts: async () => undefined })).toBeUndefined();
  expect(await notice({ ...input, readParts: async () => { throw new Error("offline"); } })).toBeUndefined();
  expect(await notice({ ...input, readParts: async () => [" \u0000"] })).toBeUndefined();

  const session = new AbortController();
  expect(await notice({
    ...input, readParts: async () => { session.abort(); return ["[语音]"]; },
  }, session.signal)).toBeUndefined();
  expect(await notice({
    ...input, readParts: async () => { controller.abort(); return ["[语音]"]; },
  })).toBeUndefined();
});

test("临时图文和表情保留原顺序，支持纯图与纯表情且拒绝未核正文", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { grouptemporaryMessage: true }\n");
  const notice = createTemporaryMessageNotice(paths);
  const input = { botId: 99, userId: 42, groupId: 77 };
  const image = { type: "image", file: new Uint8Array([1, 2, 3]) } as const;
  const face = { type: "face", data: { id: "21", is_large: true } } as const;
  const prefix = [
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "[消息(99) - 群临时消息]\n", "来源群号：77\n", "发送人账号：42\n", "消息内容：",
  ] as const;
  expect(await notice({
    ...input, readParts: async () => ["先\r\n", image, "中", face, "末"],
  })).toEqual([...prefix, "先\n", image, "中", face, "末"]);
  expect(await notice({ ...input, readParts: async () => [image] })).toEqual([...prefix, image]);
  expect(await notice({ ...input, readParts: async () => [face] })).toEqual([...prefix, face]);
  expect(await notice({ ...input, readParts: async () => [] })).toBeUndefined();
  expect(await notice({
    ...input, text: "后备", readParts: async () => ["第一段", { type: "image", file: "https://example.invalid/image" }],
  })).toBeUndefined();
  expect(await notice({
    ...input, readParts: async () => [image, { type: "face", data: { id: "invalid" } }],
  })).toBeUndefined();
});
