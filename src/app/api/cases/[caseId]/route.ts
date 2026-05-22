import { NextResponse } from "next/server";
import { deleteOriginalFiles, isOriginalFileBlobName } from "@/lib/blob-storage";
import { parseUploadedOriginalFileMetadata } from "@/lib/original-file-metadata";
import { caseRepo, draftPatentRepo, priorArtDocumentRepo } from "@/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const row = await caseRepo.findById(Number(caseId));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const body = await request.json();
  const row = await caseRepo.update(Number(caseId), body);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);
  const [drafts, priorArts] = await Promise.all([
    draftPatentRepo.findByCaseId(caseIdNum),
    priorArtDocumentRepo.findByCaseId(caseIdNum),
  ]);
  const blobNames = [
    ...drafts
      .map((draft) => draft.sourceFilePath)
      .filter((value): value is string => !!value && isOriginalFileBlobName(value, caseIdNum)),
    ...priorArts
      .map((doc) => parseUploadedOriginalFileMetadata(doc.sourceCsvRowJson)?.blobName ?? null)
      .filter((value): value is string => !!value && isOriginalFileBlobName(value, caseIdNum)),
  ];

  const deleted = await caseRepo.remove(caseIdNum);
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });

  let blobCleanup;
  try {
    blobCleanup = await deleteOriginalFiles(blobNames);
  } catch (error) {
    console.error(`[case-delete] Blob cleanup failed for case ${caseIdNum}:`, error);
    blobCleanup = {
      attempted: blobNames.length,
      deleted: 0,
      failed: blobNames,
      skipped: false,
    };
  }

  return NextResponse.json({ deleted: true, blobCleanup });
}
