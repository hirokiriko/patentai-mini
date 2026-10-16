import Link from "next/link";
import { requireOwner } from "@/lib/owner-http";
import { caseNumber } from "@/lib/prior-art-comparison/http";
import { comparisonCatalog, listComparisons } from "@/lib/prior-art-comparison/repository";
import { comparisonBlocks, SCOPE_NOTICE } from "@/lib/prior-art-comparison/report";
import { SelectionForm } from "./selection-form";
import { DownloadLink } from "./download-link";

export const dynamic = "force-dynamic";
export default async function ComparisonPage({ params }: { params: Promise<{ caseId: string }> }) {
  await requireOwner();
  const caseId = caseNumber((await params).caseId);
  const catalog = await comparisonCatalog(caseId);
  const saved = await listComparisons(caseId);
  return <main className="mx-auto max-w-5xl space-y-7 p-6 text-slate-900">
    <Link href={`/cases/${caseId}`} className="text-blue-700 underline">案件に戻る</Link>
    <header className="space-y-3"><h1 className="text-2xl font-bold">根拠付き指定文献比較</h1><p className="text-lg">{catalog.title}</p><p>{SCOPE_NOTICE}</p></header>
    <SelectionForm catalog={catalog} completedIds={saved.results.map(r => r.operationId)} blocked={saved.reservedCount > 0 || saved.invalidCount > 0} />
    <section className="space-y-5" aria-label="保存済み比較結果">
      <h2 className="text-xl font-bold">保存済み比較結果</h2>
      {saved.legacyCount > 0 && <p>旧形式の比較結果が{saved.legacyCount}件あります。旧AI部分比較または単語一致fallbackであり、全文・根拠を再検証していません。案件画面で閲覧できます。</p>}
      {saved.invalidCount > 0 && <p role="alert">整合を確認できない保存結果があります。該当結果の表示・出力を停止しています。</p>}
      {saved.reservedCount > 0 && <p role="alert">完了未確認の試行が{saved.reservedCount}件あります。同じ操作IDは再送しません。利用状況と保存結果の照合が必要です。</p>}
      {saved.results.length === 0 && <p>新形式で完了した比較はまだありません。失敗した試行や未比較を、正常0件として表示することはありません。</p>}
      {saved.results.map(result => <article key={result.operationId} className="space-y-4 rounded-xl border border-slate-300 p-5">
        <h3 className="text-lg font-bold">{result.generatedAt} の比較</h3>
        <p className="break-all text-sm">操作ID: {result.operationId}</p>
        <div className="flex gap-5">{(["pdf", "csv"] as const).map(format => <DownloadLink key={format} href={`/api/cases/${caseId}/analyze/${result.operationId}/${format}`} format={format} />)}</div>
        <p className="text-sm">保存結果から生成します。再取得でAIは実行されません。</p>
        <details open><summary className="cursor-pointer font-semibold">比較範囲・根拠・保存原文</summary>
          <div className="mt-4 space-y-3">{comparisonBlocks(result, result.inputs.inputDigest !== saved.currentInputDigest).map((block, i) => block.heading
            ? <h4 key={i} className="mt-5 font-bold">{block.text}</h4>
            : <p key={i} className="whitespace-pre-wrap break-words">{block.text}</p>)}</div>
        </details>
      </article>)}
    </section>
  </main>;
}
