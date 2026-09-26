/** HEAD errors can carry the Azure service code only in the response headers.
 * A bare 404, a missing container, or an authorization failure is not absence. */
export function isAzureBlobNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("statusCode" in error) || error.statusCode !== 404) return false;
  const e = error as { code?: unknown; response?: { headers?: { get?: (name: string) => string | undefined } } };
  const header = e.response?.headers?.get?.("x-ms-error-code");
  if (e.code !== undefined && e.code !== "BlobNotFound") return false;
  if (header !== undefined && header !== "BlobNotFound") return false;
  return e.code === "BlobNotFound" || header === "BlobNotFound";
}
