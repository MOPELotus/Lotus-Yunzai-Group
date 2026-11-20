import { expect, test } from "bun:test";
import { groupAnnouncementsCommand, isGroupAnnouncementsCommand, type GroupAnnouncementsContext } from "./group-announcements.ts";

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
