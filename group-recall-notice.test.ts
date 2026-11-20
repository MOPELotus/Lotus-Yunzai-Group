import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupRecallNotice } from "./group-recall-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, userId: 42, time: 1704038405, text: "原\r\n撤回\u0000消息" };
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-recall-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("保留旧群头像及群撤回摘要，原文独立交给宿主合并转发", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupRecall: true }\n");
  const notice = createGroupRecallNotice(paths);
  expect(await notice.retention(99, 77)).toBe(600);
  expect(await notice.format({ ...event, nickname: "原\n发言者", groupName: "测\u202e试群", operatorId: 42 })).toEqual({
    summary: [
      { type: "image", file: "https://p.qlogo.cn/gh/77/77/100" },
      "[通知(99) - 群聊撤回]\n", "撤回群名：测试群\n", "撤回群号：77\n",
      "撤回人员：原 发言者(42)\n", "撤回时间：01-01 00:00:05",
    ],
    text: "原\n撤回消息",
    nickname: "原 发言者",
  });
});

test("只有可信异于作者的操作号区分管理撤回，昵称或群名缺失不猜", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupRecall: true }\n");
  const notice = createGroupRecallNotice(paths);
  const managed = await notice.format({ ...event, operatorId: 43, operatorName: "管理员" });
  expect(managed?.summary).toContain("[通知(99) - 群聊管理撤回]\n");
  expect(managed?.summary).toContain("撤回管理：管理员(43)\n");
  expect(managed?.summary).toContain("被撤回人：42\n");
  expect(managed?.summary).toContain("撤回群名：未知\n");
  expect(managed?.nickname).toBeUndefined();
  for (const operatorId of [undefined, 0, event.userId]) {
    const unknown = await notice.format({ ...event, operatorId, operatorName: "不应显示" });
    expect(unknown?.summary).toContain("撤回人员：42\n");
    expect(unknown?.summary.join("")).not.toContain("管理");
    expect(unknown?.summary.join("")).not.toContain("不应显示");
  }
});

test("groupRecall 和 TTL 按默认、群、机器人、机器人群四层覆盖，要求真实群号", async () => {
  const paths = await fixture();
  const notice = createGroupRecallNotice(paths);
  expect(await notice.retention(99, 77)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { groupRecall: true, msgSaveDeltime: 50 }",
    "77: { groupRecall: false, msgSaveDeltime: 60 }",
    "'bot:99': { groupRecall: true, msgSaveDeltime: '90' }",
    "'bot:99:77': { msgSaveDeltime: 120 }",
    "'bot:99:88': { msgSaveDeltime: 0 }",
  ].join("\n"));
  expect(await notice.retention(99, 77)).toBe(120);
  expect(await notice.retention(99, 66)).toBe(90);
  expect(await notice.retention(100, 77)).toBeUndefined();
  expect(await notice.retention(100, 66)).toBe(50);
  expect(await notice.retention(99, 88)).toBeUndefined();
  expect(await notice.retention(99, 0)).toBeUndefined();
  expect(await notice.format({ ...event, groupId: 88 })).toBeUndefined();
  await writeFile(paths.config, "default: { PrivateRecall: true }\n");
  expect(await notice.retention(99, 77)).toBeUndefined();
});

test("机器人自己发言或撤回、无正文、非法时间与已中止会话不通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupRecall: true }\n");
  const controller = new AbortController();
  const notice = createGroupRecallNotice({ ...paths, signal: controller.signal });
  expect(await notice.format({ ...event, userId: 99 })).toBeUndefined();
  expect(await notice.format({ ...event, operatorId: 99 })).toBeUndefined();
  expect(await notice.format({ ...event, time: 0 })).toBeUndefined();
  expect(await notice.format({ ...event, text: " " })).toBeUndefined();
  expect(await notice.format(event, AbortSignal.abort())).toBeUndefined();
  controller.abort();
  expect(await notice.retention(99, 77)).toBeUndefined();
});

test("群撤回保持摘要字节，输出一个按原序的正文段列表", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupRecall: true }\n");
  const notice = createGroupRecallNotice(paths);
  const face = { type: "face", data: { id: "8", is_large: false } } as const;
  const image = { type: "image", file: new Uint8Array([4, 5, 6]) } as const;
  const original = await notice.format(event);
  if (!original) throw new Error("纯文本通知缺失");
  expect(original.parts).toBeUndefined();
  expect(await notice.format({ ...event, parts: ["先\r\n行\u0000", image, face, "后"] })).toEqual({
    ...original, parts: ["先\n行", image, face, "后"],
  });
  expect(await notice.format({ ...event, text: "", parts: [image] })).toEqual({
    ...original, text: "", parts: [image],
  });
  expect(await notice.format({ ...event, text: "", parts: [face] })).toEqual({
    ...original, text: "", parts: [face],
  });
  expect(await notice.format({ ...event, parts: [
    "勿转发前半段", { type: "image", file: new Uint8Array() },
  ] })).toBeUndefined();
  expect(await notice.format({ ...event, parts: [{ type: "face", data: { id: "unsupported" } }] })).toBeUndefined();
  expect(await notice.format({ ...event, parts: [] })).toBeUndefined();
});

test("群撤回语音在原摘要后单行标记特殊消息", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupRecall: true }\n");
  const notice = createGroupRecallNotice(paths);
  const plain = await notice.format({ ...event, operatorId: 43, operatorName: "管理员", text: "[语音]" });
  if (!plain) throw new Error("群撤回摘要缺失");
  expect(await notice.format({
    ...event, operatorId: 43, operatorName: "管理员", text: "[语音]", special: "[语音]",
  })).toEqual({ ...plain, summary: [...plain.summary, "\n特殊消息：[语音]"] });
  expect(await notice.format({ ...event, text: "[语音]", special: "[语音]" }, AbortSignal.abort())).toBeUndefined();
});
