import { neutralizeFormula } from "../patent-watch/csv";
import { generateReportBlocksPdf, type ReportBlock } from "../patent-watch/period-report-pdf";
import { validateSaved, type SavedComparison } from "./comparison";
import { managedClaimContext } from "../patent-watch/managed-claims";

export const SCOPE_NOTICE = "指定文献・指定請求項と必要な従属参照の比較です。検索の網羅性、明細書全頁・図面・非選択請求項は対象外です。説明は法的判断ではなく、専門家による原文と意味の確認が必要です。";
export function comparisonBlocks(value: SavedComparison, stale: boolean): ReportBlock[] {
  const saved = validateSaved(value);
  const blocks: ReportBlock[] = [
    { text: "根拠付き指定文献比較", heading: true },
    { text: `テーマ: ${saved.inputs.title}` },
    { text: `比較生成時点: ${saved.generatedAt}` },
    { text: `保存結果ID: ${saved.operationId}` },
    { text: stale ? "現在の入力と異なる保存結果です。以下は保存時点の文献・版を示します。" : "保存時点と現在の入力が一致しています。" },
    { text: "全予定組合せと引用の文字列・位置を機械検証済み。原本対応は実行者による申告で、説明の意味と資料の完全性は人の確認が必要です。" },
    { text: SCOPE_NOTICE },
    { text: `基準文献: ${saved.selection.draftIdentity.publication} / 版: ${saved.selection.draftIdentity.edition} / 指定請求項: ${saved.selection.draftClaimNos.join(", ")}` },
  ];
  for (const doc of saved.selection.documents) blocks.push({ text: `対象文献: ${doc.identity.publication} / 版: ${doc.identity.edition} / 指定請求項: ${doc.claimNos.join(", ")}` });
  for (const p of saved.pairs) {
    const document = saved.selection.documents.find(d => d.docId === p.docId)!;
    blocks.push({ text: `基準 請求項${p.baseClaimNo} × ${document.identity.publication} 請求項${p.candidateClaimNo}`, heading: true },
      { text: `共通点: ${p.common}` }, { text: `差分候補: ${p.differences}` },
      { text: `基準根拠 請求項${p.baseEvidence.claimNo} / UTF-16位置 ${p.baseEvidence.start}-${p.baseEvidence.end}: ${p.baseEvidence.quote}` },
      { text: `文献根拠 請求項${p.candidateEvidence.claimNo} / UTF-16位置 ${p.candidateEvidence.start}-${p.candidateEvidence.end}: ${p.candidateEvidence.quote}` },
      { text: `未確認: ${p.unconfirmed}` });
  }
  blocks.push({ text: "比較に採用した保存原文（指定請求項と従属参照の全文）", heading: true });
  const sources = [{ source: saved.inputs.draft, identity: saved.selection.draftIdentity, selected: saved.selection.draftClaimNos },
    ...saved.inputs.documents.map(source => { const selection = saved.selection.documents.find(d => d.docId === source.id)!;
      return { source, identity: selection.identity, selected: selection.claimNos }; })];
  for (const { source, identity, selected } of sources) {
    blocks.push({ text: `${identity.publication} / ${identity.edition}`, heading: true });
    for (const claim of managedClaimContext(source.source, selected).claims) {
      const location = source.positions.find(p => p.claimNo === claim.claimNo)!;
      blocks.push({ text: `請求項${claim.claimNo} / 保存原文UTF-16位置 ${location.start}-${location.end} / 参照 ${claim.dependsOn.join(", ") || "なし"}` }, { text: claim.text });
    }
  }
  return blocks;
}
export async function comparisonPdf(saved: SavedComparison, stale: boolean) {
  return generateReportBlocksPdf(comparisonBlocks(saved, stale), "根拠付き指定文献比較");
}
/** Same complete ordered content as the PDF, including full source appendices. */
export function comparisonCsv(saved: SavedComparison, stale: boolean): string {
  const cell = (value: string) => `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
  return "\uFEFF" + [["区分", "内容"], ...comparisonBlocks(saved, stale).map(b => [b.heading ? "見出し" : "本文", b.text])]
    .map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
