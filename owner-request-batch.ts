export type OwnerRequestBatchStatus = "confirmed" | "submitted" | "rejected" | "unknown" | "unavailable" | "not-found" | "ambiguous" | "risk";

export interface OwnerRequestBatchEntry {
  readonly id: number;
  readonly status: OwnerRequestBatchStatus;
  readonly resolvedFlag?: string;
}

export type OwnerRequestBatchResult = { readonly status: "unavailable" | "not-found" } |
  { readonly status: "processed"; readonly entries: readonly OwnerRequestBatchEntry[] };

export interface OwnerRequestBatchReply {
  readonly type: "forward";
  readonly nodes: readonly (readonly string[])[];
}

export function ownerRequestBatchReply(result: OwnerRequestBatchResult, kind: "好友申请" | "群邀请", verb: string): OwnerRequestBatchReply | string {
  if (result.status === "unavailable") return `当前无法核验可批量审核的${kind}，请在 QQ 中处理。`;
  if (result.status === "not-found") return `本次查询范围内未发现待处理的${kind}，请在 QQ 中查看完整列表。`;
  if (result.status !== "processed" || !result.entries.length) return `${kind}批量审核结果未确认，请先在 QQ 中核对。`;

  const labels: Record<OwnerRequestBatchStatus, string> = {
    confirmed: `已${verb}`, submitted: "已受理，待核对", rejected: "失败", unknown: "结果未知",
    unavailable: "未处理", "not-found": "已离开待审列表", ambiguous: "多条待审，请手动处理", risk: "风险",
  };
  const rows = new Map(Object.values(labels).map(label => [label, [] as number[]]));
  for (const entry of result.entries) rows.get(labels[entry.status])?.push(entry.id);
  const summary = [
    `本次共核对 ${result.entries.length} 条${kind}。审核仅覆盖本次可核验的范围，完整列表请在 QQ 中查看。`,
    ...[...rows].filter(([, ids]) => ids.length).map(([label, ids]) => `${label}：${ids.length} 条`),
  ];
  const nodes = [...rows].filter(([, ids]) => ids.length).map(([label, ids]) =>
    [`${label}名单\n${ids.map((id, index) => `${index + 1}、${id}`).join("\n")}`]);
  return { type: "forward", nodes: [summary, ...nodes] };
}
