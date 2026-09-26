import { z } from "zod";
import type { KohoPackageParseResult } from "../koho-package";
import type { KohoXmlElementSnapshot } from "../koho-xml/types";
import { KOHO_NAMESPACES } from "../koho-xml/constants";
import { managedHash, ManagedWatchError } from "../patent-watch/managed-types";
import { managedDigest } from "../patent-watch/managed-claims";
import { managedDate } from "../patent-watch/managed-period";
const date = z.string().refine(s => { try { managedDate(s); return true; } catch { return false; } });
const field = z.string().min(1).max(100);
export const managedCorrectionSchema = z.object({ eventKey: managedHash, kind: z.enum(["A5", "P5", "embedded"]), publicationNumber: field,
  applicationNumber: field, detectedPublicationDate: date, originalPublicationNumber: field.nullable(), originalPublicationDate: date.nullable(),
  contentDigest: managedHash, claimsEffect: z.enum(["none", "unresolved"]),
  changes: z.array(z.object({ documentName: field.nullable(), category: field.nullable(), item: field.nullable(), way: field.nullable() }).strict()).max(10_000),
}).strict();
export type ManagedCorrection = z.infer<typeof managedCorrectionSchema>;
const elements = (node: KohoXmlElementSnapshot) => node.children.flatMap(c => c.type === "element" ? [c.element] : []);
/** Keep amendment units separate. A reported whole amendment is never a full public claim set. */
export function managedCorrectionChanges(snapshot: KohoXmlElementSnapshot) {
  const all: KohoXmlElementSnapshot[] = [], pending = [snapshot];
  while (pending.length) { const node = pending.pop()!; all.push(node); if (all.length > 100_000) throw new ManagedWatchError("limit"); pending.push(...elements(node).reverse()); }
  const bags = all.filter(n => n.namespaceUri === KOHO_NAMESPACES.jpPatent && n.localName === "AmendmentBag");
  const single = (nodes: KohoXmlElementSnapshot[], name: string) => {
    const namespace = name === "DocumentName" ? KOHO_NAMESPACES.common : KOHO_NAMESPACES.jpPatent;
    const values = nodes.filter(n => n.namespaceUri === namespace && n.localName === name);
    if (values.length !== 1 || elements(values[0]).length) return null;
    const text = values[0].children.map(c => c.type === "text" ? c.value : "").join("").trim();
    return text && text.length <= 100 ? text : null;
  };
  const changes = bags.map(bag => {
    const children = elements(bag), contents = children.filter(n => n.namespaceUri === KOHO_NAMESPACES.jpPatent && n.localName === "AmendmentContentsBag");
    return { documentName: single(children, "DocumentName"), category: contents.length === 1 ? single(elements(contents[0]), "AmendmentDocumentNameCategory") : null,
      item: single(children, "AmendmentItem"), way: single(children, "AmendmentWay") };
  });
  // Only the strictly observed description-paragraph form is known not to change claim text.
  const written = elements(snapshot);
  const structure = snapshot.localName === "WrittenAmendmentBag" && snapshot.namespaceUri === KOHO_NAMESPACES.jpPatent && written.length > 0 &&
    written.every(w => w.localName === "WrittenAmendment" && w.namespaceUri === KOHO_NAMESPACES.jpPatent &&
      elements(w).every(c=>["WrittenAmendmentCategory","FilingDate","AmendmentsBag"].includes(c.localName)) &&
      elements(w).filter(c=>c.localName === "AmendmentsBag").length === 1 &&
      elements(w).filter(c=>c.localName === "AmendmentsBag").every(b => b.namespaceUri === KOHO_NAMESPACES.jpPatent && elements(b).length > 0 &&
        elements(b).every(a=>a.localName === "AmendmentBag" && a.namespaceUri === KOHO_NAMESPACES.jpPatent))) &&
    bags.every(b => elements(b).length === 4 && elements(b).every(c=>["DocumentName","AmendmentItem","AmendmentWay","AmendmentContentsBag"].includes(c.localName)) &&
      elements(b).filter(c=>c.localName === "AmendmentContentsBag").every(c=>elements(c).length >= 2 && elements(c).every(p=>
        (p.namespaceUri===KOHO_NAMESPACES.jpPatent&&p.localName==="AmendmentDocumentNameCategory")||(p.namespaceUri===KOHO_NAMESPACES.common&&p.localName==="P")))) &&
    all.filter(n=>["WrittenAmendmentBag","WrittenAmendment","AmendmentsBag","AmendmentBag","AmendmentContentsBag"].includes(n.localName))
      .every(n=>n.children.every(c=>c.type!=="text"||!c.value.trim()));
  const recognized = structure && changes.length > 0 && changes.every(c => c.documentName === "A16330" && c.category === "Description" && c.way === "3" && /^\d{4}$/.test(c.item?.normalize("NFKC") ?? "")) &&
    !all.some(n => /^(Claims|Claim|ClaimText)$/.test(n.localName)) &&
    all.filter(n => n.localName === "AmendmentDocumentNameCategory").length === changes.length &&
    all.filter(n => n.localName === "AmendmentBag").length === changes.length &&
    all.filter(n => n.localName === "WrittenAmendment").every(n => elements(n).filter(c => c.localName === "AmendmentsBag").length === 1);
  return { changes, claimsEffect: recognized ? "none" as const : "unresolved" as const };
}
export function projectManagedCorrections(parsed: KohoPackageParseResult): ManagedCorrection[] {
  const events: ManagedCorrection[] = [];
  for (const entry of parsed.primaryXmlResults) {
    const r = entry.result;
    if (r.entryType === "amendment" && "amendment" in r) {
      const a = r.amendment ?? r.candidate;
      if (!a) throw new ManagedWatchError("incomplete");
      const change = managedCorrectionChanges(a.amendmentContent);
      events.push(managedCorrectionSchema.parse({ eventKey: managedDigest({ path: entry.normalizedPath, content: a.amendmentContent }), kind: a.kind,
        publicationNumber: a.publicationNumber.value, applicationNumber: a.applicationNumber.value, detectedPublicationDate: a.publicationDate.value,
        originalPublicationNumber: r.identityConfirmed ? (a.nationalPublicationNumber?.value ?? (a.kind === "A5" ? a.publicationNumber.value : null)) : null,
        originalPublicationDate: r.identityConfirmed ? a.previousPublicationDate?.value ?? null : null, contentDigest: managedDigest(a.amendmentContent),
        ...change, claimsEffect: r.identityConfirmed ? change.claimsEffect : "unresolved" }));
    } else if (r.entryType === "full_publication" && "document" in r && r.document) {
      for (const [index, content] of r.document.amendmentContent.entries()) {
        events.push(managedCorrectionSchema.parse({ eventKey: managedDigest({ path: entry.normalizedPath, index, content }), kind: "embedded",
          publicationNumber: r.document.publicationNumber.value, applicationNumber: r.document.applicationNumber.value, detectedPublicationDate: r.document.publicationDate.value,
          originalPublicationNumber: r.document.publicationNumber.value, originalPublicationDate: r.document.publicationDate.value,
          contentDigest: managedDigest(content), ...managedCorrectionChanges(content) }));
      }
    }
  }
  if (events.filter(e => e.kind !== "embedded").length !== parsed.counts.confirmedAmendments) throw new ManagedWatchError("incomplete");
  return events.map(event => { const { eventKey, ...identity } = event; void eventKey; return { ...identity, eventKey: managedDigest(identity) }; });
}
