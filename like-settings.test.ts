import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLikeSettings, saveLikeSettings } from "./like-settings.ts";
import plugin from "./likes.ts";

async function withDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lotus-group-settings-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("面板与指令共用配置，保留未知字段、注释、YAML 标签和文件权限", () => withDirectory(async (root) => {
  const file = join(root, "group.yaml");
  await writeFile(file, [
    "# 组配置", "enable: true", "count: null", 'successMsg: "false"',
    "unrelated: &example", "  flag: false", "  extra: !!binary aGVsbG8=", "unchanged: *example", "",
  ].join("\n"), { mode: 0o640 });
  const previous = Bun.env.LOTUS_GROUP_CONFIG;
  Bun.env.LOTUS_GROUP_CONFIG = file;
  try {
    const before = await readLikeSettings();
    expect(before.settings.count).toBe(10);
    expect(before.settings.successMsg).toBe(false);
    const saved = await saveLikeSettings({ count: 5, successMsg: "点了 {{thumbUpNum}} 次。" }, {
      file: pathToFileURL(file), revision: before.revision,
    });
    expect(saved.revision).not.toBe(before.revision);
    expect((await readLikeSettings()).settings.count).toBe(5);
    expect(await plugin.commands["#赞我"]!("", {
      message_type: "private", user_id: 42,
      likeSelf: async (count) => { expect(count).toBe(5); return 2; },
    })).toBe("点了 2 次。");
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain("# 组配置");
    expect(yaml).toContain("unrelated: &example");
    expect(yaml).toContain("!!binary aGVsbG8=");
    expect(yaml).toContain("unchanged: *example");
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_GROUP_CONFIG;
    else Bun.env.LOTUS_GROUP_CONFIG = previous;
  }
}));

test("新配置按需创建，同一版本的并发请求只保存一次", () => withDirectory(async (root) => {
  const file = join(root, "config", "group.yaml");
  const initial = await readLikeSettings({ file });
  expect(initial.revision).toBe("missing");
  expect(initial.settings.enable).toBe(true);

  const outcomes = await Promise.allSettled([
    saveLikeSettings({ count: 2 }, { file, revision: initial.revision }),
    saveLikeSettings({ count: 3 }, { file, revision: initial.revision }),
  ]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(outcomes).toContainEqual(expect.objectContaining({
    status: "rejected", reason: expect.objectContaining({ code: "conflict" }),
  }));
  const current = await readLikeSettings({ file });
  expect([2, 3]).toContain(current.settings.count);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(root, "config"))).toEqual(["group.yaml"]);
}));

test("拒绝无效补丁、坏文件和会改变其他字段的共享锚点", () => withDirectory(async (root) => {
  const file = join(root, "group.yaml");
  const original = "enable: &status true\nunrelated: *status\n";
  await writeFile(file, original);
  const { revision } = await readLikeSettings({ file });
  for (const patch of [{ count: 11 }, { count: null }, { enable: "true" }, { unrelated: false }, { successMsg: 2 },
    { enable: false }, JSON.parse('{"__proto__":123}')]) {
    await expect(saveLikeSettings(patch, { file, revision })).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(file, "utf8")).toBe(original);
  }
  await writeFile(file, "enable: false\nenable: true\n");
  await expect(readLikeSettings({ file })).rejects.toMatchObject({ code: "invalid" });
  const yaml = await readFile(file, "utf8");
  expect(yaml).toBe("enable: false\nenable: true\n");
}));

test("保留符号链接，拒绝覆盖外部编辑及读写失败后留下的部分内容", () => withDirectory(async (root) => {
  const file = join(root, "group.yaml");
  const linked = join(root, "linked.yaml");
  await writeFile(file, "count: 2\n");
  await symlink(file, linked);

  let { revision } = await readLikeSettings({ file: linked });
  await saveLikeSettings({ count: 4 }, { file: linked, revision });
  expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  const original = "count: 7\n";
  await writeFile(file, original);
  await expect(saveLikeSettings({ count: 3 }, { file: linked, revision })).rejects.toMatchObject({ code: "conflict" });
  expect(await readFile(file, "utf8")).toBe(original);

  if (process.getuid?.() !== 0) {
    ({ revision } = await readLikeSettings({ file }));
    await chmod(root, 0o500);
    try {
      await expect(saveLikeSettings({ count: 5 }, { file, revision })).rejects.toMatchObject({ code: "EACCES" });
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      await chmod(root, 0o700);
    }
    expect((await readdir(root)).sort()).toEqual(["group.yaml", "linked.yaml"]);
  }
}));
