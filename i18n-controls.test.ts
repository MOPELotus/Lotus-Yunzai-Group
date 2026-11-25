import { expect, test } from "bun:test";
import { defaultLanguage, getLanguage, registerLanguage, setLanguage } from "../../packages/i18n/index.ts";
import { createFriendRequestReview } from "./friend-request-review.ts";
import { createGroupInvitationReview } from "./group-invitation-review.ts";
import { createGroupPendingJoinReview } from "./group-pending-join.ts";
import catalog from "./i18n/zh-CN.json";

async function isolated(name: string) {
  if (Bun.env.LOTUS_I18N_CONTROL_CHILD === name) return false;
  const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", name, import.meta.path], {
    env: { ...process.env, LOTUS_I18N_CONTROL_CHILD: name }, stdout: "pipe", stderr: "pipe",
  });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(output + errors);
  return true;
}

test("审核展示动词翻译不改变实际同意/拒绝参数", async () => {
  if (await isolated('审核展示动词翻译不改变实际同意/拒绝参数')) return;
  const previous = getLanguage();
  registerLanguage("en", { group: Object.fromEntries(Object.entries(catalog.messages).map(([key, value]) =>
    [key, value === "同意" ? "approve" : value === "拒绝" ? "reject" : value])) });
  const common = { adapter: "milky" as const, self_id: 99, user_id: 42, message_id: 1, isBotMaster: () => true };
  try {
    setLanguage("en");
    const calls: boolean[] = [];
    const result = async (_id: number, approve: boolean) => { calls.push(approve); return { status: "confirmed" as const }; };
    await createFriendRequestReview()("#同意好友申请51", { ...common, message_type: "private", reviewPendingFriendRequest: result });
    await createFriendRequestReview()("#拒绝好友申请51", { ...common, message_type: "private", reviewPendingFriendRequest: result });
    await createGroupInvitationReview()("#同意群邀请77", { ...common, message_type: "private", reviewPendingGroupInvitation: result });
    await createGroupInvitationReview()("#拒绝群邀请77", { ...common, message_type: "private", reviewPendingGroupInvitation: result });
    await createGroupPendingJoinReview()("#同意加群申请51", { ...common, message_type: "group", group_id: 77, groupReviewPendingJoin: result });
    await createGroupPendingJoinReview()("#拒绝加群申请51", { ...common, message_type: "group", group_id: 77, groupReviewPendingJoin: result });
    expect(calls).toEqual([true, false, true, false, true, false]);
  } finally { setLanguage(previous || defaultLanguage); }
});
