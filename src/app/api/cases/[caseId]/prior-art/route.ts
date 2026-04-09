import { NextResponse } from "next/server";
import { db } from "@/db";
import { cases, priorArtDocuments } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { parseJPlatPatCsv } from "@/lib/parse-jplatpat-csv";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const rows = await db
    .select()
    .from(priorArtDocuments)
    .where(eq(priorArtDocuments.caseId, Number(caseId)))
    .orderBy(desc(priorArtDocuments.docId));

  return NextResponse.json(rows);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);

  // Case 存在確認
  const [caseRow] = await db
    .select()
    .from(cases)
    .where(eq(cases.caseId, caseIdNum));
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

  // 一括挿入
  const inserted = await db
    .insert(priorArtDocuments)
    .values(
      parsed.map((r) => ({
        caseId: caseIdNum,
        publicationNo: r.publicationNo,
        title: r.title,
        abstract: r.abstract,
        claimsText: null,
        sourceCsvRowJson: JSON.stringify(r.rawRow),
        normalizedElementsJson: null,
      }))
    )
    .returning();

  return NextResponse.json(
    { imported: inserted.length },
    { status: 201 }
  );
}
