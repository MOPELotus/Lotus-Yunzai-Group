import { createAutoRepeat, type AutoRepeatEvent, type AutoRepeatOptions } from "./auto-repeat.ts";
import { changeGroupCard, type CardEvent } from "./group-card.ts";
import { announceDeparture, welcomeMember, type GroupMemberNotice } from "./member-notices.ts";
import { groupRequestReview, type GroupRequestEvent } from "./request-review.ts";
import { startRepeat, continueRepeat } from "./repeat.ts";

export function groupRuntimeEvents({ sessionSignal, ...options }: AutoRepeatOptions & {
  readonly sessionSignal?: (event: unknown) => AbortSignal | undefined;
}) {
  const observeRepeat = createAutoRepeat(options);
  return [
    {
      name: "主动复读", event: "message", priority: 5000, continue: continueRepeat,
      rule: { pattern: /^#复读$/u, permission: "master", run: startRepeat },
    },
    {
      name: "欢迎新人", event: "notice.group.increase", priority: 5000,
      async observe(event: GroupMemberNotice) { await welcomeMember(event); },
    },
    {
      name: "退群通知", event: "notice.group.decrease", priority: 5000,
      async observe(event: GroupMemberNotice) { await announceDeparture(event); },
    },
    {
      name: "群请求审核", event: "request.group", priority: 5000,
      async observe(event: GroupRequestEvent & { deferManualReview?: (review: () => Promise<void>) => void }) {
        const receive = () => groupRequestReview.receive(event);
        if (event.deferManualReview) event.deferManualReview(receive);
        else await receive();
      },
    },
    {
      name: "[group] 群名片", event: "message", priority: 1000,
      rule: { pattern: /^#改群名片/u, async run(event: CardEvent & { reply: (message: string) => unknown }) {
        await event.reply(await changeGroupCard(event));
        return true;
      } },
    },
    {
      name: "自动复读", event: "message.group", priority: -10_000,
      async observe(event: AutoRepeatEvent) { await observeRepeat(event, sessionSignal?.(event)); },
    },
  ];
}
