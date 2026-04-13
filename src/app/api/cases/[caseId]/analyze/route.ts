import { NextResponse } from "next/server";
import {
  caseRepo,
  draftPatentRepo,
  priorArtDocumentRepo,
  comparisonResultRepo,
} from "@/repositories";
import { screenPriorArt, analyzeOverlap } from "@/lib/analyze-overlap";
import type { ExtractedClaims } from "@/lib/extract-claims";

export const maxDuration = 60;

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

  const priorArts = await priorArtDocumentRepo.findByCaseId(caseIdNum);
  if (priorArts.length === 0) {
    return NextResponse.json(
      { error: "先行技術文献が取り込まれていません" },
      { status: 400 }
    );
  }

  const extracted: ExtractedClaims = JSON.parse(draft.extractedClaimsJson);

  try {
    const { relevantDocIds, reasoning } = await screenPriorArt(
      extracted,
      priorArts.map((pa) => ({
        docId: pa.docId,
        publicationNo: pa.publicationNo,
        title: pa.title,
        abstract: pa.abstract ?? pa.claimsText,
      }))
    );

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

    const count = await comparisonResultRepo.replaceByCaseId(
      caseIdNum,
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
    );

    return NextResponse.json({
      screening: { reasoning, candidateCount: relevantDocs.length },
      results: count,
    });
  } catch (err) {
    console.error("[analyze] analysis failed:", err);
    const message = err instanceof Error ? err.message : "重なり分析中にエラーが発生しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
