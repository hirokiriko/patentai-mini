import type { BibliographyField, BibliographyResult } from "@/lib/patent-watch/bibliography";
import { PERIOD_REPORT_PRINT_CSS } from "../../period-report/report-view";
import { PrintButton } from "../../runs/[runId]/print-button";
import { CopyNumber } from "./copy-number";

// The same kind mapping as the existing koho specification (docs/06).
const kindLabels = { A1: "公開特許公報（特開）", P1: "公表特許公報（特表）", B1: "特許公報", B2: "特許公報" };
const partial = "一部または全部を表示できません。原文確認が必要です";
const date = (value: string) => value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1/$2/$3");
function Field({ label, field, copy = false, isDate = false }: { label: string; field: BibliographyField<string>; copy?: boolean; isDate?: boolean }) {
  return <div className="border-b border-gray-200 py-3">
    <dt className="font-semibold">{label}</dt>
    <dd className="mt-1 whitespace-pre-wrap">{field.state === "available" ? <>{isDate ? date(field.value) : field.value}{copy && <CopyNumber label={label} value={field.value} />}</>
      : field.state === "missing" ? "公報の保存情報に記載なし" : partial}</dd>
  </div>;
}
export function BibliographyView({ caseId, result }: { caseId: number; result: BibliographyResult }) {
  const finding = result.kind === "ready" ? result.finding : null;
  const bibliography = finding?.bibliography;
  return <main className="period-report mx-auto max-w-4xl px-6 py-8">
    <style>{PERIOD_REPORT_PRINT_CSS}</style>
    <div className="print-hidden mb-6 flex flex-wrap items-center justify-between gap-3">
      <a href={`/cases/${caseId}`} className="text-indigo-700 underline">案件へ戻る</a><PrintButton />
    </div>
    <header className="border-b border-gray-300 pb-5">
      <p className="text-sm text-gray-600">出願後ウォッチング · 案件 #{caseId}{finding && ` · 候補 #${finding.findingId}`}</p>
      <h1 className="mt-1 text-3xl font-bold">出願人・書誌の確認</h1>
    </header>
    {bibliography ? <section className="mt-6">
      <h2 className="text-xl font-bold">取り込み済み公報の書誌</h2>
      <p className="mt-2 text-sm">出典の状態：保存済み候補と参照公報の番号・種別・内容の一致を確認しました。</p>
      {bibliography.reviewRequired && <p className="mt-3 rounded border border-amber-400 p-3">取込時に確認が必要とされた公報です。書誌情報も原文で確認してください。</p>}
      <dl className="mt-3">
        <Field label="公開番号・公報番号" field={{ state: "available", value: bibliography.publicationNumber }} copy />
        <Field label="公報種別" field={{ state: "available", value: `${kindLabels[bibliography.kind]}（${bibliography.kind}）` }} />
        <Field label="公開日・公報発行日" field={{ state: "available", value: bibliography.publicationDate }} isDate />
        <Field label="発明名称" field={bibliography.inventionTitle} />
        <Field label="出願番号" field={bibliography.applicationNumber} copy />
        <Field label="登録番号" field={bibliography.registrationNumber} />
        <Field label="登録日" field={bibliography.registrationDate} isDate />
        <div className="border-b border-gray-200 py-3"><dt className="font-semibold">公報に記載された出願人名</dt>
          <dd className="mt-2">{bibliography.applicants.state === "available" ? <ol className="list-decimal space-y-3 pl-6">
            {bibliography.applicants.value.map((names, index) => <li key={index}>{names.map((name, n) => <p key={n} className="whitespace-pre-wrap">{name}</p>)}</li>)}
          </ol> : bibliography.applicants.state === "missing" ? "公報の保存情報に記載なし" : partial}</dd>
        </div>
      </dl>
    </section> : <p role="alert" className="mt-6 rounded border border-amber-400 p-4">書誌情報を確認できません。出典は未確認です。保存済みの比較結果は変更していません。原文確認が必要です。</p>}
    {finding && <p className="print-hidden mt-6"><a className="text-indigo-700 underline" href={`/cases/${caseId}/watch/runs/${finding.firstRunId}#finding-${finding.findingId}`}>この候補の一致・差分・説明・分析mode・確認状態を単一runレポートで確認</a></p>}
    <aside className="mt-6 space-y-2 rounded border border-amber-300 bg-amber-50 p-4 text-sm leading-6">
      <h2 className="font-bold">原文確認と表示の限界</h2>
      <p>公開番号を用いてJ-PlatPat等で該当公報を開き、番号・種別・請求項を確認してください。</p>
      <p className="print-hidden"><a href="https://www.j-platpat.inpit.go.jp/" target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline">J-PlatPatの公式検索入口を開く</a></p>
      <p>表示は取り込み済み公報に記載された情報です。最新の権利者・権利の有効性・審査経過を確認したものではありません。</p>
      <p>自社・他社は自動判定していません。同一出願かは出願番号等と原文を確認してください。本機能だけで自己案件除外済みとはしません。</p>
      <p>比較結果は確認候補であり、法的結論ではありません。公報・請求項の原文と専門家による確認が必要です。</p>
    </aside>
  </main>;
}
