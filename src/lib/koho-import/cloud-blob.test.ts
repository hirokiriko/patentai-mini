import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudFixture } from "../../../scripts/koho-cloud-import-fixtures";
import { managedCloudImportFixture } from "../../../scripts/managed-koho-cloud.test-support";
import { createCloudBlobBoundary } from "./cloud-blob";
import { sha256 } from "./cloud-config";

const transport = vi.hoisted(() => ({
  requests: [] as { timeout?: number; signal: AbortSignal; conditions: { ifMatch: string }; retries: number }[],
  metadata: [] as (number | undefined)[],
  body: vi.fn<() => Readable>(),
}));
vi.mock("@azure/storage-blob", () => ({ BlobServiceClient: class {
  constructor(_url: string, _identity: unknown, private options: { retryOptions: { maxTries: number; tryTimeoutInMs?: number } }) {}
  getContainerClient() {
    const options = this.options;
    return { getBlobClient: () => ({
      async getProperties() {
        transport.metadata.push(options.retryOptions.tryTimeoutInMs);
        return { contentLength: 9, etag: '"fictional"' };
      },
      async download(_offset: number, _count: number | undefined, input: {
        abortSignal: AbortSignal; conditions: { ifMatch: string }; maxRetryRequests: number;
      }) {
        expect(options.retryOptions.maxTries).toBe(1);
        transport.requests.push({ timeout: options.retryOptions.tryTimeoutInMs, signal: input.abortSignal,
          conditions: input.conditions, retries: input.maxRetryRequests });
        return { contentLength: 9, etag: '"fictional"', readableStreamBody: transport.body() };
      },
    }) };
  }
} }));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cloud-download-test-"));
  vi.stubEnv("IDENTITY_ENDPOINT", "http://127.0.0.1:1/msi/token");
  vi.stubEnv("IDENTITY_HEADER", "FICTIONAL");
  transport.requests.length = transport.metadata.length = 0;
  transport.body.mockImplementation(() => Readable.from([Buffer.from("fictional")]));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

it("keeps metadata limits while a full ZIP GET uses the service default and exact ETag/hash", async () => {
  const { config } = await managedCloudImportFixture(), job = new AbortController(), permit = new AbortController();
  const blob = createCloudBlobBoundary(config, job.signal), path = join(directory, "source.zip");
  expect(await blob.download("inputs/fictional.zip", 9, '"fictional"', path, permit.signal)).toBe(sha256("fictional"));
  expect(await readFile(path, "utf8")).toBe("fictional");
  expect(transport.requests[0]).toMatchObject({ timeout: undefined, conditions: { ifMatch: '"fictional"' }, retries: 0 });
  expect(await blob.read("manifest.json", 9, '"fictional"')).toEqual(Buffer.from("fictional"));
  expect(transport.requests[1].timeout).toBe(60_000);
  expect(transport.metadata).toEqual([60_000, 60_000]);
});

it("retains the legacy pilot's bulk server timeout", async () => {
  const { config } = await cloudFixture();
  await createCloudBlobBoundary(config, new AbortController().signal)
    .download("inputs/fictional.zip", 9, '"fictional"', join(directory, "source.zip"));
  expect(transport.requests[0].timeout).toBe(60_000);
});

it.each(["job", "permit"])("aborts an in-flight body on the %s deadline without another GET", async kind => {
  const { config } = await managedCloudImportFixture(), job = new AbortController(), permit = new AbortController();
  const body = new Readable({ read() {} });
  transport.body.mockImplementation(() => { setTimeout(() => (kind === "job" ? job : permit).abort(), 10); return body; });
  const blob = createCloudBlobBoundary(config, job.signal);
  await expect(blob.download("inputs/fictional.zip", 9, '"fictional"', join(directory, "source.zip"), permit.signal)).rejects.toThrow();
  expect(body.destroyed).toBe(true); expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0].signal.aborted).toBe(true);
});

it.each(["short", "long"])("rejects a %s body without retrying or returning a digest", async kind => {
  const { config } = await managedCloudImportFixture();
  transport.body.mockImplementation(() => Readable.from([Buffer.alloc(kind === "short" ? 8 : 10)]));
  await expect(createCloudBlobBoundary(config, new AbortController().signal)
    .download("inputs/fictional.zip", 9, '"fictional"', join(directory, "source.zip"))).rejects.toThrow();
  expect(transport.requests).toHaveLength(1);
});
