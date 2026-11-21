import { expect, test } from "bun:test";
import { continueRepeat, startRepeat, type RepeatContexts, type RepeatEvent } from "./repeat.ts";

interface Scope {
  readonly self_id: number;
  readonly user_id: number;
  readonly group_id?: number;
  readonly message_type: "group" | "private" | "terminal";
}

type Sent = Parameters<RepeatEvent["reply"]>;

function setup() {
  const conversations = new Map<string, RepeatEvent>();
  function key(event: RepeatEvent) {
    const { self_id, user_id, group_id, message_type } = event as RepeatEvent & Scope;
    return JSON.stringify([self_id, user_id, group_id, message_type]);
  }
  const contexts: RepeatContexts = {
    set(event, method, group, seconds, timeout) {
      expect(method).toBe("repeatMessage");
      expect(group).toBe(false);
      expect(seconds).toBe(120);
      expect(timeout).toBe("操作超时已取消");
      conversations.set(key(event), event);
      return event;
    },
    get(event, group) {
      expect(group).toBe(false);
      const origin = conversations.get(key(event));
      return origin ? { repeatMessage: origin } : {};
    },
    finish(event, method, group) {
      expect(group).toBe(false);
      expect(method).toBe("repeatMessage");
      conversations.delete(key(event));
    },
  };
  return { contexts, conversations, key };
}

function session(input: Partial<Scope & RepeatEvent> = {}, sent: Sent[] = [], succeeds = true): RepeatEvent & Scope {
  return {
    self_id: 1, user_id: 42, group_id: 50, message_type: "group",
    message: "#复读", isMaster: true,
    reply(...message) { sent.push(message); return succeeds; },
    ...input,
  };
}

test("主人开启一次复读，要求当前发送者和会话匹配并保留消息段", async () => {
  const { contexts, conversations, key } = setup();
  const prompted: Sent[] = [];
  expect(await startRepeat(session({}, prompted), contexts)).toBe(true);
  expect(prompted).toEqual([["请发送要复读的内容", false, { at: true }]]);
  for (const difference of [{ user_id: 43 }, { group_id: 51 }, { self_id: 2 }, { group_id: undefined }]) {
    expect(await continueRepeat(session(difference), contexts)).toBe(false);
  }

  const message = [{ type: "text", text: "内容" }, { type: "image", file: "test.png" }];
  const sent: Sent[] = [];
  const event = session({ message }, sent);
  expect(conversations.has(key(event))).toBe(true);
  expect(await continueRepeat(event, contexts)).toBe(true);
  expect(sent).toEqual([[message, false, { recallMsg: 5 }]]);
  expect(conversations.has(key(event))).toBe(false);
});

test("按原行为清除失败和撤权会话，委托不能建立或续接复读", async () => {
  const { contexts, conversations } = setup();
  expect(await startRepeat(session({}, [], false), contexts)).toBe(false);
  expect(conversations.size).toBe(0);
  const sent: Sent[] = [];
  expect(await startRepeat(session({ isDelegated: true }, sent), contexts)).toBe(true);
  expect(sent).toEqual([["无法建立复读会话。"]]);
  expect(conversations.size).toBe(0);

  await startRepeat(session(), contexts);
  expect(await continueRepeat(session({ isDelegated: true }), contexts)).toBe(false);
  expect(conversations.size).toBe(1);
  const echo: Sent[] = [];
  expect(await continueRepeat(session({ isMaster: false }, echo), contexts)).toBe(true);
  expect(echo).toEqual([]);
  expect(conversations.size).toBe(0);
});
