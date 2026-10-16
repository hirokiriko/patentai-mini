import { withOwnerRoute } from "@/lib/owner-http";
import { NextResponse } from "next/server";
import { draftPatentRepo } from "@/repositories";
import { extractClaims, extractTrialClaims } from "@/lib/extract-claims";
import { trialConfigured } from "../../../../../../../lib/trial/policy";
import { runTrialExtraction } from "../../../../../../../lib/trial/extraction";
import { db } from "../../../../../../../db";
import { reserveTrialDatabase } from "../../../../../../../lib/trial/database-capacity";
import { trialHash } from "../../../../../../../lib/trial/ledger";

export const maxDuration = 60;

 async function handlePOST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string; draftId: string }> }
) {
  const { caseId, draftId } = await params;
  const draftIdNum = Number(draftId);

  const drafts = await draftPatentRepo.findByCaseId(Number(caseId));
  const draft = drafts.find((d) => d.draftId === draftIdNum);

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
    if (trialConfigured()) {
      if(draft.parsedText.length>15000)return NextResponse.json({error:"抽出演習の本文は15,000文字以内です"},{status:400});
      const capacity=await reserveTrialDatabase(db,`extract:${draftIdNum}:${trialHash(draft.parsedText)}`,256*1024);
      const updated = await runTrialExtraction(Number(caseId),draftIdNum,draft.parsedText,
        () => extractTrialClaims(draft.parsedText!), claims => draftPatentRepo.updateExtractedClaims(draftIdNum,JSON.stringify(claims)));
      await capacity.persisted();
      return NextResponse.json(updated);
    }
    const claims = await extractClaims(draft.parsedText);

    const updated = await draftPatentRepo.updateExtractedClaims(
      draftIdNum,
      JSON.stringify(claims)
    );

    return NextResponse.json(updated);
  } catch {
    console.error("[extract] extraction failed");
    const message = "請求項抽出中にエラーが発生しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withOwnerRoute(handlePOST);
