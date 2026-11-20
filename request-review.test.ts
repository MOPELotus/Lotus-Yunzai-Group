import { expect, test } from "bun:test";
import { createGroupRequestReview, type GroupRequestEvent } from "./request-review.ts";

const request = { self_id: 1, group_id: 30, user_id: 42, sub_type: "add" as const, flag: "opaque-add" };
const owner = { message_type: "private" as const, self_id: 1, user_id: 7, isMaster: true };

function visibleId(text: string): string {
  const id = /#同意入群 ([a-f0-9]{12})/u.exec(text)?.[1];
  if (!id) throw new Error("通知没有审核编号。");
  return id;
}

test("普通申请和邀请待人工处理，主人收到编号和说明，flag 不会披露", async () => {
  const review = createGroupRequestReview();
  const notices: string[] = [];
  const notifyMasters = async (message: string) => { notices.push(message); return 1; };
  const event: GroupRequestEvent = { ...request, comment: " 欢迎\n验证 ", notifyMasters };
  await Promise.all([review.receive(event), review.receive(event)]);
  await review.receive({ ...event, sub_type: "invite", flag: "opaque-invite" });
  await review.receive({ ...event, user_id: event.self_id, flag: "ignore-self" });

  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain("成员申请入群 · 群 30 · 申请人 42");
  expect(notices[0]).toContain("附言：欢迎 验证");
  expect(notices[1]).toContain("邀请机器人加入群聊 · 群 30 · 邀请者 42");

  const list = review.commands["#入群申请"]("", owner);
  expect(list).toContain(visibleId(notices[0]!));
  expect(list).toContain(visibleId(notices[1]!));
  for (const reply of [...notices, list]) expect(reply).not.toContain("opaque-");

  await review.receive({
    ...event, self_id: 2, flag: "notify-failed",
    notifyMasters: async () => { throw new Error("私聊未送达"); },
  });
  expect(review.commands["#入群申请"]("", { ...owner, self_id: 2 })).toContain("成员申请入群");
});

test("群内和非主人不能审核，其他机器人的主人不能使用本请求编号", async () => {
  const review = createGroupRequestReview();
  let id = "";
  await review.receive({
    ...request,
    notifyMasters: async (message) => { id = visibleId(message); return 1; },
  });

  const calls: unknown[][] = [];
  const reviewGroupRequest = async (...args: unknown[]) => { calls.push(args); return true; };
  for (const context of [{ ...owner, isMaster: false }, { ...owner, message_type: "group" as const }]) {
    expect(review.commands["#入群申请"]("", context)).toContain("主人私聊");
    expect(await review.commands["#同意入群"](id, { ...context, reviewGroupRequest })).toContain("主人私聊");
  }
  const otherBot = { ...owner, self_id: 2, reviewGroupRequest };
  expect(review.commands["#入群申请"]("", otherBot)).toContain("没有待审核");
  expect(await review.commands["#同意入群"](id, otherBot)).toContain("未找到");
  expect(await review.commands["#拒绝入群"](request.flag, { ...owner, reviewGroupRequest })).toContain("用法");
  expect(await review.commands["#同意入群"](id, owner)).toContain("协议端不支持");
  expect(calls).toHaveLength(0);
});

test("审核使用当前连接，按响应区分明确拒绝、结果未知和已处理", async () => {
  const review = createGroupRequestReview();
  let id = "";
  let notifications = 0;
  const event = {
    ...request, sub_type: "invite" as const,
    notifyMasters: async (message: string) => { id = visibleId(message); notifications++; return 1; },
  };
  await review.receive(event);
  expect(await review.commands["#拒绝入群"](`${id} 原因`, {
    ...owner, reviewGroupRequest: async () => false,
  })).toContain("仍待审核");
  expect(await review.commands["#同意入群"](id, {
    ...owner, reviewGroupRequest: async () => { throw new Error("连接断开"); },
  })).toContain("结果未确认");
  expect(review.commands["#入群申请"]("", owner)).toContain(id);

  const result = Promise.withResolvers<boolean>();
  const calls: unknown[][] = [];
  const current = {
    ...owner,
    reviewGroupRequest: (...args: unknown[]) => { calls.push(args); return result.promise; },
  };
  const processing = review.commands["#拒绝入群"](`${id.toUpperCase()} 验证信息不足`, current);
  expect(await review.commands["#同意入群"](id, current)).toContain("正在处理");
  expect(calls).toEqual([["opaque-add", "invite", false, "验证信息不足"]]);
  result.resolve(true);
  expect(await processing).toBe("已拒绝群请求。");
  expect(review.commands["#入群申请"]("", owner)).toContain("没有待审核");
  await review.receive({ ...event, comment: "重发" });
  expect(notifications).toBe(1);
});

test("Milky 和 OneBot 的同账号同 flag 请求分别通知和审核", async () => {
  const review = createGroupRequestReview();
  const notices: string[] = [];
  const notifyMasters = async (message: string) => { notices.push(message); return 1; };
  const milky = { ...request, groupRequestScope: "milky" as const, inviter_id: 51, notifyMasters };
  await review.receive({ ...request, notifyMasters });
  await review.receive(milky);
  await review.receive(milky);
  expect(notices).toHaveLength(2);
  const [oneBotId, milkyId] = notices.map(visibleId);
  expect(milkyId).not.toBe(oneBotId);
  expect(notices[1]).toContain("成员申请入群 · 群 30 · 申请人 42 · 邀请者 51");
  expect(notices[1]).not.toContain(milky.flag);

  const calls: unknown[][] = [];
  const reviewGroupRequest = async (...args: unknown[]) => { calls.push(args); return true; };
  const oneBotContext = { ...owner, reviewGroupRequest };
  const milkyContext = { ...oneBotContext, isMaster: false, groupRequestScope: "milky" as const, canReviewGroupRequests: true };
  const oneBotList = review.commands["#入群申请"]("", oneBotContext);
  const milkyList = review.commands["#入群申请"]("", milkyContext);
  expect(oneBotList).toContain(oneBotId!);
  expect(oneBotList).not.toContain(milkyId!);
  expect(milkyList).toContain(milkyId!);
  expect(milkyList).not.toContain(oneBotId!);
  expect(await review.commands["#同意入群"](milkyId!, oneBotContext)).toContain("未找到");
  expect(await review.commands["#同意入群"](oneBotId!, milkyContext)).toContain("未找到");
  expect(calls).toEqual([]);

  expect(await review.commands["#同意入群"](milkyId!, milkyContext)).toBe("已同意群请求。");
  await review.receive(milky);
  expect(notices).toHaveLength(2);
  expect(review.commands["#入群申请"]("", milkyContext)).toContain("没有待审核");
  expect(review.commands["#入群申请"]("", oneBotContext)).toContain(oneBotId!);
  expect(calls).toEqual([[milky.flag, "add", true, undefined]]);
});

test("Milky 审核需要私聊专用权限，明确拒绝和未知回执保留请求", async () => {
  const review = createGroupRequestReview();
  const scope = "milky" as const;
  let id = "";
  await review.receive({
    ...request, groupRequestScope: scope,
    notifyMasters: async (message) => { id = visibleId(message); return 1; },
  });
  const capable = { ...owner, groupRequestScope: scope, canReviewGroupRequests: true };
  for (const context of [
    { ...capable, canReviewGroupRequests: undefined }, { ...capable, canReviewGroupRequests: false },
    { ...capable, message_type: "group" as const }, { ...capable, message_type: "terminal" as const },
    { ...capable, groupRequestScope: undefined, isMaster: false },
  ]) {
    expect(review.commands["#入群申请"]("", context)).toContain("主人私聊");
    expect(await review.commands["#同意入群"](id, context)).toContain("主人私聊");
  }
  expect(await review.commands["#拒绝入群"](`${id} 拒绝理由`, {
    ...capable, reviewGroupRequest: async () => false,
  })).toContain("仍待审核");
  expect(await review.commands["#同意入群"](id, {
    ...capable, reviewGroupRequest: async () => { throw new Error("测试连接断开"); },
  })).toContain("结果未确认");
  expect(review.commands["#入群申请"]("", capable)).toContain(id);
});

test("Milky 群邀请优先发可追踪主人通知并保留编号，其他请求不提示引用审核", async () => {
  const review = createGroupRequestReview();
  const messages: string[] = [];
  let legacyCalls = 0;
  const notifyRequestOwners = async (message: string) => { messages.push(message); return 1; };
  const notifyMasters = async () => { legacyCalls++; return 1; };
  await review.receive({ ...request, groupRequestScope: "milky", sub_type: "invite", flag: "quote-invite", notifyRequestOwners, notifyMasters });
  await review.receive({ ...request, groupRequestScope: "milky", notifyRequestOwners, notifyMasters });
  await review.receive({ ...request, sub_type: "invite", flag: "legacy", notifyMasters });
  expect(messages).toHaveLength(2);
  expect(visibleId(messages[0]!)).toHaveLength(12);
  expect(messages[0]).toContain("引用此通知回复「同意」或「拒绝」");
  expect(messages[0]).not.toContain("quote-invite");
  expect(messages[1]).not.toContain("引用此通知");
  expect(legacyCalls).toBe(1);
});
