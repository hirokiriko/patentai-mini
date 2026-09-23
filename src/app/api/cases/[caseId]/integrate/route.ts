import { withOwnerRoute } from "@/lib/owner-http";
import { NextResponse } from "next/server";
import { caseRepo, draftPatentRepo } from "@/repositories";
import { integrateClaims } from "@/lib/integrate-claims";
import { latestDraft } from "@/lib/current-draft";

export const maxDuration = 60;

 async function handlePOST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  const caseRow = await caseRepo.findById(caseIdNum);
  if (!caseRow) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (!caseRow.baseApplicationMode) {
    return NextResponse.json(
      { error: "this case is not in base application mode" },
      { status: 400 }
    );
  }

  const drafts = await draftPatentRepo.findByCaseId(caseIdNum);
  const base = latestDraft(drafts, "base");
  const addition = latestDraft(drafts, "addition");

  if (!base?.parsedText) {
    return NextResponse.json(
      { error: "ベース出願ファイルが未アップロード、またはテキスト抽出に失敗しています" },
      { status: 400 }
    );
  }
  if (!addition?.parsedText) {
    return NextResponse.json(
      { error: "新規事項ファイルが未アップロード、またはテキスト抽出に失敗しています" },
      { status: 400 }
    );
  }

  try {
    const { integratedText } = await integrateClaims({
      baseText: base.parsedText,
      additionText: addition.parsedText,
      baseApplicationNumber: caseRow.baseApplicationNumber,
    });

    const main = await draftPatentRepo.upsertMain({
      caseId: caseIdNum,
      sourceFilePath: `[統合: ${base.sourceFilePath ?? "base"} + ${addition.sourceFilePath ?? "addition"}]`,
      parsedText: integratedText,
    });

    return NextResponse.json(main);
  } catch {
    console.error("[integrate] failed");
    const message = "統合処理中にエラーが発生しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withOwnerRoute(handlePOST);
