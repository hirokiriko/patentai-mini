import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  caseRepo,
  draftPatentRepo,
  searchQuerySetRepo,
  priorArtDocumentRepo,
  comparisonResultRepo,
} from "@/repositories";
import { UploadDraftForm } from "./upload-draft-form";
import { ExtractClaimsButton } from "./extract-claims-button";
import { basename } from "path";
import { GenerateQueriesButton } from "./generate-queries-button";
import { UploadCsvForm } from "./upload-csv-form";
import { AnalyzeButton } from "./analyze-button";
import type { ExtractedClaims } from "@/lib/extract-claims";
import { StepProgressBar } from "@/components/step-progress-bar";
import { NextActionBanner } from "@/components/next-action-banner";
import { JplatpatGuide } from "@/components/jplatpat-guide";
import { StepScrollHandler } from "@/components/step-scroll-handler";
import { CopyButton } from "@/components/copy-button";
import { ScrollToTop } from "@/components/scroll-to-top";
import { CaseDetailClient } from "./case-detail-client";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  const row = await caseRepo.findById(caseIdNum);
  if (!row) notFound();

  const drafts = await draftPatentRepo.findByCaseId(caseIdNum);

  // 最初のドラフトの抽出結果を取得
  const firstDraft = drafts[0];
  const extracted: ExtractedClaims | null = firstDraft?.extractedClaimsJson
    ? JSON.parse(firstDraft.extractedClaimsJson)
    : null;

  // 検索式を取得
  const querySets = await searchQuerySetRepo.findByCaseId(caseIdNum);
  const latestQuerySet = querySets[0];
  const queryRationale = latestQuerySet?.rationaleJson
    ? JSON.parse(latestQuerySet.rationaleJson)
    : null;

  // 先行技術文献を取得
  const priorArts = await priorArtDocumentRepo.findByCaseId(caseIdNum);

  // 分析結果を取得
  const analysisResults = await comparisonResultRepo.findByCaseId(caseIdNum);

  // docId → 文献番号のマップ
  const docMap = new Map(
    priorArts.map((pa) => [pa.docId, pa])
  );

  // ── ステップ状態の算出 ──
  const hasDraft = drafts.length > 0;
  const hasParsedText = !!firstDraft?.parsedText;
  const hasExtracted = !!extracted;
  const hasQueries = !!latestQuerySet;
  const hasPriorArts = priorArts.length > 0;
  const hasAnalysis = analysisResults.length > 0;

  let currentStep: number;
  if (!hasDraft || !hasParsedText || !hasExtracted) currentStep = 1;
  else if (!hasQueries) currentStep = 3;
  else if (!hasPriorArts) currentStep = 4;
  else if (!hasAnalysis) currentStep = 5;
  else currentStep = 6;

  const completedSteps: number[] = [];
  if (hasDraft && hasParsedText) completedSteps.push(1);
  if (hasExtracted) completedSteps.push(2);
  if (hasQueries) completedSteps.push(3);
  if (hasPriorArts) completedSteps.push(4);
  if (hasAnalysis) completedSteps.push(5);

  function stepCardClass(step: number): string {
    if (completedSteps.includes(step)) {
      return "border-green-200 bg-green-50/50";
    }
    if (currentStep === step) {
      return "border-blue-300 bg-white shadow-md ring-2 ring-blue-100";
    }
    return "border-gray-200 bg-gray-50";
  }

  return (
    <CaseDetailClient>
    <main className="mx-auto max-w-3xl px-4 pb-12">
      {/* Sticky Header: プログレスバー + 次のアクション */}
      <div className="sticky top-0 z-50 -mx-4 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-sm">
        <StepProgressBar
          currentStep={currentStep}
          completedSteps={completedSteps}
        />
        <NextActionBanner
          currentStep={currentStep}
          hasDraft={hasDraft}
          hasExtracted={hasExtracted}
        />
      </div>

      {/* Hash スクロール制御 */}
      <Suspense>
        <StepScrollHandler />
      </Suspense>

      {/* 案件情報 */}
      <Link
        href="/"
        className="mt-4 inline-block text-base text-blue-700 hover:underline"
      >
        ← 案件一覧に戻る
      </Link>

      <h1 className="mt-4 text-3xl font-bold">{row.title}</h1>
      <p className="mt-1 text-base text-gray-600">
        ステータス: {row.status} ／ 作成日: {row.createdAt}
      </p>

      {/* ── Step 1: 特許案アップロード ── */}
      <section
        id="step-1"
        className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(1)}`}
      >
        <h2 className="text-xl font-bold">1. 特許案アップロード</h2>
        <div className="mt-4">
          <UploadDraftForm caseId={caseIdNum} />
        </div>

        {drafts.length > 0 && (
          <ul className="mt-4 space-y-2">
            {drafts.map((d) => (
              <li
                key={d.draftId}
                className="rounded-lg border border-gray-200 px-4 py-3 text-base space-y-3"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-green-600 text-lg">✓</span>
                  <span className="font-medium">
                    {d.sourceFilePath
                      ? basename(d.sourceFilePath)
                      : "（ファイル名不明）"}
                  </span>
                  {d.parsedText && (
                    <span className="text-sm text-green-700 font-medium">
                      テキスト抽出済み
                    </span>
                  )}
                  {d.extractedClaimsJson && (
                    <span className="text-sm text-blue-700 font-medium">
                      請求項抽出済み
                    </span>
                  )}
                </div>
                {d.parsedText && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <ExtractClaimsButton
                      caseId={caseIdNum}
                      draftId={d.draftId}
                      hasExtracted={!!d.extractedClaimsJson}
                    />
                    <details className="flex-1 text-sm text-gray-700">
                      <summary className="cursor-pointer hover:text-gray-900">
                        抽出テキスト（
                        {d.parsedText.length.toLocaleString()} 文字）
                      </summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">
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

      {/* ── Step 2: 請求項・構成要素の抽出結果 ── */}
      {extracted && (
        <section
          id="step-2"
          className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(2)}`}
        >
          <h2 className="text-xl font-bold">2. 請求項・構成要素</h2>

          <div className="mt-4 space-y-3 text-base">
            <p>
              <span className="font-medium">発明の名称:</span>{" "}
              {extracted.title}
            </p>
            {extracted.solvedProblems.length > 0 && (
              <div>
                <span className="font-medium">解決課題:</span>
                <ul className="ml-4 list-disc text-gray-700">
                  {extracted.solvedProblems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {extracted.effects.length > 0 && (
              <div>
                <span className="font-medium">作用効果:</span>
                <ul className="ml-4 list-disc text-gray-700">
                  {extracted.effects.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {extracted.claims.map((claim) => (
              <div
                key={claim.claimNo}
                className="rounded-lg border border-gray-200 px-4 py-3"
              >
                <div className="flex items-center gap-2 text-base font-medium">
                  <span>
                    請求項 {claim.claimNo}
                    {claim.isIndependent ? "（独立）" : "（従属）"}
                  </span>
                  {!claim.isIndependent && claim.dependsOn && (
                    <span className="text-sm text-gray-600">
                      → 請求項 {claim.dependsOn} に従属
                    </span>
                  )}
                </div>
                <p className="mt-1 text-base text-gray-700">{claim.text}</p>
                {claim.elements.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {claim.elements.map((el, i) => (
                      <span
                        key={i}
                        className={`inline-block rounded px-2.5 py-1 text-sm ${
                          el.importance === "core"
                            ? "bg-red-50 text-red-700 border border-red-200"
                            : "bg-gray-100 text-gray-700"
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

      {/* ── Step 3: 検索式生成 ── */}
      {extracted && (
        <section
          id="step-3"
          className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(3)}`}
        >
          <h2 className="text-xl font-bold">3. J-PlatPat 検索式</h2>
          <div className="mt-4">
            <GenerateQueriesButton
              caseId={caseIdNum}
              hasQueries={!!latestQuerySet}
            />
          </div>

          {latestQuerySet && (
            <div className="mt-4 space-y-4">
              {(
                [
                  ["広め（再現率重視）", latestQuerySet.broadQuery],
                  ["中庸（バランス）", latestQuerySet.balancedQuery],
                  ["狭め（適合率重視）", latestQuerySet.narrowQuery],
                ] as const
              ).map(([label, query]) => (
                <div key={label} className="rounded-lg border border-gray-200 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-base font-medium text-gray-700">{label}</p>
                    <CopyButton text={query ?? ""} />
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-3 text-base font-mono">
                    {query}
                  </pre>
                </div>
              ))}

              {queryRationale && (
                <details className="text-base text-gray-700">
                  <summary className="cursor-pointer font-medium hover:text-gray-900">
                    キーワード・根拠の詳細
                  </summary>
                  <div className="mt-2 space-y-2">
                    {queryRationale.keywordGroups && (
                      <div className="flex flex-wrap gap-1.5">
                        {queryRationale.keywordGroups.core?.map(
                          (k: string, i: number) => (
                            <span key={i} className="rounded bg-red-50 px-2.5 py-1 text-sm text-red-700 border border-red-200">
                              {k}
                            </span>
                          )
                        )}
                        {queryRationale.keywordGroups.synonyms?.map(
                          (k: string, i: number) => (
                            <span key={i} className="rounded bg-blue-50 px-2.5 py-1 text-sm text-blue-700 border border-blue-200">
                              {k}
                            </span>
                          )
                        )}
                        {queryRationale.keywordGroups.effects?.map(
                          (k: string, i: number) => (
                            <span key={i} className="rounded bg-green-50 px-2.5 py-1 text-sm text-green-700 border border-green-200">
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

              {/* J-PlatPat 操作手順ガイド */}
              <JplatpatGuide />
            </div>
          )}
        </section>
      )}

      {/* ── Step 4: 検索結果 CSV 取り込み ── */}
      {latestQuerySet && (
        <section
          id="step-4"
          className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(4)}`}
        >
          <h2 className="text-xl font-bold">4. 検索結果の取り込み</h2>
          <div className="mt-4">
            <UploadCsvForm caseId={caseIdNum} />
          </div>

          {priorArts.length > 0 && (
            <div className="mt-4">
              <p className="text-base text-gray-700 mb-2">
                取り込み済み: {priorArts.length} 件
              </p>
              <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
                <table className="w-full text-base">
                  <thead className="sticky top-0 bg-gray-100">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-700">
                        文献番号
                      </th>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-700">
                        発明の名称
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {priorArts.map((pa) => (
                      <tr key={pa.docId} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-mono text-sm whitespace-nowrap">
                          {pa.publicationNo}
                        </td>
                        <td className="px-4 py-2.5">{pa.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Step 5: 重なり分析・リスクレポート ── */}
      {priorArts.length > 0 && extracted && (
        <section
          id="step-5"
          className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(5)}`}
        >
          <h2 className="text-xl font-bold">5. 重なり分析・リスクレポート</h2>
          <div className="mt-4">
            <AnalyzeButton
              caseId={caseIdNum}
              hasResults={analysisResults.length > 0}
            />
          </div>

          {analysisResults.length > 0 && (
            <div className="mt-4 space-y-4">
              <p className="text-base text-gray-600 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3">
                ※ 類似度が高い＝新規性なし ではありません。最終判断には専門家の確認が必要です。
              </p>

              {analysisResults
                .sort((a, b) => {
                  const order = { High: 0, Medium: 1, Low: 2, Unknown: 3 };
                  return (
                    (order[a.riskLabel as keyof typeof order] ?? 3) -
                    (order[b.riskLabel as keyof typeof order] ?? 3)
                  );
                })
                .map((r) => {
                  const doc = docMap.get(r.priorDocId ?? 0);
                  const overall =
                    0.3 * (r.lexicalScore ?? 0) +
                    0.35 * (JSON.parse(r.matchedElementsJson ?? "{}").elementScore ?? 0) +
                    0.2 * (r.semanticScore ?? 0) +
                    0.15 * (r.structuralScore ?? 0);
                  const detail = r.matchedElementsJson
                    ? JSON.parse(r.matchedElementsJson)
                    : null;
                  const riskColor = {
                    High: "bg-red-100 text-red-800 border-red-300",
                    Medium: "bg-yellow-100 text-yellow-800 border-yellow-300",
                    Low: "bg-green-100 text-green-800 border-green-300",
                    Unknown: "bg-gray-100 text-gray-600 border-gray-300",
                  }[r.riskLabel ?? "Unknown"];

                  return (
                    <div
                      key={r.resultId}
                      className="rounded-lg border border-gray-200 px-4 py-3 space-y-2"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`rounded border px-2.5 py-1 text-sm font-bold ${riskColor}`}
                        >
                          {r.riskLabel}
                        </span>
                        <span className="text-base font-medium">
                          請求項 {r.draftClaimId}
                        </span>
                        <span className="text-base text-gray-600">vs</span>
                        <span className="text-base font-mono">
                          {doc?.publicationNo ?? `Doc#${r.priorDocId}`}
                        </span>
                        <span className="ml-auto text-sm text-gray-600">
                          総合: {(overall * 100).toFixed(0)}%
                        </span>
                      </div>

                      {doc && (
                        <p className="text-sm text-gray-600">{doc.title}</p>
                      )}

                      <div className="flex gap-3 text-sm text-gray-600">
                        <span>L1語彙: {((r.lexicalScore ?? 0) * 100).toFixed(0)}%</span>
                        <span>L2要素: {((detail?.elementScore ?? 0) * 100).toFixed(0)}%</span>
                        <span>L3意味: {((r.semanticScore ?? 0) * 100).toFixed(0)}%</span>
                        <span>L4構造: {((r.structuralScore ?? 0) * 100).toFixed(0)}%</span>
                      </div>

                      {detail?.explanation && (
                        <p className="text-base text-gray-700">
                          {detail.explanation}
                        </p>
                      )}

                      {detail?.matched?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {detail.matched.map((m: string, i: number) => (
                            <span
                              key={i}
                              className="rounded bg-red-50 px-2.5 py-1 text-sm text-red-700 border border-red-200"
                            >
                              一致: {m}
                            </span>
                          ))}
                        </div>
                      )}

                      {detail?.unmatched?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {detail.unmatched.map((u: string, i: number) => (
                            <span
                              key={i}
                              className="rounded bg-green-50 px-2.5 py-1 text-sm text-green-700 border border-green-200"
                            >
                              差分: {u}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      )}

      <ScrollToTop />
    </main>
    </CaseDetailClient>
  );
}
