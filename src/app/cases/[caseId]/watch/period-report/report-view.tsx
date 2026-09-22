import type { PeriodFindingView, PeriodReportResult } from "@/lib/patent-watch/period-report";
import { PERIOD_QUERY_MESSAGE, periodDateTimeLabel, type WatchPeriod } from "@/lib/patent-watch/period";
import { PrintButton } from "../runs/[runId]/print-button";
import { PeriodSelector } from "./period-selector";
import { BibliographyLink } from "../bibliography-link";
import { ComparisonScopeNotice } from "../comparison-scope-notice";
import { PdfDownloadButton } from "./pdf-download-button";

export const PERIOD_REPORT_PRINT_CSS = `
  .period-report { overflow-wrap: anywhere; }
  @media print {
    nav, button, .print-hidden { display: none !important; }
    body { background: white !important; color: black !important; }
    .period-report { max-width: none !important; padding: 0 !important; }
    .period-report article { break-inside: auto; overflow: visible; }
    .period-report h2, .period-report h3, .period-report h4 { break-after: avoid; }
    .period-report p, .period-report li { orphans: 3; widows: 3; }
  }
`;
const statusLabel = { completed: "完了", failed: "失敗", running: "実行中" };
const scoreLabel = (score: number) => `${Math.round(score * 100)}%`;
function Finding({ caseId, finding }: { caseId: number; finding: PeriodFindingView }) {
  return <article className="rounded-lg border border-gray-300 p-4" data-finding-id={finding.findingId}>
    <h3 className="text-lg font-semibold">{finding.publicationNumber} · {finding.inventionTitle}</h3>
    <p className="mt-2 text-sm">公開日: {finding.publicationDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1/$2/$3")} ／ 初回検出: {periodDateTimeLabel(finding.firstSeenAt)}</p>
    <p className="mt-2 text-sm">risk label（AI比較の参考）: <strong>{finding.riskLabel}</strong> ／ 分析: {finding.analysisMode} ／ 確認状態: {finding.reviewStatus === "reviewed" ? "確認済み" : "未確認"}</p>
    <dl className="mt-3 flex flex-wrap gap-5 text-sm">
      <div><dt>語彙</dt><dd>{scoreLabel(finding.lexicalScore)}</dd></div><div><dt>要素</dt><dd>{scoreLabel(finding.elementScore)}</dd></div>
      <div><dt>意味</dt><dd>{scoreLabel(finding.semanticScore)}</dd></div><div><dt>構造</dt><dd>{scoreLabel(finding.structuralScore)}</dd></div>
    </dl>
    <h4 className="mt-3 font-semibold">一致候補</h4>
    <ul className="list-disc pl-5 text-sm">{finding.matchedElements.length ? finding.matchedElements.map((text, index) => <li key={index}>{text}</li>) : <li>明示された候補はありません</li>}</ul>
    <h4 className="mt-3 font-semibold">差分候補</h4>
    <ul className="list-disc pl-5 text-sm">{finding.unmatchedElements.length ? finding.unmatchedElements.map((text, index) => <li key={index}>{text}</li>) : <li>明示された候補はありません</li>}</ul>
    <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{finding.explanation}</p>
    <BibliographyLink caseId={caseId} findingId={finding.findingId} />
  </article>;
}

export function PeriodReportView({ caseId, period, invalidQuery = false, result }: {
  caseId: number; period?: WatchPeriod; invalidQuery?: boolean; result?: PeriodReportResult;
}) {
  const report = result?.kind === "ready" ? result.report : undefined;
  const incomplete = report && (report.summary.failed > 0 || report.summary.running > 0);
  return <main className="period-report mx-auto max-w-4xl px-6 py-8">
    <style>{PERIOD_REPORT_PRINT_CSS}</style>
    <div className="print-hidden mb-6 flex flex-wrap justify-between gap-3">
      <a href={`/cases/${caseId}`} className="text-indigo-700 underline">案件へ戻る</a>
      {report && <PrintButton />}
      {report && <PdfDownloadButton caseId={caseId} period={report.period} />}
    </div>
    <header className="border-b border-gray-300 pb-5">
      <p className="text-sm text-gray-600">出願後ウォッチング</p>
      <h1 className="mt-1 text-3xl font-bold">案件 #{caseId} の期間レポート</h1>
      {period && <p className="mt-3 font-semibold">対象期間: {period.from} 〜 {period.to}（両端を含む）</p>}
      <p className="mt-2 text-sm">集計基準: 監視実行開始日（日本時間）。公報の発行期間・出願期間・全公報の網羅期間とは異なります。</p>
      {report && <p className="mt-2 text-sm">レポート作成日時: {periodDateTimeLabel(report.createdAt)}</p>}
      {incomplete && <h2 className="mt-4 rounded border-2 border-amber-500 p-3 font-bold">不完全なレポート：失敗・実行中の監視を含みます。完了した実行の保存済み候補のみを表示しています。</h2>}
    </header>
    <PeriodSelector key={period ? `${period.from}/${period.to}` : "select"} caseId={caseId} initialPeriod={period} />
    {invalidQuery && <p role="alert" className="my-4 rounded border border-amber-400 p-4">{PERIOD_QUERY_MESSAGE}</p>}
    {result?.kind === "unavailable" && <h2 role="alert" className="my-4 rounded border border-amber-400 p-4 font-bold">データ取得不能：期間レポートを取得できませんでした。候補0件とは判断できません。</h2>}
    {result?.kind === "too_many" && <h2 role="alert" className="my-4 rounded border border-amber-400 p-4 font-bold">対象が多いため期間を短くしてください。上限超過のためレポート全体を表示していません。</h2>}
    {report && <>
      <section className="my-6 rounded-lg border border-gray-300 p-4">
        <h2 className="text-xl font-bold">期間の集計</h2>
        <p className="mt-2">実行件数: {report.runs.length}件（完了 {report.summary.completed}件 ／ 失敗 {report.summary.failed}件 ／ 実行中 {report.summary.running}件）</p>
        <p className="mt-2">完了した実行の新規候補数: {report.findings.length}件</p>
        <p className="mt-2">未確認 {report.summary.unreviewed}件 ／ 確認済み {report.summary.reviewed}件 ／ AI {report.summary.ai}件 ／ fallback {report.summary.fallback}件</p>
        <p className="mt-2 text-sm">確認状態はレポート作成時点の保存状態です。当時の状態履歴や専門家確認済みの所見を示すものではありません。</p>
      </section>
      <section className="my-6 space-y-4">
        <h2 className="text-xl font-bold">確認候補</h2>
        <ComparisonScopeNotice hasAiFindings={report.findings.some(finding => finding.analysisMode === "ai")} />
        {!report.runs.length ? <p>実行記録なし：この期間に開始した保存済みの監視実行はありません。公報の取得状況や比較結果は判断できません。</p>
          : !report.summary.completed ? <p>完了した実行がありません。新規候補の有無は未確定です。</p>
          : !report.findings.length ? <p>完了した実行の新規候補は0件です。過去に初検出済みの候補は再計上していません。</p> : null}
        {report.findings.map(finding => <Finding key={finding.findingId} caseId={caseId} finding={finding} />)}
      </section>
      <section className="my-6">
        <h2 className="text-xl font-bold">対象の監視実行</h2>
        <ul className="mt-3 space-y-2 text-sm">{report.runs.map(run => <li key={run.runId} className="rounded border border-gray-300 p-3">
          run #{run.runId} ／ 開始 {periodDateTimeLabel(run.startedAt)} ／ {statusLabel[run.status]} ／ 新規候補 {run.status === "completed" ? `${run.newFindingCount}件` : "未確定"}
          <a href={`/cases/${caseId}/watch/runs/${run.runId}`} className="print-hidden ml-3 text-indigo-700 underline">単一runレポート</a>
        </li>)}</ul>
      </section>
    </>}
    <aside className="mt-6 space-y-2 rounded border border-amber-300 bg-amber-50 p-4 text-sm leading-6">
      <h2 className="font-bold">レポートの範囲と原文確認</h2>
      <p>対象は各実行時の取り込み済み公報です。対象期間の全公開公報の取得完了や全件のAI精読は保証しません。</p>
      <p>本レポートは確認候補を整理するもので、法的判断ではありません。risk labelはAI比較の参考であり、法的危険度・対応義務・専門家の確定所見を示しません。人による原文確認が必要です。</p>
      <p>自己案件の除外や「他社」の判定は保証しません。公開番号を使ってJ-PlatPat等で原文を確認してください。専門家の所見は印刷物や既存の単一run CSVへ外部で追記できます。</p>
    </aside>
  </main>;
}
