export type MessageNoticePart = string |
  { readonly type: "image"; readonly file: string | Uint8Array } |
  { readonly type: "face"; readonly data: { readonly id: string | number; readonly is_large?: boolean } };
export type ReadMessageNoticeParts = () => Promise<readonly MessageNoticePart[] | undefined>;

export function formatNoticeBodyText(value: string): string {
  const limit = 4096;
  const text = value.slice(0, limit * 2).replace(/\r\n?|[\u2028\u2029]/gu, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  return text.length > limit ? text.slice(0, limit - 1).toWellFormed() + "…" : text.toWellFormed();
}

function faceId(value: unknown): boolean {
  if (typeof value === "string" && /^\d{1,16}$/u.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function verifyMessageNoticeParts(original: readonly MessageNoticePart[] | undefined): MessageNoticePart[] | undefined {
  if (!Array.isArray(original)) return;
  const parts: MessageNoticePart[] = [];
  const source: readonly MessageNoticePart[] = original;
  for (const part of source) {
    if (typeof part === "string") {
      parts.push(formatNoticeBodyText(part));
    } else if (part?.type === "image" && part.file instanceof Uint8Array && part.file.byteLength > 0) {
      parts.push({ type: "image", file: part.file });
    } else if (part?.type === "face" && part.data && faceId(part.data.id) &&
        (part.data.is_large === undefined || typeof part.data.is_large === "boolean")) {
      const { id, is_large } = part.data;
      parts.push({ type: "face", data: { id, ...(is_large !== undefined ? { is_large } : {}) } });
    } else return;
  }
  if (parts.some(part => typeof part !== "string" || part.trim())) return parts;
}

export async function readMessageNoticeParts(readParts: ReadMessageNoticeParts) {
  try { return verifyMessageNoticeParts(await readParts()); } catch { return; }
}
