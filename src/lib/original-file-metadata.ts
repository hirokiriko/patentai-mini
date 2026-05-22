export type UploadedOriginalFileMetadata = {
  source: "uploaded-file";
  originalFileName: string;
  blobName: string;
  contentType: string;
  size: number;
};

const BLOB_UPLOAD_PREFIX =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

export function isOriginalFileBlobName(value: string, caseId?: number): boolean {
  const prefix = caseId === undefined ? "cases/" : `cases/${caseId}/`;
  return value.startsWith(prefix);
}

export function getOriginalFileDisplayName(sourceFilePath: string | null): string | null {
  if (!sourceFilePath) {
    return null;
  }

  const fileName = sourceFilePath.split("/").pop() ?? sourceFilePath;
  return fileName.match(BLOB_UPLOAD_PREFIX)?.[1] ?? fileName;
}

export function parseUploadedOriginalFileMetadata(
  sourceCsvRowJson: string | null
): UploadedOriginalFileMetadata | null {
  if (!sourceCsvRowJson) {
    return null;
  }

  try {
    const metadata = JSON.parse(sourceCsvRowJson) as Partial<UploadedOriginalFileMetadata>;
    if (
      metadata.source === "uploaded-file" &&
      typeof metadata.originalFileName === "string" &&
      typeof metadata.blobName === "string" &&
      typeof metadata.contentType === "string" &&
      typeof metadata.size === "number"
    ) {
      return {
        source: metadata.source,
        originalFileName: metadata.originalFileName,
        blobName: metadata.blobName,
        contentType: metadata.contentType,
        size: metadata.size,
      };
    }
  } catch {
    return null;
  }

  return null;
}

