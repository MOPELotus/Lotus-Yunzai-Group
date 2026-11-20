import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupOwnerGroupNotice, type GroupOwnerGroupNoticeInput } from "./group-owner-group-notice.ts";

const temporary: string[] = [];
const event = { botId: 99, groupId: 77, kind: "joined", time: 1704038405 } satisfies GroupOwnerGroupNoticeInput;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-owner-group-notice-"));
  temporary.push(path);
  const root = pathToFileURL(path + "/");
  return { config: new URL("group-notice.yaml", root), legacyConfig: new URL("legacy-notice.yaml", root) };
}

test("机器人原入退群、被移出、群解散模板是纯文字，未核退群类型用中性标题", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupNumberChange: true }\n");
  const notice = createGroupOwnerGroupNotice(paths);
  for (const [kind, title, operator] of [
    ["joined", "🟢 机器人加入群聊", false], ["left", "⚪ 机器人退出群聊", false],
    ["removed", "🔴 机器人被移出", true], ["dissolved", "🔴 群聊已解散", true],
    ["departed", "⚪ 机器人已离开群聊", false],
  ] as const) {
    const output = await notice({ ...event, kind, operatorId: 51, groupName: "测试\n\u202e群" });
    expect(output).toBe([
      title, "────────────", "群聊：测试 群", "群号：77", ...(operator ? ["操作人：51"] : []),
      "", "时间：2024-01-01 00:00:05", "机器人：99",
    ].join("\n"));
  }
  expect((await notice({ ...event, kind: "removed", operatorId: 0 }))).not.toContain("操作人");
});

test("通知独立默认关闭，四层只看真实群，群名查询在启用且无原名时才执行", async () => {
  const paths = await fixture();
  const notice = createGroupOwnerGroupNotice(paths);
  let calls = 0;
  const describe = async () => { calls++; return "核实的群"; };
  expect(await notice({ ...event, describe })).toBeUndefined();
  await writeFile(paths.legacyConfig, [
    "default: { groupNumberChange: false }",
    "77: { groupNumberChange: true }",
    "'bot:99': { groupNumberChange: false }",
    "'bot:99:77': { groupNumberChange: true }",
  ].join("\n"));
  expect(await notice({ ...event, groupId: 88, describe })).toBeUndefined();
  expect(await notice({ ...event, groupName: "原群名", describe })).toContain("群聊：原群名");
  expect(calls).toBe(0);
  expect(await notice({ ...event, describe })).toContain("群聊：核实的群");
  expect(calls).toBe(1);
  expect(await notice({ ...event, describe: async () => { throw new Error("暂不可查"); } })).toContain("群聊：群名称暂不可用");
  await writeFile(paths.config, "default: { groupMemberNumberChange: true }\n");
  expect(await notice({ ...event, describe })).toBeUndefined();
  expect(calls).toBe(1);
});

test("不从无效时间、事件或已中止的读群名生成通知", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "default: { groupNumberChange: true }\n");
  const notice = createGroupOwnerGroupNotice(paths);
  for (const invalid of [{ time: 0 }, { time: Number.MAX_SAFE_INTEGER }, { botId: 0 }, { groupId: Number.NaN },
    { kind: "transfer" as "joined" }]) {
    expect(await notice({ ...event, ...invalid })).toBeUndefined();
  }
  const stop = new AbortController();
  expect(await notice({ ...event, describe: async () => { stop.abort(); return "迟到群名"; } }, stop.signal)).toBeUndefined();
});
