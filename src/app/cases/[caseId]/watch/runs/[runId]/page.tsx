import Link from "next/link";
import { notFound } from "next/navigation";

import { caseRepo, patentWatchRepo } from "@/repositories";
import {
  boundedPatentWatchPublicText,
  sanitizePatentWatchAnalysis,
} from "@/lib/patent-watch/domain";
import type { CaseWatchFinding } from "@/lib/patent-watch/types";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";
const POSTGRES_INTEGER_MAX = 2_147_483_647;

type AnalysisView = {
  matchedElements: string[];
  unmatchedElements: string[];
  explanation: string;
};

function positiveInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= POSTGRES_INTEGER_MAX
    ? parsed
    : null;
}

function parseAnalysis(value: string): AnalysisView {
  try {
    const parsed = JSON.parse(value) as Partial<AnalysisView>;
    if (
      !Array.isArray(parsed.matchedElements) ||
      !parsed.matchedElements.every((item) => typeof item === "string") ||
      !Array.isArray(parsed.unmatchedElements) ||
      !parsed.unmatchedElements.every((item) => typeof item === "string") ||
      typeof parsed.explanation !== "string"
    ) {
      throw new Error("invalid analysis");
    }
    return sanitizePatentWatchAnalysis({
      matchedElements: parsed.matchedElements,
      unmatchedElements: parsed.unmatchedElements,
      explanation: parsed.explanation,
    });
  } catch {
    return {
      matchedElements: [],
      unmatchedElements: [],
      explanation: "人による確認が必要な比較候補です。",
    };
  }
}

function dateTimeLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "long",
        timeStyle: "short",
      }).format(date);
}

function publicationDateLabel(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`
    : value;
}

function scoreLabel(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function FindingReport({ finding }: { finding: CaseWatchFinding }) {
  const analysis = parseAnalysis(finding.analysisJson);

  return (
    <article className="break-inside-avoid rounded-lg border border-gray-300 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">
          {boundedPatentWatchPublicText(finding.publicationNumber, 100)}
        </span>
        <span>{publicationDateLabel(finding.publicationDate)}</span>
        <span className="rounded border border-gray-300 px-2 py-0.5 text-xs">
          {finding.kind}
        </span>
        <span className="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold">
          {finding.riskLabel}
        </span>
        <span className="rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs">
          {finding.analysisMode}
        </span>
      </div>
      <h3 className="mt-2 text-lg font-semibold">
        {boundedPatentWatchPublicText(finding.inventionTitle, 500)}
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><dt className="text-gray-500">語彙</dt><dd>{scoreLabel(finding.lexicalScore)}</dd></div>
        <div><dt className="text-gray-500">要素</dt><dd>{scoreLabel(finding.elementScore)}</dd></div>
        <div><dt className="text-gray-500">意味</dt><dd>{scoreLabel(finding.semanticScore)}</dd></div>
        <div><dt className="text-gray-500">構造</dt><dd>{scoreLabel(finding.structuralScore)}</dd></div>
      </dl>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <h4 className="text-sm font-semibold text-rose-800">一致候補</h4>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {analysis.matchedElements.length > 0 ? (
              analysis.matchedElements.map((item, index) => (
                <li key={index}>{item}</li>
              ))
            ) : (
              <li>明示された候補はありません</li>
            )}
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold text-emerald-800">差分候補</h4>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {analysis.unmatchedElements.length > 0 ? (
              analysis.unmatchedElements.map((item, index) => (
                <li key={index}>{item}</li>
              ))
            ) : (
              <li>明示された候補はありません</li>
            )}
          </ul>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-gray-700">
        {analysis.explanation}
      </p>
      <p className="mt-2 text-xs text-gray-500">
        確認状態: {finding.reviewStatus === "reviewed" ? "確認済み" : "未確認"}
      </p>
    </article>
  );
}

export default async function PatentWatchReportPage({
  params,
}: {
  params: Promise<{ caseId: string; runId: string }>;
}) {
  const values = await params;
  const caseId = positiveInteger(values.caseId);
  const runId = positiveInteger(values.runId);
  if (caseId === null || runId === null) notFound();

  if (!(await caseRepo.findById(caseId))) notFound();

  let report:
    | {
        run: NonNullable<Awaited<ReturnType<typeof patentWatchRepo.getRun>>>;
        findings: CaseWatchFinding[];
      }
    | null = null;
  let unavailable = false;

  try {
    const run = await patentWatchRepo.getRun(caseId, runId);
    if (run) {
      report = {
        run,
        findings: await patentWatchRepo.listFindings(caseId, {
          runId,
          limit: 100,
        }),
      };
    }
  } catch {
    unavailable = true;
  }

  if (!unavailable && !report) notFound();

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <style>{`
        @media print {
          nav, button, .print-hidden { display: none !important; }
          body { background: white !important; color: black !important; }
          main { max-width: none !important; padding: 0 !important; }
          article { break-inside: avoid; }
        }
      `}</style>
      <div className="print-hidden mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/cases/${caseId}`} className="text-indigo-700 underline">
          案件へ戻る
        </Link>
        <PrintButton />
      </div>

      <header className="border-b border-gray-300 pb-5">
        <p className="text-sm text-gray-500">出願後ウォッチング</p>
        <h1 className="mt-1 text-3xl font-bold">
          案件 #{caseId} の監視レポート
        </h1>
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          本レポートは確認候補を整理するもので、法的判断ではありません
        </p>
      </header>

      {unavailable || !report ? (
        <p className="mt-6 rounded border border-gray-300 px-4 py-3">
          この環境ではウォッチング機能がまだ利用可能になっていません
        </p>
      ) : (
        <>
          <section className="mt-6 rounded-lg border border-gray-300 p-4">
            <h2 className="text-lg font-semibold">監視実行サマリー</h2>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-gray-500">run日時</dt><dd>{dateTimeLabel(report.run.completedAt ?? report.run.startedAt)}</dd></div>
              <div><dt className="text-gray-500">対象公報数</dt><dd>{report.run.scannedDocumentCount}件</dd></div>
              <div><dt className="text-gray-500">新着候補数</dt><dd>{report.run.newFindingCount}件</dd></div>
              <div><dt className="text-gray-500">fallback</dt><dd>{report.run.fallbackFindingCount > 0 ? `あり（${report.run.fallbackFindingCount}件）` : "なし"}</dd></div>
            </dl>
          </section>

          <section className="mt-6 space-y-4">
            <h2 className="text-xl font-bold">確認候補</h2>
            {report.findings.length > 0 ? (
              report.findings.map((finding) => (
                <FindingReport key={finding.findingId} finding={finding} />
              ))
            ) : (
              <p className="text-sm text-gray-600">このrunで追加された確認候補はありません。</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
