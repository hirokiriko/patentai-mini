import { NextResponse } from "next/server";
import { draftPatentRepo } from "@/repositories";
import { extractClaims } from "@/lib/extract-claims";

export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string; draftId: string }> }
) {
  const { caseId, draftId } = await params;

  const drafts = await draftPatentRepo.findByCaseId(Number(caseId));
  const draft = drafts.find((d) => d.draftId === Number(draftId));

  if (!draft) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }

  if (!draft.parsedText) {
    return NextResponse.json(
      { error: "parsed text is empty — re-upload the file" },
      { status: 400 }
    );
  }

  try {
    const claims = await extractClaims(draft.parsedText);

    const updated = await draftPatentRepo.updateExtractedClaims(
      Number(draftId),
      JSON.stringify(claims)
    );

    return NextResponse.json(updated);
  } catch (err) {
    console.error("[extract] extraction failed:", err);
    const message = err instanceof Error ? err.message : "請求項抽出中にエラーが発生しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
