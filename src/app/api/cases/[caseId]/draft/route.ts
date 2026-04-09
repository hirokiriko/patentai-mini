import { NextResponse } from "next/server";
import { caseRepo, draftPatentRepo } from "@/repositories";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { parseFile } from "@/lib/parse-file";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./data/uploads";

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

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "docx", "txt"].includes(ext ?? "")) {
    return NextResponse.json(
      { error: "Supported formats: pdf, docx, txt" },
      { status: 400 }
    );
  }

  const dir = join(UPLOAD_DIR, String(caseIdNum));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  let parsedText: string | null = null;
  try {
    parsedText = await parseFile(filePath);
  } catch {
    // 抽出失敗してもレコードは作成する
  }

  const row = await draftPatentRepo.create({
    caseId: caseIdNum,
    sourceFilePath: filePath,
    parsedText,
  });

  return NextResponse.json(row, { status: 201 });
}
