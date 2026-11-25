import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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
  $t("auto-group-card.text_6031fceaed"),
  $t("auto-group-card.text_37b47581f6"),
  "Hello，Kugou！",
  $t("auto-group-card.text_44b021b500"),
  $t("auto-group-card.text_e575b86262"),
  $t("auto-group-card.text_9551591bac"),
] as const;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function groupId(value: unknown): number {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (!positiveId(id)) throw new TypeError($t("auto-group-card.text_2ac43b3e10"));
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
  return parseAutoGroupCardSettings({});
}

export function parseAutoGroupCardSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError($t("auto-group-card.text_cb5eb80671"));
  }
  const { enable, cron, nickname, notGroup, suffixes } = input as Record<string, unknown>;
  if (enable !== undefined && enable !== null && typeof enable !== "boolean") throw new TypeError($t("auto-group-card.text_b0f9d8a5ca"));
  const expression = cron ? (typeof cron === "string" ? cron.trim().replace(/\s+/gu, " ") : "") : defaultCron;
  if (![5, 6].includes(expression.split(" ").length)) throw new TypeError($t("auto-group-card.text_809ea92463"));
  if (nickname !== undefined && nickname !== null && nickname !== "" && !cardPart(nickname)) {
    throw new TypeError($t("auto-group-card.text_7b24c209e2"));
  }
  if (notGroup != null && !Array.isArray(notGroup)) throw new TypeError($t("auto-group-card.text_d78a288233"));
  if (suffixes != null && !Array.isArray(suffixes)) throw new TypeError($t("auto-group-card.text_37bdf5f936"));
  return {
    enabled: enable === true, cron: expression, nickname: cardPart(nickname),
    notGroup: new Set((notGroup as unknown[] | undefined)?.map(groupId)),
    suffixes: suffixes === undefined ? originalSuffixes : (suffixes as unknown[] | null)?.map((value) => {
      const text = cardPart(value);
      if (!text) throw new TypeError($t("auto-group-card.text_1abc3171cd"));
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
      return $t("auto-group-card.text_fbd33cf343", { "updated": updated, "unchanged": unchanged, "failed": failed, "unknown": unknown }) +
        (unavailableAccounts ? $t("auto-group-card.text_2152e8e729", { "unavailableAccounts": unavailableAccounts }) : "。");
    }
    case "disabled": return $t("auto-group-card.text_d21763c792");
    case "missing-template": return $t("auto-group-card.text_80d0539a8a");
    case "invalid-config": return $t("auto-group-card.text_f5baa309c3");
    case "no-accounts": return $t("auto-group-card.text_f240b8b322");
    case "busy": return $t("auto-group-card.text_6ca25c7ddf");
    case "stopped": return $t("auto-group-card.text_328c8c4b27");
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
      if (context.isDelegated || (!context.isMaster && !context.ownGroupCardAccount)) return $t("auto-group-card.text_d46f6afc9a");
      if (argument) return $t("auto-group-card.text_d04418da4d");
      const { ownGroupCardAccount } = context;
      if (context.message_type === "terminal" || !ownGroupCardAccount || ownGroupCardAccount.signal.aborted) {
        return $t("auto-group-card.text_cadd3c025e");
      }
      return describe(await run(() => [ownGroupCardAccount]));
    },
    async scheduled(): Promise<AutoGroupCardSummary | undefined> {
      const result = await run(accounts);
      if (result.status === "complete") return result.summary;
    },
  };
}
