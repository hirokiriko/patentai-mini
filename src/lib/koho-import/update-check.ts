import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDistributionTable, DISTRIBUTION_LIMITS, validCompactDate, type DistributionRow,
  type DistributionTableResult } from "../koho-distribution-table";
import { parseKohoPackage, type KohoPackageParseResult } from "../koho-package";
import { buildKohoImportPlan } from "./builder";
import { buildKohoManualImportLimits } from "./manual-api";
import { requireManual } from "./manual-cli-config";
import { MANUAL_RECEIPT_BYTES } from "./manual-cli-receipt";
import { inspectManualSource, copyManualSource, verifyManualSnapshot } from "./manual-cli-source";
import { summarizeManualPackage, type ManualSummary } from "./manual-cli-summary";
import { type UpdateConfiguration } from "./update-check-config";
import { readUpdateReceipt, type UpdateReceipt, type ReceiptEntry } from "./update-check-receipts";

type PackageObservation = {
  packageType: "JPA" | "JPB"; name: string; sha256?: string; byteLength?: number;
  date?: string; issue?: string; summary?: ManualSummary; sections?: KohoPackageParseResult["counts"]["bySection"];
  notes: string[]; error: boolean;
};
type ReceiptObservation = { name: string; result: UpdateReceipt };
type TableObservation = { name: string; packageType: "JPA" | "JPB"; result?: DistributionTableResult };

/** Encode every Markdown metacharacter and control; never render source HTML or links. */
export function updateCell(value: string): string {
  return value.replace(/[&<>"'`\\*_[\]{}()|!#~+=\-\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
    char => `&#${char.codePointAt(0)};`);
}
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
const countsText = (s: ManualSummary) => `本文（要確認含む） ${s.documentCount} / うち要確認本文 ${s.reviewDocumentCount} / 補正 ${s.amendmentCount} / 添付 ${s.attachmentCount} / ST26 ${s.nestedSt26Count} / parser ${s.packageStatus}; ` +
  `package要確認/未対応/失敗 ${s.review.packageIssues.reviewRequired}/${s.review.packageIssues.unsupported}/${s.review.packageIssues.failed}; ` +
  `XML要確認/未対応/失敗 ${s.review.xmlIssues.reviewRequired}/${s.review.xmlIssues.unsupported}/${s.review.xmlIssues.failed}; 未処理entry ${s.review.unprocessedEntries}`;
const outcomeText = {
  preview_not_saved: "previewのみ（未保存）", inserted: "記録上inserted（保存）", reused: "記録上reused（再利用）",
  review_not_saved: "要確認のため未保存", failed_before_save: "保存前失敗", save_outcome_unknown: "保存結果不明（自動再送しない）", not_processed: "未処理",
};
function receiptLinks(p: PackageObservation, receipts: ReceiptObservation[]) {
  return receipts.flatMap(r => r.result.entries.filter(e => e.binding && e.packageType === p.packageType &&
    e.binding.sha256 === p.sha256 && e.binding.byteLength === p.byteLength).map(e => ({ receipt: r, entry: e })));
}
function recordText(p: PackageObservation, receipts: ReceiptObservation[]) {
  const links = receiptLinks(p, receipts);
  if (!links.length) return "一致する取込記録なし";
  return links.map(({ receipt: r, entry: e }) => `${r.name} #${e.ordinal}: ${historicalResult(e)}; ` +
    `${r.result.structuralComplete ? "構造完備" : "記録が不完全"}; 終了ACK未確認; cleanup=${e.result?.cleanup ?? "unconfirmed"}`).join(" / ");
}
function nextOperation(p: PackageObservation, receipts: ReceiptObservation[]) {
  const links = receiptLinks(p, receipts);
  if (links.some(x => x.entry.result?.cleanup === "required" || x.receipt.result.cleanup === "required"))
    return "cleanup未完了を先に確認・回収し、同じ実行の保存結果を照合。自動再送しない";
  if (links.some(x => !x.entry.result || x.entry.result.outcome === "save_outcome_unknown" || !x.receipt.result.structuralComplete))
    return "自動再送せず、同じ実行の終了記録と許可された保存先で保存結果を照合";
  if (links.some(x => ["inserted", "reused"].includes(x.entry.result?.outcome ?? "")))
    return "号/内容と同じ実行の終了ACK・保存先を照合。本番継続取込は別承認待ち";
  if (links.some(x => x.entry.result?.outcome === "preview_not_saved")) return "要確認を確認し、許可された隔離Local DBだけで取込";
  return "原文/号・要確認を確認し、既存手動CLIでpreview。結果不明は保存先の照合を先に行う";
}
function historicalResult(e: ReceiptEntry) {
  return e.result ? `${outcomeText[e.result.outcome]}; 記録上の保存文書数 ${e.result.savedDocumentCount}; ` +
    `保存時の要確認 ${e.result.includesReviewRequired ? "あり" : "なし"}; 記録上parser ${e.result.summary?.packageStatus ?? "記録なし"}` : "入力確認後の結果記録なし";
}

export async function collectUpdateCheck(config: UpdateConfiguration, directory: string, deadline: number) {
  const tables: TableObservation[] = [], packages: PackageObservation[] = [], receipts: ReceiptObservation[] = [];
  let errors = 0, slot = 0, total = 0;
  const checkTime = () => requireManual(performance.now() < deadline);
  async function snapshot(path: string, limit: number, zip = false) {
    checkTime(); const stat = await inspectManualSource(path, limit);
    if (zip) { total += stat.size; requireManual(total <= config.maxTotalBytes); }
    const copy = join(directory, `input-${++slot}`);
    const sha256 = await copyManualSource(path, copy, stat.size);
    await verifyManualSnapshot(copy, stat.size, sha256); checkTime();
    return { copy, sha256, byteLength: stat.size };
  }
  async function finish(path: string, s: Awaited<ReturnType<typeof snapshot>>) {
    await verifyManualSnapshot(s.copy, s.byteLength, s.sha256);
    await verifyManualSnapshot(path, s.byteLength, s.sha256); checkTime();
  }
  for (const file of config.distributionTables) {
    const table: TableObservation = { name: basename(file.path), packageType: file.packageType }; tables.push(table);
    try {
      const s = await snapshot(file.path, DISTRIBUTION_LIMITS.bytes);
      const result = parseDistributionTable({ bytes: await readFile(s.copy), packageType: file.packageType, ...config.period });
      await finish(file.path, s); table.result = result;
      if (!result.ok) errors++;
    } catch { errors++; }
  }
  for (const file of config.packages) {
    const p: PackageObservation = { name: basename(file.path), packageType: file.packageType, notes: [], error: false }; packages.push(p);
    try {
      const s = await snapshot(file.path, config.maxFileBytes, true);
      const parsed = await parseKohoPackage({ packageType: file.packageType, source: { type: "file", path: s.copy },
        limits: buildKohoManualImportLimits(s.byteLength) });
      const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: s.sha256 });
      const summary = summarizeManualPackage(parsed, plan);
      await finish(file.path, s);
      Object.assign(p, { sha256: s.sha256, byteLength: s.byteLength, summary, sections: parsed.counts.bySection }, updatePackageMetadata(parsed));
      if (parsed.status !== "success") p.notes.push("parserの要確認/失敗を保持。原文・号・section/countを確認");
      if (parsed.status === "failed") { p.error = true; errors++; }
    } catch { p.error = true; p.notes.push("読取/解析未完了。発行号ZIPの分離/確認が必要"); errors++; }
  }
  for (const file of config.receipts) {
    let result: UpdateReceipt = { structuralComplete: false, endAcknowledgement: "unconfirmed", invalid: true, entries: [], cleanup: "unconfirmed" };
    try {
      const s = await snapshot(file.path, MANUAL_RECEIPT_BYTES);
      const parsed = readUpdateReceipt(await readFile(s.copy));
      await finish(file.path, s); result = parsed;
    } catch { /* Keep fixed states, never raw errors. */ }
    if (!result.structuralComplete) errors++;
    receipts.push({ name: basename(file.path), result });
  }
  return renderUpdateCheck(config, tables, packages, receipts, errors);
}

function renderUpdateCheck(config: UpdateConfiguration, tables: TableObservation[], packages: PackageObservation[], receipts: ReceiptObservation[], errors: number) {
  const lines = ["# 公報の定例更新チェック", "",
    `対象期間: ${config.period.from} ～ ${config.period.to}（両端を含む）`, "",
    "供給された発行表snapshotの観測範囲だけを確認。coverageProven: false。全期間の網羅性は未証明。",
    "現在の本番DB状態: 未確認。v1 receiptはDB識別子を持たず、記録上の保存は現在DB状態の証明ではありません。",
    "終了ACK: 未確認。v1 footerだけではsync/close成功を証明できません。同じ実行に対応する終了記録を別途照合してください。",
    "本CLIはDB接続・取込・取得・AI・watch・外部通信を実行しません。", "", "## 発行表snapshot", ""];
  let missingTables = 0, zeroTables = 0, warnings = 0;
  for (const type of ["JPA", "JPB"] as const) {
    const t = tables.find(x => x.packageType === type), r = t?.result;
    if (!t) { missingTables++; lines.push(`- ${type}: 表なし。対象期間の発行表を正規取得して再チェック。`); }
    else if (!r?.ok) lines.push(`- ${type}: ${updateCell(t.name)} 読取/解析未完了。${r && !r.ok ? r.error.code : "read_incomplete"}。資料を確認して再チェック。`);
    else {
      if (!r.rows.length) zeroTables++;
      warnings += r.warnings.length;
      lines.push(`- ${type}: ${updateCell(t.name)} / hash ${r.sourceSha256} / 観測 ${r.observedDateRange?.from ?? "なし"} ～ ${r.observedDateRange?.to ?? "なし"} / 対象行 ${r.rows.length}`);
      if (!r.rows.length) lines.push("  - snapshot対象0行。取得済みではありません。期間と取得元snapshotを確認。");
      for (const w of r.warnings) lines.push(`  - parser警告 ${w.code}（行 ${w.row ?? "全体"}）。snapshot外の期間を含め、元の発行表を確認。`);
    }
  }
  lines.push("", "## 発行表の対象行", "", "| 発行表の対象行 | 取得可否 | 対応するファイル候補 | 内容・同一性の確認 | 記録上の結果 | 要確認 | 次の操作 |", "|---|---|---|---|---|---|---|");
  const rows = tables.flatMap(t => t.result?.ok ? t.result.rows : []);
  const used = new Set<PackageObservation>();
  let missing = 0, unavailable = 0, conflicts = 0, duplicates = 0;
  const duplicateGroups = new Map<string, number>();
  for (const p of packages) if (p.sha256) duplicateGroups.set(p.sha256, (duplicateGroups.get(p.sha256) ?? 0) + 1);
  duplicates = [...duplicateGroups.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  function content(p: PackageObservation, row?: DistributionRow) {
    const details = [p.sha256 ? `SHA256 ${p.sha256}; bytes ${p.byteLength}; 前後hash/原本再照合済み` : "同一性未確認"];
    if (p.summary) details.push(countsText(p.summary));
    if (p.issue) details.push(`ABSTRACT号 ${p.issue}（年通号/総通号との対応は未確認）`);
    if (p.sha256 && (duplicateGroups.get(p.sha256) ?? 0) > 1) details.push("同一bytesの重複取得候補（別名を含む）");
    if (row && p.sections) {
      // JPA daily counts include A5/P5 amendments. Preserve the component counts;
      // attachments are separate and a total match alone never proves parsing completeness.
      const units = row.packageType === "JPA" ? [["公開(本文+補正)", row.dailyCounts.published, p.sections.P_A1.primaryXmlCandidates + p.sections.P_A5.primaryXmlCandidates],
        ["公表(本文+補正)", row.dailyCounts.translated, p.sections.P_P1.primaryXmlCandidates + p.sections.P_P5.primaryXmlCandidates]] : [["特許", row.dailyCounts.patents, p.sections.P_B1.primaryXmlCandidates]];
      for (const [name, daily, observed] of units) details.push(`${name}: 表の日件数 ${daily} / 対応section本文XML候補 ${observed}（比較単位の一致は未確認）`);
    }
    return details.join("; ");
  }
  for (const row of rows) {
    const candidates = packages.filter(p => p.packageType === row.packageType && p.date === row.publicationDate);
    candidates.forEach(p => used.add(p));
    const conflict = new Set(candidates.flatMap(p => p.sha256 ? [p.sha256] : [])).size > 1;
    if (conflict) conflicts++;
    if (row.downloadAvailability === "unavailable") unavailable++;
    if (!candidates.length) missing++;
    const rawCounts = row.packageType === "JPA" ? `公開 ${row.raw[7]} / 公表 ${row.raw[8]}` : `特許 ${row.raw[8]}`;
    const fields = [ `${row.packageType} ${row.publicationDate}; 年通号 ${row.annualIssue}; 総通号 ${row.cumulativeIssue}; 日件数 ${rawCounts}`,
      row.downloadAvailability === "available" ? "取得可" : "提供不可（0件/取得済みにはしない）",
      candidates.map(p => `${p.name}（日付一致の候補）`).join(" / ") || "対応ファイル不足",
      candidates.map(p => content(p, row)).join(" / ") || "未確認",
      candidates.map(p => recordText(p, receipts)).join(" / ") || "記録未照合",
      ["号の意味・比較単位・公式配布物としての完全性は未確認", ...candidates.flatMap(p => p.notes),
        ...(conflict ? ["別bytesの変更または競合候補。勝手に採用しない"] : []),
        ...row.warnings.map(w => w.code)].join("; "),
      !candidates.length ? (row.downloadAvailability === "available" ? "不足号を正規取得し、原本を保持して再チェック/preview" : "提供可否を正規の発行表で再確認。代替号を推測しない") :
        conflict ? "別bytesの号・内容と記録を照合し、変更/競合を解消してからpreview。どちらも自動採用・再送しない" :
        candidates.map(p => nextOperation(p, receipts)).join(" / "),
    ];
    lines.push(`| ${fields.map(updateCell).join(" | ")} |`);
  }
  lines.push("", "## 提供されたZIPのうち期間外/対応不明", "", "| ファイル | 状態・内容 | 記録上の結果 | 次の操作 |", "|---|---|---|---|");
  for (const p of packages.filter(p => !used.has(p))) lines.push(`| ${[p.name,
    `${p.date && (p.date < config.period.from || p.date > config.period.to) ? "期間外" : "対応不明"}; ${content(p)}; ${p.notes.join("; ")}`,
    recordText(p, receipts), "発行日/種別/原文/号を確認。まとめZIPは発行号ZIPへ分離して再チェック"].map(updateCell).join(" | ")} |`);
  lines.push("", "## 取込記録（全receiptを保持）", "", "| receipt | 構造・終了・cleanup | 入力と記録上の結果 | 次の操作 |", "|---|---|---|---|");
  let unmatchedRecords = 0, unknown = 0, inserted = 0, reused = 0, previews = 0;
  for (const r of receipts) {
    const descriptions = r.result.entries.map(e => {
      const matches = packages.some(p => e.binding && e.binding.sha256 === p.sha256 && e.binding.byteLength === p.byteLength && e.packageType === p.packageType);
      if (!matches) unmatchedRecords++;
      if (e.result?.outcome === "save_outcome_unknown" || !e.result) unknown++;
      if (matches && e.result?.outcome === "inserted") inserted++;
      if (matches && e.result?.outcome === "reused") reused++;
      if (matches && e.result?.outcome === "preview_not_saved") previews++;
      return `#${e.ordinal} ${e.packageType}: ${historicalResult(e)}; ${matches ? "実bytes一致" : "実bytes対応なし/未確認"}; cleanup=${e.result?.cleanup ?? "unconfirmed"}`;
    });
    lines.push(`| ${[r.name, `${r.result.structuralComplete ? "構造完備" : "記録が不完全"}; ${r.result.invalid ? "不正/途中切断を検出; " : ""}終了ACK未確認; cleanup=${r.result.cleanup}`,
      descriptions.join(" / ") || "有効な入力記録なし", "同じ実行の終了記録と許可先で結果を照合。不明は自動再送しない"].map(updateCell).join(" | ")} |`);
  }
  if (!receipts.length) lines.push("取込記録なし。preview/許可先への取込後、生成receiptと同じ実行の終了記録を保持して再チェック。");
  lines.push("", "現在の内容解析と過去の送信/保存記録は別の証拠です。先行成功は残し、後続の不明・不一致・cleanup未確認を成功で上書きしません。",
    "Localチェック後の本番更新・監視・期間報告・専門家評価・商用提供は別工程です。", "");
  const aggregate = { status: errors ? "incomplete" : "checked", coverageProven: false, productionState: "unconfirmed",
    attentionRequired: true, counts: { targetRows: rows.length, missingFiles: missing, unavailableRows: unavailable,
      missingTables, zeroRowTables: zeroTables, tableWarnings: warnings, suppliedPackages: packages.length,
      unmatchedPackages: packages.length - used.size, duplicateFiles: duplicates, conflictingRows: conflicts,
      receiptFiles: receipts.length, incompleteReceipts: receipts.filter(r => !r.result.structuralComplete).length,
      unmatchedReceiptRecords: unmatchedRecords, unknownReceiptRecords: unknown, recordedInserted: inserted,
      recordedReused: reused, recordedPreviews: previews, processingErrors: errors }, exitCode: errors ? 2 : 0 };
  return { markdown: lines.join("\n"), aggregate };
}
