import group, { createGroupPlugin } from "./likes.ts";
import { GroupDeparture, GroupNewcomer } from "./member-notices-v3.js";
import { apps as repeat } from "./repeat.js";
import { groupRequestReview } from "./request-review.ts";
import { ReviewGroupRequest } from "./request-review-v3.js";
import { GroupCard } from "./group-card-v3.js";
import { createAutoGroupCard, type AutoGroupCardSummary, type OwnGroupCardAccount } from "./auto-group-card.ts";

export { createGroupPlugin };
export type { AutoGroupCardContext, AutoGroupCardSummary, OwnGroupCardAccount, OwnGroupCardResult } from "./auto-group-card.ts";
export const apps = { ...repeat, GroupNewcomer, GroupDeparture, ReviewGroupRequest, GroupCard };
const manifest = { ...group, commands: { ...group.commands, ...groupRequestReview.commands } };
export default manifest;

export async function createModule({ signal, ownGroupCardAccounts, registerAutoGroupCardTask }: {
  readonly signal: AbortSignal;
  readonly ownGroupCardAccounts?: () => readonly OwnGroupCardAccount[];
  readonly registerAutoGroupCardTask?: (cron: string, run: () => Promise<AutoGroupCardSummary | undefined>) => (() => void | Promise<void>);
}) {
  const updater = createAutoGroupCard({ signal, accounts: ownGroupCardAccounts ?? (() => []) });
  let stopTask: (() => void | Promise<void>) | undefined;
  if (registerAutoGroupCardTask) {
    try {
      const configuration = await updater.configuration();
      if (configuration && !signal.aborted) stopTask = registerAutoGroupCardTask(configuration.cron, updater.scheduled);
    } catch {
      console.warn("[group] 自动群名片配置无效，未启动定时更新。");
    }
  }
  return {
    ...manifest,
    commands: { ...manifest.commands, "#更新群名片": updater.command },
    dispose: stopTask,
  };
}
