import type { KohoPackageParseResult } from "../koho-package";
import { validCompactDate } from "../koho-distribution-table";

/** Pure metadata projection, shared by the operator preview and cloud receipts. */
export function updatePackageMetadata(parsed: KohoPackageParseResult) {
  const abstracts = parsed.csvResults.flatMap(c => c.result.logicalFile === "abstract" ? c.result.records : [])
    .flatMap(r => r.semantic?.recordType === "metadata" ? [r.semantic] : []);
  const listedDates = parsed.csvResults.flatMap(c => c.result.logicalFile === "document_list" ? c.result.records : [])
    .flatMap(r => r.semantic ? [r.semantic.issuePublicationDate] : []);
  const notes: string[] = [];
  if (abstracts.length !== 1) return { notes: ["ABSTRACTの発行号が一意でない。発行号ZIPの分離/確認が必要"] };
  const m = abstracts[0];
  const raw = m.publicationDate.replaceAll("-", "");
  if (!validCompactDate(raw)) return { notes: ["ABSTRACT日付を確認できない"] };
  if (listedDates.some(d => d.replaceAll("-", "") !== raw)) notes.push("ABSTRACTとdocument_listの発行日が矛盾（要確認）");
  if (!listedDates.length) notes.push("document_listの発行日が未確認");
  const codeMatches = parsed.packageType === "JPA" ? /^(JPA|A_.+)$/.test(m.packageCode) : /^(JPB|B_.+)$/.test(m.packageCode);
  if (!codeMatches) notes.push("ABSTRACTの種別が矛盾（要確認）");
  return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, issue: m.issueNumber, notes };
}
