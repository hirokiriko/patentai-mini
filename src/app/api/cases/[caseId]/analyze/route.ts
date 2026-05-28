import { NextResponse } from "next/server";
import {
  caseRepo,
  draftPatentRepo,
  priorArtDocumentRepo,
  comparisonResultRepo,
} from "@/repositories";
import { screenPriorArt, analyzeOverlap } from "@/lib/analyze-overlap";
import type { ExtractedClaims } from "@/lib/extract-claims";
import { parseJsonOrNull } from "@/lib/safe-json";

export const maxDuration = 60;

type PriorArtForFallback = Awaited<
  ReturnType<typeof priorArtDocumentRepo.findByCaseId>
>[number];

function tokenize(value: string | null | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? "")
        .toLowerCase()
        .replace(/[()[\]{}"'`]/g, " ")
        .split(/[\s,.;:、。・/]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  );
}

function scoreOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const matches = left.filter((token) => rightSet.has(token)).length;
  return Math.min(1, Number((matches / Math.max(4, left.length)).toFixed(2)));
}

function fallbackAnalysisRows(
  caseId: number,
  extracted: ExtractedClaims,
  priorArts: PriorArtForFallback[]
) {
  const independentClaims = extracted.claims.filter((claim) => claim.isIndependent);
  const targetClaims = independentClaims.length > 0 ? independentClaims : extracted.claims;
  const docs = priorArts.slice(0, 5);

  return targetClaims.flatMap((claim) => {
    const claimText = [
      claim.text,
      ...claim.elements.map((element) => element.text),
    ].join(" ");
    const claimTokenList = tokenize(claimText);

    return docs.map((doc) => {
      const docText = [doc.title, doc.abstract, doc.claimsText]
        .filter(Boolean)
        .join(" ");
      const docTokenList = tokenize(docText);
      const lexicalScore = scoreOverlap(claimTokenList, docTokenList);
      const elementScore = Math.min(1, Number((lexicalScore + 0.1).toFixed(2)));
      const semanticScore = lexicalScore;
      const structuralScore = Math.max(0, Number((lexicalScore - 0.1).toFixed(2)));
      const matched = claimTokenList
        .filter((token) => docTokenList.includes(token))
        .slice(0, 8);

      return {
        caseId,
        draftClaimId: String(claim.claimNo),
        priorDocId: doc.docId,
        lexicalScore,
        semanticScore,
        structuralScore,
        matchedElementsJson: JSON.stringify({
          matched,
          unmatched: claim.elements.map((element) => element.text).slice(0, 8),
          explanation:
            "AI overlap analysis was temporarily unavailable. This deterministic fallback uses keyword overlap only and requires human review.",
          elementScore,
        }),
        riskLabel: lexicalScore >= 0.2 ? "Medium" : "Unknown",
      };
    });
  });
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

  const priorArts = await priorArtDocumentRepo.findByCaseId(caseIdNum);
  if (priorArts.length === 0) {
    return NextResponse.json(
      { error: "先行技術文献が取り込まれていません" },
      { status: 400 }
    );
  }

  const extracted = parseJsonOrNull<ExtractedClaims>(
    draft.extractedClaimsJson,
    `case.${caseIdNum}.extractedClaimsJson`
  );
  if (!extracted) {
    return NextResponse.json(
      { error: "請求項データの読み込みに失敗しました。もう一度、請求項抽出を実行してください。" },
      { status: 400 }
    );
  }

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
    const fallbackRows = fallbackAnalysisRows(caseIdNum, extracted, priorArts);
    const count = await comparisonResultRepo.replaceByCaseId(
      caseIdNum,
      fallbackRows
    );

    return NextResponse.json({
      screening: {
        reasoning:
          "AI analysis was temporarily unavailable, so deterministic keyword overlap fallback results were saved for human review.",
        candidateCount: priorArts.length,
      },
      results: count,
      fallback: true,
    });
  }
}
