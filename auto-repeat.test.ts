import { expect, test } from "bun:test";
import { createAutoRepeat } from "./auto-repeat.ts";

const self_id = 99, group_id = 77, session = new AbortController().signal;
const face = { type: "face", id: "18" } as const;
const text = (value: string) => ({ type: "text", text: value });
const cdn = "https://multimedia.nt.qq.com.cn/download";
const md5 = "0123456789abcdef0123456789abcdef";

function fixture() {
  const sent: unknown[] = [];
  const event = (user_id: number, message: unknown, overrides = {}) => ({
    self_id, group_id, user_id, message, ...overrides,
    reply(payload: unknown) { sent.push(payload); return true; },
  });
  return { sent, event };
}

test("旧自动复读同群两位用户重复后只跟读一次，保留表情并忽略机器人", async () => {
  const { sent, event } = fixture();
  const observe = createAutoRepeat({ isBot: (id) => id === 100 });
  const same = [text("早上\r\n好"), face];
  await observe(event(42, same));
  await observe(event(43, same, { isDelegated: true }), session);
  await observe(event(self_id, same), session);
  await observe(event(100, same), session);
  await observe(event(101, same, { sender: { is_bot: true } }), session);
  expect(sent).toEqual([]);
  await observe(event(42, same), session);
  await observe(event(42, same), session);
  await observe(event(43, [text("早上\n"), text("好"), face], { group_id: 78 }), session);
  expect(sent).toEqual([]);
  await observe(event(43, [text("早上\n"), text("好"), face]), session);
  await observe(event(44, same), session);
  expect(sent).toEqual([[text("早上\n"), text("好"), face]]);
});

test("命令、空文本或不支持的消息段打断旧复读连续轮次，超时后重新计数", async () => {
  const { sent, event } = fixture();
  let now = 0;
  const observe = createAutoRepeat({ now: () => now });
  const same = [text("两次同句")];
  for (const reset of [[text(" ＃命令")], [text("  ")], [{ type: "mention_all" }], [{ type: "file", name: "记录.json" }]]) {
    await observe(event(44, [text("新的一轮")]), session);
    await observe(event(42, same), session);
    await observe(event(44, reset), session);
    await observe(event(43, same), session);
    expect(sent).toEqual([]);
  }
  now = 120_001;
  await observe(event(42, same), session);
  expect(sent).toEqual([]);
  await observe(event(43, same), session);
  expect(sent).toEqual([same]);
});

test("图片只比较可信的协议标识，触发后才下载并以字节发送一次", async () => {
  const { sent, event } = fixture();
  const downloaded: unknown[] = [];
  const bytes = Uint8Array.of(137, 80, 78, 71);
  const observe = createAutoRepeat({ async readImage(url) { downloaded.push(url); return bytes; } });
  const image = (url: string, file: string) => [{ type: "image", url, file }];
  await observe(event(42, image(cdn + "?key=first", md5 + ".jpg")), session);
  await observe(event(43, [{ type: "image", url: cdn + "?key=second", resource_id: md5 }], { adapter: "milky" }), session);
  expect(downloaded).toEqual([]);
  await observe(event(42, image(cdn + "?key=first", md5 + ".jpg")), session);
  await Promise.all([
    observe(event(43, image(cdn + "?key=second", md5.toUpperCase() + ".jpg")), session),
    observe(event(44, image(cdn + "?key=third", md5 + ".jpg")), session),
  ]);
  expect(downloaded).toEqual([cdn + "?key=second"]);
  expect(sent).toEqual([[{ type: "image", file: bytes }]]);

  await observe(event(42, [{ type: "image", file: "/private/file.png" }]), session);
  await observe(event(43, [{ type: "image", file: "/private/file.png" }]), session);
  expect(downloaded).toHaveLength(1);
  const resource_id = "milky-resource";
  await observe(event(42, [{ type: "image", url: cdn, resource_id }], { adapter: "milky" }), session);
  await observe(event(43, [{ type: "image", resource_id, getDownloadUrl: async () => cdn + "?key=resolved" }], { adapter: "milky" }), session);
  expect(downloaded).toEqual([cdn + "?key=second", cdn + "?key=resolved"]);
  expect(sent).toHaveLength(2);
});

test("已占用的图片跟读遇到原连接断开时不发送，也不会重试", async () => {
  const { sent, event } = fixture();
  const gateway = new AbortController();
  const downloading = Promise.withResolvers<Uint8Array>();
  const started = Promise.withResolvers<void>();
  let reads = 0;
  const observe = createAutoRepeat({
    async readImage(_url, signal) {
      reads++;
      expect(signal).toBe(gateway.signal);
      started.resolve();
      return downloading.promise;
    },
  });
  const message = [{ type: "image", url: cdn }];
  await observe(event(42, message), gateway.signal);
  const repeating = observe(event(43, message), gateway.signal);
  await started.promise;
  gateway.abort();
  downloading.resolve(Uint8Array.of(1));
  await repeating;
  await observe(event(44, message), session);
  expect(sent).toEqual([]);
  expect(reads).toBe(1);
});

test("OneBot 保留旧图片 file URL，Milky 临时链接失败后按资源重新查询一次", async () => {
  const { sent, event } = fixture();
  const reads: string[] = [];
  const expired = cdn + "?expired";
  const fresh = cdn + "?fresh";
  const bytes = Uint8Array.of(137, 80, 78, 71);
  const observe = createAutoRepeat({ async readImage(url) {
    reads.push(String(url));
    if (url === expired) throw new Error("链接已失效");
    return bytes;
  } });
  await observe(event(42, [{ type: "image", file: cdn }]), session);
  await observe(event(43, [{ type: "image", file: cdn, url: "" }]), session);
  let renewals = 0;
  const milky = [{ type: "image", url: expired, resource_id: "same-image", async getDownloadUrl() {
    renewals++;
    return fresh;
  } }];
  for (const user of [42, 43, 44]) await observe(event(user, milky, { adapter: "milky" }), session);
  expect(reads).toEqual([cdn, expired, fresh]);
  expect(renewals).toBe(1);
  expect(sent).toEqual([[{ type: "image", file: bytes }], [{ type: "image", file: bytes }]]);
});

test("复读取触发消息的已知 OneBot 图片子类型，忽略 Milky 和无效原值", async () => {
  const { sent, event } = fixture();
  const file = Uint8Array.of(1);
  const observe = createAutoRepeat({ async readImage() { return file; } });
  const cases = [0, 1, 7, "6", -1, 8, 1.5, "sticker"] as const;
  for (const [index, sub_type] of cases.entries()) {
    const url = `${cdn}?case=${index}`;
    await observe(event(42, [{ type: "image", url, sub_type: 1 }]), session);
    await observe(event(43, [{ type: "image", url, sub_type }]), session);
  }
  const sticker = [{ type: "image", url: cdn, resource_id: "milky-sticker", sub_type: "sticker" }];
  await observe(event(42, sticker, { adapter: "milky" }), session);
  await observe(event(43, sticker, { adapter: "milky" }), session);
  expect(sent).toEqual([0, 1, 7, 6, undefined, undefined, undefined, undefined, undefined].map(sub_type => [{
    type: "image", file, ...(sub_type !== undefined && { sub_type }),
  }]));
});

test("延迟观察保留触发图段的原子类型及接收时间，外部规则的修改不渗入", async () => {
  const { sent, event } = fixture();
  const queued: ((receivedAt?: number) => Promise<void>)[] = [];
  const file = Uint8Array.of(1);
  const observe = createAutoRepeat({
    async readImage() { return file; },
    observeAutoRepeat(_group, run) { queued.push(run); },
  });
  const parts = [{ type: "image", url: cdn, sub_type: 1 }];
  await observe(event(42, [{ ...parts[0], sub_type: 0 }]), session);
  await observe(event(43, parts), session);
  expect(sent).toEqual([]);
  parts[0]!.sub_type = 0;
  await queued[0]!(0);
  await queued[1]!(1);
  const reply = [{ type: "image", file, sub_type: 1 }];
  expect(sent).toEqual([reply]);

  await observe(event(44, [{ type: "image", url: cdn, sub_type: 1 }]), session);
  await queued[2]!(120_002);
  expect(sent).toEqual([reply]);
  await observe(event(43, [{ type: "image", url: cdn, sub_type: 1 }]), session);
  await queued[3]!(120_003);
  expect(sent).toEqual([reply, reply]);
});
