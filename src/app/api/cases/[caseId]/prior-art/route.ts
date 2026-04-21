import { NextResponse } from "next/server";
import { caseRepo, priorArtDocumentRepo } from "@/repositories";
import { parseJPlatPatCsv } from "@/lib/parse-jplatpat-csv";
import { parseFile } from "@/lib/parse-file";

export const maxDuration = 60;

const PATENT_EXTS = ["pdf", "docx", "txt"];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const rows = await priorArtDocumentRepo.findByCaseId(Number(caseId));
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
  const files = formData.getAll("file") as File[];
  if (files.length === 0) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  let totalImported = 0;
  const errors: string[] = [];

  for (const file of files) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "csv") {
      // CSV: 既存の J-PlatPat CSV パース処理
      const csvText = await file.text();
      const parsed = parseJPlatPatCsv(csvText);
      if (parsed.length === 0) {
        errors.push(`${file.name}: 有効なレコードがありません`);
        continue;
      }
      const count = await priorArtDocumentRepo.createMany(
        parsed.map((r) => ({
          caseId: caseIdNum,
          publicationNo: r.publicationNo,
          title: r.title,
          abstract: r.abstract,
          claimsText: null,
          sourceCsvRowJson: JSON.stringify(r.rawRow),
          normalizedElementsJson: null,
        }))
      );
      totalImported += count;
    } else if (PATENT_EXTS.includes(ext)) {
      // 個別特許ファイル: テキスト抽出して1件として登録
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const text = await parseFile(buffer, ext);
        if (!text.trim()) {
          errors.push(`${file.name}: テキストを抽出できませんでした`);
          continue;
        }
        const count = await priorArtDocumentRepo.createMany([
          {
            caseId: caseIdNum,
            publicationNo: null,
            title: file.name.replace(/\.[^.]+$/, ""),
            abstract: null,
            claimsText: text,
            sourceCsvRowJson: null,
            normalizedElementsJson: null,
          },
        ]);
        totalImported += count;
      } catch (err) {
        console.error(`parseFile failed: ${file.name}`, err);
        errors.push(`${file.name}: ファイルの読み取りに失敗しました`);
      }
    } else {
      errors.push(`${file.name}: 非対応の形式です（CSV, PDF, DOCX, TXT のみ）`);
    }
  }

  if (totalImported === 0 && errors.length > 0) {
    return NextResponse.json(
      { error: errors.join("\n") },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { imported: totalImported, errors: errors.length > 0 ? errors : undefined },
    { status: 201 }
  );
}
