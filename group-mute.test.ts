import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupMute, maxGroupMuteSeconds, type GroupMuteResult } from "./group-mute.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(result?: (userId: number, seconds: number) => Promise<GroupMuteResult>) {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-mute-"));
  temporary.push(path);
  const directory = join(path, "plugins/yenai-plugin/config/config");
  await mkdir(directory, { recursive: true });
  const whitelist = join(directory, "groupAdmin.yaml");
  const calls: [number, number][] = [];
  const context = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 77,
    isBotMaster: (userId: number) => userId === 99,
    groupMute: async (userId: number, seconds: number) => {
      calls.push([userId, seconds]);
      return result ? result(userId, seconds) : "confirmed" as const;
    },
  };
  return { command: createGroupMute(pathToFileURL(path + "/")), whitelist, calls, context };
}

const at = (qq: number | string) => ({ type: "at", qq });

test("禁言和解禁识别真实 @、粘连 QQ 和旧时间单位，群内默认 300 秒", async () => {
  const { command, calls, context } = await fixture();
  expect(await command("#禁言", { ...context, message: [at(99), at("43"), at(43), at(44)] })).toContain("43、44 禁言 300 秒");
  await command("#禁言43 三分钟", context);
  await command("#禁言 一百零二秒", { ...context, message: [at(43)] });
  await command("#禁言四十六MINUTE", { ...context, message: [at(43)] });
  await command("#禁言壹年", { ...context, message: [at(43)] });
  await command("#禁言1000毫秒", { ...context, message: [at(43)] });
  await command("#禁言分钟", { ...context, message: [at(43)] });
  await command(`#禁言43 ${maxGroupMuteSeconds}`, context);
  await command("#解禁43", context);
  await command("#解禁", { ...context, message: [at(44)] });
  expect(calls).toEqual([
    [43, 300], [44, 300], [43, 180], [43, 102], [43, 2760], [43, 31536000], [43, 1], [43, 18000],
    [43, maxGroupMuteSeconds], [43, 0], [44, 0],
  ]);
});

test("拒绝无效目标、@ 全体、文本伪造、委托、跨会话及无效时长", async () => {
  const { command, calls, context } = await fixture();
  for (const message of [[at("all"), at(43)], [at(99)], [at("bad")], [{ type: "mention_all" }, at(43)],
    "[CQ:at,qq=43]", [{ type: "text", text: "@43" }]]) {
    expect(await command("#禁言", { ...context, message })).toContain("请 @ 群成员或输入 QQ 号");
  }
  for (const input of ["#禁言43 1001毫秒", "#禁言43 2147483648秒", "#禁言43 1.5秒", "#禁言43 -1秒", "#禁言43 7火星日", "#解禁43 1"]) {
    expect(await command(input, context)).toContain("填写有效");
  }
  expect(await command("#禁言99", context)).toContain("填写有效");
  expect(await command("#禁言43", { ...context, message_type: "private" })).toBeUndefined();
  expect(await command("#禁言43", { ...context, isDelegated: true })).toContain("没有群禁言权限");
  expect(await command("#禁言43", { ...context, groupMute: undefined })).toContain("没有群禁言权限");
  expect(await command("#禁言列表", context)).toBeUndefined();
  expect(calls).toEqual([]);
});

test("旧白名单仅保护普通群管理禁言，主人和解禁按宿主复核，坏配置不写协议", async () => {
  const { command, calls, context, whitelist } = await fixture();
  const original = 'whiteQQ: ["43", 44]\nother: retained\n';
  await writeFile(whitelist, original);
  expect(await command("#禁言", { ...context, message: [at(43), at(45)] })).toContain("无法操作 43");
  expect(await command("#解禁43", context)).toContain("解除禁言");
  expect(await command("#禁言44", { ...context, isBotMaster: () => true })).toContain("已将 44");
  expect(calls).toEqual([[45, 300], [43, 0], [44, 300]]);
  expect(await readFile(whitelist, "utf8")).toBe(original);
  await writeFile(whitelist, "whiteQQ: 43\n");
  expect(await command("#禁言43", context)).toContain("保护配置暂不可用");
  expect(calls).toHaveLength(3);
});

test("每个成员只提交一次，准确列出混合结果并拒绝消息重放", async () => {
  const { command, calls, context } = await fixture(async (id) => {
    switch (id) {
      case 43: return "confirmed";
      case 44: throw new Error("timeout");
      case 45: return "rejected";
      case 46: return "protected";
      default: return "unavailable";
    }
  });
  const scope = { ...context, message_id: 10, message: [at(43), at(44), at(44), at(45), at(46), at(47)] };
  const reply = await command("#禁言 1小时", scope);
  expect(reply).toContain("已将 43 禁言 3600 秒");
  expect(reply).toContain("44 的操作结果未确认");
  expect(reply).toContain("协议端拒绝操作 45");
  expect(reply).toContain("无法操作 46、47");
  expect(await command("#禁言 1小时", scope)).toEqual([]);
  expect(calls).toEqual([43, 44, 45, 46, 47].map((id) => [id, 3600]));
  expect(await command("#禁言 1小时", { ...scope, adapter: "milky" })).toEqual(reply);
});

test("旧全体和全员禁言、解禁使用独立群能力，个人白名单不参与", async () => {
  const { command, calls, context, whitelist } = await fixture();
  await writeFile(whitelist, "whiteQQ: malformed\n");
  const variants: boolean[] = [];
  const scope = { ...context, groupMute: undefined, async groupWholeMute(enabled: boolean) {
    variants.push(enabled);
    return "confirmed" as const;
  } };
  expect(await command("#全体禁言", scope)).toBe("已开启全体禁言。");
  expect(await command("#全员禁言", scope)).toBe("已开启全体禁言。");
  expect(await command("#全体解禁", scope)).toBe("已关闭全体禁言。");
  expect(await command("#全员解禁", scope)).toBe("已关闭全体禁言。");
  expect(await command("#解除全部禁言", scope)).toBeUndefined();
  expect(await command("#全体禁言 30秒", scope)).toBeUndefined();
  expect(await command("全员禁言", scope)).toBeUndefined();
  expect(variants).toEqual([true, true, false, false]);
  expect(calls).toEqual([]);
});

test("全体禁言仅本群且非委托，原消息在结果未确认时也不重发", async () => {
  const { command, context } = await fixture();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const calls: boolean[] = [];
  const scope = { ...context, message_id: 9, async groupWholeMute(enabled: boolean) {
    calls.push(enabled);
    started.resolve();
    await finish.promise;
    throw new Error("timeout");
  } };
  expect(await command("#全体禁言", { ...scope, message_type: "private" })).toBeUndefined();
  expect(await command("#全体禁言", { ...scope, message_type: "terminal" })).toBeUndefined();
  expect(await command("#全体禁言", { ...scope, isDelegated: true })).toContain("没有群禁言权限");
  expect(await command("#全体禁言", { ...scope, group_id: undefined })).toContain("没有群禁言权限");
  expect(await command("#全体禁言", context)).toContain("没有群禁言权限");
  expect(calls).toEqual([]);
  const first = command("#全体禁言", scope);
  await started.promise;
  expect(await command("#全员禁言", scope)).toEqual([]);
  finish.resolve();
  expect(await first).toContain("未确认");
  expect(await command("#全体禁言", scope)).toEqual([]);
  expect(calls).toEqual([true]);
  expect(await command("#全员解禁", { ...scope, adapter: "milky", async groupWholeMute() { return "rejected"; } })).toContain("协议端拒绝");
  expect(await command("#全员解禁", { ...scope, group_id: 78, async groupWholeMute() { return "unavailable"; } })).toContain("请核对群管理权限");
});
