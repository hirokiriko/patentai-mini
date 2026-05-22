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

export type BlobCleanupResult = {
  attempted: number;
  deleted: number;
  failed: string[];
  skipped: boolean;
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

export function isOriginalFileBlobName(value: string, caseId?: number): boolean {
  const prefix = caseId === undefined ? "cases/" : `cases/${caseId}/`;
  return value.startsWith(prefix);
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

export async function deleteOriginalFiles(blobNames: string[]): Promise<BlobCleanupResult> {
  const uniqueBlobNames = [...new Set(blobNames)].filter((name) => isOriginalFileBlobName(name));

  const config = getBlobConfig();
  if (!config || uniqueBlobNames.length === 0) {
    return {
      attempted: uniqueBlobNames.length,
      deleted: 0,
      failed: [],
      skipped: !config,
    };
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString);
  const containerClient = blobServiceClient.getContainerClient(config.containerName);
  const failed: string[] = [];
  let deleted = 0;

  for (const blobName of uniqueBlobNames) {
    try {
      const response = await containerClient.getBlobClient(blobName).deleteIfExists({
        deleteSnapshots: "include",
      });
      if (response.succeeded) {
        deleted++;
      }
    } catch (error) {
      console.error(`[blob-storage] Failed to delete blob ${blobName}:`, error);
      failed.push(blobName);
    }
  }

  return {
    attempted: uniqueBlobNames.length,
    deleted,
    failed,
    skipped: false,
  };
}
