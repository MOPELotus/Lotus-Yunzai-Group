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
