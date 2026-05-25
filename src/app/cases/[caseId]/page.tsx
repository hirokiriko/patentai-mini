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
import { IntegrateButton } from "./integrate-button";
import { GenerateQueriesButton } from "./generate-queries-button";
import { UploadCsvForm } from "./upload-csv-form";
import { UploadPatentFilesForm } from "./upload-patent-files-form";
import { AnalyzeButton } from "./analyze-button";
import type { ExtractedClaims } from "@/lib/extract-claims";
import { StepProgressBar } from "@/components/step-progress-bar";
import { NextActionBanner } from "@/components/next-action-banner";
import { JplatpatGuide } from "@/components/jplatpat-guide";
import { StepScrollHandler } from "@/components/step-scroll-handler";
import { CopyButton } from "@/components/copy-button";
import { ScrollToTop } from "@/components/scroll-to-top";
import { CaseDetailClient } from "./case-detail-client";
import { PriorArtTable } from "./prior-art-table";
import {
  getOriginalFileDisplayName,
  isOriginalFileBlobName,
} from "@/lib/original-file-metadata";
import { parseJsonOrNull } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

type QueryRationale = {
  keywordGroups?: {
    core?: string[];
    synonyms?: string[];
    effects?: string[];
  };
  keywordQueries?: { theme: string; keywords: string }[];
  searchExpansionHints?: {
    spellingVariants?: {
      baseTerm?: string;
      variants?: string[];
      reason?: string;
      suggestedUse?: string;
    }[];
    companyNameHints?: {
      observedName?: string;
      relatedNames?: string[];
      reason?: string;
      confidence?: "high" | "medium" | "low";
      source?: "ai" | "dictionary";
    }[];
    additionalKeywordQueries?: {
      theme?: string;
      keywords?: string;
      note?: string;
    }[];
    leakageRisks?: string[];
  };
  excludedTerms?: string[];
  rationale?: string[];
};

type MatchedElementDetail = {
  elementScore?: number;
  explanation?: string;
  matched?: string[];
  unmatched?: string[];
};

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
  const isBaseMode = row.baseApplicationMode;

  // kind 別に分類。kind="main" は通常モードの特許案、または統合後の特許案。
  const baseDraft = drafts.find((d) => d.kind === "base");
  const additionDraft = drafts.find((d) => d.kind === "addition");
  const mainDraft = drafts.find((d) => d.kind === "main");

  // 通常モードでは main draft（または kind 未設定の旧データ）を主として使う
  const primaryDraft = mainDraft ?? drafts[0];
  const extracted: ExtractedClaims | null = primaryDraft?.extractedClaimsJson
    ? parseJsonOrNull<ExtractedClaims>(
        primaryDraft.extractedClaimsJson,
        "draft.extractedClaimsJson"
      )
    : null;

  // 検索式を取得
  const querySets = await searchQuerySetRepo.findByCaseId(caseIdNum);
  const latestQuerySet = querySets[0];
  const queryRationale = latestQuerySet?.rationaleJson
    ? parseJsonOrNull<QueryRationale>(
        latestQuerySet.rationaleJson,
        "searchQuerySet.rationaleJson"
      )
    : null;
  const keywordQueries = queryRationale?.keywordQueries ?? [];
  const searchExpansionHints = queryRationale?.searchExpansionHints;
  const spellingVariants = searchExpansionHints?.spellingVariants ?? [];
  const companyNameHints = searchExpansionHints?.companyNameHints ?? [];
  const additionalKeywordQueries =
    searchExpansionHints?.additionalKeywordQueries ?? [];
  const leakageRisks = searchExpansionHints?.leakageRisks ?? [];
  const hasSearchExpansionHints =
    spellingVariants.length > 0 ||
    companyNameHints.length > 0 ||
    additionalKeywordQueries.length > 0 ||
    leakageRisks.length > 0;
  const excludedTerms = queryRationale?.excludedTerms ?? [];
  const rationaleItems = queryRationale?.rationale ?? [];

  // 先行技術文献を取得
  const priorArts = await priorArtDocumentRepo.findByCaseId(caseIdNum);

  // 分析結果を取得
  const analysisResults = await comparisonResultRepo.findByCaseId(caseIdNum);

  // docId → 文献番号のマップ
  const docMap = new Map(
    priorArts.map((pa) => [pa.docId, pa])
  );

  // ── ステップ状態の算出 ──
  const hasBase = !!baseDraft?.parsedText;
  const hasAddition = !!additionDraft?.parsedText;
  const hasIntegrated = !!mainDraft?.parsedText;

  // 「Step 1 完了」の意味:
  //  通常モード: ドラフトがあり parsedText が抽出済み
  //  ベース出願モード: ベース + 新規事項の両方アップロード済みかつ統合済み (main draft あり)
  const hasDraft = isBaseMode ? hasIntegrated : drafts.length > 0;
  const hasParsedText = isBaseMode ? hasIntegrated : !!primaryDraft?.parsedText;
  const hasExtracted = !!extracted;
  const hasQueries = !!latestQuerySet;
  const hasPriorArts = priorArts.length > 0;
  const hasAnalysis = analysisResults.length > 0;

  let currentStep: number;
  if (!hasDraft || !hasParsedText || !hasExtracted) currentStep = 1;
  else if (!hasQueries && !hasPriorArts) currentStep = 3;
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

  function renderBlobBadge(sourceFilePath: string | null) {
    if (!sourceFilePath || !isOriginalFileBlobName(sourceFilePath, caseIdNum)) {
      return null;
    }

    return (
      <span className="rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
        Azure Blob saved
      </span>
    );
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
          isBaseMode={isBaseMode}
          hasBase={hasBase}
          hasAddition={hasAddition}
          hasIntegrated={hasIntegrated}
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
      {isBaseMode && (
        <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-base text-purple-900">
          <p className="font-medium">国内優先権主張出願モード（FR-07）</p>
          <p className="mt-1 text-sm">
            公開前の出願済み特許 + 新規事項を統合した発明全体を分析対象にします。
            {row.baseApplicationNumber && (
              <>
                {" "}ベース出願番号: <span className="font-mono">{row.baseApplicationNumber}</span>
              </>
            )}
          </p>
        </div>
      )}

      {/* ── Step 1: 特許案アップロード ── */}
      <section
        id="step-1"
        className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(1)}`}
      >
        <h2 className="text-xl font-bold">
          {isBaseMode ? "1. ベース出願 + 新規事項のアップロードと統合" : "1. 特許案アップロード"}
        </h2>

        {!isBaseMode && (
          <>
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
                          ? getOriginalFileDisplayName(d.sourceFilePath)
                          : "（ファイル名不明）"}
                      </span>
                      {renderBlobBadge(d.sourceFilePath)}
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
          </>
        )}

        {isBaseMode && (
          <div className="mt-4 space-y-5">
            {/* 1a: ベース出願 */}
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <p className="text-sm font-medium text-gray-500 mb-2">
                1-A. 公開前のベース出願（自身の出願済み特許）
              </p>
              <UploadDraftForm
                caseId={caseIdNum}
                kind="base"
                label="ベース出願ファイル（PDF / DOCX / TXT）"
                buttonLabel={baseDraft ? "差し替え" : "アップロード"}
              />
              {baseDraft && (
                <div className="mt-3 rounded border border-gray-200 px-3 py-2 text-sm space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-green-600">✓</span>
                    <span className="font-medium">
                      {baseDraft.sourceFilePath
                        ? getOriginalFileDisplayName(baseDraft.sourceFilePath)
                        : "（ファイル名不明）"}
                    </span>
                    {renderBlobBadge(baseDraft.sourceFilePath)}
                    {baseDraft.parsedText && (
                      <span className="text-xs text-green-700 font-medium">
                        テキスト抽出済み（
                        {baseDraft.parsedText.length.toLocaleString()} 文字）
                      </span>
                    )}
                  </div>
                  {baseDraft.parsedText && (
                    <details className="text-sm text-gray-700">
                      <summary className="cursor-pointer hover:text-gray-900">
                        抽出テキストを表示
                      </summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">
                        {baseDraft.parsedText}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>

            {/* 1b: 新規事項 */}
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <p className="text-sm font-medium text-gray-500 mb-2">
                1-B. 追加したい新規事項（例: UI、新機能、追加構成要素）
              </p>
              <UploadDraftForm
                caseId={caseIdNum}
                kind="addition"
                label="新規事項ファイル（PDF / DOCX / TXT）"
                buttonLabel={additionDraft ? "差し替え" : "アップロード"}
              />
              {additionDraft && (
                <div className="mt-3 rounded border border-gray-200 px-3 py-2 text-sm space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-green-600">✓</span>
                    <span className="font-medium">
                      {additionDraft.sourceFilePath
                        ? getOriginalFileDisplayName(additionDraft.sourceFilePath)
                        : "（ファイル名不明）"}
                    </span>
                    {renderBlobBadge(additionDraft.sourceFilePath)}
                    {additionDraft.parsedText && (
                      <span className="text-xs text-green-700 font-medium">
                        テキスト抽出済み（
                        {additionDraft.parsedText.length.toLocaleString()} 文字）
                      </span>
                    )}
                  </div>
                  {additionDraft.parsedText && (
                    <details className="text-sm text-gray-700">
                      <summary className="cursor-pointer hover:text-gray-900">
                        抽出テキストを表示
                      </summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">
                        {additionDraft.parsedText}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>

            {/* 1c: 統合 */}
            <div className="rounded-lg border border-purple-200 bg-purple-50 px-4 py-3">
              <p className="text-sm font-medium text-purple-700 mb-2">
                1-C. AI で統合した発明全体を生成
              </p>
              <p className="text-sm text-purple-900 mb-3">
                両ファイルから「ベース出願 + 新規事項」を組み合わせた発明全体の明細書テキストを生成します。
                以降の請求項抽出・先行技術調査はこの統合後テキストを対象とします。
              </p>
              <IntegrateButton
                caseId={caseIdNum}
                enabled={hasBase && hasAddition}
                hasIntegrated={hasIntegrated}
              />
              {!(hasBase && hasAddition) && (
                <p className="mt-2 text-xs text-purple-700">
                  ※ ベース出願 + 新規事項の両方をアップロード（テキスト抽出成功）すると押せるようになります
                </p>
              )}
              {mainDraft && (
                <div className="mt-3 rounded border border-purple-200 bg-white px-3 py-2 text-sm space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-green-600">✓</span>
                    <span className="font-medium">統合済み発明全体</span>
                    {mainDraft.parsedText && (
                      <span className="text-xs text-green-700 font-medium">
                        （{mainDraft.parsedText.length.toLocaleString()} 文字）
                      </span>
                    )}
                    {mainDraft.extractedClaimsJson && (
                      <span className="text-xs text-blue-700 font-medium">
                        請求項抽出済み
                      </span>
                    )}
                  </div>
                  {mainDraft.parsedText && (
                    <div className="flex items-center gap-3 flex-wrap">
                      <ExtractClaimsButton
                        caseId={caseIdNum}
                        draftId={mainDraft.draftId}
                        hasExtracted={!!mainDraft.extractedClaimsJson}
                      />
                      <details className="flex-1 text-sm text-gray-700">
                        <summary className="cursor-pointer hover:text-gray-900">
                          統合後テキストを表示
                        </summary>
                        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">
                          {mainDraft.parsedText}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
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

              {keywordQueries.length > 0 && (
                <div className="space-y-2">
                  <p className="text-base font-medium text-gray-700">
                    キーワード検索用（コピペ可）
                  </p>
                  {keywordQueries.map(
                    (kq: { theme: string; keywords: string }, i: number) => (
                      <div
                        key={i}
                        className="rounded-lg border border-gray-200 px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-gray-600">
                            {kq.theme}
                          </p>
                          <CopyButton text={kq.keywords} />
                        </div>
                        <p className="mt-1 rounded bg-gray-50 p-3 text-base font-mono">
                          {kq.keywords}
                        </p>
                      </div>
                    )
                  )}
                </div>
              )}

              {hasSearchExpansionHints && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-base text-amber-950">
                  <div>
                    <p className="font-medium">
                      検索漏れ対策（表記ゆれ・社名変遷）
                    </p>
                    <p className="mt-1 text-sm text-amber-900">
                      メイン検索式に詰め込みすぎず、追加確認用の候補として使います。社名変遷は断定ではなく確認候補です。
                    </p>
                  </div>

                  {spellingVariants.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm font-medium text-amber-900">
                        表記ゆれ候補
                      </p>
                      {spellingVariants.map((item, i) => (
                        <div key={i} className="rounded border border-amber-200 bg-white px-3 py-2">
                          <p className="font-medium">
                            {item.baseTerm ?? "確認語"}
                          </p>
                          {item.variants && item.variants.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {item.variants.map((variant, variantIndex) => (
                                <span
                                  key={variantIndex}
                                  className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-900"
                                >
                                  {variant}
                                </span>
                              ))}
                            </div>
                          )}
                          {item.reason && (
                            <p className="mt-1 text-sm text-gray-700">
                              {item.reason}
                            </p>
                          )}
                          {item.suggestedUse && (
                            <p className="mt-1 text-sm text-gray-600">
                              使い方: {item.suggestedUse}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {companyNameHints.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm font-medium text-amber-900">
                        社名変遷・出願人名ゆれ候補
                      </p>
                      {companyNameHints.map((item, i) => (
                        <div key={i} className="rounded border border-amber-200 bg-white px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">
                              {item.observedName ?? "確認対象"}
                            </p>
                            {item.confidence && (
                              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                                confidence: {item.confidence}
                              </span>
                            )}
                            <span
                              className={`rounded px-2 py-0.5 text-xs ${
                                item.source === "dictionary"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-amber-100 text-amber-900"
                              }`}
                            >
                              {item.source === "dictionary"
                                ? "辞書候補"
                                : "AI推定"}
                            </span>
                          </div>
                          {item.relatedNames && item.relatedNames.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {item.relatedNames.map((name, nameIndex) => (
                                <span
                                  key={nameIndex}
                                  className="rounded bg-sky-50 px-2 py-0.5 text-sm text-sky-800"
                                >
                                  {name}
                                </span>
                              ))}
                            </div>
                          )}
                          {item.reason && (
                            <p className="mt-1 text-sm text-gray-700">
                              {item.reason}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {additionalKeywordQueries.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm font-medium text-amber-900">
                        追加で試す検索
                      </p>
                      {additionalKeywordQueries.map((query, i) => (
                        <div key={i} className="rounded border border-amber-200 bg-white px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-gray-700">
                              {query.theme ?? "追加検索"}
                            </p>
                            <CopyButton text={query.keywords ?? ""} />
                          </div>
                          <p className="mt-1 rounded bg-gray-50 p-2 font-mono text-sm">
                            {query.keywords}
                          </p>
                          {query.note && (
                            <p className="mt-1 text-sm text-gray-600">
                              {query.note}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {leakageRisks.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm font-medium text-amber-900">
                        検索漏れリスク
                      </p>
                      <ul className="ml-4 mt-1 list-disc text-sm text-gray-700">
                        {leakageRisks.map((risk, i) => (
                          <li key={i}>{risk}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

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
                    {excludedTerms.length > 0 && (
                      <p>
                        <span className="font-medium">除外語:</span>{" "}
                        {excludedTerms.join(", ")}
                      </p>
                    )}
                    {rationaleItems.length > 0 && (
                      <ul className="ml-4 list-disc">
                        {rationaleItems.map(
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

      {/* ── Step 4: 先行技術文献の取り込み ── */}
      {extracted && (
        <section
          id="step-4"
          className={`mt-6 scroll-mt-36 rounded-xl border-2 px-6 py-5 ${stepCardClass(4)}`}
        >
          <h2 className="text-xl font-bold">4. 先行技術文献の取り込み</h2>
          <p className="mt-2 text-sm text-gray-600">
            方法 A と方法 B は併用可。どちらか一方だけでも分析に進めます。
          </p>

          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-500 mb-2">方法A: J-PlatPat 検索結果 CSV（Step 3 の検索式を使用）</p>
              <UploadCsvForm caseId={caseIdNum} />
            </div>
            <div className="rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-500 mb-2">方法B: 個別の特許文献ファイル（検索式なしで直接取り込み可）</p>
              <UploadPatentFilesForm caseId={caseIdNum} />
            </div>
          </div>

          {priorArts.length > 0 && (
            <div className="mt-4">
              <PriorArtTable caseId={caseIdNum} priorArts={priorArts} />
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
                  const detail = parseJsonOrNull<MatchedElementDetail>(
                    r.matchedElementsJson,
                    `comparisonResult.${r.resultId}.matchedElementsJson`
                  );
                  const matchedElements = detail?.matched ?? [];
                  const unmatchedElements = detail?.unmatched ?? [];
                  const overall =
                    0.3 * (r.lexicalScore ?? 0) +
                    0.35 * (detail?.elementScore ?? 0) +
                    0.2 * (r.semanticScore ?? 0) +
                    0.15 * (r.structuralScore ?? 0);
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

                      {matchedElements.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {matchedElements.map((m: string, i: number) => (
                            <span
                              key={i}
                              className="rounded bg-red-50 px-2.5 py-1 text-sm text-red-700 border border-red-200"
                            >
                              一致: {m}
                            </span>
                          ))}
                        </div>
                      )}

                      {unmatchedElements.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {unmatchedElements.map((u: string, i: number) => (
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
