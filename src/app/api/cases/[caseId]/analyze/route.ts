import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  cases,
  draftPatents,
  priorArtDocuments,
  comparisonResults,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { screenPriorArt, analyzeOverlap } from "@/lib/analyze-overlap";
import type { ExtractedClaims } from "@/lib/extract-claims";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  // Case 存在確認
  const [caseRow] = await db
    .select()
    .from(cases)
    .where(eq(cases.caseId, caseIdNum));
  if (!caseRow) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  // 抽出済みドラフトを取得
  const drafts = await db
    .select()
    .from(draftPatents)
    .where(eq(draftPatents.caseId, caseIdNum));
  const draft = drafts.find((d) => d.extractedClaimsJson);
  if (!draft?.extractedClaimsJson) {
    return NextResponse.json(
      { error: "請求項の抽出が完了していません" },
      { status: 400 }
    );
  }

  // 先行技術文献を取得
  const priorArts = await db
    .select()
    .from(priorArtDocuments)
    .where(eq(priorArtDocuments.caseId, caseIdNum));
  if (priorArts.length === 0) {
    return NextResponse.json(
      { error: "先行技術文献が取り込まれていません" },
      { status: 400 }
    );
  }

  const extracted: ExtractedClaims = JSON.parse(draft.extractedClaimsJson);

  // Step 1: スクリーニング
  const { relevantDocIds, reasoning } = await screenPriorArt(
    extracted,
    priorArts.map((pa) => ({
      docId: pa.docId,
      publicationNo: pa.publicationNo,
      title: pa.title,
      abstract: pa.abstract,
    }))
  );

  // Step 2: 詳細分析
  const relevantDocs = priorArts.filter((pa) =>
    relevantDocIds.includes(pa.docId)
  );

  if (relevantDocs.length === 0) {
    return NextResponse.json({
      screening: { reasoning, candidateCount: 0 },
      results: [],
    });
  }

  const results = await analyzeOverlap(extracted, relevantDocs);

  // 既存の分析結果を削除して新しい結果を保存
  await db
    .delete(comparisonResults)
    .where(eq(comparisonResults.caseId, caseIdNum));

  const inserted = await db
    .insert(comparisonResults)
    .values(
      results.map((r) => ({
        caseId: caseIdNum,
        draftClaimId: String(r.draftClaimNo),
        priorDocId: r.priorDocId,
        lexicalScore: r.lexicalScore,
        semanticScore: r.semanticScore,
        structuralScore: r.structuralScore,
        matchedElementsJson: JSON.stringify({
          matched: r.matchedElements,
          unmatched: r.unmatchedElements,
          explanation: r.explanation,
          elementScore: r.elementScore,
        }),
        riskLabel: r.riskLabel,
      }))
    )
    .returning();

  return NextResponse.json({
    screening: { reasoning, candidateCount: relevantDocs.length },
    results: inserted.length,
  });
}
