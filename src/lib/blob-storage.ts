import { randomUUID } from "crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { isOriginalFileBlobName } from "./original-file-metadata";

export { isOriginalFileBlobName } from "./original-file-metadata";

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
    if (process.env.OWNER_AUTH_MODE === "azure-easy-auth") throw new Error("original_storage_unavailable");
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
  if (params.buffer.length < 1 || params.buffer.length > 50 * 1024**2) throw new Error("original_file_size_invalid");
  const config = getBlobConfig();
  if (!config) {
    return null;
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString, { retryOptions: { maxTries: 1, tryTimeoutInMs: 20_000 } });
  const containerClient = blobServiceClient.getContainerClient(config.containerName);
  await containerClient.createIfNotExists({ abortSignal: AbortSignal.timeout(20_000) });
  const properties = await containerClient.getProperties({ abortSignal: AbortSignal.timeout(20_000) });
  if (properties.blobPublicAccess) throw new Error("original_storage_unavailable");

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
    conditions: { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(20_000),
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: "private, no-store",
    },
  });

  return {
    blobName,
    originalFileName: params.fileName,
    contentType,
    size: params.buffer.length,
  };
}

export function isScopedOriginalName(name: string, caseId: number, category: BlobCategory): boolean {
  if (!Number.isSafeInteger(caseId) || caseId < 1) return false;
  const prefix = `cases/${caseId}/${category}/`;
  const tail = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  return /^(?:(?:main|base|addition)\/)?\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[\w.-]{1,120}$/i.test(tail) &&
    (category === "drafts" || !tail.includes("/"));
}
/** The caller obtains name from a case-bound DB row, never from a URL parameter. */
export async function readOriginalFile(caseId: number, category: BlobCategory, name: string) {
  if (!isScopedOriginalName(name, caseId, category)) throw new Error("original_not_found");
  const config = getBlobConfig(); if (!config) throw new Error("original_storage_unavailable");
  try {
    const container = BlobServiceClient.fromConnectionString(config.connectionString, { retryOptions: { maxTries: 1, tryTimeoutInMs: 20_000 } }).getContainerClient(config.containerName);
    const properties = await container.getProperties({ abortSignal: AbortSignal.timeout(20_000) });
    if (properties.blobPublicAccess) throw Error();
    const blob = container.getBlobClient(name), metadata = await blob.getProperties({ abortSignal: AbortSignal.timeout(20_000) });
    if (!Number.isSafeInteger(metadata.contentLength) || metadata.contentLength! < 0 || metadata.contentLength! > 50 * 1024**2 || !metadata.etag) throw Error();
    const bytes = metadata.contentLength === 0 ? Buffer.alloc(0) : await blob.downloadToBuffer(0, metadata.contentLength, { conditions: { ifMatch: metadata.etag }, abortSignal: AbortSignal.timeout(20_000) });
    if (bytes.length !== metadata.contentLength) throw Error();
    const contentType = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "application/xml"].includes(metadata.contentType ?? "") ? metadata.contentType! : "application/octet-stream";
    return { bytes, contentType };
  } catch { throw new Error("original_storage_unavailable"); }
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
    } catch {
      console.error("[blob-storage] scoped deletion failed");
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
