import { expect, test } from "bun:test";

const conversations = new Map<string, string>();
interface ReplyOptions {
  readonly at?: boolean;
  readonly recallMsg?: number;
}
type Reply = [unknown, boolean | undefined, ReplyOptions | undefined];
interface Event {
  readonly self_id: number;
  readonly user_id: number;
  readonly group_id?: number;
  readonly message: unknown;
  readonly isMaster: boolean;
}

class MockPlugin {
  e!: Event;
  readonly sent: Reply[] = [];
  fail = false;

  constructor(readonly options: { readonly rule: unknown }) {}

  get key() {
    const { self_id, user_id, group_id } = this.e;
    return JSON.stringify([self_id, user_id, group_id]);
  }

  setContext(name: string, group = false) {
    expect(group).toBe(false);
    conversations.set(this.key, name);
    return this.e;
  }

  finish(name: string, group = false) {
    expect(group).toBe(false);
    if (conversations.get(this.key) === name) conversations.delete(this.key);
  }

  reply(message: unknown, quote?: boolean, options?: ReplyOptions): boolean {
    this.sent.push([message, quote, options]);
    return !this.fail;
  }
}

const previous = Object.getOwnPropertyDescriptor(globalThis, "plugin");
Object.assign(globalThis, { plugin: MockPlugin });
const { apps: { Repeat } } = await import("./repeat.js");
if (previous) Object.defineProperty(globalThis, "plugin", previous);
else Reflect.deleteProperty(globalThis, "plugin");

function session(event: Event) {
  return Object.assign(new Repeat(), { e: event }) as unknown as MockPlugin & {
    repeat(): Promise<boolean>;
    repeatMessage(): boolean;
  };
}

const owner = { self_id: 1, user_id: 42, group_id: 50, message: "#复读", isMaster: true };

test("主人开启一次复读，要求当前发送者和会话匹配并保留消息段", async () => {
  const start = session(owner);
  expect(start.options.rule).toEqual([{ reg: /^#复读$/u, fnc: "repeat", permission: "master" }]);
  expect(await start.repeat()).toBe(true);
  expect(start.sent).toEqual([["请发送要复读的内容", false, { at: true }]]);
  const otherEvents = [{ user_id: 43 }, { group_id: 51 }, { self_id: 2 }, { group_id: undefined }];
  for (const difference of otherEvents) {
    expect(conversations.has(session({ ...owner, ...difference }).key)).toBe(false);
  }

  const message = [{ type: "text", text: "内容" }, { type: "image", file: "test.png" }];
  const followup = session({ ...owner, message });
  expect(conversations.get(followup.key)).toBe("repeatMessage");
  expect(followup.repeatMessage()).toBe(true);
  expect(followup.sent).toEqual([[message, false, { recallMsg: 5 }]]);
  expect(conversations.has(followup.key)).toBe(false);
});

test("提示无法发出或续接时已无主人权限，清除复读会话", async () => {
  const failed = session(owner);
  failed.fail = true;
  expect(await failed.repeat()).toBe(false);
  expect(conversations.has(failed.key)).toBe(false);

  const start = session(owner);
  await start.repeat();
  const followup = session({ ...owner, isMaster: false });
  expect(followup.repeatMessage()).toBe(false);
  expect(followup.sent).toHaveLength(0);
  expect(conversations.has(followup.key)).toBe(false);
});
