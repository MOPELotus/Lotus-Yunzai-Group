import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAutoGroupCard, type OwnGroupCardAccount, type OwnGroupCardResult } from "./auto-group-card.ts";

const defaultCron = "0 0,30 * * * *";
const alternates = "enable: true\nsuffixes: [替换文案一, 替换文案二]\n";

async function fixture(run: (root: URL, write: (text: string, legacy?: boolean) => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-auto-group-card-"));
  const config = join(directory, "config");
  try {
    await mkdir(join(config, "config"), { recursive: true });
    await run(pathToFileURL(directory + "/"), (text, legacy) =>
      writeFile(join(config, ...(legacy ? ["config"] : []), "auto-group-card.yaml"), text));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function account({ adapter = "onebot", botId = 99, groups = [77], outcomes = [], nickname = "当前昵称" }: {
  adapter?: OwnGroupCardAccount["adapter"];
  botId?: number;
  groups?: readonly number[];
  outcomes?: readonly OwnGroupCardResult[];
  nickname?: string;
} = {}) {
  const connection = new AbortController();
  const observed = { reads: 0, writes: [] as [number, string][] };
  const current: OwnGroupCardAccount = {
    adapter, botId, nickname, signal: connection.signal,
    async groups() { observed.reads++; return groups; },
    async updateSelfCard(group, card, signal) {
      expect(signal?.aborted).toBe(false);
      observed.writes.push([group, card]);
      return outcomes[observed.writes.length - 1] ?? "confirmed";
    },
  };
  return { current, connection, observed };
}

test("自动群名片识别旧配置和原文案，主配置和显式文案优先", () => fixture(async (root, write) => {
  const { current, observed } = account();
  const updater = createAutoGroupCard({ root, signal: new AbortController().signal, accounts: () => [current] });
  const owner = { message_type: "private" as const, isMaster: true, ownGroupCardAccount: current };
  expect(await updater.configuration()).toBeUndefined();
  expect(await updater.scheduled()).toBeUndefined();
  expect(await updater.command("", owner)).toContain("未启用");
  await write("enable: true\nnickname: 旧昵称\n", true);
  expect(await updater.configuration()).toEqual({ cron: defaultCron });
  await write("enable: true\nsuffixes: []\n", true);
  expect(await updater.configuration()).toBeUndefined();
  expect(await updater.command("", owner)).toContain("配置群名片文案");
  await write(alternates, true);
  expect(await updater.configuration()).toEqual({ cron: defaultCron });
  await write(alternates.replace("enable: true", "enable: false"));
  expect(await updater.configuration()).toBeUndefined();
  expect(await updater.scheduled()).toBeUndefined();
  expect(observed).toEqual({ reads: 0, writes: [] });
  await write(`${alternates}cron: "15 * * * *"\n`);
  expect(await updater.configuration()).toEqual({ cron: "15 * * * *" });
  await write("suffixes: [坏文案]\nnotGroup: 77\n");
  await expect(updater.configuration()).rejects.toThrow("群号列表");
  expect(await updater.command("", owner)).toContain("无法读取");
}));

test("主人手动只更新宿主提供的原会话账号，允许旧排除列表与固定昵称", () => fixture(async (root, write) => {
  await write(`${alternates}nickname: 旧首选昵称\nnotGroup: [77, "78"]\n`, true);
  const own = account({ adapter: "milky", groups: [77, 78, 79, 79, 80, 81, 82],
    outcomes: ["unchanged", "unknown", "rejected", "confirmed"] });
  const other = account();
  const updater = createAutoGroupCard({ root, signal: new AbortController().signal, accounts: () => [other.current], choose: () => 1 });
  const owner = { message_type: "group" as const, isMaster: false, ownGroupCardAccount: own.current };
  expect(await updater.command("", { ...owner, ownGroupCardAccount: undefined })).toContain("仅限主人");
  expect(await updater.command("", { ...owner, isDelegated: true })).toContain("仅限主人");
  expect(await updater.command("", { ...owner, message_type: "terminal" })).toContain("不支持");
  expect(await updater.command("目标 123", owner)).toContain("直接发送");
  expect(await updater.command("", owner)).toMatch(/成功 1 个，未变 1 个，失败 1 个，未确认 1 个/u);
  expect(own.observed.writes).toEqual([79, 80, 81, 82].map((id) => [id, "旧首选昵称｜替换文案二"]));
  expect(other.observed).toEqual({ reads: 0, writes: [] });
}));

test("定时按 QQ 去重优先 OneBot，失败列表与空列表区分，连接撤销时停止该账号", () => fixture(async (root, write) => {
  await write(alternates);
  const duplicate = account({ adapter: "milky" });
  const onebot = account({ groups: [77, 78] });
  const empty = account({ adapter: "milky", botId: 100, groups: [] });
  const unreadable = account({ adapter: "milky", botId: 101 });
  const runtime = new AbortController();
  const updater = createAutoGroupCard({
    root, signal: runtime.signal, choose: () => 0,
    accounts: () => [
      duplicate.current,
      { ...onebot.current, async updateSelfCard(...args) {
        const result = await onebot.current.updateSelfCard(...args);
        onebot.connection.abort();
        return result;
      } },
      empty.current,
      { ...unreadable.current, async groups() { return undefined; } },
    ],
  });
  expect(await updater.scheduled()).toEqual({ updated: 1, unchanged: 0, failed: 0, unknown: 0, unavailableAccounts: 1 });
  expect(duplicate.observed.reads).toBe(0);
  expect(onebot.observed.writes).toEqual([[77, "当前昵称｜替换文案一"]]);
  expect(empty.observed.reads).toBe(1);
  runtime.abort();
  expect(await updater.scheduled()).toBeUndefined();
}));

test("定时和手动不重入，停机期间的群列表不能发出写入", () => fixture(async (root, write) => {
  await write(alternates);
  const found = Promise.withResolvers<readonly number[]>();
  const started = Promise.withResolvers<void>();
  const runtime = new AbortController();
  const { current, observed } = account();
  const waiting: OwnGroupCardAccount = {
    ...current, async groups() { started.resolve(); return found.promise; },
  };
  const updater = createAutoGroupCard({ root, signal: runtime.signal, accounts: () => [waiting] });
  const pending = updater.scheduled();
  await started.promise;
  expect(await updater.command("", { message_type: "group", isMaster: true, ownGroupCardAccount: current })).toContain("正在更新");
  runtime.abort();
  found.resolve([77, 78]);
  expect(await pending).toBeUndefined();
  expect(observed.writes).toEqual([]);
}));


test("自动群名片读取群列表后使用会话延迟确认的机器人昵称", () => fixture(async (root, write) => {
  await write(alternates);
  const { current, observed } = account();
  let nickname: string | undefined;
  const lazy: OwnGroupCardAccount = {
    ...current,
    get nickname() { return nickname; },
    async groups() {
      nickname = "延迟读取的昵称";
      return current.groups();
    },
  };
  const updater = createAutoGroupCard({
    root, signal: new AbortController().signal, accounts: () => [lazy], choose: () => 0,
  });
  expect(await updater.scheduled()).toMatchObject({ updated: 1 });
  expect(observed.writes).toEqual([[77, "延迟读取的昵称｜替换文案一"]]);
}));


test("现有旧配置省略文案时继承原文案，缺文件或明确停用时不写入", () => fixture(async (root, write) => {
  const { current, observed } = account();
  const updater = createAutoGroupCard({
    root, signal: new AbortController().signal, accounts: () => [current], choose: () => 2,
  });
  expect(await updater.scheduled()).toBeUndefined();
  await write("enable: true\nnickname: 旧昵称\n", true);
  expect(await updater.scheduled()).toMatchObject({ updated: 1 });
  expect(observed.writes).toEqual([[77, "旧昵称｜Hello，Kugou！"]]);
  await write("enable: false\n");
  expect(await updater.scheduled()).toBeUndefined();
  expect(observed.writes).toHaveLength(1);
}));

test("新安装默认只预置后缀且关闭，开启后取当前QQ昵称", () => fixture(async (root, write) => {
  const { current, observed } = account({ nickname: "实时QQ昵称" });
  const updater = createAutoGroupCard({ root, signal: new AbortController().signal, accounts: () => [current], choose: () => 2 });
  expect(await updater.configuration()).toBeUndefined();
  await write("enable: true\n");
  expect(await updater.configuration()).toEqual({ cron: defaultCron });
  expect(await updater.scheduled()).toMatchObject({ updated: 1 });
  expect(observed.writes).toEqual([[77, "实时QQ昵称｜Hello，Kugou！"]]);
}));
