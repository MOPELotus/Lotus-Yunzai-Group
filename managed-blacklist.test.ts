import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupMute, groupModerationFeature } from "./group-mute.ts";
import { createManagedBlacklist } from "./managed-blacklist.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lotus-managed-blacklist-"));
  temporary.push(directory);
  await mkdir(join(directory, "plugins/yenai-plugin/config/config"), { recursive: true });
  await mkdir(join(directory, "config"));
  const root = pathToFileURL(`${directory}/`);
  const primary = new URL("config/groupAdmin.yaml", root);
  const legacy = new URL("plugins/yenai-plugin/config/config/groupAdmin.yaml", root);
  let queue = Promise.resolve();
  function store() {
    return createManagedBlacklist(root, async () => {
      const waiting = queue;
      const held = Promise.withResolvers<void>();
      queue = waiting.then(() => held.promise);
      await waiting;
      return { close: () => held.resolve() };
    });
  }
  const active = store();
  const command = createGroupMute(root, active);
  return { directory, root, primary, legacy, store, active, command };
}

test("读取不创建配置，规范路径仅显式 blackQQ 覆盖旧记录", async () => {
  const { active, primary, legacy } = await fixture();
  expect(await active.blocked(43)).toBe(false);
  await expect(readFile(primary)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(legacy, 'blackQQ: ["43"]\n');
  await writeFile(primary, "whiteQQ: [44]\n");
  expect(await active.blocked(43)).toBe(true);
  expect(await active.update([45], true)).toBe(true);
  expect(await readFile(primary, "utf8")).toBe("whiteQQ: [44]\n");
  expect(await readFile(legacy, "utf8")).toContain("45");
  await writeFile(primary, "blackQQ: []\n");
  expect(await active.blocked(43)).toBe(false);
  expect(await active.update([46], true)).toBe(true);
  expect(await readFile(primary, "utf8")).toContain("46");
  expect(await active.blocked(45)).toBe(false);
});

test("并发编辑串行保留 YAML 注释、符号链接、BOM、CRLF 和其他字段", async () => {
  const { directory, active, store, legacy } = await fixture();
  const actual = join(directory, "original.yaml");
  await writeFile(actual, '\uFEFF# 文件头\r\nwhiteQQ: [44] # 白名单\r\nblackQQ: # 黑名单\r\n  - "43" # 旧成员\r\nfeature: true # 其他\r\n');
  await symlink(actual, legacy);
  expect(await Promise.all([active.update([45], true), store().update([46], true)])).toEqual([true, true]);
  const output = await readFile(actual, "utf8");
  expect(output).toStartWith("\uFEFF# 文件头\r\n");
  expect(output).toContain('  - "43" # 旧成员\r\n');
  expect(output).toContain("whiteQQ: [44] # 白名单\r\n");
  expect(output).toContain("feature: true # 其他\r\n");
  expect(await active.blocked(45)).toBe(true);
  expect(await active.blocked(46)).toBe(true);
  expect(await active.update([43, 70], false)).toBe(true);
  expect(await active.blocked(43)).toBe(false);
  expect(await readFile(legacy, "utf8")).toBe(await readFile(actual, "utf8"));
});

test("只修改目标字段源码，保留紧凑 flow、非目标注释、BOM 和 CRLF 原字节", async () => {
  const { active, primary } = await fixture();
  const original = '\uFEFF---\r\nwhiteQQ: [41,42] # untouched 😀\r\nblackQQ: [ "43",44, ]  # members\r\nnoBan: true # switch\r\nextra: {a: [1,2],b: 3}\r\n...\r\n# footer';
  await writeFile(primary, original);
  await active.update([45], true);
  const added = original.replace('[ "43",44, ]', '[ "43",44, 45, ]');
  expect(await readFile(primary)).toEqual(Buffer.from(added));
  await active.setAutoUnmute(false);
  const changed = added.replace("noBan: true", "noBan: false");
  expect(await readFile(primary)).toEqual(Buffer.from(changed));
  await active.update([44], false);
  expect(await readFile(primary)).toEqual(Buffer.from(changed.replace('[ "43",44, 45, ]', '["43", 45]')));
});

test("隐式空值、缺键及缩进不规则的列表只在能验证范围时发布", async () => {
  const { active, primary } = await fixture();
  const cases = [
    ["blackQQ: # keep\r\nwhiteQQ: [41,42]\r\n", "blackQQ: [43] # keep\r\nwhiteQQ: [41,42]\r\n"],
    ["blackQQ: ~ # keep\n", "blackQQ: [43] # keep\n"],
    ["{whiteQQ: [41,42],noBan: false}\n", "{blackQQ: [43], whiteQQ: [41,42],noBan: false}\n"],
    ["---\nwhiteQQ: [41,42]\n...\n# end", "---\nwhiteQQ: [41,42]\nblackQQ: [43]\n...\n# end"],
    ["\uFEFF# 空配置", "\uFEFF# 空配置\nblackQQ: [43]\n"],
    ["---\n# 空文档\n...\n", "---\n# 空文档\nblackQQ: [43]\n...\n"],
    ["null # 空配置\n", "{blackQQ: [43]} # 空配置\n"],
  ];
  for (const [before, expected] of cases) {
    await writeFile(primary, before!);
    expect(await active.update([43], true)).toBe(true);
    expect(await readFile(primary, "utf8")).toBe(expected!);
  }
  const block = "blackQQ:\n- 43 # removed\n# intervening\n- 44 # removed\nwhiteQQ: [41,42]\n";
  await writeFile(primary, block);
  expect(await active.update([43, 44], false)).toBe(true);
  expect(await readFile(primary, "utf8")).toBe("blackQQ:\n  []\n# intervening\nwhiteQQ: [41,42]\n");
  const ambiguous = "blackQQ: [43, # keep with another item?\n  44]\nwhiteQQ: [41,42]\n";
  await writeFile(primary, ambiguous);
  await expect(active.update([43], false)).rejects.toThrow("无法安全定位");
  expect(await readFile(primary, "utf8")).toBe(ambiguous);
});

test("YAML 共享引用、损坏文件和锁外编辑都不会被覆盖", async () => {
  const { active, primary } = await fixture();
  for (const raw of ["blackQQ: &shared [43]\nother: *shared\n", "blackQQ: [43\n"]) {
    await writeFile(primary, raw);
    await expect(active.update([45], true)).rejects.toThrow();
    expect(await readFile(primary, "utf8")).toBe(raw);
  }
  await writeFile(primary, "blackQQ: [43]\n");
  await expect(active.update([45], true, undefined, async () => {
    await writeFile(primary, "blackQQ: [46]\n");
    return true;
  })).rejects.toThrow("已变更");
  expect(await readFile(primary, "utf8")).toBe("blackQQ: [46]\n");
});

test("群管加删黑名单要求本群原会话，提交前复核权限", async () => {
  const { active, command, primary } = await fixture();
  let checks = 0;
  const scope = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 77, message_id: 1,
    isBotMaster: () => false, async groupManageBlacklist() { return ++checks === 1; } };
  expect(await command("#群管加黑名单43", scope)).toContain("没有编辑");
  expect(await active.blocked(43)).toBe(false);
  await expect(readFile(primary)).rejects.toMatchObject({ code: "ENOENT" });
  const live = { ...scope, async groupManageBlacklist() { return true; } };
  expect(await command("群管加黑名单", { ...live, message_id: 2, message: [{ type: "at", qq: 43 }] })).toContain("加入");
  expect(await command("#群管删黑43", { ...live, message_id: 2 })).toEqual([]);
  expect(await command("#群管删黑43", { ...live, message_id: 3, isDelegated: true })).toContain("没有编辑");
  expect(await command("#群管删黑43", { ...live, message_id: 3, message_type: "private" })).toBeUndefined();
  expect(await active.blocked(43)).toBe(true);
  expect(await command("#群管删黑43", { ...live, message_id: 3 })).toContain("移除");
  expect(await active.blocked(43)).toBe(false);
  expect(groupModerationFeature({ normalizedMessage: "群管删黑43" })).toEqual(["[group] 群管黑名单"]);
});

test("只持久化确认踢黑的成员，已完成的协议动作与写入失败分别回执", async () => {
  const { active, command, primary } = await fixture();
  const scope = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 77, message_id: 1,
    isBotMaster: () => false, async groupKick(id: number, block: boolean, onConfirmedName?: (name: string) => void) {
      expect(block).toBe(true);
      if (id === 44) return "unknown" as const;
      onConfirmedName?.("仅回执展示");
      return "confirmed" as const;
    } };
  const reply = await command("#踢黑", { ...scope, message: [{ type: "at", qq: 43 }, { type: "at", qq: 44 }] });
  expect(reply).toContain("已将 仅回执展示（43） 踢出群聊");
  expect(reply).toContain("43 已列入跨群群管黑名单");
  expect(reply).toContain("44 的操作结果未确认");
  expect(await active.blocked(43)).toBe(true);
  expect(await active.blocked(44)).toBe(false);
  const bad = "blackQQ: broken\n";
  await writeFile(primary, bad);
  await expect(active.blocked(43)).rejects.toThrow();
  expect(await command("#踢黑45", { ...scope, message_id: 2 })).toContain("协议已确认踢黑，未能将 45 保存");
  expect(await readFile(primary, "utf8")).toBe(bad);
});

test("白名单和自动解禁分别沿用旧键，规范路径显式覆盖且默认停止", async () => {
  const { active, primary, legacy } = await fixture();
  expect(await active.shouldAutoUnmute(43)).toBe(false);
  await writeFile(legacy, 'whiteQQ: ["43"]\nnoBan: true # 旧设置\nblackQQ: [44]\n');
  await writeFile(primary, "blackQQ: [45]\n");
  expect(await active.shouldAutoUnmute(43)).toBe(true);
  expect(await active.shouldAutoUnmute(44)).toBe(false);
  expect(await active.blocked(45)).toBe(true);
  expect(await active.updateWhitelist([46], true)).toBe(true);
  expect(await active.shouldAutoUnmute(46)).toBe(true);
  expect(await active.setAutoUnmute(false)).toBe(true);
  expect(await active.shouldAutoUnmute(43)).toBe(false);
  expect(await readFile(legacy, "utf8")).toContain("noBan: false # 旧设置");
  expect(await readFile(primary, "utf8")).toBe("blackQQ: [45]\n");
  await writeFile(primary, "whiteQQ: [47]\nnoBan: true\n");
  expect(await active.shouldAutoUnmute(43)).toBe(false);
  expect(await active.shouldAutoUnmute(47)).toBe(true);
  await writeFile(primary, "whiteQQ: [47]\nnoBan: 'true'\n");
  expect(await active.shouldAutoUnmute(47)).toBe(false);
});

test("旧群管加删白名单作用于手动禁言保护，自动解禁开关单独核验主人", async () => {
  const { active, command } = await fixture();
  const muted: number[] = [];
  const scope = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 77,
    isBotMaster: () => false, async groupManageBlacklist() { return true; },
    async groupMute(id: number) { muted.push(id); return "confirmed" as const; } };
  expect(await command("群管加白名单", { ...scope, message_id: 1, message: [{ type: "at", qq: 43 }] })).toContain("加入群管白名单");
  expect(await command("#禁言43", { ...scope, message_id: 2 })).toContain("无法操作 43");
  expect(muted).toEqual([]);
  expect(await command("#开启白名单自动解禁", { ...scope, message_id: 3 })).toContain("没有设置");
  expect(await active.shouldAutoUnmute(43)).toBe(false);
  let checks = 0;
  const owner = { ...scope, async groupManageWhitelistAutoUnmute() { checks++; return true; } };
  expect(await command("#开启白名单自动解禁", { ...owner, message_id: 4 })).toBe("已开启白名单自动解禁。");
  expect(checks).toBe(2);
  expect(await active.shouldAutoUnmute(43)).toBe(true);
  expect(await command("开启白名单解禁", { ...owner, message_id: 5 })).toContain("已处于开启状态");
  expect(await command("关闭白名单解禁", { ...owner, message_id: 6, isDelegated: true })).toContain("没有设置");
  expect(await command("关闭白名单解禁", { ...owner, message_id: 6, message_type: "private" })).toBeUndefined();
  expect(await command("关闭白名单解禁", { ...owner, message_id: 6 })).toBe("已关闭白名单自动解禁。");
  expect(await command("#群管删白43", { ...scope, message_id: 7 })).toContain("群管白名单移除");
  expect(await command("#禁言43", { ...scope, message_id: 8 })).toContain("已将 43");
  expect(muted).toEqual([43]);
  expect(groupModerationFeature({ normalizedMessage: "关闭白名单解禁" })).toEqual(["[group] 群管白名单"]);
});

test("黑白名单和开关共用锁，保护引用和最新权限", async () => {
  const { active, store, primary, command } = await fixture();
  expect(await Promise.all([active.update([43], true), store().updateWhitelist([45], true), active.setAutoUnmute(true)])).toEqual([true, true, true]);
  expect(await active.blocked(43)).toBe(true);
  expect(await active.shouldAutoUnmute(45)).toBe(true);
  let checks = 0;
  const scope = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 77, message_id: 8,
    isBotMaster: () => true, async groupManageWhitelistAutoUnmute() { return ++checks === 1; } };
  expect(await command("#关闭白名单自动解禁", scope)).toContain("没有设置");
  expect(await active.shouldAutoUnmute(45)).toBe(true);
  const linked = "whiteQQ: &white [43]\nnoBan: &on true\nother: {skip: *white, state: *on}\n";
  await writeFile(primary, linked);
  await expect(active.updateWhitelist([45], true)).rejects.toThrow();
  await expect(active.setAutoUnmute(false)).rejects.toThrow();
  expect(await readFile(primary, "utf8")).toBe(linked);
});
