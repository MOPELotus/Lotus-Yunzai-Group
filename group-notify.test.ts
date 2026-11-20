import { expect, test } from "bun:test";
import { createGroupNotification, type GroupNotificationContext, type GroupNotificationPart } from "./group-notify.ts";

const text = (value: string) => ({ type: "text", text: value });
const at = (qq: string | number) => ({ type: "at", qq });

function fixture() {
  const controller = new AbortController();
  const calls: (readonly GroupNotificationPart[])[] = [];
  const context: GroupNotificationContext = {
    message_type: "group", adapter: "onebot", group_id: 77, self_id: 99, user_id: 42, message_id: 100,
    normalizedMessage: "#发通知开会", message: [text("#发通知开会")],
    async groupNotifyAll(parts) { calls.push(parts); return "confirmed"; },
  };
  return { command: createGroupNotification(controller.signal), controller, context, calls };
}

test("使用原正文顺序、媒体来源和真实 @，剥离命令寻址及所有旧 @全体", async () => {
  const { command, context, calls } = fixture();
  const image = Object.freeze({ type: "image", url: "https://multimedia.nt.qq.com.cn/download/image" });
  const face = { type: "face", id: 88 };
  const voice = { type: "record", getDownloadUrl: async () => undefined };
  const video = { type: "video", url: "https://grouptalk.c2c.qq.com/download/video" };
  const message = Object.freeze([Object.freeze({ type: "reply", id: 1 }), at(99), at("all"), text(" ＃发通知  开会  "), image, at(43),
    text("\n九点见 "), face, at("all"), voice, video]);
  expect(await command({ ...context, normalizedMessage: "#发通知  开会  \n九点见", message })).toEqual([]);
  expect(calls).toEqual([[text("开会"), image, at(43), text("\n九点见 "), face, voice, video]]);
  expect(calls[0]?.[1]).toBe(image);
  expect(message[3]).toEqual(text(" ＃发通知  开会  "));
});

test("支持配置寻址、连续拆分的命令前缀和纯媒体通知，空正文保持旧提示", async () => {
  const { command, context, calls } = fixture();
  expect(await command({ ...context, normalizedMessage: "#发通知", message: [text("小助手  #发"), text("通知  "), { type: "face", id: 14 }] })).toEqual([]);
  expect(await command({ ...context, message_id: 101, normalizedMessage: "#发通知", message: [text("#发通知"), text("  "), at("all")] })).toBe("❎ 通知不能为空");
  expect(calls).toEqual([[{ type: "face", id: 14 }]]);
});

test("未知正文段不发部分通知，无原会话、委托、退出或私聊也不发送", async () => {
  const { command, context, controller, calls } = fixture();
  for (const part of [{ type: "file", file: "/local" }, { type: "reply", id: 5 }, { type: "at", qq: "@all" }]) {
    expect(await command({ ...context, message: [text("#发通知开会"), part] })).toContain("不支持发送的消息段");
  }
  expect(await command({ ...context, message: [at(43), text("#发通知开会")] })).toContain("不支持发送的消息段");
  expect(await command({ ...context, message: [text("普通消息")] })).toContain("不支持发送的消息段");
  expect(await command({ ...context, message_id: undefined })).toContain("无法发送");
  expect(await command({ ...context, isDelegated: true })).toContain("无法发送");
  expect(await command({ ...context, groupNotifyAll: undefined })).toContain("无法发送");
  expect(await command({ ...context, message_type: "private" })).toBeUndefined();
  controller.abort();
  expect(await command(context)).toContain("无法发送");
  expect(calls).toEqual([]);
});

test("只一次尝试，区分已拒绝、结果未知和无法发送；不同协议不会共用去重", async () => {
  const { command, context } = fixture();
  let attempts = 0;
  const failing: GroupNotificationContext = { ...context, async groupNotifyAll() { attempts++; throw new Error("timeout"); } };
  expect(await command(failing)).toContain("结果未确认");
  expect(await command(failing)).toEqual([]);
  expect(await command({ ...failing, adapter: "milky" })).toContain("结果未确认");
  expect(attempts).toBe(2);
  expect(await command({ ...context, message_id: 102, groupNotifyAll: async () => "rejected" })).toContain("协议端拒绝");
  expect(await command({ ...context, message_id: 103, groupNotifyAll: async () => "unavailable" })).toContain("无法发送");
});
