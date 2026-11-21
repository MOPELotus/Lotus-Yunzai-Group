import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    })).toEqual({ type: "quoted", message: "点了 2 次。" });
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

test("提交聊天点赞设置前再次核对授权", () => withDirectory(async (root) => {
  const file = join(root, "group.yaml");
  const original = "# 留下旧配置\nstrangeThumbUp: true\n";
  await writeFile(file, original);
  const { revision } = await readLikeSettings({ file });
  let checks = 0;
  await expect(saveLikeSettings({ strangeThumbUp: false }, {
    file, revision, canWrite: () => ++checks === 1,
  })).rejects.toMatchObject({ code: "conflict" });
  expect(checks).toBe(2);
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await readdir(root)).toEqual(["group.yaml"]);
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


test("旧 thumbUp.yaml 缺少撤回字段时沿用 20 秒，新配置默认关闭", () => withDirectory(async (root) => {
  const legacy = join(root, "thumbUp.yaml");
  const modern = join(root, "group.yaml");
  await writeFile(legacy, "# 旧格式\nunrelated: 保留\n");
  expect((await readLikeSettings({ file: modern })).settings.recall).toBe(0);
  const before = await readLikeSettings({ file: legacy });
  expect(before.settings.recall).toBe(20);
  const after = await saveLikeSettings({ recall: 0 }, { file: legacy, revision: before.revision });
  expect(after.settings.recall).toBe(0);
  expect(await readFile(legacy, "utf8")).toContain("recall: 0");
  expect(await readFile(legacy, "utf8")).toContain("unrelated: 保留");
  for (const recall of [-1, 121, Infinity, "20", null]) {
    await expect(saveLikeSettings({ recall }, { file: legacy, revision: after.revision })).rejects.toMatchObject({ code: "invalid" });
  }
  await writeFile(modern, "recall: 600\ncount: 5\n");
  const invalid = await readLikeSettings({ file: modern });
  expect(invalid.settings).toMatchObject({ recall: 0, count: 5 });
  await saveLikeSettings({ count: 6 }, { file: modern, revision: invalid.revision });
  expect(await readFile(modern, "utf8")).toContain("recall: 600");
  await writeFile(legacy, "recall: 0.5\n");
  expect((await readLikeSettings({ file: legacy })).settings.recall).toBe(0.5);
}));

test("公共群路由保留旧点赞字段，只有主文件同名点赞字段覆盖；面板在主文件保存", () => withDirectory(async (directory) => {
  const root = pathToFileURL(directory + "/");
  const legacy = join(directory, "plugins/yenai-plugin/config/config/thumbUp.yaml");
  const primary = join(directory, "config/group.yaml");
  await mkdir(dirname(legacy), { recursive: true });
  await mkdir(dirname(primary), { recursive: true });
  const original = "enable: false\nstrangeThumbUp: false\ncloseTips: 原关闭提示\nsuccessMsg: 原回执\n";
  const routing = "# 群路由\ndefault:\n  enable: []\n  disable: [ 帮助 ]\n77:\n  onlyReplyAt: 1\n";
  await writeFile(legacy, original);
  await writeFile(primary, routing);
  const before = await readLikeSettings({ root });
  expect(before.settings).toMatchObject({
    enable: false, strangeThumbUp: false, closeTips: "原关闭提示", successMsg: "原回执", recall: 20,
  });
  const saved = await saveLikeSettings({ enable: true, count: 3 }, { root, revision: before.revision });
  expect(saved.settings).toMatchObject({ enable: true, count: 3, strangeThumbUp: false, recall: 20, successMsg: "原回执" });
  expect(await readLikeSettings({ root })).toEqual(saved);
  expect(await readFile(primary, "utf8")).toStartWith(routing);
  expect(await readFile(legacy, "utf8")).toBe(original);
  expect((await readLikeSettings({ file: primary })).settings.strangeThumbUp).toBe(true);

  const previous = Bun.env.LOTUS_GROUP_CONFIG;
  Bun.env.LOTUS_GROUP_CONFIG = legacy;
  try {
    const explicit = await readLikeSettings({ root });
    expect(explicit.settings).toMatchObject({ enable: false, count: 10, strangeThumbUp: false });
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_GROUP_CONFIG;
    else Bun.env.LOTUS_GROUP_CONFIG = previous;
  }
}));

test("仅旧文件时可保存部分覆盖，旧文件变动令已读面板版本失效", () => withDirectory(async (directory) => {
  const root = pathToFileURL(directory + "/");
  const legacy = join(directory, "plugins/yenai-plugin/config/config/thumbUp.yaml");
  const primary = join(directory, "config/group.yaml");
  await mkdir(dirname(legacy), { recursive: true });
  const original = "enable: false\nrecall: 15\n";
  await writeFile(legacy, original);
  const initial = await readLikeSettings({ root });
  expect(initial.settings).toMatchObject({ enable: false, recall: 15 });
  await writeFile(legacy, "enable: false\nrecall: 17\n");
  await expect(saveLikeSettings({ count: 2 }, { root, revision: initial.revision })).rejects.toMatchObject({ code: "conflict" });
  await expect(lstat(primary)).rejects.toMatchObject({ code: "ENOENT" });

  const fresh = await readLikeSettings({ root });
  const saved = await saveLikeSettings({ count: 2 }, { root, revision: fresh.revision });
  expect(await readFile(primary, "utf8")).toBe("count: 2\n");
  expect(await readFile(legacy, "utf8")).toBe("enable: false\nrecall: 17\n");
  expect(await readLikeSettings({ root })).toEqual(saved);
  expect(saved.settings).toMatchObject({ enable: false, count: 2, recall: 17 });
}));

test("主配置链接与旧文件是同一文件时保留链接，读取和保存的版本一致", () => withDirectory(async (directory) => {
  const root = pathToFileURL(directory + "/");
  const legacy = join(directory, "plugins/yenai-plugin/config/config/thumbUp.yaml");
  const primary = join(directory, "config/group.yaml");
  await mkdir(dirname(legacy), { recursive: true });
  await mkdir(dirname(primary), { recursive: true });
  await writeFile(legacy, "enable: false\n");
  await symlink(legacy, primary);
  const initial = await readLikeSettings({ root });
  const saved = await saveLikeSettings({ count: 2 }, { root, revision: initial.revision });
  expect((await lstat(primary)).isSymbolicLink()).toBe(true);
  expect(saved.settings).toMatchObject({ enable: false, count: 2, recall: 20 });
  expect(await readLikeSettings({ root })).toEqual(saved);
}));
