import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupScreenedWords, isGroupScreenedWordsCommand, type ScreenedWordsContext } from "./screened-words.ts";

test("旧开关、各月份词表、本群和全局的命令保持独立并沿用实际身份", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-screened-words-"));
  try {
    const root = pathToFileURL(`${directory}/`);
    const legacy = join(directory, "plugins/flower-plugin");
    const global = join(legacy, "resources/blackword/global");
    const local = join(legacy, "resources/blackword/77");
    await Promise.all([global, local, join(legacy, "defSet"), join(legacy, "config")].map(path => mkdir(path, { recursive: true })));
    const previous = "- 全局旧词\n- 100\n";
    await writeFile(join(global, "2024-01.yaml"), previous);
    await writeFile(join(global, "2024-02.yaml"), "- 全局新词\n- 全局旧词\n");
    await writeFile(join(local, "2024-01.yaml"), "- 本群旧词\n");
    await writeFile(join(legacy, "defSet/wordListener.yaml"), "enable: true\ntime: 72\nreplyText: 旧回复\n");
    await writeFile(join(legacy, "config/wordListener.yaml"), "enable: false\nreplyText: 自定义回复\n");
    const lifetime = new AbortController();
    const session = new AbortController();
    const words = createGroupScreenedWords(root, async () => ({ close() {} }), lifetime.signal);
    const context: Omit<ScreenedWordsContext, "normalizedMessage"> = { message_type: "group", self_id: 99, group_id: 77, user_id: 50,
      isBotMaster: user => user === 51, groupActivitySignal: session.signal, privateCredentialSignal: session.signal,
      async groupManageBlacklist() { return true; },
    };
    let message_id = 0;
    const command = (normalizedMessage: string, override: Partial<ScreenedWordsContext> = {}) =>
      words.command({ ...context, message_id: ++message_id, normalizedMessage, ...override });
    const matched = (text: string, group = 77) => words.match(group, text, session.signal);
    expect(await matched("带有全局旧词")).toBeUndefined();
    expect(await command("#屏蔽词列表")).toBe("屏蔽词监听当前关闭。");
    expect(await command("#抽卡设置 屏蔽词 开启")).toContain("主人");
    expect(await command("#抽卡设置屏蔽词开启", { user_id: 51, isDelegated: true })).toBeUndefined();
    expect(await command("#抽卡设置违禁词开启", { user_id: 51, message_type: "private" })).toBe("已开启屏蔽词监听。");
    expect(await matched("前全局旧词后")).toEqual({ action: "mute-recall", seconds: 72, preview: "全局**", screenedReply: "自定义回复" });
    expect(await matched("数字100也要加载")).toMatchObject({ preview: "10*" });
    expect(await matched("本群旧词", 78)).toBeUndefined();
    expect(await matched("##取消屏蔽全局 全局旧词")).toBeUndefined();
    const listing = await command("屏蔽词列表");
    expect(JSON.stringify(listing)).toContain("本群屏蔽词如下，共 1 个");
    expect(JSON.stringify(listing)).toContain("全局屏蔽词如下，共 3 个");
    const refused = await command("#屏蔽本群 日常词", { async groupManageBlacklist() { return false; } });
    expect(refused).toContain("没有编辑本群屏蔽词的权限");
    let checks = 0;
    expect(await command("#屏蔽本群 失去权限", { async groupManageBlacklist() { return ++checks === 1; } })).toContain("没有编辑本群屏蔽词的权限");
    expect(await matched("失去权限")).toBeUndefined();
    expect(await command("#屏蔽全局 新本群词，另一个")).toContain("新增本群屏蔽词");
    expect(await matched("新本群词")).toBeDefined();
    expect(await matched("新本群词", 78)).toBeUndefined();
    expect(await command("#屏蔽本群", { user_id: 51 })).toContain("请填写有效屏蔽词");
    expect(await command("#删除屏蔽全局", { user_id: 51 })).toContain("请填写有效屏蔽词");
    expect(await matched("本群和全局仍可普通聊天")).toBeUndefined();
    expect(await command("#屏蔽 真全局词", { user_id: 51 })).toContain("新增全局屏蔽词");
    expect(await matched("真全局词", 78)).toBeDefined();
    expect(await command("#解除屏蔽全局 全局旧词", { user_id: 51 })).toContain("删除全局屏蔽词");
    expect(await matched("前全局旧词后")).toBeUndefined();
    expect(await readFile(join(global, "2024-01.yaml"), "utf8")).toBe(previous);
    expect(await readFile(join(legacy, "config/wordListener.yaml"), "utf8")).toBe("enable: false\nreplyText: 自定义回复\n");
    expect(await command("#抽卡设置屏蔽词关闭", { user_id: 51 })).toBe("已关闭屏蔽词监听。");
    expect(await matched("真全局词")).toBeUndefined();
    expect(isGroupScreenedWordsCommand("普通屏蔽词列表内容")).toBe(false);
    for (const action of ["解除", "删除", "取消", "不"]) expect(isGroupScreenedWordsCommand(`${action}屏蔽本群 任意词`)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
