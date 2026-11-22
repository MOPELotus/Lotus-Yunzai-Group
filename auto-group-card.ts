import { readFile } from "node:fs/promises";

export type OwnGroupCardResult = "confirmed" | "unchanged" | "rejected" | "unknown";

export interface OwnGroupCardAccount {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly nickname?: string;
  readonly signal: AbortSignal;
  groups(): Promise<readonly number[] | undefined>;
  updateSelfCard(groupId: number, card: string, signal?: AbortSignal): Promise<OwnGroupCardResult>;
}

export interface AutoGroupCardContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly isMaster: boolean;
  readonly isDelegated?: boolean;
  readonly ownGroupCardAccount?: OwnGroupCardAccount;
}

export interface AutoGroupCardSummary {
  updated: number;
  unchanged: number;
  failed: number;
  unknown: number;
  unavailableAccounts: number;
}

interface Settings {
  readonly enabled: boolean;
  readonly cron: string;
  readonly nickname?: string;
  readonly notGroup: ReadonlySet<number>;
  readonly suffixes: readonly string[];
}

interface AutoGroupCardOptions {
  readonly root?: URL;
  readonly signal: AbortSignal;
  readonly accounts: () => readonly OwnGroupCardAccount[];
  readonly choose?: (length: number) => number;
}

type Run = { readonly status: "complete"; readonly summary: AutoGroupCardSummary } | {
  readonly status: "disabled" | "missing-template" | "invalid-config" | "no-accounts" | "busy" | "stopped";
};

const defaultRoot = new URL("../../", import.meta.url);
const defaultCron = "0 0,30 * * * *";
// MOPELotus example/自动群名片.js at 3969d13.
const originalSuffixes = [
  "本机器人拒绝服务酷狗！",
  "米游社区寄生的酷狗能不能滚一边去！",
  "Hello，Kugou！",
  "MC是Minecraft，别连简称也蹭！",
  "在米游社区跳脸就接受后果！",
  "推广米游不好玩呜哇好玩有素质没？",
] as const;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function groupId(value: unknown): number {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (!positiveId(id)) throw new TypeError("notGroup 应包含有效群号。");
  return id;
}

function cardPart(value: unknown): string | undefined {
  if (typeof value === "string" && value.isWellFormed() && value.trim() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    return value.trim();
  }
}

async function readSettings(root: URL): Promise<Settings | undefined> {
  for (const path of ["config/auto-group-card.yaml", "config/config/auto-group-card.yaml"]) {
    const source = await readFile(new URL(path, root), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (source === undefined) continue;

    return parseAutoGroupCardSettings(Bun.YAML.parse(source) ?? {});
  }
}

export function parseAutoGroupCardSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("自动群名片配置须为映射。");
  }
  const { enable, cron, nickname, notGroup, suffixes } = input as Record<string, unknown>;
  if (enable !== undefined && enable !== null && typeof enable !== "boolean") throw new TypeError("enable 应为布尔值。");
  const expression = cron ? (typeof cron === "string" ? cron.trim().replace(/\s+/gu, " ") : "") : defaultCron;
  if (![5, 6].includes(expression.split(" ").length)) throw new TypeError("cron 应为五段或六段表达式。");
  if (nickname !== undefined && nickname !== null && nickname !== "" && !cardPart(nickname)) {
    throw new TypeError("nickname 应为单行文本。");
  }
  if (notGroup != null && !Array.isArray(notGroup)) throw new TypeError("notGroup 应为群号列表。");
  if (suffixes != null && !Array.isArray(suffixes)) throw new TypeError("suffixes 应为文案列表。");
  return {
    enabled: enable !== false, cron: expression, nickname: cardPart(nickname),
    notGroup: new Set((notGroup as unknown[] | undefined)?.map(groupId)),
    suffixes: suffixes === undefined ? originalSuffixes : (suffixes as unknown[] | null)?.map((value) => {
      const text = cardPart(value);
      if (!text) throw new TypeError("suffixes 应包含非空的单行文本。");
      return text;
    }) ?? [],
  };
}

function scheduledAccounts(accounts: readonly OwnGroupCardAccount[]) {
  const selected = new Map<number, OwnGroupCardAccount>();
  for (const account of accounts) {
    if (account.signal.aborted || !positiveId(account.botId)) continue;
    const current = selected.get(account.botId);
    if (!current || (current.adapter === "milky" && account.adapter === "onebot")) selected.set(account.botId, account);
  }
  return [...selected.values()];
}

function describe(result: Run): string {
  switch (result.status) {
    case "complete": {
      const { updated, unchanged, failed, unknown, unavailableAccounts } = result.summary;
      return `群名片更新完成：成功 ${updated} 个，未变 ${unchanged} 个，失败 ${failed} 个，未确认 ${unknown} 个` +
        (unavailableAccounts ? `，无法读取 ${unavailableAccounts} 个账号的群名片目标。` : "。");
    }
    case "disabled": return "自动群名片功能未启用。";
    case "missing-template": return "请先在 auto-group-card.yaml 配置群名片文案。";
    case "invalid-config": return "自动群名片配置无法读取。";
    case "no-accounts": return "没有可查询的在线机器人账号。";
    case "busy": return "群名片正在更新，请稍后再试。";
    case "stopped": return "群名片更新已停止。";
  }
}

export function createAutoGroupCard({ root = defaultRoot, signal, accounts, choose = (length) => Math.floor(Math.random() * length) }: AutoGroupCardOptions) {
  let running = false;

  async function run(getAccounts: () => readonly OwnGroupCardAccount[]): Promise<Run> {
    if (signal.aborted) return { status: "stopped" };
    if (running) return { status: "busy" };
    running = true;
    try {
      let settings: Settings | undefined;
      try {
        settings = await readSettings(root);
      } catch {
        return { status: "invalid-config" };
      }
      if (signal.aborted) return { status: "stopped" };
      if (!settings?.enabled) return { status: "disabled" };
      if (!settings.suffixes.length) return { status: "missing-template" };
      const suffix = settings.suffixes[choose(settings.suffixes.length)];
      if (!suffix) return { status: "invalid-config" };
      const active = scheduledAccounts(getAccounts());
      if (!active.length) return { status: "no-accounts" };
      const summary: AutoGroupCardSummary = { updated: 0, unchanged: 0, failed: 0, unknown: 0, unavailableAccounts: 0 };
      for (const account of active) {
        if (signal.aborted) return { status: "stopped" };
        const accountSignal = AbortSignal.any([signal, account.signal]);
        if (accountSignal.aborted) {
          summary.unavailableAccounts++;
          continue;
        }
        const groups = await account.groups().catch(() => undefined);
        const nickname = settings.nickname ?? cardPart(account.nickname);
        if (accountSignal.aborted || !nickname || !Array.isArray(groups) || ![...groups].every(positiveId)) {
          summary.unavailableAccounts++;
          continue;
        }
        const card = `${nickname}｜${suffix}`;
        for (const group of new Set(groups)) {
          if (accountSignal.aborted) break;
          if (settings.notGroup.has(group)) continue;
          const result = await account.updateSelfCard(group, card, accountSignal).catch(() => "unknown" as const);
          if (result === "confirmed") summary.updated++;
          else if (result === "unchanged") summary.unchanged++;
          else if (result === "rejected") summary.failed++;
          else summary.unknown++;
        }
      }
      return signal.aborted ? { status: "stopped" } : { status: "complete", summary };
    } finally {
      running = false;
    }
  }

  return {
    async configuration() {
      const settings = await readSettings(root);
      return settings?.enabled && settings.suffixes.length ? { cron: settings.cron } : undefined;
    },
    async command(argument: string, context: AutoGroupCardContext) {
      if (context.isDelegated || (!context.isMaster && !context.ownGroupCardAccount)) return "❎ 该命令仅限主人可用";
      if (argument) return "请直接发送 #更新群名片。";
      const { ownGroupCardAccount } = context;
      if (context.message_type === "terminal" || !ownGroupCardAccount || ownGroupCardAccount.signal.aborted) {
        return "当前会话不支持批量更新本机器人的群名片。";
      }
      return describe(await run(() => [ownGroupCardAccount]));
    },
    async scheduled(): Promise<AutoGroupCardSummary | undefined> {
      const result = await run(accounts);
      if (result.status === "complete") return result.summary;
    },
  };
}
