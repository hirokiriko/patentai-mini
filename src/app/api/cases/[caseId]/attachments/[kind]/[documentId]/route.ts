import { withOwnerRoute } from "@/lib/owner-http";
import { draftPatentRepo, priorArtDocumentRepo } from "@/repositories";
import { isScopedOriginalName, readOriginalFile } from "@/lib/blob-storage";
import { parseUploadedOriginalFileMetadata } from "@/lib/original-file-metadata";
import { managedCaseId } from "@/lib/patent-watch/managed-api";
export const runtime = "nodejs";
export const GET = withOwnerRoute(async (_request: Request, context: { params: Promise<{ caseId: string; kind: string; documentId: string }> }) => {
  const params = await context.params;
  let caseId: number, documentId: number;
  try { caseId = managedCaseId(params.caseId); documentId = managedCaseId(params.documentId); }
  catch { return Response.json({ error: "not_found" }, { status: 404 }); }
  let name: string | null = null;
  if (params.kind === "draft") name = (await draftPatentRepo.findByCaseId(caseId)).find(row => row.draftId === documentId && row.caseId === caseId)?.sourceFilePath ?? null;
  else if (params.kind === "prior-art") {
    const row = (await priorArtDocumentRepo.findByCaseId(caseId)).find(row => row.docId === documentId && row.caseId === caseId);
    name = parseUploadedOriginalFileMetadata(row?.sourceCsvRowJson ?? null)?.blobName ?? null;
  }
  const category = params.kind === "draft" ? "drafts" : "prior-art";
  if (!name || !isScopedOriginalName(name, caseId, category)) return Response.json({ error: "not_found" }, { status: 404 });
  const result = await readOriginalFile(caseId, category, name);
  const extension = result.contentType === "application/pdf" ? "pdf" : result.contentType.includes("wordprocessingml") ? "docx" : result.contentType === "text/plain" ? "txt" : result.contentType==="application/xml"?"xml":"bin";
  return new Response(new Uint8Array(result.bytes), { headers: { "Content-Type": result.contentType,
    "Content-Disposition": `attachment; filename="original-${documentId}.${extension}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
});
