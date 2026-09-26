import { withOwnerRoute } from "@/lib/owner-http";
import { NextResponse } from "next/server";
import { deleteOriginalFiles } from "@/lib/blob-storage";
import { caseRepo, removeCaseWithOriginals } from "@/repositories";

 async function handleGET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const row = await caseRepo.findById(Number(caseId));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

 async function handlePATCH(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const body = await request.json();
  const row = await caseRepo.update(Number(caseId), body);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

 async function handleDELETE(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const caseIdNum = Number(caseId);
  const { deleted, blobNames } = await removeCaseWithOriginals(caseIdNum);
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });

  let blobCleanup;
  try {
    blobCleanup = await deleteOriginalFiles(blobNames);
  } catch {
    console.error("[case-delete] Blob cleanup failed");
    blobCleanup = {
      attempted: blobNames.length,
      deleted: 0,
      failed: blobNames,
      skipped: false,
    };
  }

  return NextResponse.json({ deleted: true, blobCleanup });
}

export const GET = withOwnerRoute(handleGET);
export const PATCH = withOwnerRoute(handlePATCH);
export const DELETE = withOwnerRoute(handleDELETE);
