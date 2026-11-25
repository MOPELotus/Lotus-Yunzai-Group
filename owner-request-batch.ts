import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("group", messageCatalog.messages);
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

export function ownerRequestBatchReply(result: OwnerRequestBatchResult, kind: string, verb: string): OwnerRequestBatchReply | string {
  if (result.status === "unavailable") return $t("owner-request-batch.text_bf241ef309", { "kind": kind });
  if (result.status === "not-found") return $t("owner-request-batch.text_5a5ce4e708", { "kind": kind });
  if (result.status !== "processed" || !result.entries.length) return $t("owner-request-batch.text_b39b248297", { "kind": kind });

  const labels: Record<OwnerRequestBatchStatus, string> = {
    confirmed: $t("owner-request-batch.text_597ee8e766", { "verb": verb }), submitted: $t("owner-request-batch.text_b0be616a4b"), rejected: $t("owner-request-batch.text_28384d7afd"), unknown: $t("owner-request-batch.text_fb7e71452c"),
    unavailable: $t("owner-request-batch.text_83fbf42f9e"), "not-found": $t("owner-request-batch.text_18cf61afbd"), ambiguous: $t("owner-request-batch.text_7d7c402c04"), risk: $t("owner-request-batch.text_af75e78cac"),
  };
  const rows = new Map(Object.values(labels).map(label => [label, [] as number[]]));
  for (const entry of result.entries) rows.get(labels[entry.status])?.push(entry.id);
  const summary = [
    $t("owner-request-batch.text_e36a329356", { "length": result.entries.length, "kind": kind }),
    ...[...rows].filter(([, ids]) => ids.length).map(([label, ids]) => $t("owner-request-batch.text_f8a770e14e", { "label": label, "length": ids.length })),
  ];
  const nodes = [...rows].filter(([, ids]) => ids.length).map(([label, ids]) =>
    [$t("owner-request-batch.text_e9339d3412", { "label": label, "value2": ids.map((id, index) => `${index + 1}、${id}`).join("\n") })]);
  return { type: "forward", nodes: [summary, ...nodes] };
}
