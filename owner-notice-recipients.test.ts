import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOwnerNoticeRecipients } from "./owner-notice-recipients.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-owner-notice-recipients-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("旧全部通知读当前机器人和默认覆盖，忽略空群及其他群配置", async () => {
  const paths = await fixture();
  const recipients = createOwnerNoticeRecipients(paths);
  expect(await recipients(99)).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { notificationsAll: false }",
    "'': { notificationsAll: true }",
    "77: { notificationsAll: true }",
    "'bot:99': { notificationsAll: true }",
    "'bot:99:': { notificationsAll: false }",
    "'bot:99:77': { notificationsAll: false }",
    "'bot:101': { notificationsAll: 'false' }",
  ].join("\n"));
  expect(await recipients(99)).toBe(true);
  expect(await recipients(100)).toBe(false);
  expect(await recipients(101)).toBeUndefined();

  await writeFile(paths.config, "default: { privateMessage: true }\n");
  expect(await recipients(100)).toBeUndefined();
  await writeFile(paths.config, "default: { notificationsAll: true }\n'bot:99': { notificationsAll: false }\n");
  expect(await recipients(99)).toBe(false);
  expect(await recipients(100)).toBe(true);
});

test("无效账号和已结束的通知会话不返回收件人策略", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { notificationsAll: false }\n");
  const lifetime = new AbortController();
  const recipients = createOwnerNoticeRecipients({ ...paths, signal: lifetime.signal });
  expect(await recipients(0)).toBeUndefined();
  expect(await recipients(99, AbortSignal.abort())).toBeUndefined();
  const pending = recipients(99);
  lifetime.abort();
  expect(await pending).toBeUndefined();
  expect(await recipients(99)).toBeUndefined();
});
