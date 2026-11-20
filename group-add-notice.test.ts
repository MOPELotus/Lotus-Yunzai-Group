import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGroupAddNotice, type GroupAddNoticeEvent, type GroupAddNoticePart } from "./group-add-notice.ts";
import { createManagedBlacklist } from "./managed-blacklist.ts";

async function useFixture(run: (testFixture: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-group-add-notice-"));
  try { await run(await fixture(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function fixture(directory: string) {
  const primary = join(directory, "config/groupAdmin.yaml");
  const legacy = join(directory, "plugins/yenai-plugin/config/config/groupAdmin.yaml");
  await mkdir(join(directory, "plugins/yenai-plugin/config/config"), { recursive: true });
  await mkdir(join(directory, "config"));
  const lock = async () => ({ close() {} });
  const store = createManagedBlacklist(pathToFileURL(directory + "/"), lock);
  const instance = new AbortController();
  const session = new AbortController();
  const notice = createGroupAddNotice(store, instance.signal);
  const delivered: (readonly GroupAddNoticePart[])[] = [];
  const request: GroupAddNoticeEvent = { sub_type: "add", self_id: 99, group_id: 77, user_id: 42, flag: "opaque",
    signal: session.signal, async notifyGroup(parts) { delivered.push(parts); return true; } };
  const context = { message_type: "group" as const, group_id: 77, isBotMaster: () => false, groupManageBlacklist: async () => true };
  return { primary, legacy, store, instance, session, notice, request, delivered, context };
}

test("从旧嵌套 YAML 来回编辑当前群，其他字段、注释、CRLF 和紧凑列表仍逐字一致", () => useFixture(async (f) => {
  const original = '\uFEFF# 旧群管\r\n' +
    'groupAddNotice: # 申请通知\r\n  openGroup: # 群号\r\n    - "88" # 本来已有\r\n  # 自定义文本\r\n  msg: |+ # 保持样式\r\n    请处理入群申请。\r\n    我是第二行。\r\n  other: [a,b,c]\r\n' +
    'whiteQQ: [1,2] # 不碰这些\r\n';
  const primary = "blackQQ: [10,20] # 规范路径但未指定通知\n";
  await writeFile(f.legacy, original);
  await writeFile(f.primary, primary);
  expect(await f.store.readGroupAddNotice(77)).toBeUndefined();
  expect(await f.notice.command("#开启加群通知", f.context)).toBe("✅ 已开启「77」的加群申请通知");
  expect(await f.notice.command("开启加群通知", f.context)).toBe("❎ 本群加群申请通知已处于开启状态");
  expect(await readFile(f.legacy)).toEqual(Buffer.from(original.replace("  # 自定义文本", "    - 77\r\n  # 自定义文本")));
  expect(await readFile(f.primary, "utf8")).toBe(primary);
  expect(await f.store.readGroupAddNotice(77)).toBe("请处理入群申请。\n我是第二行。\n");
  expect(await f.notice.command("关闭加群通知", f.context)).toBe("✅ 已关闭「77」的加群申请通知");
  expect(await f.notice.command("#关闭加群通知", f.context)).toBe("❎ 本群暂未开启加群申请通知");
  expect(await readFile(f.legacy)).toEqual(Buffer.from(original));
  await writeFile(f.legacy, original.replace('- "88" # 本来已有', '- "77" # 本来已有'));
  expect(await f.notice.command("#关闭加群通知", f.context)).toContain("已关闭");
  expect(await readFile(f.legacy)).toEqual(Buffer.from(original.replace('- "88" # 本来已有', '[]\r\n    # 本来已有')));
}));

test("规范字段精确优先并继承旧标题；新安装无文件时仅显式命令创建", () => useFixture(async (f) => {
  expect(await f.store.readGroupAddNotice(77)).toBeUndefined();
  expect(await f.notice.command("#关闭加群通知", f.context)).toContain("暂未开启");
  await expect(readFile(f.primary)).rejects.toThrow();
  await writeFile(f.legacy, 'groupAddNotice: {openGroup: [77], msg: "旧标题"}\n');
  const primary = 'groupAddNotice: {extra: [ok,yes], openGroup: []} # 留存\n';
  await writeFile(f.primary, primary);
  expect(await f.store.readGroupAddNotice(77)).toBeUndefined();
  expect(await f.notice.command("#开启加群通知", f.context)).toContain("已开启");
  expect(await readFile(f.primary, "utf8")).toBe(primary.replace("openGroup: []", "openGroup: [77]"));
  expect(await f.store.readGroupAddNotice(77)).toBe("旧标题");
  const freshConfig = "blackQQ: []\n# 需保留的其他项\n";
  await writeFile(f.legacy, "# 这是旧配置，但没有相关字段\n");
  await writeFile(f.primary, freshConfig);
  expect(await f.notice.command("#开启加群通知", f.context)).toContain("已开启");
  expect(await readFile(f.primary, "utf8")).toBe("blackQQ: []\ngroupAddNotice: {openGroup: [77]}\n# 需保留的其他项\n");
  expect(await f.store.readGroupAddNotice(77)).toBe("有一个加群通知，管理员快去看看吧~");
}));

test("写前复核真实权限，拒绝影响其他 YAML 引用，且无委托或私聊写入", () => useFixture(async (f) => {
  let checks = 0;
  const initial = "groupAddNotice: &settings\n  openGroup: [88]\n  msg: 原样\nbackup: *settings\n";
  await writeFile(f.primary, initial);
  expect(await f.notice.command("#开启加群通知", f.context)).toContain("无法保存");
  expect(await readFile(f.primary, "utf8")).toBe(initial);
  await writeFile(f.primary, "groupAddNotice:\n  msg: 原样 # 配置\n");
  expect(await f.notice.command("#开启加群通知", { ...f.context, groupManageBlacklist: async () => ++checks === 1 })).toContain("没有设置");
  expect(checks).toBe(2);
  expect(await f.notice.command("#开启加群通知", { ...f.context, isDelegated: true })).toContain("没有设置");
  expect(await f.notice.command("#开启加群通知", { ...f.context, message_type: "private" })).toBeUndefined();
  expect(await readFile(f.primary, "utf8")).toBe("groupAddNotice:\n  msg: 原样 # 配置\n");
  expect(await f.notice.command("开启加群通知", f.context)).toContain("已开启");
  expect(await readFile(f.primary, "utf8")).toBe("groupAddNotice:\n  msg: 原样 # 配置\n  openGroup: [77]\n");
}));

test("只在明确开启的申请群通知，保留原资料，邀请不发送且协议帐号各自去重", () => useFixture(async (f) => {
  await f.notice.policy.receive(f.request);
  await writeFile(f.primary, 'groupAddNotice: {openGroup: [77, 88], msg: "审核提醒"}\n');
  await f.notice.policy.receive({ ...f.request, sub_type: "invite" });
  await f.notice.policy.receive({ ...f.request, group_id: 789 });
  const incoming = { ...f.request, nickname: "申请\n人", inviter_id: 44, comment: "第一行\r\n第二行" };
  await Promise.all([f.notice.policy.receive(incoming), f.notice.policy.receive(incoming)]);
  expect(f.delivered).toEqual([["审核提醒\n", { type: "image", file: "https://q1.qlogo.cn/g?b=qq&s=100&nk=42" },
    "QQ号：42\n", "昵称：申请 人\n", "第一行\n第二行", "\n邀请人：44"]]);
  await f.notice.policy.receive({ ...f.request, groupRequestScope: "milky" });
  await f.notice.policy.receive({ ...f.request, self_id: 98 });
  await f.notice.policy.receive({ ...f.request, group_id: 88 });
  expect(f.delivered).toHaveLength(4);
  expect(f.delivered[1]?.at(-1)).toBe("昵称：未知\n");
  let sends = 0;
  const unknown = { ...f.request, flag: "new", async notifyGroup() { sends++; throw new Error("disconnect"); } };
  await f.notice.policy.receive(unknown);
  await f.notice.policy.receive(unknown);
  expect(sends).toBe(1);
  f.session.abort();
  await f.notice.policy.receive({ ...f.request, flag: "different" });
  expect(f.delivered).toHaveLength(4);
}));
