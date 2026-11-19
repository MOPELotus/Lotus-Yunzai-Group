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
  expect(output).toContain("whiteQQ: [ 44 ] # 白名单\r\n");
  expect(output).toContain("feature: true # 其他\r\n");
  expect(await active.blocked(45)).toBe(true);
  expect(await active.blocked(46)).toBe(true);
  expect(await active.update([43, 70], false)).toBe(true);
  expect(await active.blocked(43)).toBe(false);
  expect(await readFile(legacy, "utf8")).toBe(await readFile(actual, "utf8"));
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
    isBotMaster: () => false, async groupKick(id: number, block: boolean) {
      expect(block).toBe(true);
      return id === 44 ? "unknown" as const : "confirmed" as const;
    } };
  const reply = await command("#踢黑", { ...scope, message: [{ type: "at", qq: 43 }, { type: "at", qq: 44 }] });
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
