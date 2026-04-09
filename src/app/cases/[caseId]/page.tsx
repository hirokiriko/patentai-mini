import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { cases, draftPatents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { UploadDraftForm } from "./upload-draft-form";
import { basename } from "path";

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
                className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm"
              >
                <span className="text-green-600">✓</span>
                <span>
                  {d.sourceFilePath ? basename(d.sourceFilePath) : "（ファイル名不明）"}
                </span>
                {d.extractedClaimsJson && (
                  <span className="ml-auto text-xs text-green-600">
                    抽出済み
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 後続ステップ（未実装） */}
      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">処理ステップ</h2>
        <ol className="list-decimal list-inside space-y-2 text-gray-600" start={2}>
          <li>請求項・構成要素を抽出（未実装）</li>
          <li>J-PlatPat 検索式を生成（未実装）</li>
          <li>検索結果 CSV をアップロード（未実装）</li>
          <li>重なり分析・リスクレポート（未実装）</li>
        </ol>
      </section>
    </main>
  );
}
