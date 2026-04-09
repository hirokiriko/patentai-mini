import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { cases } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const [row] = await db
    .select()
    .from(cases)
    .where(eq(cases.caseId, Number(caseId)));

  if (!row) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← 案件一覧
      </Link>

      <h1 className="mt-4 text-2xl font-bold">{row.title}</h1>
      <p className="mt-1 text-sm text-gray-500">
        ステータス: {row.status} ／ 作成日: {row.createdAt}
      </p>

      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">処理ステップ</h2>
        <ol className="list-decimal list-inside space-y-2 text-gray-600">
          <li>特許案をアップロード（未実装）</li>
          <li>請求項・構成要素を抽出（未実装）</li>
          <li>J-PlatPat 検索式を生成（未実装）</li>
          <li>検索結果 CSV をアップロード（未実装）</li>
          <li>重なり分析・リスクレポート（未実装）</li>
        </ol>
      </section>
    </main>
  );
}
