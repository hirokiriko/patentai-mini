import { NextResponse } from "next/server";
import { db } from "@/db";
import { cases, draftPatents, searchQuerySets } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateQueries } from "@/lib/generate-queries";
import type { ExtractedClaims } from "@/lib/extract-claims";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const rows = await db
    .select()
    .from(searchQuerySets)
    .where(eq(searchQuerySets.caseId, Number(caseId)))
    .orderBy(desc(searchQuerySets.querySetId));

  return NextResponse.json(rows);
}

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

  const extracted: ExtractedClaims = JSON.parse(draft.extractedClaimsJson);
  const queries = await generateQueries(extracted);

  const [row] = await db
    .insert(searchQuerySets)
    .values({
      caseId: caseIdNum,
      broadQuery: queries.broadQuery,
      balancedQuery: queries.balancedQuery,
      narrowQuery: queries.narrowQuery,
      rationaleJson: JSON.stringify({
        keywordGroups: queries.keywordGroups,
        excludedTerms: queries.excludedTerms,
        rationale: queries.rationale,
      }),
    })
    .returning();

  return NextResponse.json(row, { status: 201 });
}
