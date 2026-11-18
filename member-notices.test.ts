import { expect, test } from "bun:test";
import { announceDeparture, welcomeMember, type GroupMemberNotice } from "./member-notices.ts";

const member = { self_id: 1, user_id: 42, group_id: 50 };

test("欢迎同一群 30 秒内只发一次，保留头像、群名和提及", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "redis");
  const locks = new Set<string>();
  const sent: unknown[] = [];
  function set(key: string, value: string, options: unknown) {
    expect(key).toBe("Yz:newcomers:50");
    expect(value).toBe("1");
    expect(options).toEqual({ NX: true, EX: 30 });
    if (locks.has(key)) return Promise.resolve(null);
    locks.add(key);
    return Promise.resolve("OK");
  }

  Object.assign(globalThis, { redis: { set } });
  try {
    const event: GroupMemberNotice = {
      ...member, group_name: "绘图\n讨论群", action_sub_type: "invite",
      reply: (body) => { sent.push(body); return true; },
    };
    expect(await Promise.all([welcomeMember(event), welcomeMember({ ...event, user_id: 43 })])).toEqual([true, false]);
    expect(sent).toEqual([[
      { type: "image", file: "https://q1.qlogo.cn/g?b=qq&nk=42&s=100" },
      "\n", "🌸 欢迎来到「绘图 讨论群」\n\n", { type: "at", qq: 42 },
      " 欢迎加入～\n先看看群公告，有问题随时交流。",
    ]]);
    expect(await welcomeMember({ ...event, user_id: event.self_id })).toBe(false);
    expect(sent).toHaveLength(1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "redis", previous);
    else Reflect.deleteProperty(globalThis, "redis");
  }
});

test("头像失败时回复无头像消息，区分退出和移出", async () => {
  for (const rejection of [false, new Error("头像不可用")]) {
    const sent: unknown[] = [];
    const event: GroupMemberNotice = {
      ...member, member: { card: "群\n名片", nickname: "昵称" }, operator_id: 99, action_sub_type: "kick",
      async reply(content) {
        sent.push(content);
        if (sent.length > 1) return true;
        if (rejection instanceof Error) throw rejection;
        return rejection;
      },
    };
    expect(await announceDeparture(event)).toBe(true);
    expect(sent).toEqual([
      [{ type: "image", file: "https://q1.qlogo.cn/g?b=qq&nk=42&s=100" }, "\n",
        "📋 成员变动\n\n群 名片（42） 已被移出本群。"],
      ["📋 成员变动\n\n群 名片（42） 已被移出本群。"],
    ]);
  }

  const sent: unknown[] = [];
  const event: GroupMemberNotice = {
    ...member, operator_id: member.user_id, action_sub_type: "leave",
    reply(content) { sent.push(content); return true; },
  };
  expect(await announceDeparture(event)).toBe(true);
  expect(sent).toEqual([[
    { type: "image", file: "https://q1.qlogo.cn/g?b=qq&nk=42&s=100" }, "\n",
    "🍃 成员离开\n\nQQ 42 已退出本群。\n有缘再见，祝一切顺利。",
  ]]);
  expect(await announceDeparture({ ...event, dismiss: true })).toBe(false);
  expect(await announceDeparture({ ...event, user_id: event.self_id })).toBe(false);
  expect(sent).toHaveLength(1);
});

test("未连接 Valkey 时按群分别限制欢迎频率", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "redis");
  Reflect.deleteProperty(globalThis, "redis");
  try {
    const event = { ...member, reply: () => true };
    expect(await welcomeMember(event)).toBe(true);
    expect(await welcomeMember({ ...event, user_id: 43 })).toBe(false);
    expect(await welcomeMember({ ...event, group_id: 51 })).toBe(true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "redis", previous);
  }
});
