import { withOwnerRoute } from "@/lib/owner-http";
import { NextResponse } from "next/server";
import { caseRepo, draftPatentRepo } from "@/repositories";
import { storeOriginalFile } from "@/lib/blob-storage";
import { isFileParseError, parseFile } from "@/lib/parse-file";
import { db } from "@/db";
import { withManagedOriginalUpload } from "@/repositories/managed-case-graph";

export const maxDuration = 60;

 async function handleGET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const rows = await draftPatentRepo.findByCaseId(Number(caseId));
  return NextResponse.json(rows);
}

 async function handlePOST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  const caseRow = await caseRepo.findById(caseIdNum);
  if (!caseRow) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (file.size < 1 || file.size > 50 * 1024**2) return NextResponse.json({ error: "ファイルは1バイト以上50MiB以下で指定してください" }, { status: 400 });

  const kindRaw = formData.get("kind");
  const kind =
    kindRaw === "base" || kindRaw === "addition" ? kindRaw : "main";

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "docx", "txt"].includes(ext ?? "")) {
    return NextResponse.json(
      { error: "対応形式: PDF, DOCX, TXT" },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let parsedText: string | null = null;
  try {
    parsedText = await parseFile(buffer, ext!);
  } catch (err) {
    if (isFileParseError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // 抽出失敗してもレコードは作成する
  }

  const row = await withManagedOriginalUpload(db, caseIdNum, async () => {
  const storedFile = await storeOriginalFile({
    caseId: caseIdNum,
    category: "drafts",
    kind,
    fileName: file.name,
    buffer,
    contentType: file.type,
  });

  return draftPatentRepo.create({
    caseId: caseIdNum,
    kind,
    sourceFilePath: storedFile?.blobName ?? file.name,
    parsedText,
  });
  });

  return NextResponse.json(row, { status: 201 });
}

export const GET = withOwnerRoute(handleGET);
export const POST = withOwnerRoute(handlePOST);
