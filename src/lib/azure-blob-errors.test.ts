import { BlobServiceClient } from "@azure/storage-blob";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { isAzureBlobNotFound } from "./azure-blob-errors";

it("recognizes a real SDK HEAD 404 with an Azure error header and no response body", async () => {
  const service = new BlobServiceClient("https://fictional.blob.core.windows.net", {
    async getToken() { return { token: "FICTIONAL", expiresOnTimestamp: Date.now() + 3600_000 }; },
  }, { retryOptions: { maxTries: 1 }, httpClient: { async sendRequest(request) {
    expect(request.method).toBe("HEAD");
    const headers = request.headers.clone();
    for (const name of headers.headerNames()) headers.remove(name);
    headers.set("x-ms-error-code", "BlobNotFound");
    return { request, status: 404, headers, readableStreamBody: Readable.from([]), bodyAsText: "" };
  } } });
  const error = await service.getContainerClient("private-test").getBlobClient("absent.json").getProperties().catch(e => e);
  expect(error.statusCode).toBe(404);
  expect(error.code).toBeUndefined();
  expect(isAzureBlobNotFound(error)).toBe(true);
});
it.each([
  { statusCode: 404 },
  { statusCode: 403, code: "BlobNotFound" },
  { statusCode: 500, code: "BlobNotFound" },
  { statusCode: 404, code: "ContainerNotFound" },
  { statusCode: 404, code: "AuthorizationFailure", response: { headers: { get: () => "BlobNotFound" } } },
  { statusCode: 404, code: "BlobNotFound", response: { headers: { get: () => "ContainerNotFound" } } },
])("does not turn ambiguous or conflicting errors into an absent Blob %#", error => {
  expect(isAzureBlobNotFound(error)).toBe(false);
});
it("retains the SDK body-code form", () => {
  expect(isAzureBlobNotFound({ statusCode: 404, code: "BlobNotFound" })).toBe(true);
});
