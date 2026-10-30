import { createHash } from "node:crypto";
import { managedClaimReferences } from "../koho-import/managed-claim-source";
import { validateManagedClaims, type ManagedClaimSet } from "../patent-watch/managed-claims";

export class ComparisonError extends Error {
  constructor(readonly code: "source_review_required" | "selection_invalid" | "plan_limit" | "ai_incomplete" | "stale_input" | "save_unconfirmed" | "result_invalid" | "not_found") { super(code); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]));
  return value;
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export type SourceSnapshot = {
  id: number; label: string; version: string; textDigest: string;
  source: ManagedClaimSet;
  positions: { claimNo: number; start: number; end: number }[];
};

/** Native Japanese text only. The saved text, never AI extraction, is authoritative.
 * A user's original-text check is additionally required: lost PDF objects cannot be
 * detected reliably from plain text. Offsets are UTF-16 in the saved source text. */
export function parseComparisonSource(text: string | null, id: number, label: string): SourceSnapshot {
  if (!text || Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024 ||
      /\u0000/.test(text)) {
    throw new ComparisonError("source_review_required");
  }
  const headers = [...text.matchAll(/(?:^|\n)[ \t　]*【請求項[ \t　]*([0-9０-９]+)】[ \t　]*/g)];
  if (!headers.length || headers.length > 1000) throw new ComparisonError("source_review_required");
  const positions: SourceSnapshot["positions"] = [];
  const claims = headers.map((header, index) => {
    const claimNo = Number(header[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
    // Missing/duplicate/reordered numbers must not silently become a complete set.
    if (claimNo !== index + 1) throw new ComparisonError("source_review_required");
    let start = header.index! + header[0].length;
    let end = headers[index + 1]?.index ?? text.length;
    const boundary = /(?:^|\n)[ \t　]*【(?:発明の詳細な説明|要約|書類名|図面の簡単な説明|発明の名称)】/.exec(text.slice(start, end));
    if (boundary) {
      if (index !== headers.length - 1) throw new ComparisonError("source_review_required");
      end = start + boundary.index;
    }
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const body = text.slice(start, end);
    if (!body || !/[。．.]$/.test(body) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|【|】|\uFFFD|<[^>]+>|\[\s*(?:image|formula|missing|truncated)\s*\]|(?:省略|以下略|中略)|\.\.\.|…/i.test(body)) throw new ComparisonError("source_review_required");
    positions.push({ claimNo, start, end });
    try { return { claimNo, text: body, dependsOn: managedClaimReferences(body) }; }
    catch { throw new ComparisonError("source_review_required"); }
  });
  const version = digest(text);
  const source: ManagedClaimSet = { publicationNumber: label || `document-${id}`, version, claims };
  try { validateManagedClaims(source); } catch { throw new ComparisonError("source_review_required"); }
  return { id, label: label || `文献 ${id}`, version, textDigest: version, source, positions };
}
