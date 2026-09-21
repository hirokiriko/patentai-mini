import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BlobServiceClient } from "@azure/storage-blob";
import { requireManual } from "./manual-cli-config";
import type { CloudConfiguration } from "./cloud-config";

export interface CloudBlobBoundary {
  assertPrivate(): Promise<void>;
  read(name: string, bytes: number, etag: string): Promise<Buffer>;
  download(name: string, bytes: number, etag: string, path: string): Promise<string>;
  create(name: string, bytes: Buffer): Promise<string>;
  replace(name: string, bytes: Buffer, etag: string): Promise<string>;
}

/** Only ACA's injected loopback identity endpoint is admitted; there is no credential fallback. */
export function cloudManagedIdentity(config: CloudConfiguration, env: Record<string, string | undefined> = process.env, signal?: AbortSignal) {
  const endpoint = new URL(env.IDENTITY_ENDPOINT ?? "");
  requireManual(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
    endpoint.pathname === "/msi/token" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
    typeof env.IDENTITY_HEADER === "string" && env.IDENTITY_HEADER.length > 0);
  endpoint.searchParams.set("api-version", "2019-08-01");
  endpoint.searchParams.set("resource", "https://storage.azure.com/");
  if (config.managedIdentityClientId) endpoint.searchParams.set("client_id", config.managedIdentityClientId);
  let cached: { token: string; expiresOnTimestamp: number } | undefined;
  return { async getToken() {
    if (cached && cached.expiresOnTimestamp > Date.now() + 120_000) return cached;
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(endpoint, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER! } });
    requireManual(response.ok);
    const value = await response.json() as { access_token?: unknown; expires_on?: unknown; resource?: unknown };
    requireManual(typeof value.access_token === "string" && value.access_token.length > 0 && value.access_token.length < 32768 &&
      value.resource === "https://storage.azure.com/");
    const expiry = Number(value.expires_on) * 1000;
    requireManual(Number.isFinite(expiry) && expiry > Date.now() + 30_000);
    cached = { token: value.access_token, expiresOnTimestamp: expiry }; return cached;
  } };
}

export function createCloudBlobBoundary(config: CloudConfiguration, signal: AbortSignal): CloudBlobBoundary {
  const service = new BlobServiceClient(`https://${config.storageAccount}.blob.core.windows.net`,
    cloudManagedIdentity(config, process.env, signal), { retryOptions: { maxTries: 1, tryTimeoutInMs: 60_000 } });
  const container = service.getContainerClient(config.container);
  const options = { abortSignal: signal };
  const etagOf = (value: { etag?: string }) => { requireManual(typeof value.etag === "string" && /^"[A-Za-z0-9]+"$/.test(value.etag)); return value.etag; };
  const stream = async (name: string, bytes: number, etag: string) => {
    const blob = container.getBlobClient(name);
    const properties = await blob.getProperties({ ...options, conditions: { ifMatch: etag } });
    requireManual(properties.contentLength === bytes && properties.etag === etag && !properties.contentEncoding);
    const response = await blob.download(0, undefined, { ...options, conditions: { ifMatch: etag }, maxRetryRequests: 0 });
    requireManual(response.contentLength === bytes && response.etag === etag && response.readableStreamBody);
    return response.readableStreamBody;
  };
  return {
    async assertPrivate() { requireManual((await container.getProperties(options)).blobPublicAccess === undefined); },
    async read(name, bytes, etag) {
      requireManual(bytes <= 131072);
      const source = await stream(name, bytes, etag), parts: Buffer[] = []; let length = 0;
      try { for await (const chunk of source) { const b = Buffer.from(chunk); length += b.length; requireManual(length <= bytes); parts.push(b); } }
      finally { source.destroy(); }
      requireManual(length === bytes); return Buffer.concat(parts);
    },
    async download(name, bytes, etag, path) {
      const source = await stream(name, bytes, etag), hash = createHash("sha256"); let length = 0;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        length += chunk.length;
        if (length > bytes) callback(Error("cloud_source_stopped"));
        else { hash.update(chunk); callback(null, chunk); }
      } });
      await pipeline(source, bound, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
      requireManual(length === bytes); return hash.digest("hex");
    },
    async create(name, bytes) {
      requireManual(bytes.length <= 1024 * 1024);
      return etagOf(await container.getBlockBlobClient(name).uploadData(bytes, { ...options,
        conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" } }));
    },
    async replace(name, bytes, etag) {
      requireManual(bytes.length <= 1024 * 1024);
      return etagOf(await container.getBlockBlobClient(name).uploadData(bytes, { ...options,
        conditions: { ifMatch: etag }, blobHTTPHeaders: { blobContentType: "application/x-ndjson" } }));
    },
  };
}
