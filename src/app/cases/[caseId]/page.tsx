import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { cases, draftPatents, searchQuerySets, priorArtDocuments } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { UploadDraftForm } from "./upload-draft-form";
import { ExtractClaimsButton } from "./extract-claims-button";
import { basename } from "path";
import { GenerateQueriesButton } from "./generate-queries-button";
import { UploadCsvForm } from "./upload-csv-form";
import type { ExtractedClaims } from "@/lib/extract-claims";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  const [row] = await db
    .select()
    .from(cases)
    .where(eq(cases.caseId, caseIdNum));

  if (!row) notFound();

  const drafts = await db
    .select()
    .from(draftPatents)
    .where(eq(draftPatents.caseId, caseIdNum));

  // 最初のドラフトの抽出結果を取得
  const firstDraft = drafts[0];
  const extracted: ExtractedClaims | null = firstDraft?.extractedClaimsJson
    ? JSON.parse(firstDraft.extractedClaimsJson)
    : null;

  // 検索式を取得
  const querySets = await db
    .select()
    .from(searchQuerySets)
    .where(eq(searchQuerySets.caseId, caseIdNum))
    .orderBy(desc(searchQuerySets.querySetId));
  const latestQuerySet = querySets[0];
  const queryRationale = latestQuerySet?.rationaleJson
    ? JSON.parse(latestQuerySet.rationaleJson)
    : null;

  // 先行技術文献を取得
  const priorArts = await db
    .select()
    .from(priorArtDocuments)
    .where(eq(priorArtDocuments.caseId, caseIdNum))
    .orderBy(desc(priorArtDocuments.docId));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← 案件一覧
      </Link>

      <h1 className="mt-4 text-2xl font-bold">{row.title}</h1>
      <p className="mt-1 text-sm text-gray-500">
        ステータス: {row.status} ／ 作成日: {row.createdAt}
      </p>

      {/* Step 1: 特許案アップロード */}
      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">1. 特許案アップロード</h2>
        <UploadDraftForm caseId={caseIdNum} />

        {drafts.length > 0 && (
          <ul className="mt-3 space-y-1">
            {drafts.map((d) => (
              <li
                key={d.draftId}
                className="rounded border border-gray-200 px-3 py-2 text-sm space-y-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-green-600">✓</span>
                  <span>
                    {d.sourceFilePath
                      ? basename(d.sourceFilePath)
                      : "（ファイル名不明）"}
                  </span>
                  {d.parsedText && (
                    <span className="text-xs text-green-600">
                      テキスト抽出済み
                    </span>
                  )}
                  {d.extractedClaimsJson && (
                    <span className="text-xs text-blue-600">
                      請求項抽出済み
                    </span>
                  )}
                </div>
                {d.parsedText && (
                  <div className="flex items-center gap-3">
                    <ExtractClaimsButton
                      caseId={caseIdNum}
                      draftId={d.draftId}
                      hasExtracted={!!d.extractedClaimsJson}
                    />
                    <details className="flex-1 text-xs text-gray-600">
                      <summary className="cursor-pointer hover:text-gray-800">
                        抽出テキスト（
                        {d.parsedText.length.toLocaleString()} 文字）
                      </summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2">
                        {d.parsedText}
                      </pre>
                    </details>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Step 2: 請求項・構成要素の抽出結果 */}
      {extracted && (
        <section className="mt-8 space-y-4">
          <h2 className="text-lg font-semibold">2. 請求項・構成要素</h2>

          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">発明の名称:</span>{" "}
              {extracted.title}
            </p>
            {extracted.solvedProblems.length > 0 && (
              <div>
                <span className="font-medium">解決課題:</span>
                <ul className="ml-4 list-disc text-gray-600">
                  {extracted.solvedProblems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {extracted.effects.length > 0 && (
              <div>
                <span className="font-medium">作用効果:</span>
                <ul className="ml-4 list-disc text-gray-600">
                  {extracted.effects.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="space-y-3">
            {extracted.claims.map((claim) => (
              <div
                key={claim.claimNo}
                className="rounded border border-gray-200 px-4 py-3"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>
                    請求項 {claim.claimNo}
                    {claim.isIndependent ? "（独立）" : "（従属）"}
                  </span>
                  {!claim.isIndependent && claim.dependsOn && (
                    <span className="text-xs text-gray-500">
                      → 請求項 {claim.dependsOn} に従属
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-gray-700">{claim.text}</p>
                {claim.elements.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {claim.elements.map((el, i) => (
                      <span
                        key={i}
                        className={`inline-block rounded px-2 py-0.5 text-xs ${
                          el.importance === "core"
                            ? "bg-red-50 text-red-700 border border-red-200"
                            : "bg-gray-100 text-gray-600"
                        }`}
                        title={`${el.type} / ${el.importance}`}
                      >
                        {el.text}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Step 3: 検索式生成 */}
      {extracted && (
        <section className="mt-8 space-y-4">
          <h2 className="text-lg font-semibold">3. J-PlatPat 検索式</h2>
          <GenerateQueriesButton
            caseId={caseIdNum}
            hasQueries={!!latestQuerySet}
          />

          {latestQuerySet && (
            <div className="space-y-4">
              {(
                [
                  ["広め（再現率重視）", latestQuerySet.broadQuery],
                  ["中庸（バランス）", latestQuerySet.balancedQuery],
                  ["狭め（適合率重視）", latestQuerySet.narrowQuery],
                ] as const
              ).map(([label, query]) => (
                <div key={label} className="rounded border border-gray-200 px-4 py-3">
                  <p className="text-sm font-medium text-gray-700">{label}</p>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 text-sm font-mono">
                    {query}
                  </pre>
                </div>
              ))}

              {queryRationale && (
                <details className="text-sm text-gray-600">
                  <summary className="cursor-pointer font-medium hover:text-gray-800">
                    キーワード・根拠の詳細
                  </summary>
                  <div className="mt-2 space-y-2">
                    {queryRationale.keywordGroups && (
                      <div className="flex flex-wrap gap-1">
                        {queryRationale.keywordGroups.core?.map(
                          (k: string, i: number) => (
                            <span key={i} className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700 border border-red-200">
                              {k}
                            </span>
                          )
                        )}
                        {queryRationale.keywordGroups.synonyms?.map(
                          (k: string, i: number) => (
                            <span key={i} className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 border border-blue-200">
                              {k}
                            </span>
                          )
                        )}
                        {queryRationale.keywordGroups.effects?.map(
                          (k: string, i: number) => (
                            <span key={i} className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700 border border-green-200">
                              {k}
                            </span>
                          )
                        )}
                      </div>
                    )}
                    {queryRationale.excludedTerms?.length > 0 && (
                      <p>
                        <span className="font-medium">除外語:</span>{" "}
                        {queryRationale.excludedTerms.join(", ")}
                      </p>
                    )}
                    {queryRationale.rationale?.length > 0 && (
                      <ul className="ml-4 list-disc">
                        {queryRationale.rationale.map(
                          (r: string, i: number) => (
                            <li key={i}>{r}</li>
                          )
                        )}
                      </ul>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      {/* Step 4: 検索結果 CSV 取り込み */}
      {latestQuerySet && (
        <section className="mt-8 space-y-4">
          <h2 className="text-lg font-semibold">4. 検索結果の取り込み</h2>
          <UploadCsvForm caseId={caseIdNum} />

          {priorArts.length > 0 && (
            <div>
              <p className="text-sm text-gray-600 mb-2">
                取り込み済み: {priorArts.length} 件
              </p>
              <div className="max-h-80 overflow-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-700">
                        文献番号
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-gray-700">
                        発明の名称
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {priorArts.map((pa) => (
                      <tr key={pa.docId} className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                          {pa.publicationNo}
                        </td>
                        <td className="px-3 py-2">{pa.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 後続ステップ */}
      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">処理ステップ</h2>
        <ol
          className="list-decimal list-inside space-y-2 text-gray-600"
          start={priorArts.length > 0 ? 5 : latestQuerySet ? 4 : extracted ? 3 : 2}
        >
          {!extracted && <li>請求項・構成要素を抽出（上のボタンから実行）</li>}
          {extracted && !latestQuerySet && (
            <li>J-PlatPat 検索式を生成（上のボタンから実行）</li>
          )}
          {latestQuerySet && priorArts.length === 0 && (
            <li>検索結果 CSV をアップロード（上のフォームから実行）</li>
          )}
          <li>重なり分析・リスクレポート（未実装）</li>
        </ol>
      </section>
    </main>
  );
}
