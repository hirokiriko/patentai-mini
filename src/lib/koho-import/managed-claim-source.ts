import type { KohoFullPublicationDocument, KohoContentToken } from "../koho-xml/types";
import { ManagedClaimsError, managedDigest, validateManagedClaims, type ManagedClaimSet } from "../patent-watch/managed-claims";
import type { KohoImportDocumentPlan, KohoImportPlan } from "./types";

export type ManagedClaimSource = Readonly<{
  normalizedEntryPath: string;
  contentSha256: string;
  sourceSha256: string;
  status: "complete" | "review_required";
  claimsJson: string | null;
  claimsDigest: string | null;
  reason: "claims_missing" | "claims_invalid" | "reference_missing" | "split_limit" | "non_text_claim" | null;
}>;
const digits = (text: string) => text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
function number(value: string | null): number {
  if (value === null || !/^\d+$/.test(digits(value)) || !Number.isSafeInteger(Number(digits(value))) || Number(digits(value)) <= 0) throw new ManagedClaimsError("claims_invalid");
  return Number(digits(value));
}
/** Conservative Japanese reference grammar; ambiguous references remain incomplete. */
export function managedClaimReferences(text: string): number[] {
  const normalized = digits(text), references = new Set<number>();
  const conjunction = "(?:及び|および|又は|または|若しくは|もしくは)";
  const separator = `(?:から|乃至|ないし|〜|～|－|-|[、,]\\s*${conjunction}|、|,|${conjunction})`;
  const reference = new RegExp(`請求項\\s*([0-9]+(?:\\s*${separator}\\s*(?:請求項\\s*)?[0-9]+)*)`, "g");
  const remainder = normalized.replace(reference, (match: string, expression: string, offset: number) => {
    // A regex prefix is not a complete reference: unsupported composite separators
    // must not silently drop the remaining claim numbers (e.g. 1及び／又は2).
    const suffix = normalized.slice(offset + match.length).replace(/^\s*まで\s*/, "");
    const existingTail = /^\s*(?:$|に(?:記載|係る|おいて)|の(?:いずれか|何れか)|記載|を引用|[。．])/;
    const explicitSelectionTail = /^\s*(?:の記載の|(?:のすべてに|(?:の(?:うち(?:の)?|内|少なくとも))?(?:いずれか|何れか)(?:\s*[1一]項?)?\s*(?:に)?)記載(?:の|された|される|する|[。．]|$))/;
    if (!existingTail.test(suffix) && !explicitSelectionTail.test(suffix)) {
      throw new ManagedClaimsError("reference_missing");
    }
    const items = expression.replace(/請求項\s*/g, "").split(new RegExp(`\\s*(${separator})\\s*`));
    let previous = number(items[0]); references.add(previous);
    for (let i = 1; i < items.length; i += 2) {
      const next = number(items[i + 1]);
      if (/^(から|乃至|ないし|〜|～|－|-)$/.test(items[i])) {
        if (next < previous || next - previous > 999) throw new ManagedClaimsError("reference_missing");
        for (let n = previous; n <= next; n++) references.add(n);
      } else references.add(next);
      previous = next;
    }
    return "";
  });
  if (remainder.includes("請求項") || references.size > 1000) throw new ManagedClaimsError("reference_missing");
  return [...references].sort((a, b) => a - b);
}
function isTextComplete(tokens: readonly KohoContentToken[]): boolean {
  const pending = [...tokens];
  while (pending.length) {
    const token = pending.pop()!;
    if (token.type === "text" || token.type === "boundary") continue;
    if ((token.type === "subscript" || token.type === "superscript" || token.type === "patent_citation") && token.plainText !== null) {
      pending.push(...token.content); continue;
    }
    return false;
  }
  return true;
}
export function extractManagedClaimSet(document:KohoFullPublicationDocument):ManagedClaimSet{
  if(document.claims.some(c=>!isTextComplete(c.content.tokens)))throw new ManagedClaimsError("claims_invalid");
  const source:ManagedClaimSet={publicationNumber:document.publicationNumber.value,version:document.kind,
    claims:document.claims.map(c=>({claimNo:number(c.claimNumber),text:c.plainText,dependsOn:managedClaimReferences(c.plainText)}))};
  validateManagedClaims(source);return source;
}
/** Same parser output and exact immutable import projection; never reconstruct numbers from ordinals. */
export function projectManagedClaimSource(document: KohoFullPublicationDocument, stored: KohoImportDocumentPlan, sourceSha256: string): ManagedClaimSource {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || document.source.normalizedEntryPath !== stored.normalizedEntryPath ||
      document.publicationNumber.value !== stored.publicationNumber || document.kind !== stored.kind ||
      document.claims.map(c => c.plainText).join("\n\n") !== stored.claimsText) throw new ManagedClaimsError("claims_invalid");
  const identity = { normalizedEntryPath: stored.normalizedEntryPath, contentSha256: stored.contentSha256, sourceSha256 };
  let nonText = false;
  try {
    nonText = document.claims.some(c => !isTextComplete(c.content.tokens));
    if (nonText) throw new ManagedClaimsError("claims_invalid");
    const source = extractManagedClaimSet(document);
    const claimsJson = JSON.stringify(source);
    return { ...identity, status: "complete", claimsJson, claimsDigest: managedDigest({ schema: 1, source }), reason: null };
  } catch (error) {
    return { ...identity, status: "review_required", claimsJson: null, claimsDigest: null,
      reason: nonText ? "non_text_claim" : error instanceof ManagedClaimsError && error.code !== "coverage_invalid" ? error.code : "claims_invalid" };
  }
}

/** Check the whole sidecar set before opening the import transaction. */
export function validateManagedImportSources(plan: KohoImportPlan, values: readonly ManagedClaimSource[]): ManagedClaimSource[] {
  if (!Array.isArray(values) || values.length !== plan.documents.length) throw new ManagedClaimsError("claims_invalid");
  const documents = new Map(plan.documents.map(d => [d.normalizedEntryPath, d]));
  const seen = new Set<string>();
  return values.map(value => {
    if (!value || Object.keys(value).some(k => !["normalizedEntryPath","contentSha256","sourceSha256","status","claimsJson","claimsDigest","reason"].includes(k))) throw new ManagedClaimsError("claims_invalid");
    const document = documents.get(value.normalizedEntryPath);
    if (!document || seen.has(value.normalizedEntryPath) || document.contentSha256 !== value.contentSha256 || value.sourceSha256 !== plan.sourceSha256) throw new ManagedClaimsError("claims_invalid");
    seen.add(value.normalizedEntryPath);
    if (value.status === "complete") {
      if (typeof value.claimsJson !== "string" || Buffer.byteLength(value.claimsJson) > 8 * 1024 * 1024 || value.reason !== null) throw new ManagedClaimsError("claims_invalid");
      let source: ManagedClaimSet;
      try { source = JSON.parse(value.claimsJson); validateManagedClaims(source); }
      catch { throw new ManagedClaimsError("claims_invalid"); }
      if (source.publicationNumber !== document.publicationNumber || source.version !== document.kind ||
          source.claims.map(c => c.text).join("\n\n") !== document.claimsText || managedDigest({ schema: 1, source }) !== value.claimsDigest) throw new ManagedClaimsError("claims_invalid");
      if (source.claims.some(c => JSON.stringify(managedClaimReferences(c.text)) !== JSON.stringify([...c.dependsOn].sort((a,b) => a-b)))) throw new ManagedClaimsError("reference_missing");
    } else if (value.status !== "review_required" || value.claimsJson !== null || value.claimsDigest !== null ||
      !["claims_missing","claims_invalid","reference_missing","split_limit","non_text_claim"].includes(value.reason ?? "")) throw new ManagedClaimsError("claims_invalid");
    return Object.freeze({ normalizedEntryPath: value.normalizedEntryPath, contentSha256: value.contentSha256, sourceSha256: value.sourceSha256,
      claimsJson: value.claimsJson, claimsDigest: value.claimsDigest, status: value.status, reason: value.reason });
  });
}
