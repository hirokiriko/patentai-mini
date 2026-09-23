import { z } from "zod";
import { managedDate, managedDeliveryDueOn, managedPeriodForPublication, JAPAN_HOLIDAYS } from "./managed-period";
import { managedId, ManagedWatchError } from "./managed-types";
import { boundedPatentWatchPublicText, containsForbiddenAggregate, sanitizePatentWatchAnalysis } from "./domain";
import { neutralizeFormula } from "./csv";
import { generateReportBlocksPdf, type ReportBlock } from "./period-report-pdf";
const count = z.number().int().nonnegative();
const date = z.string().refine(x => { try { managedDate(x); return true; } catch { return false; } });
const position = z.object({ claimNo: managedId, start: count, end: z.number().int().positive() }).strict();
const score = z.number().min(0).max(1);
export const managedDeliverySchema = z.object({ schema: z.literal(1), deliveryId: z.uuidv4(), caseId: managedId, version: z.number().int().positive(),
  previousDeliveryId: z.uuidv4().nullable(), reason: z.enum(["initial", "late_publication", "correction", "review_update"]),
  period: z.object({ from: date, to: date }).strict(), generatedAt: z.iso.datetime(), deliveryDueOn: date, deliveredOn: date.nullable(),
  contractSignedOn: date, monitoringStartsOn: date, contractEndsOn: date.nullable(),
  base: z.object({ publicationNumber: z.string().max(100), version: z.string().max(100), selectedClaimNos: z.array(managedId).min(1).max(1000) }).strict(),
  coverage: z.object({ expectedPackages: count, availablePackages: count, importedDocuments: count, incompleteDocuments: count,
    observedCorrections: count, unresolvedCorrections: count,
    prefiltered: count, compared: count, completedRuns: count, failedRuns: count, activeRuns: count,
    acquiredAt: z.iso.datetime(), comparedAt: z.iso.datetime().nullable(), complete: z.boolean() }).strict(),
  findings: z.array(z.object({ findingId: managedId, publicationNumber: z.string().max(100), publicationDate: date,
    inventionTitle: z.string().max(1000), detectedAt: z.iso.datetime(), reviewStatus: z.enum(["reviewed", "unreviewed"]),
    relation: z.enum(["own_publication", "other_applicant", "unknown"]),
    comparisons: z.array(z.object({ baseClaimNo: managedId, candidateClaimNo: managedId, baseEvidence: position, candidateEvidence: position,
      lexicalScore: score, elementScore: score, semanticScore: score, structuralScore: score, riskLabel: z.enum(["High","Medium","Low","Unknown"]),
      explanation: z.string().min(1).max(1500) }).strict()).min(1).max(480) }).strict()).max(20_000),
}).strict();
export type ManagedDelivery = z.infer<typeof managedDeliverySchema>;
export function validateManagedDelivery(value: unknown): ManagedDelivery {
  try {
    const report = managedDeliverySchema.parse(value), seen = new Set<number>();
    const expectedPeriod = managedPeriodForPublication(report.monitoringStartsOn, report.period.to);
    if (expectedPeriod?.from !== report.period.from || expectedPeriod.to !== report.period.to) throw Error();
    if (managedDeliveryDueOn(report.period, JAPAN_HOLIDAYS) !== report.deliveryDueOn ||
      (report.version === 1) !== (report.previousDeliveryId === null) ||
      report.coverage.availablePackages > report.coverage.expectedPackages ||
      report.coverage.compared !== report.findings.length || report.period.from < report.monitoringStartsOn) throw Error();
    if (report.coverage.complete && (report.coverage.expectedPackages !== report.coverage.availablePackages ||
      !report.coverage.completedRuns || report.coverage.failedRuns || report.coverage.activeRuns || report.coverage.incompleteDocuments || report.coverage.unresolvedCorrections)) throw Error();
    for (const finding of report.findings) {
      if (seen.has(finding.findingId) || finding.publicationDate < report.period.from || finding.publicationDate > report.period.to) throw Error();
      seen.add(finding.findingId);
      const pairs = new Set<string>();
      for (const comparison of finding.comparisons) {
        const key = `${comparison.baseClaimNo}:${comparison.candidateClaimNo}`;
        if (pairs.has(key) || !report.base.selectedClaimNos.includes(comparison.baseClaimNo) ||
          comparison.baseEvidence.start >= comparison.baseEvidence.end || comparison.candidateEvidence.start >= comparison.candidateEvidence.end) throw Error();
        pairs.add(key);
      }
    }
    return report;
  } catch { throw new ManagedWatchError("incomplete"); }
}
/** No source text, quotes, hashes, storage locators or arbitrary metadata become display fields. */
export function managedExplanation(text: string, fullClaims: readonly string[]): string {
  return boundedPatentWatchPublicText(sanitizePatentWatchAnalysis({ matchedElements: [], unmatchedElements: [], explanation: text }, fullClaims).explanation, 1500);
}
/** Evaluate the complete explanation collection before any per-cell truncation. */
export function managedExplanations(texts: readonly string[], fullClaims: readonly string[]): string[] {
  if (containsForbiddenAggregate(texts, fullClaims)) return texts.map(() => managedExplanation("", fullClaims));
  return texts.map(text => managedExplanation(text, fullClaims));
}
export function projectManagedDeliveryDisplay(value: ManagedDelivery): ManagedDelivery {
  const report = validateManagedDelivery(value);
  return { ...report, base: { ...report.base, publicationNumber: boundedPatentWatchPublicText(report.base.publicationNumber, 100),
    version: boundedPatentWatchPublicText(report.base.version, 100) }, findings: report.findings.map(f => ({ ...f,
    publicationNumber: boundedPatentWatchPublicText(f.publicationNumber, 100), inventionTitle: boundedPatentWatchPublicText(f.inventionTitle, 1000),
    comparisons: f.comparisons.map(c => ({ ...c, explanation: managedExplanation(c.explanation, []) })) })) };
}
export const MANAGED_NOTICE = "指定した監視元請求項の全文と必要な参照請求項を、採用候補の請求項全文と比較しています。語彙選別は最大100件、AI詳細採用は最大20件です。対象外を全文AI比較済みとは扱いません。法的判断ではなく、人による原文確認が必要です。";
export const MANAGED_SOURCE_NOTICE = "公開番号を用いてJ-PlatPat等の正規原文を確認してください。自社公報は番号・出願対応で確認できたものだけを区別し、出願人不明を他社確定にしません。Lowでも記載不存在・権利非侵害を意味しません。";
export function managedIncompleteMessage(value:ManagedDelivery):string|null{
  const r=validateManagedDelivery(value);if(r.coverage.complete)return null;
  return `対象公開期間 ${r.period.from}〜${r.period.to} の定例報告について、取得・解析・比較の確認が完了していないため、候補の有無は確定していません。`+
    `配布一覧 ${r.coverage.expectedPackages}号中の保存確認 ${r.coverage.availablePackages}号、全文不足 ${r.coverage.incompleteDocuments}件、未解決補正 ${r.coverage.unresolvedCorrections}件、`+
    `失敗 ${r.coverage.failedRuns}件、未完了 ${r.coverage.activeRuns}件です。確認が済み次第、この第${r.version}版に対応する補足・訂正版をご案内します。`;
}
export function* managedDeliveryBlocks(value: ManagedDelivery): Generator<ReportBlock> {
  const r = projectManagedDeliveryDisplay(value), text = (text: string) => ({ text }), heading = (text: string) => ({ text, heading: true });
  yield heading("標準特許ウォッチ 定例報告");
  yield text(`案件 #${r.caseId} ／ 納品版 ${r.version} ／ ${r.coverage.complete ? "対象範囲の処理確認済み" : "未完了・要確認"}`);
  yield text(`対象公開期間: ${r.period.from} 〜 ${r.period.to}（元の公開日で帰属）`);
  yield text(`契約日: ${r.contractSignedOn} ／ 監視開始日: ${r.monitoringStartsOn}`);
  yield text(`取得確認日時: ${r.coverage.acquiredAt} ／ 比較確認日時: ${r.coverage.comparedAt ?? "未比較"}`);
  yield text(`生成日時: ${r.generatedAt} ／ 納品期限: ${r.deliveryDueOn} ／ 納品日: ${r.deliveredOn ?? "未記録"}`);
  yield text(`監視元: ${r.base.publicationNumber} ${r.base.version} ／ 指定請求項: ${r.base.selectedClaimNos.join("、")}`);
  yield text(`補足理由: ${{ initial: "初回版", late_publication: "元公開期間の遅延検出", correction: "訂正・変更版の追加", review_update: "確認状態の更新" }[r.reason]}`);
  yield heading("取得・処理の範囲");
  yield text(`配布一覧対象 ${r.coverage.expectedPackages}号 ／ 保存確認 ${r.coverage.availablePackages}号 ／ 取込文献 ${r.coverage.importedDocuments}件`);
  yield text(`語彙選別候補 ${r.coverage.prefiltered}件 ／ 全文AI比較候補 ${r.coverage.compared}件 ／ 全文不足 ${r.coverage.incompleteDocuments}件`);
  yield text(`取得済み補正 ${r.coverage.observedCorrections}件 ／ 元期間との対応・請求項変更が未解決 ${r.coverage.unresolvedCorrections}件`);
  yield text(`完了run ${r.coverage.completedRuns}件 ／ 失敗 ${r.coverage.failedRuns}件 ／ 未完了 ${r.coverage.activeRuns}件`);
  if (!r.coverage.complete) {
    yield heading("未完了：取得不足・未実行・失敗・全文不足を含みます。表示件数0を正常0と解釈しないでください。");
    yield heading("不足時の連絡用文案（運営者が確認して手動送信）");yield text(managedIncompleteMessage(r)!);
  }
  else if (!r.findings.length) yield text("確認済みの対象範囲で新規の詳細比較候補は0件です。全公報の全件AI精読や記載不存在を保証するものではありません。");
  yield text(MANAGED_NOTICE);
  for (const f of r.findings) {
    yield heading(`候補 #${f.findingId}: ${f.publicationNumber} ／ ${f.inventionTitle}`);
    yield text(`公開日: ${f.publicationDate} ／ 検出日時: ${f.detectedAt}`);
    yield text(`区分: ${{ own_publication: "自社公報", other_applicant: "他社出願確認済み", unknown: "出願対応未確認" }[f.relation]} ／ ${f.reviewStatus === "reviewed" ? "確認済み" : "未確認"}`);
    for (const c of f.comparisons) {
      yield text(`監視元請求項${c.baseClaimNo} × 候補請求項${c.candidateClaimNo} ／ ${c.riskLabel}`);
      yield text(`語彙 ${Math.round(c.lexicalScore*100)}% ／ 要素 ${Math.round(c.elementScore*100)}% ／ 意味 ${Math.round(c.semanticScore*100)}% ／ 構造 ${Math.round(c.structuralScore*100)}%`);
      yield text(`根拠位置（UTF-16、0始まり・末尾除外）: 監視元請求項${c.baseEvidence.claimNo} ${c.baseEvidence.start}〜${c.baseEvidence.end} ／ 候補請求項${c.candidateEvidence.claimNo} ${c.candidateEvidence.start}〜${c.candidateEvidence.end}`);
      yield text(c.explanation);
    }
  }
  yield heading("原文確認と利用範囲"); yield text(MANAGED_SOURCE_NOTICE);
  yield text("確認状態はこの納品版の生成時点です。後の確認・追加公報は別版として保存され、以前の納品版を変更しません。");
}
export const generateManagedDeliveryPdf = (report: ManagedDelivery) => generateReportBlocksPdf(managedDeliveryBlocks(report), "標準特許ウォッチ 定例報告");
const cell = (value: unknown) => `"${neutralizeFormula(String(value ?? "")).replaceAll('"','""')}"`;
export function managedDeliveryCsv(value: ManagedDelivery): Buffer {
  const r = projectManagedDeliveryDisplay(value);
  const header = ["案件", "納品版", "公開期間開始", "公開期間終了", "生成日時", "処理状態", "公開番号", "公開日", "検出日時", "区分", "確認状態", "監視元請求項", "候補請求項", "risk", "語彙", "要素", "意味", "構造", "監視元根拠位置", "候補根拠位置", "説明", "注意文"];
  const rows: unknown[][] = [];
  const common = [r.caseId,r.version,r.period.from,r.period.to,r.generatedAt,r.coverage.complete ? "処理確認済み" : "未完了・要確認"];
  for (const f of r.findings) for (const c of f.comparisons) rows.push([...common,f.publicationNumber,f.publicationDate,f.detectedAt,f.relation,f.reviewStatus,
    c.baseClaimNo,c.candidateClaimNo,c.riskLabel,c.lexicalScore,c.elementScore,c.semanticScore,c.structuralScore,
    `${c.baseEvidence.claimNo}:${c.baseEvidence.start}-${c.baseEvidence.end}`, `${c.candidateEvidence.claimNo}:${c.candidateEvidence.start}-${c.candidateEvidence.end}`,c.explanation,MANAGED_NOTICE]);
  if (!rows.length) rows.push([...common,...Array(14).fill(""),r.coverage.complete ? "詳細比較候補0件" : "未完了のため候補の有無は未確定",MANAGED_NOTICE]);
  header.push("監視元公開番号","監視元版","指定請求項","契約日","監視開始日","契約終了日","取得確認日時","比較確認日時","納品期限","納品日",
    "配布一覧対象号数","保存確認号数","取込文献数","選別候補数","全文比較候補数","全文不足数","取得補正数","未解決補正数","完了run数","失敗run数","未完了run数","原文確認方法","不足連絡用文案");
  const metadata=[r.base.publicationNumber,r.base.version,r.base.selectedClaimNos.join("、"),r.contractSignedOn,r.monitoringStartsOn,r.contractEndsOn,r.coverage.acquiredAt,r.coverage.comparedAt,r.deliveryDueOn,r.deliveredOn,
    r.coverage.expectedPackages,r.coverage.availablePackages,r.coverage.importedDocuments,r.coverage.prefiltered,r.coverage.compared,r.coverage.incompleteDocuments,r.coverage.observedCorrections,r.coverage.unresolvedCorrections,
    r.coverage.completedRuns,r.coverage.failedRuns,r.coverage.activeRuns,MANAGED_SOURCE_NOTICE,managedIncompleteMessage(r)];
  for(const row of rows)row.push(...metadata);
  return Buffer.from("\uFEFF"+[header,...rows].map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n");
}
