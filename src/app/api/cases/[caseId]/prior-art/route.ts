import { NextResponse } from "next/server";
import { caseRepo, priorArtDocumentRepo } from "@/repositories";
import { parseJPlatPatCsv } from "@/lib/parse-jplatpat-csv";

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
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const csvText = await file.text();
  const parsed = parseJPlatPatCsv(csvText);

  if (parsed.length === 0) {
    return NextResponse.json(
      { error: "CSV に有効なレコードがありません" },
      { status: 400 }
    );
  }

  const count = await priorArtDocumentRepo.createMany(
    parsed.map((r) => ({
      caseId: caseIdNum,
      docId: 0, // auto-increment
      publicationNo: r.publicationNo,
      title: r.title,
      abstract: r.abstract,
      claimsText: null,
      sourceCsvRowJson: JSON.stringify(r.rawRow),
      normalizedElementsJson: null,
    }))
  );

  return NextResponse.json({ imported: count }, { status: 201 });
}
