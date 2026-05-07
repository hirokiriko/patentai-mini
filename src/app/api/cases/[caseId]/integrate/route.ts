import { NextResponse } from "next/server";
import { caseRepo, draftPatentRepo } from "@/repositories";
import { integrateClaims } from "@/lib/integrate-claims";

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
  if (!caseRow.baseApplicationMode) {
    return NextResponse.json(
      { error: "this case is not in base application mode" },
      { status: 400 }
    );
  }

  const drafts = await draftPatentRepo.findByCaseId(caseIdNum);
  const base = drafts.find((d) => d.kind === "base");
  const addition = drafts.find((d) => d.kind === "addition");

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
  } catch (err) {
    console.error("[integrate] failed:", err);
    const message = err instanceof Error ? err.message : "統合処理中にエラーが発生しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
