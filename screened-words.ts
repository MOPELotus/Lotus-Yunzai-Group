import { link, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";

export const groupScreenedWordsFeature = "[group] 屏蔽词";
const listCommand = /^#*屏蔽词列表/u;
const addCommand = /^#*屏蔽(本群|全局)?([\s\S]*)$/u;
const removeCommand = /^#*(?:解除|删除|取消|不)屏蔽(本群|全局)?([\s\S]*)$/u;
const toggleCommand = /^#抽卡设置\s*(?:违禁词|屏蔽词)\s*(开启|关闭)$/u;
const defaults = { enable: false, time: 60, replyText: "检测到违规词汇，已经制裁" };
export const screenedWordLimits = { bytes: 512 * 1024, files: 240, words: 4096 } as const;
const { bytes: maxBytes, files: maxFiles, words: maxWords } = screenedWordLimits;
const maxLength = 512;
const unavailable = "屏蔽词配置暂不可用。";
const controls = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

type LockFile = (file: string, subject: string) => Promise<{ close(): void }>;
type Settings = typeof defaults;
type Reply = string | readonly [] | { readonly type: "forward"; readonly nodes: readonly (readonly string[])[] };

export interface ScreenedWordsContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_id?: number | string;
  readonly adapter?: "milky" | "onebot";
  readonly isDelegated?: boolean;
  readonly groupActivitySignal?: AbortSignal;
  readonly privateCredentialSignal?: AbortSignal;
  readonly groupManageBlacklist?: () => Promise<boolean>;
  readonly isBotMaster: (user: number) => boolean;
  readonly normalizedMessage: string;
}

export function isGroupScreenedWordsCommand(command: string): boolean {
  return listCommand.test(command) || removeCommand.test(command) || addCommand.test(command) || toggleCommand.test(command);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function word(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxLength && !!value.trim() && value.isWellFormed() && !controls.test(value);
}

async function readYaml(path: string) {
  try {
    const file = Bun.file(path);
    if (!await file.exists()) return;
    if (file.size > maxBytes) throw new Error("屏蔽词文件超出上限。");
    const source = await file.text();
    if (Buffer.byteLength(source) > maxBytes) throw new Error("屏蔽词文件超出上限。");
    return { source, data: Bun.YAML.parse(source) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function settingsObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("屏蔽词配置格式无效。");
  return value as Record<string, unknown>;
}

export function readScreenedWordSettings(settings: Record<string, unknown>): Settings {
  const effective: Record<string, unknown> = { ...defaults, ...settings };
  const { enable, time, replyText } = effective;
  const enabled = enable === true || enable === 1 || enable === "1" || enable === "true";
  const seconds = typeof time === "number" || typeof time === "string" && /^\d+$/u.test(time) ? Number(time) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2_147_483_647 || typeof replyText !== "string" ||
      replyText.length > 2048 || !replyText.isWellFormed()) throw new Error("屏蔽词设置无效。");
  return { enable: enabled, time: seconds, replyText };
}

export function readScreenedWordList(value: unknown, legacy = false): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxWords) throw new Error("屏蔽词词表无效。");
  if (!legacy && !value.every(word)) throw new Error("屏蔽词词表无效。");
  const strings = legacy ? value.map(item => item === true || typeof item === "number" && Number.isFinite(item) && item !== 0 ? String(item) : item) : value;
  return [...new Set(strings.filter(word))];
}

function listReply(local: readonly string[], global: readonly string[]): Reply {
  const nodes: string[][] = [];
  for (const [name, words] of [["本群", local], ["全局", global]] as const) {
    nodes.push([`${name}屏蔽词如下，共 ${words.length} 个`]);
    const shown = words.slice(0, 600);
    for (let i = 0; i < shown.length; i += 25) {
      nodes.push([shown.slice(i, i + 25).map((text, offset) => `${i + offset + 1}、【${text}】`).join("\n")]);
    }
    if (shown.length < words.length) nodes.push([`${name}剩余 ${words.length - shown.length} 个词未展示。`]);
  }
  return { type: "forward", nodes };
}

export function createGroupScreenedWords(root: URL, lockFile: LockFile, signal: AbortSignal) {
  const configFile = fileURLToPath(new URL("config/group-screened-words.yaml", root));
  const directory = fileURLToPath(new URL("data/group/screened-words/", root));
  const legacy = fileURLToPath(new URL("plugins/flower-plugin/", root));
  const seen = new Set<string>();

  async function settings() {
    const [bundled, user, current] = await Promise.all([
      readYaml(join(legacy, "defSet/wordListener.yaml")), readYaml(join(legacy, "config/wordListener.yaml")), readYaml(configFile),
    ]);
    const effective = { ...defaults, ...settingsObject(bundled?.data), ...settingsObject(user?.data), ...settingsObject(current?.data) };
    return { current, effective, values: readScreenedWordSettings(effective) };
  }

  async function scopeWords(scope: string) {
    const current = await readYaml(join(directory, `${scope}.yaml`));
    if (current) return { current, words: readScreenedWordList(current.data) };
    const folder = join(legacy, "resources/blackword", scope);
    const entries = await readdir(folder, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".yaml")).map(entry => entry.name).sort().reverse();
    if (files.length > maxFiles) throw new Error("屏蔽词文件超出上限。");
    const words = new Set<string>();
    let bytes = 0;
    for (const file of files) {
      const loaded = await readYaml(join(folder, file));
      bytes += Buffer.byteLength(loaded?.source ?? "");
      if (bytes > maxBytes) throw new Error("屏蔽词文件超出上限。");
      for (const text of readScreenedWordList(loaded?.data, true)) words.add(text);
      if (words.size > maxWords) throw new Error("屏蔽词数量超出上限。");
    }
    return { current, words: [...words] };
  }

  async function save(path: string, before: string | undefined, contents: string, authorized: () => Promise<boolean>, unchanged: () => Promise<boolean>) {
    if (Buffer.byteLength(contents) > maxBytes) throw new Error("屏蔽词文件超出上限。");
    const staging = await mkdtemp(join(dirname(path), ".screened-words-"));
    try {
      const temporary = join(staging, "settings.yaml");
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      if (!await authorized()) return false;
      if (!await unchanged()) throw new Error("屏蔽词配置正由其他程序修改。");
      signal.throwIfAborted();
      if (before === undefined) await link(temporary, path);
      else await rename(temporary, path);
      return true;
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }

  function claim(context: ScreenedWordsContext) {
    const { message_id, self_id, user_id, group_id, adapter } = context;
    if (!(typeof message_id === "number" && Number.isSafeInteger(message_id)) &&
        !(typeof message_id === "string" && message_id.length > 0 && message_id.length <= 128)) return false;
    const key = JSON.stringify([adapter ?? "onebot", self_id, user_id, group_id, String(message_id)]);
    if (seen.has(key)) return false;
    if (seen.size >= 2048) seen.delete(seen.values().next().value!);
    seen.add(key);
    return true;
  }

  async function command(context: ScreenedWordsContext): Promise<Reply | undefined> {
    const message = context.normalizedMessage.trim();
    const { group_id, user_id, self_id } = context;
    if (context.isDelegated || signal.aborted || !positiveId(self_id) || !positiveId(user_id)) return;
    const toggle = toggleCommand.exec(message);
    const session = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal;
    const active = () => !signal.aborted && !!session && !session.aborted;
    const master = () => context.isBotMaster(user_id);
    if (!active()) return;
    try {
      if (toggle) {
        const authorized = async () => active() && master();
        if (!await authorized()) return "仅当前机器人的主人可以设置屏蔽词监听。";
        if (!claim(context)) return [];
        const enable = toggle[1] === "开启";
        await mkdir(dirname(configFile), { recursive: true });
        const lock = await lockFile(configFile + ".sqlite", "屏蔽词设置");
        try {
          const { current, effective, values } = await settings();
          if (values.enable === enable) return `屏蔽词监听已处于${toggle[1]}状态。`;
          const document = parseDocument(current?.source ?? stringify(effective));
          document.set("enable", enable);
          const saved = await save(configFile, current?.source, document.toString(), authorized, async () => {
            const latest = await settings();
            return active() && master() && latest.current?.source === current?.source && JSON.stringify(latest.effective) === JSON.stringify(effective);
          });
          return saved ? `已${toggle[1]}屏蔽词监听。` : "仅当前机器人的主人可以设置屏蔽词监听。";
        } finally { lock.close(); }
      }
      if (context.message_type !== "group" || !positiveId(group_id)) return;
      if (!(await settings()).values.enable) return "屏蔽词监听当前关闭。";
      if (listCommand.test(message)) {
        const [local, global] = await Promise.all([scopeWords(String(group_id)), scopeWords("global")]);
        if (active()) return listReply(local.words, global.words);
        return;
      }
      const removal = removeCommand.exec(message);
      const match = removal ?? addCommand.exec(message);
      if (!match) return;
      const requested = [...new Set((match[2] ?? "").trim().split(/[,，]/u))];
      if (requested.length > 32 || !requested.every(word)) return "请填写有效屏蔽词，多个词用逗号分隔。";
      const scope = master() && match[1] !== "本群" ? "global" : String(group_id);
      const label = scope === "global" ? "全局" : "本群";
      const authorized = async () => active() && (scope !== "global" || master()) &&
        await context.groupManageBlacklist?.() === true && active() && (scope !== "global" || master());
      const denied = `当前会话没有编辑${label}屏蔽词的权限。`;
      if (!await authorized()) return denied;
      if (!claim(context)) return [];
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${scope}.yaml`);
      const lock = await lockFile(path + ".sqlite", "屏蔽词词表");
      try {
        const { current, words } = await scopeWords(scope);
        const present = new Set(words);
        const changed = requested.filter(text => present.has(text) === !!removal);
        const unchanged = requested.filter(text => present.has(text) !== !!removal);
        if (changed.length) {
          const next = removal ? words.filter(text => !changed.includes(text)) : [...words, ...changed];
          if (next.length > maxWords) return `${label}屏蔽词已达上限。`;
          const saved = await save(path, current?.source, stringify(next), authorized, async () => {
            const latest = await scopeWords(scope);
            return latest.current?.source === current?.source && JSON.stringify(latest.words) === JSON.stringify(words) &&
              (await settings()).values.enable && active() && (scope !== "global" || master());
          });
          if (!saved) return denied;
        }
        return [...(changed.length ? [`${removal ? "删除" : "新增"}${label}屏蔽词：【${changed.join("】【")}】`] : []),
          ...(unchanged.length ? [`词语【${unchanged.join("】【")}】${removal ? "尚未被屏蔽" : "已经被屏蔽"}`] : [])].join("\n");
      } finally { lock.close(); }
    } catch { return active() ? unavailable : undefined; }
  }

  async function match(group: number, text: string, active: AbortSignal) {
    if (active.aborted || !text || text.length > 4096 || removeCommand.test(text.trim()) || listCommand.test(text.trim())) return;
    const values = (await settings()).values;
    if (!values.enable || active.aborted) return;
    const [global, local] = await Promise.all([scopeWords("global"), scopeWords(String(group))]);
    if (active.aborted) return;
    // Older monthly files were prepended on each read, and local words preceded global words.
    const found = local.words.find(word => text.includes(word)) ?? global.words.find(word => text.includes(word));
    if (!found) return;
    const letters = [...found];
    return { action: "mute-recall" as const, seconds: values.time, screenedReply: values.replyText,
      preview: letters.slice(0, 2).join("") + "*".repeat(Math.max(0, letters.length - 2)) };
  }

  return { command, match };
}
