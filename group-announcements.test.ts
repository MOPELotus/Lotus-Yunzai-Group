import { expect, test } from "bun:test";
import { createGroupAnnouncementDeletion, createGroupAnnouncementPublisher, groupAnnouncementsCommand, isGroupAnnouncementsCommand,
  type GroupAnnouncementDeleteContext, type GroupAnnouncementDeleteResult, type GroupAnnouncementPublishContext, type GroupAnnouncementsContext } from "./group-announcements.ts";

test("旧群公告简称和全称只读取当前群，保持原顺序与 20 项编号", async () => {
  let reads = 0;
  const context: GroupAnnouncementsContext = { message_type: "group", async groupListAnnouncements() {
    reads++;
    return Array.from({ length: 21 }, (_, index) => ({ id: `opaque-${index}`, text: `公告 ${index}` }));
  } };
  expect(isGroupAnnouncementsCommand("#查群公告")).toBe(true);
  expect(isGroupAnnouncementsCommand("#查公告")).toBe(true);
  for (const command of ["查群公告", "#查群公告 第2页", "#发布公告", "#删群公告1", "#发群公告内容"]) {
    expect(await groupAnnouncementsCommand(command, context)).toBeUndefined();
  }
  const listing = await groupAnnouncementsCommand("#查群公告", context);
  expect(listing?.split("\n")).toHaveLength(20);
  expect(listing?.split("\n").at(0)).toBe("1、公告 0");
  expect(listing?.split("\n").at(-1)).toBe("20、公告 19");
  expect(listing).not.toContain("opaque-");
  expect(await groupAnnouncementsCommand("#查公告", context)).toBe(listing);
  expect(reads).toBe(2);
});

test("保留 emoji 与原编码，序号不受换行影响，空正文仍占原位置", async () => {
  const emoji = "👩‍🎨";
  const text = `${"字".repeat(26)}${emoji}甲乙丙丁戊`;
  const result = await groupAnnouncementsCommand("#查公告", { message_type: "group", async groupListAnnouncements() {
    return [{ id: "1", text: "  一行\r\n二行 &amp; [CQ:text,text=原样]" }, { id: "2", text: "  \n" }, { id: "3", text }];
  } });
  expect(result?.split("\n")).toEqual(["1、一行 二行 &amp; [CQ:text,text=原样]", "2、（无文字）", `3、${"字".repeat(26)}${emoji}...`]);
});

test("无列表能力或网关拒绝不报真空，退出和委托不发查询", async () => {
  const base = { message_type: "group" as const };
  expect(await groupAnnouncementsCommand("#查群公告", { ...base, groupListAnnouncements: async () => [] })).toBe("本群暂无群公告。");
  expect(await groupAnnouncementsCommand("#查群公告", { ...base, groupListAnnouncements: async () => undefined })).toContain("无法获取");
  expect(await groupAnnouncementsCommand("#查群公告", { ...base, groupListAnnouncements: async () => { throw new Error("lost"); } })).toContain("无法获取");
  let reads = 0;
  const signal = new AbortController();
  const context = { ...base, groupListAnnouncements: async () => { reads++; return []; } };
  expect(await groupAnnouncementsCommand("#查公告", { ...context, message_type: "private" })).toBeUndefined();
  expect(await groupAnnouncementsCommand("#查公告", { ...context, isDelegated: true })).toContain("无法获取");
  signal.abort();
  expect(await groupAnnouncementsCommand("#查公告", context, signal.signal)).toContain("无法获取");
  expect(reads).toBe(0);
});

function announcementPublisher() {
  const signal = new AbortController();
  const publish = createGroupAnnouncementPublisher(signal.signal);
  const sent: string[] = [];
  const context: GroupAnnouncementPublishContext = {
    message_type: "group", adapter: "onebot", group_id: 77, self_id: 99, user_id: 42, message_id: -101,
    async groupPublishAnnouncement(text) { sent.push(text); return "confirmed"; },
  };
  return { publish, sent, context, signal };
}

test("旧发布别名支持粘连和多行，正文中再出现命令字样也保留", async () => {
  const { publish, sent, context } = announcementPublisher();
  expect(await publish("#发群公告周五开会\n   原文 #发公告 & 你好👩‍🎨  ", context)).toEqual([]);
  expect(await publish("#发公告  ", { ...context, message_id: 2 })).toBe("❎ 公告不能为空");
  expect(await publish("#发公告 另一期安排", { ...context, message_id: 3 })).toEqual([]);
  expect(sent).toEqual(["周五开会\n   原文 #发公告 & 你好👩‍🎨", "另一期安排"]);
});

test("群发布使用原事件闭包，缺权限能力、委托、私聊或退出都不发", async () => {
  const { publish, sent, context, signal } = announcementPublisher();
  const message = "#发群公告例会";
  expect(await publish("#发布公告另一个模块", context)).toBeUndefined();
  expect(await publish(message, { ...context, message_type: "private" })).toBeUndefined();
  expect(await publish(message, { ...context, isDelegated: true })).toContain("无法发布");
  expect(await publish(message, { ...context, message_id: undefined })).toContain("无法发布");
  expect(await publish(message, { ...context, groupPublishAnnouncement: undefined })).toContain("无法发布");
  signal.abort();
  expect(await publish(message, context)).toContain("无法发布");
  expect(sent).toEqual([]);
});

test("原消息并发和未知重放只调用一次，图片无法确认时不降级发布纯文字", async () => {
  const { publish, context } = announcementPublisher();
  let calls = 0;
  const result = Promise.withResolvers<never>();
  const message = "#发群公告例会";
  const awaiting = { ...context, groupPublishAnnouncement: (text: string) => { expect(text).toBe("例会"); calls++; return result.promise; } };
  const first = publish(message, awaiting);
  expect(await publish(message, awaiting)).toEqual([]);
  result.reject(new Error("response lost"));
  expect(await first).toContain("结果未确认");
  expect(await publish(message, awaiting)).toEqual([]);
  expect(await publish(message, { ...awaiting, adapter: "milky" })).toContain("结果未确认");
  expect(calls).toBe(2);
  let images = 0;
  expect(await publish(message, { ...context, message_id: 2, groupPublishAnnouncement: async () => { images++; return "invalid-image"; } })).toContain("原消息的公告图片");
  expect(images).toBe(1);
  expect(await publish(message, { ...context, message_id: 3, groupPublishAnnouncement: async () => "rejected" })).toContain("协议端拒绝");
  expect(await publish(message, { ...context, message_id: 4, groupPublishAnnouncement: async () => "unavailable" })).toContain("无法发布");
});

function announcementDeletion() {
  const signal = new AbortController();
  const remove = createGroupAnnouncementDeletion(signal.signal);
  const indices: number[] = [];
  const context: GroupAnnouncementDeleteContext = {
    message_type: "group", adapter: "onebot", group_id: 77, self_id: 99, user_id: 42, message_id: -7,
    async groupDeleteAnnouncement(index) { indices.push(index); return { status: "confirmed", text: "第一行\n第二行" }; },
  };
  return { remove, indices, context, signal };
}

test("旧删公告别名接同群实时序号，允许前导零和列表显示上限之后的正序号", async () => {
  const { remove, context, indices } = announcementDeletion();
  expect(await remove("#删群公告001", context)).toBe("✅ 已删除「第一行\n第二行」");
  expect(await remove("#删公告21", { ...context, message_id: -8 })).toBe("✅ 已删除「第一行\n第二行」");
  expect(await remove(`#删公告${Number.MAX_SAFE_INTEGER}`, { ...context, message_id: -9 })).toContain("已删除");
  expect(await remove(`#删公告${Number.MAX_SAFE_INTEGER + 1}`, context)).toContain("序号须为正整数");
  expect(await remove("#删公告0", context)).toContain("序号须为正整数");
  for (const input of ["删群公告1", "#删公告 1", "#删群公告-1", "#删公告1.5", "#撤回已发公告1"]) {
    expect(await remove(input, context)).toBeUndefined();
  }
  expect(indices).toEqual([1, 21, Number.MAX_SAFE_INTEGER]);
});

test("已确认删除保留正常长正文、原换行和表情，并明确提示无文字公告", async () => {
  const { remove, context } = announcementDeletion();
  const text = `${"公告".repeat(24)}\r\n第二行👩‍🎨\u202E\u0000`;
  expect(await remove("#删公告2", { ...context, groupDeleteAnnouncement: async () => ({ status: "confirmed", text }) }))
    .toBe(`✅ 已删除「${"公告".repeat(24)}\n第二行👩‍🎨」`);
  expect(await remove("#删公告2", { ...context, message_id: -8, groupDeleteAnnouncement: async () => ({ status: "confirmed", text: " \n" }) }))
    .toBe("✅ 已删除「（无文字，可能仅含图片）」");
  const longText = `${"字".repeat(4094)}😀剩余字符`;
  expect(await remove("#删公告2", { ...context, message_id: -9, groupDeleteAnnouncement: async () => ({ status: "confirmed", text: longText }) }))
    .toBe(`✅ 已删除「${"字".repeat(4094)}…」`);
});

test("群删除缺可信会话、命令 ID 或已退出时不操作", async () => {
  const { remove, context, indices, signal } = announcementDeletion();
  const message = "#删公告2";
  expect(await remove(message, { ...context, message_type: "private" })).toBeUndefined();
  expect(await remove(message, { ...context, isDelegated: true })).toContain("无法删除");
  expect(await remove(message, { ...context, message_id: undefined })).toContain("无法删除");
  expect(await remove(message, { ...context, groupDeleteAnnouncement: undefined })).toContain("无法删除");
  signal.abort();
  expect(await remove(message, context)).toContain("无法删除");
  expect(indices).toEqual([]);
});

test("已确认、找不到、明确拒绝和未知回执分开，同一原消息不重复删除", async () => {
  const { remove, context } = announcementDeletion();
  const pending = Promise.withResolvers<GroupAnnouncementDeleteResult>();
  let attempts = 0;
  const waiting = { ...context, groupDeleteAnnouncement(index: number) { expect(index).toBe(9); attempts++; return pending.promise; } };
  const message = "#删公告9";
  const first = remove(message, waiting);
  expect(await remove(message, waiting)).toEqual([]);
  pending.reject(new Error("response lost"));
  expect(await first).toContain("结果未确认");
  expect(await remove(message, waiting)).toEqual([]);
  expect(await remove(message, { ...waiting, adapter: "milky" })).toContain("结果未确认");
  expect(attempts).toBe(2);
  const responses = { "not-found": "找不到该序号", rejected: "协议端拒绝删除", unavailable: "无法删除", confirmed: "已删除第 9 条" } as const;
  for (const [i, status] of (Object.keys(responses) as (keyof typeof responses)[]).entries()) {
    expect(await remove(message, { ...context, message_id: i, groupDeleteAnnouncement: async () => ({ status }) })).toContain(responses[status]);
  }
});
