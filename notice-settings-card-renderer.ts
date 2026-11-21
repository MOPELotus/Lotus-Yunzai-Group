import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { renderPng } from "@lotus-yunzai/skia";
import { FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import type { NoticeSettingsCardModel, NoticeSettingsCardRenderer, NoticeSettingsCardRow } from "./notice-settings-card-model.ts";

const width = 800;
const scale = 4;
// Skia filters and shadow distances use device pixels. Keep their former logical sizes.
const effectScale = scale / 1.4;
type Mode = Parameters<typeof renderPng>[3];

interface Theme {
  readonly background: Image;
  readonly body: string;
  readonly title: string;
}

async function asset(root: string, path: string): Promise<string | undefined> {
  try {
    const file = await realpath(join(root, path));
    const entry = relative(root, file);
    if (!entry || entry === ".." || entry.startsWith(".." + sep) || isAbsolute(entry)) return;
    const info = await stat(file);
    if (info.isFile() && info.size > 0 && info.size <= 24 * 1024 ** 2) return file;
  } catch { return; }
}

function registerFont(file: string): string {
  const family = "Lotus Notice " + createHash("sha256").update(file).digest("hex").slice(0, 16);
  if (!FontLibrary.has(family)) FontLibrary.use(family, file);
  if (!FontLibrary.has(family)) throw new Error("旧通知设置字体不可用。");
  return `"${family}", "Noto Sans CJK SC", sans-serif`;
}

export async function loadNoticeSettingsCardTheme(directory: string): Promise<Theme | undefined> {
  const root = await realpath(directory).catch(() => undefined);
  if (!root) return;
  for (const theme of [root, join(root, "resources")]) {
    const folder = await realpath(theme).catch(() => undefined);
    if (folder !== theme) continue;
    const [background, body, title] = await Promise.all([
      asset(theme, "admin/imgs/bg/default.jpg"),
      asset(theme, "common/font/FZB.ttf"),
      asset(theme, "common/font/NZBZ.ttf"),
    ]);
    if (background && body && title) {
      return {
        background: await loadImage(await readFile(background)), body: registerFont(body), title: registerFont(title),
      };
    }
  }
}

export function createNoticeSettingsCardRenderer({ resourceDirectory, mode }: {
  readonly resourceDirectory: string;
  readonly mode?: Mode;
}): NoticeSettingsCardRenderer {
  return createAdminSettingsCardRenderer({ resourceDirectories: [resourceDirectory], mode });
}

export function createAdminSettingsCardRenderer({ resourceDirectories, mode, label = "#通知设置" }: {
  readonly resourceDirectories: readonly string[];
  readonly mode?: Mode;
  readonly label?: "#设置" | "#通知设置";
}): NoticeSettingsCardRenderer {
  async function findTheme() {
    for (const directory of resourceDirectories) {
      const loaded = await loadNoticeSettingsCardTheme(directory).catch(() => undefined);
      if (loaded) return loaded;
    }
  }

  let theme: Promise<Theme | undefined> | undefined;
  return async (model, signal) => {
    if (signal?.aborted) return;
    theme ??= findTheme();
    const loaded = await theme;
    if (!loaded && !signal?.aborted) theme = undefined;
    if (!loaded || signal?.aborted) return;
    const { png, engine } = await renderNoticeSettingsCard(model, loaded, mode, label);
    if (!signal?.aborted) {
      if (label === "#设置") console.log(`[渲染] 设置 ${engine.renderer} ${engine.api} ${engine.device}`);
      return png;
    }
  };
}

function rounded(ctx: Context, x: number, y: number, w: number, h: number, radius: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function background(ctx: Context, image: Image, height: number) {
  const ratio = Math.max(width / image.width, height / image.height);
  const imageWidth = image.width * ratio;
  ctx.drawImage(image, (width - imageWidth) / 2, 0, imageWidth, image.height * ratio);
}

function section(ctx: Context, theme: Theme, height: number, top: number, h: number, override: boolean) {
  ctx.save();
  rounded(ctx, 15, top, 770, h, 26);
  ctx.shadowOffsetY = 8 * effectScale;
  ctx.shadowBlur = 32 * effectScale;
  ctx.shadowColor = "rgba(51,51,52,0.50)";
  ctx.fillStyle = "white";
  ctx.fill();
  ctx.restore();

  ctx.save();
  rounded(ctx, 15, top, 770, h, 26);
  ctx.clip();
  ctx.filter = `blur(${18 * effectScale}px)`;
  background(ctx, theme.background, height);
  ctx.filter = "none";
  ctx.fillStyle = "rgba(255,255,255,0.30)";
  ctx.fillRect(15, top, 770, h);
  const light = ctx.createLinearGradient(15, top, 785, top + h);
  light.addColorStop(0, "rgba(255,255,255,0.30)");
  light.addColorStop(0.33, "rgba(255,255,255,0.08)");
  light.addColorStop(1, "rgba(255,255,255,0.24)");
  ctx.fillStyle = light;
  ctx.fillRect(15, top, 770, h);
  ctx.filter = `blur(${10 * effectScale}px)`;
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 13;
  ctx.stroke();
  ctx.restore();

  if (override) {
    ctx.save();
    rounded(ctx, 17, top + 2, 766, h - 4, 24);
    ctx.setLineDash([7, 4]);
    ctx.strokeStyle = "#454444";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }
}

function text(ctx: Context, value: string, x: number, y: number, font: string, color: string, maxWidth?: number) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y, maxWidth);
  // The original FZB asset only has a regular face; Chromium synthesizes the bold weight.
  if (font.startsWith("700 ")) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.55;
    ctx.strokeText(value, x, y, maxWidth);
  }
}

function statusValueFont(ctx: Context, value: string, family: string): string {
  for (let size = 20; size > 1; size--) {
    const font = `700 ${size}px ${family}`;
    ctx.font = font;
    const measured = ctx.measureText(value);
    // Leave the 160 px column's inner padding and room for the synthetic bold stroke.
    if (Math.max(measured.width, 2 * measured.actualBoundingBoxLeft, 2 * measured.actualBoundingBoxRight) <= 149) return font;
  }
  return `700 1px ${family}`;
}

function descriptionHeight(row: NoticeSettingsCardRow, first: boolean): number {
  if (!row.description) return 0;
  return first && (row.label === "好友消息" || row.label === "通知全部主人") ? 29 : 26;
}

export async function renderNoticeSettingsCard(model: NoticeSettingsCardModel, theme: Theme, mode: Mode = "gpu",
  label = "#通知设置") {
  const groups = model.groups.map(({ title, rows, override }) => ({
    title, rows, override: override === true,
    height: (override ? 70 : 59) + rows.reduce((total, row, i) => total + 47 + descriptionHeight(row, i === 0), 0),
  }));
  const height = 219 + groups.reduce((total, group) => total + group.height + 20, 0);

  return renderPng(Math.round(width * scale), Math.round(height * scale), ctx => {
    ctx.scale(scale, scale);
    ctx.fillStyle = "#000144";
    ctx.fillRect(0, 0, width, height);
    background(ctx, theme.background, height);

    ctx.save();
    ctx.shadowOffsetX = 1 * effectScale;
    ctx.shadowOffsetY = 1 * effectScale;
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3 * effectScale;
    text(ctx, label, 35, 47, `16px ${theme.body}`, "#fff");
    text(ctx, "Lotus-Yunzai 管理面板", 35, 80, `36px ${theme.title}`, "#fff", 700);
    ctx.restore();

    let y = 179;
    for (const group of groups) {
      const border = group.override ? 4 : 0;
      const x = 30 + border;
      const lineWidth = 740 - 2 * border;
      section(ctx, theme, height, y, group.height, group.override);
      const headingFont = `700 22px ${theme.body}`;
      text(ctx, group.title, x + 21, y + border + 40, headingFont, "#252525", lineWidth - 40);
      text(ctx, group.title, x + 20, y + border + 39, headingFont, "#f9b3c6", lineWidth - 40);
      let top = y + (group.override ? 61 : 54);
      for (const [index, row] of group.rows.entries()) {
        ctx.save();
        rounded(ctx, x, top, lineWidth, 37, [5, 20, 5, 20]);
        ctx.shadowOffsetY = 1 * effectScale;
        ctx.shadowBlur = 2 * effectScale;
        ctx.shadowColor = "rgba(0,0,0,0.50)";
        const gradient = ctx.createLinearGradient(x, 0, x + lineWidth, 0);
        gradient.addColorStop(0, "#fceae7");
        gradient.addColorStop(0.40, "#fceae7");
        gradient.addColorStop(0.65, "#fbf3f1");
        gradient.addColorStop(1, "#ffd5e0");
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.restore();

        text(ctx, row.label, x + 20, top + 26, `700 18px ${theme.body}`, "#303030");
        if (row.hint) {
          const hintX = x + 20 + ctx.measureText(row.label).width + 4;
          text(ctx, row.hint, hintX, top + 26, `16px ${theme.body}`, "#303030", x + lineWidth - 170 - hintX);
        }
        ctx.textAlign = "center";
        const valueFont = statusValueFont(ctx, row.value, theme.body);
        text(ctx, row.value, x + lineWidth - 80, top + 26, valueFont, row.off ? "#b74545" : "#2d5285");
        ctx.textAlign = "start";
        if (row.description) {
          text(ctx, row.description, x + 20, top + 62, `16px ${theme.body}`, "#454444", lineWidth - 40);
        }
        top += 47 + descriptionHeight(row, index === 0);
      }
      y += group.height + 20;
    }

    ctx.textAlign = "center";
    ctx.shadowOffsetX = 1 * effectScale;
    ctx.shadowOffsetY = 1 * effectScale;
    ctx.shadowColor = "#000";
    text(ctx, "Created By Lotus-Yunzai", width / 2 + 5, y + 16, `14px ${theme.body}`, "#fff");
  }, mode);
}
