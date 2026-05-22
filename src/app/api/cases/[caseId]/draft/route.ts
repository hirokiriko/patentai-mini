import { NextResponse } from "next/server";
import { caseRepo, draftPatentRepo } from "@/repositories";
import { storeOriginalFile } from "@/lib/blob-storage";
import { parseFile } from "@/lib/parse-file";

export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const rows = await draftPatentRepo.findByCaseId(Number(caseId));
  return NextResponse.json(rows);
}

export async function POST(
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
  const storedFile = await storeOriginalFile({
    caseId: caseIdNum,
    category: "drafts",
    kind,
    fileName: file.name,
    buffer,
    contentType: file.type,
  });

  let parsedText: string | null = null;
  try {
    parsedText = await parseFile(buffer, ext!);
  } catch {
    // 抽出失敗してもレコードは作成する
  }

  const row = await draftPatentRepo.create({
    caseId: caseIdNum,
    kind,
    sourceFilePath: storedFile?.blobName ?? file.name,
    parsedText,
  });

  return NextResponse.json(row, { status: 201 });
}
