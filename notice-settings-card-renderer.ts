import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { drawInfoText, infoCardColors as colors, measureInfoText, renderInfoCard, type InfoCardOptions } from "@lotus-yunzai/skia/info-card";
import type { NoticeSettingsCardModel, NoticeSettingsCardRenderer } from "./notice-settings-card-model.ts";

type Mode = InfoCardOptions["mode"];
type Label = "#设置" | "#通知设置";

export function createNoticeSettingsCardRenderer({ resourceDirectory, mode }: {
  readonly resourceDirectory?: string;
  readonly mode?: Mode;
} = {}): NoticeSettingsCardRenderer {
  return createAdminSettingsCardRenderer({ resourceDirectories: resourceDirectory ? [resourceDirectory] : undefined, mode });
}

async function readThemeAvailability(resourceDirectories: readonly string[]) {
  for (const directory of resourceDirectories) {
    const root = await realpath(directory).catch(() => undefined);
    if (!root) continue;
    for (const theme of [root, join(root, "resources")]) {
      if (await realpath(theme).catch(() => undefined) !== theme) continue;
      const available = await Promise.all(["admin/imgs/bg/default.jpg", "common/font/FZB.ttf", "common/font/NZBZ.ttf"]
        .map(async entry => {
          const path = await realpath(join(theme, entry)).catch(() => undefined);
          if (!path) return false;
          const inside = relative(theme, path);
          if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) return false;
          const info = await stat(path).catch(() => undefined);
          return !!info?.isFile() && info.size > 0 && info.size <= 24 * 1024 ** 2;
        }));
      if (available.every(Boolean)) return true;
    }
  }
  return false;
}

export function createAdminSettingsCardRenderer({ resourceDirectories = [], mode, label = "#通知设置" }: {
  readonly resourceDirectories?: readonly string[];
  readonly mode?: Mode;
  readonly label?: Label;
} = {}): NoticeSettingsCardRenderer {
  let theme: Promise<boolean> | undefined;
  return async (model, signal) => {
    if (signal?.aborted) return;
    theme ??= readThemeAvailability(resourceDirectories);
    if (!await theme || signal?.aborted) return;
    const { png, engine } = await renderNoticeSettingsCard(model, mode, label);
    if (signal?.aborted) return;
    console.log(`[渲染] ${label.slice(1)} ${engine.renderer} ${engine.api} ${engine.device}`);
    return png;
  };
}

export function renderNoticeSettingsCard(model: NoticeSettingsCardModel, mode: Mode = "gpu", label: Label = "#通知设置") {
  return renderInfoCard({ title: label.slice(1), metadata: label === "#通知设置" ? "群管配置" : undefined, width: 800 }, ({ x, y, width, measure }) => {
    const valueWidth = 170;
    const leftWidth = width - valueWidth - 54;
    const groups = model.groups.map(({ title, rows, override }) => {
      const heading = measureInfoText(measure, title, width - 32, 24);
      const entries = rows.map(({ label, hint, description, value, off }) => {
        const labels = measureInfoText(measure, label, leftWidth, 20);
        const notes = [hint, description].filter((text): text is string => Boolean(text))
          .flatMap(text => measureInfoText(measure, text, leftWidth, 16));
        const values = measureInfoText(measure, value, valueWidth, 20);
        const height = 20 + Math.max(labels.length * 29 + notes.length * 23, values.length * 29);
        return { labels, notes, values, off, height };
      });
      return { heading, override, entries, height: 36 + heading.length * 34 + entries.reduce((sum, row) => sum + row.height, 0) };
    });

    return {
      height: groups.reduce((sum, group) => sum + group.height + 14, 0),
      draw(ctx) {
        let top = y;
        for (const group of groups) {
          ctx.fillStyle = colors.tile;
          ctx.beginPath();
          ctx.roundRect(x, top, width, group.height, 12);
          ctx.fill();
          if (group.override) {
            ctx.strokeStyle = colors.rule;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          drawInfoText(ctx, group.heading, x + 16, top + 12, { size: 24, leading: 34, color: colors.gold });
          let rowTop = top + 24 + group.heading.length * 34;
          for (const { labels, notes, values, off, height } of group.entries) {
            ctx.fillStyle = colors.rule;
            ctx.fillRect(x + 16, rowTop, width - 32, 1);
            drawInfoText(ctx, labels, x + 16, rowTop + 10, { size: 20, leading: 29 });
            drawInfoText(ctx, notes, x + 16, rowTop + 10 + labels.length * 29, { size: 16, leading: 23, color: colors.muted });
            drawInfoText(ctx, values, x + width - 16, rowTop + 10,
              { size: 20, leading: 29, color: off ? colors.muted : colors.gold, align: "right" });
            rowTop += height;
          }
          top += group.height + 14;
        }
      },
    };
  }, { mode });
}
