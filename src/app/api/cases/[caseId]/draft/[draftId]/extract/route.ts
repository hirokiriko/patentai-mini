import { NextResponse } from "next/server";
import { draftPatentRepo } from "@/repositories";
import { extractClaims } from "@/lib/extract-claims";

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

  const claims = await extractClaims(draft.parsedText);

  const updated = await draftPatentRepo.updateExtractedClaims(
    Number(draftId),
    JSON.stringify(claims)
  );

  return NextResponse.json(updated);
}
