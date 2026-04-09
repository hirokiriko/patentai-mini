import { NextResponse } from "next/server";
import { caseRepo, draftPatentRepo, searchQuerySetRepo } from "@/repositories";
import { generateQueries } from "@/lib/generate-queries";
import type { ExtractedClaims } from "@/lib/extract-claims";

export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const rows = await searchQuerySetRepo.findByCaseId(Number(caseId));
  return NextResponse.json(rows);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  const caseRow = await caseRepo.findById(caseIdNum);
  if (!caseRow) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const drafts = await draftPatentRepo.findByCaseId(caseIdNum);
  const draft = drafts.find((d) => d.extractedClaimsJson);
  if (!draft?.extractedClaimsJson) {
    return NextResponse.json(
      { error: "請求項の抽出が完了していません" },
      { status: 400 }
    );
  }

  const extracted: ExtractedClaims = JSON.parse(draft.extractedClaimsJson);

  try {
    const queries = await generateQueries(extracted);

    const row = await searchQuerySetRepo.create({
      caseId: caseIdNum,
      broadQuery: queries.broadQuery,
      balancedQuery: queries.balancedQuery,
      narrowQuery: queries.narrowQuery,
      rationaleJson: JSON.stringify({
        keywordGroups: queries.keywordGroups,
        excludedTerms: queries.excludedTerms,
        rationale: queries.rationale,
      }),
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error("[queries] generation failed:", err);
    const message = err instanceof Error ? err.message : "検索式生成中にエラーが発生しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
