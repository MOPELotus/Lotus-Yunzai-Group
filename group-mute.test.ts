import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupMute, groupModerationFeature, maxGroupMuteSeconds, type GroupMuteResult } from "./group-mute.ts";

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
  expect(await command("#禁言列表", context)).toContain("无法提供可靠");
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
  expect(await command("#解除全部禁言", scope)).toContain("没有解除群禁言的权限");
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

test("旧踢人与踢黑入口只操作明确本群成员，精确命令控制协议 block", async () => {
  const { command, calls, context } = await fixture();
  const kicks: [number, boolean][] = [];
  const scope = { ...context, async groupKick(id: number, block: boolean) {
    kicks.push([id, block]);
    return "confirmed" as const;
  } };
  expect(await command("#踢43", { ...scope, message_id: 10, message: [at(99)] })).toBe("已将 43 踢出群聊。");
  expect(await command("#踢黑", { ...scope, message_id: 11, message: [at(43), at("44"), at(43)] }))
    .toBe("已将 43、44 踢出群聊，协议端已确认踢黑请求。");
  expect(await command("#踢黑", { ...scope, message_id: 12, normalizedMessage: "#踢黑45" })).toContain("踢黑请求");
  expect(await command("#踢黑 45", { ...scope, message_id: 13 })).toBeUndefined();
  expect(await command("#踢黑45", { ...scope, message_id: 14, message: [at(46)] })).toContain("请 @ 要移出的群成员");
  expect(await command("#踢", { ...scope, message_id: 15, message: [at("all"), at(43)] })).toContain("请 @ 要移出的群成员");
  expect(await command("#踢99", { ...scope, message_id: 16 })).toContain("请 @ 要移出的群成员");
  expect(groupModerationFeature({ normalizedMessage: "#踢黑45" })).toEqual(["[group] 群成员移出"]);
  expect(groupModerationFeature({ normalizedMessage: "#禁言45" })).toEqual(["[group] 群禁言"]);
  expect(kicks).toEqual([[43, false], [43, true], [44, true], [45, true]]);
  expect(calls).toEqual([]);
});

test("踢人尊重旧白名单和宿主回执，无原始消息 ID、重放、委托及跨会话均不写", async () => {
  const { command, context, whitelist } = await fixture();
  await writeFile(whitelist, 'whiteQQ: ["43"]\n');
  const kicks: [number, boolean][] = [];
  const scope = { ...context, async groupKick(id: number, block: boolean): Promise<GroupMuteResult> {
    kicks.push([id, block]);
    if (id === 44) throw new Error("timeout");
    if (id === 45) return "rejected";
    return "confirmed";
  } };
  expect(await command("#踢黑44", scope)).toEqual([]);
  expect(await command("#踢黑44", { ...scope, message_id: 20, isDelegated: true })).toContain("没有移出群成员的权限");
  expect(await command("#踢黑44", { ...scope, message_id: 20, group_id: undefined })).toContain("没有移出群成员的权限");
  expect(await command("#踢黑44", { ...scope, message_id: 20, message_type: "private" })).toBeUndefined();
  const targeted = { ...scope, message_id: 20, message: [at(43), at(44), at(44), at(45)] };
  const reply = await command("#踢黑", targeted);
  expect(reply).toContain("无法操作 43");
  expect(reply).toContain("44 的操作结果未确认");
  expect(reply).toContain("协议端拒绝操作 45");
  expect(await command("#踢黑", targeted)).toEqual([]);
  expect(await command("#踢43", { ...scope, message_id: 21, isBotMaster: () => true })).toBe("已将 43 踢出群聊。");
  expect(kicks).toEqual([[44, true], [45, true], [43, false]]);
});

test("旧设置及取消群管理员只由当前主人发起，支持实际多个提及和裸 QQ", async () => {
  const { command, calls, context, whitelist } = await fixture();
  await writeFile(whitelist, "whiteQQ: unrelated\n");
  const actions: [number, boolean][] = [];
  const scope = { ...context, isBotMaster: (id: number) => id === 42, async groupSetAdmin(id: number, enabled: boolean) {
    actions.push([id, enabled]);
    return "confirmed" as const;
  } };
  expect(await command("#设置管理", { ...scope, message_id: 12, message: [at(99), at(43), at("44"), at(43)] }))
    .toBe("已将 43、44 设置为群管理员。");
  expect(await command("#取消管理12345", { ...scope, message_id: 13 })).toBe("已取消 12345 的群管理员权限。");
  expect(await command("#取消管理 23456", { ...scope, message_id: 14 })).toBe("已取消 23456 的群管理员权限。");
  expect(await command("#设置管理1234", { ...scope, message_id: 15 })).toContain("有效 QQ");
  expect(await command("#设置管理12345", { ...scope, message_id: 16, message: [at(43)] })).toContain("有效 QQ");
  expect(await command("#设置管理", { ...scope, message_id: 17, message: [at("all"), at(43)] })).toContain("有效 QQ");
  expect(await command("#设置管理12345", { ...scope, message_id: 18, isDelegated: true })).toContain("没有设置");
  expect(await command("#设置管理12345", { ...scope, message_id: 19, isBotMaster: () => false })).toContain("没有设置");
  expect(await command("#设置管理12345", { ...scope, message_id: 20, message_type: "private" })).toBeUndefined();
  expect(await command("#设置管理12345", { ...scope, message_id: 21, group_id: undefined })).toContain("没有设置");
  expect(await command("#设置管理12345", { ...scope, message_id: 22, groupSetAdmin: undefined })).toContain("没有设置");
  expect(await command("#设置管理12345", scope)).toEqual([]);
  expect(groupModerationFeature({ normalizedMessage: "#取消管理12345" })).toEqual(["[group] 群管理员"]);
  expect(actions).toEqual([[43, true], [44, true], [12345, false], [23456, false]]);
  expect(calls).toEqual([]);
});

test("群管理员批量每目标只收一次回执，未知不会重试", async () => {
  const { command, context } = await fixture();
  const actions: number[] = [];
  const scope = { ...context, adapter: "milky" as const, message_id: 12, isBotMaster: () => true,
    message: [at(43), at(44), at(45), at(46), at(47), at(44)], async groupSetAdmin(id: number): Promise<GroupMuteResult> {
      actions.push(id);
      if (id === 44) throw new Error("超时");
      if (id === 45) return "rejected";
      if (id === 46) return "protected";
      if (id === 47) return "unavailable";
      return "confirmed";
    },
  };
  const reply = await command("#设置管理", scope);
  expect(reply).toContain("已将 43 设置为群管理员");
  expect(reply).toContain("44 的操作结果未确认");
  expect(reply).toContain("协议端拒绝操作 45");
  expect(reply).toContain("46 受群管保护");
  expect(reply).toContain("无法操作 47");
  expect(await command("#设置管理", scope)).toEqual([]);
  expect(actions).toEqual([43, 44, 45, 46, 47]);
});

test("三条旧禁言列表指令公开展示真实快照中的头像、群身份和剩余时间", async () => {
  const { command, context, calls } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const scope = { ...context, user_id: 50, groupMute: undefined, async groupMuteRoster() {
    return [{ userId: 43001, name: "群名片", role: "admin" as const, until: now + 7200 },
      { userId: 43002, until: now + 300 }, { userId: 43003, until: now - 1 }];
  } };
  for (const name of ["#禁言列表", "#获取禁言列表", "#查看禁言列表"]) {
    const result = await command(name, scope);
    if (typeof result !== "object" || !("nodes" in result)) throw new Error("禁言列表未返回合并转发。");
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.[0]).toEqual({ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=43001" });
    expect(result.nodes[1]?.[0]).toEqual({ type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=43002" });
    expect(result.nodes[0]?.[1]).toContain("群身份：群管理");
    expect(result.nodes[1]?.[1]).toContain("群身份：未确认");
    expect(JSON.stringify(result)).toContain("禁言到期时间：");
    expect(JSON.stringify(result)).toContain("禁言剩余时间：");
    expect(JSON.stringify(result)).toContain("群名片");
    expect(JSON.stringify(result)).not.toContain("43003");
  }
  expect(await command("#禁言列表", { ...scope, async groupMuteRoster() { return []; } })).toContain("没有被禁言");
  expect(await command("#禁言列表", { ...scope, async groupMuteRoster() {return undefined; } })).toContain("无法提供可靠");
  expect(await command("#禁言列表", { ...scope, message_type: "private" })).toBeUndefined();
  expect(calls).toEqual([]);
  expect(groupModerationFeature({ normalizedMessage: "#查看禁言列表" })).toEqual(["[group] 群禁言列表"]);
});

test("解除全部禁言仅向快照中未来成员分发单人解除，回执区分且无全员变更", async () => {
  const { command, context, calls } = await fixture(async (id) => {
    if (id === 44) throw new Error("timeout");
    if (id === 45) return "rejected";
    if (id === 46) return "protected";
    return "confirmed";
  });
  let rosters = 0, whole = 0;
  const now = Math.floor(Date.now() / 1000);
  const scope = { ...context, message_id: 59, async groupManageBlacklist() { return true; }, async groupMuteRoster() {
    rosters++;
    return [{ userId: 42, until: now }, ...[43, 44, 45, 46].map((userId) => ({ userId, until: now + 300 }))];
  }, async groupWholeMute() { whole++; return "confirmed" as const; } };
  const [first, duplicate] = await Promise.all([command("#解除全部禁言", scope), command("#解除全部禁言", scope)]);
  expect(first).toContain("已解除 1 人");
  expect(first).toContain("1 人的解禁被协议端拒绝");
  expect(first).toContain("1 人的解禁结果未确认");
  expect(first).toContain("1 人未能解禁");
  expect(duplicate).toEqual([]);
  expect(await command("#解除全部禁言", { ...scope, message_id: 60, isDelegated: true })).toContain("没有群禁言权限");
  expect(await command("#解除全部禁言", { ...scope, message_id: 61, groupMute: undefined })).toContain("没有解除群禁言的权限");
  expect(await command("#解除全部禁言", { ...scope, message_id: undefined })).toEqual([]);
  expect(await command("#解除全部禁言", { ...scope, message_id: 62, async groupMuteRoster() {
    return [{ userId: 43, until: now + 300 }, { userId: 43, until: now + 300 }];
  } })).toContain("无法提供可靠");
  expect(calls).toEqual([[43, 0], [44, 0], [45, 0], [46, 0]]);
  expect(rosters).toBe(1);
  expect(whole).toBe(0);
});

test("解除全部禁言在读取快照前先确认群管理身份", async () => {
  const { command, context, calls } = await fixture();
  let reads = 0, checks = 0;
  const scope = { ...context, message_id: 1, async groupMuteRoster() {
    reads++;
    return [{ userId: 43, until: Math.floor(Date.now() / 1000) + 300 }];
  }, async groupManageBlacklist() { checks++; return false; } };
  expect(await command("#解除全部禁言", scope)).toContain("没有解除群禁言的权限");
  expect(await command("#解除全部禁言", { ...scope, message_id: 2, async groupManageBlacklist() { throw new Error("未确认"); } }))
    .toContain("没有解除群禁言的权限");
  expect(await command("#解除全部禁言", { ...scope, message_id: 3, groupManageBlacklist: undefined })).toContain("没有解除群禁言的权限");
  expect(reads).toBe(0);
  expect(checks).toBe(1);
  expect(calls).toEqual([]);
  expect(await command("#查看禁言列表", scope)).toMatchObject({ type: "forward" });
  expect(reads).toBe(1);
  expect(checks).toBe(1);
});
