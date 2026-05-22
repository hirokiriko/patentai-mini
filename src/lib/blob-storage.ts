import { randomUUID } from "crypto";
import { BlobServiceClient } from "@azure/storage-blob";

type BlobCategory = "drafts" | "prior-art";

type BlobConfig = {
  connectionString: string;
  containerName: string;
};

export type StoredOriginalFile = {
  blobName: string;
  originalFileName: string;
  contentType: string;
  size: number;
};

function getBlobConfig(): BlobConfig | null {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_BLOB_CONTAINER_NAME;

  if (!connectionString && !containerName) {
    return null;
  }

  const missing = [
    !connectionString ? "AZURE_STORAGE_CONNECTION_STRING" : null,
    !containerName ? "AZURE_BLOB_CONTAINER_NAME" : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Azure Blob Storage is partially configured. Missing: ${missing.join(", ")}`);
  }

  return {
    connectionString: connectionString!,
    containerName: containerName!,
  };
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.slice(0, 120) || "upload.bin";
}

export async function storeOriginalFile(params: {
  caseId: number;
  category: BlobCategory;
  fileName: string;
  buffer: Buffer;
  contentType?: string;
  kind?: string;
}): Promise<StoredOriginalFile | null> {
  const config = getBlobConfig();
  if (!config) {
    return null;
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString);
  const containerClient = blobServiceClient.getContainerClient(config.containerName);
  await containerClient.createIfNotExists();

  const safeName = sanitizeFileName(params.fileName);
  const kindSegment = params.kind ? `${sanitizeFileName(params.kind)}/` : "";
  const blobName = [
    "cases",
    String(params.caseId),
    params.category,
    `${kindSegment}${Date.now()}-${randomUUID()}-${safeName}`,
  ].join("/");

  const contentType = params.contentType || "application/octet-stream";
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(params.buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType,
    },
  });

  return {
    blobName,
    originalFileName: params.fileName,
    contentType,
    size: params.buffer.length,
  };
}
