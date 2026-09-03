import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMinimalFictionalPackage,
} from "../../src/lib/koho-package/__fixtures__/fictional-package";
import {
  createKohoManualImportPostHandler,
  withBoundedKohoTempSource,
} from "../../src/lib/koho-import/manual-api";
import type { KohoImportPlan } from "../../src/lib/koho-import";
import type { KohoImportSaveResult } from "../../src/repositories/types";
import {
  JOB_EXIT_CODES,
  readBoundedJson,
  readJobConfig,
  runKohoJob,
  startLoopbackApplication,
} from "./runner.mjs";
import {
  createLoopbackHttpServer,
  readLoopbackServerConfig,
  startLoopbackServer,
} from "./server.mjs";

const FICTIONAL_BLOB_SECRET = "FICTIONAL-SAS-SECRET-DO-NOT-LOG";
const FICTIONAL_DATABASE_SECRET = "FICTIONAL-DB-SECRET-DO-NOT-LOG";
const FICTIONAL_TOKEN = "FICTIONAL-INTERNAL-TOKEN-0123456789-ABCDEFG";
const HASH = "a".repeat(64);

function environment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    KOHO_JOB_BLOB_URL:
      `https://fictional.blob.core.windows.net/private/object.zip?` +
      `sp=r&sr=b&spr=https&se=2026-09-03T03%3A00%3A00Z&sig=${FICTIONAL_BLOB_SECRET}`,
    KOHO_JOB_PACKAGE_TYPE: "JPA",
    KOHO_JOB_EXPECTED_DOCUMENT_COUNT: "1",
    KOHO_JOB_EXPECTED_SOURCE_SHA256: HASH,
    KOHO_JOB_MAX_SOURCE_BYTES: "2000000",
    KOHO_JOB_TIMEOUT_SECONDS: "7200",
    KOHO_JOB_DATABASE_SCOPE: "issue-75-dedicated-staging",
    KOHO_JOB_EXPECTED_DATABASE_HOST:
      "fictional.postgres.database.azure.com:5432",
    KOHO_JOB_EXPECTED_DATABASE_NAME: "issue75_staging",
    DATABASE_URL:
      `postgres://runner:${FICTIONAL_DATABASE_SECRET}` +
      "@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=require",
    ...overrides,
  };
}

async function consumeBody(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  try {
    while (!(await reader.read()).done) {
      // Intentionally consume without retaining package bytes.
    }
  } finally {
    reader.releaseLock();
  }
}

function pendingResponseUntilAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(new Error("FICTIONAL-ABORTED"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function successfulPayload(packageType: "JPA" | "JPB" = "JPA") {
  return {
    packageType,
    packageStatus: "success",
    sourceSha256: HASH,
    importId: 1,
    documentCount: 1,
    savedDocumentCount: 1,
    amendmentCount: 0,
    nestedSt26Count: 0,
  };
}

function controllableApplication() {
  let resolveExit: (value: { code: number; signal: null }) => void = () => undefined;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    resolveExit = resolve;
  });
  return {
    application: {
      exited,
      stop: vi.fn(async () => undefined),
    },
    exit: (code = 1) => resolveExit({ code, signal: null }),
  };
}

function defaultDependencies(
  chunks: readonly Uint8Array[] = [new TextEncoder().encode("fictional")],
) {
  const child = controllableApplication();
  const removeTempRoot = vi.fn(async () => undefined);
  return {
    child,
    removeTempRoot,
    dependencies: {
      now: () => Date.parse("2026-09-03T00:00:00Z"),
      makeTempRoot: vi.fn(async () => "FICTIONAL-TEMP-ROOT"),
      removeTempRoot,
      startApplication: vi.fn(async () => child.application),
      downloadBlob: vi.fn(
        async (): Promise<{
          contentLength?: number;
          readableStreamBody: Readable;
        }> => ({
          contentLength: chunks.reduce(
            (sum, chunk) => sum + chunk.byteLength,
            0,
          ),
          readableStreamBody: Readable.from(chunks),
        }),
      ),
      sendImport: vi.fn(
        async ({
          body,
        }: {
          body: ReadableStream<Uint8Array>;
          signal: AbortSignal;
        }) => {
          await consumeBody(body);
          return Response.json(successfulPayload());
        },
      ),
      readMemorySample: vi.fn(async () => ({
        bytes: 123_456,
        source: "cgroup_peak",
      })),
      directoryBytes: vi.fn(async () => 0),
      randomToken: () => FICTIONAL_TOKEN,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("koho one-shot job configuration", () => {
  it.each(["JPA", "JPB"] as const)(
    "accepts an explicit %s package with a read-only object SAS and staging identity",
    (packageType) => {
      const config = readJobConfig(
        environment({ KOHO_JOB_PACKAGE_TYPE: packageType }),
        Date.parse("2026-09-03T00:00:00Z"),
      );

      expect(config.packageType).toBe(packageType);
      expect(config.expectedDocumentCount).toBe(1);
      expect(config.maxSourceBytes).toBe(2_000_000);
      expect(config.timeoutMilliseconds).toBe(7_200_000);
      expect(config.operationTimeoutMilliseconds).toBe(7_190_000);
      expect(config.expectedSourceSha256).toBe(HASH);
      expect(config.loopbackPort).toBe(3_000);
    },
  );

  it.each([
    "KOHO_JOB_BLOB_URL",
    "KOHO_JOB_PACKAGE_TYPE",
    "KOHO_JOB_EXPECTED_DOCUMENT_COUNT",
    "KOHO_JOB_EXPECTED_SOURCE_SHA256",
    "KOHO_JOB_MAX_SOURCE_BYTES",
    "KOHO_JOB_TIMEOUT_SECONDS",
    "KOHO_JOB_DATABASE_SCOPE",
    "KOHO_JOB_EXPECTED_DATABASE_HOST",
    "KOHO_JOB_EXPECTED_DATABASE_NAME",
    "DATABASE_URL",
  ])("fails closed when %s is missing", (name) => {
    expect(() =>
      readJobConfig(
        environment({ [name]: undefined }),
        Date.parse("2026-09-03T00:00:00Z"),
      ),
    ).toThrow("invalid_config");
  });

  it.each([
    { KOHO_JOB_PACKAGE_TYPE: "jpa" },
    { KOHO_JOB_EXPECTED_DOCUMENT_COUNT: "0" },
    { KOHO_JOB_EXPECTED_DOCUMENT_COUNT: "1.5" },
    { KOHO_JOB_MAX_SOURCE_BYTES: "68719476737" },
    { KOHO_JOB_TIMEOUT_SECONDS: "7201" },
    { KOHO_JOB_TIMEOUT_SECONDS: "10" },
    { KOHO_JOB_EXPECTED_SOURCE_SHA256: "A".repeat(64) },
    { KOHO_JOB_EXPECTED_SOURCE_SHA256: "a".repeat(63) },
    { KOHO_JOB_LOOPBACK_PORT: "80" },
    { KOHO_JOB_DATABASE_SCOPE: "production" },
    {
      KOHO_JOB_EXPECTED_DATABASE_HOST:
        "other.postgres.database.azure.com:5432",
    },
    { KOHO_JOB_EXPECTED_DATABASE_NAME: "other_database" },
    {
      KOHO_JOB_EXPECTED_DATABASE_NAME: "patentai",
      DATABASE_URL:
        "postgres://runner:fictional@fictional.postgres.database.azure.com:5432/patentai?sslmode=require",
    },
    {
      DATABASE_URL:
        "postgres://runner:fictional@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=disable",
    },
    {
      DATABASE_URL:
        "postgres://runner:fictional@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=require&host=other.postgres.database.azure.com",
    },
    {
      DATABASE_URL:
        "postgres://runner:fictional@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=require&application_name=fictional-job",
    },
    {
      DATABASE_URL:
        "postgres://runner:fictional@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=require&sslmode=verify-full",
    },
    {
      DATABASE_URL:
        "postgres://runner@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=require",
    },
    {
      KOHO_JOB_BLOB_URL:
        `http://fictional.blob.core.windows.net/private/object.zip?` +
        `sp=r&sr=b&spr=https&se=2026-09-03T03%3A00%3A00Z&sig=${FICTIONAL_BLOB_SECRET}`,
    },
    {
      KOHO_JOB_BLOB_URL:
        `https://not-blob.example/private/object.zip?` +
        `sp=r&sr=b&spr=https&se=2026-09-03T03%3A00%3A00Z&sig=${FICTIONAL_BLOB_SECRET}`,
    },
    {
      KOHO_JOB_BLOB_URL:
        `https://fictional.blob.core.windows.net/private/object.zip?` +
        `sp=rw&sr=b&spr=https&se=2026-09-03T03%3A00%3A00Z&sig=${FICTIONAL_BLOB_SECRET}`,
    },
    {
      KOHO_JOB_BLOB_URL:
        `https://fictional.blob.core.windows.net/private/object.zip?` +
        `sp=r&sr=c&spr=https&se=2026-09-03T03%3A00%3A00Z&sig=${FICTIONAL_BLOB_SECRET}`,
    },
    {
      KOHO_JOB_BLOB_URL:
        `https://fictional.blob.core.windows.net/private/object.zip?` +
        `sp=r&sr=b&spr=https&se=2026-09-03T00%3A01%3A00Z&sig=${FICTIONAL_BLOB_SECRET}`,
    },
    {
      KOHO_JOB_BLOB_URL:
        `https://fictional.blob.core.windows.net/private/object.zip?` +
        `sp=r&sr=b&spr=https&se=2026-09-04T00%3A00%3A01Z&sig=${FICTIONAL_BLOB_SECRET}`,
    },
  ])("rejects unsafe or ambiguous input before execution", (override) => {
    expect(() =>
      readJobConfig(
        environment(override),
        Date.parse("2026-09-03T00:00:00Z"),
      ),
    ).toThrow("invalid_config");
  });

  it.each([
    "host",
    "port",
    "user",
    "password",
    "database",
    "dbname",
    "ssl",
    "uselibpqcompat",
    "application_name",
    "unknown_option",
  ])("rejects the additional PostgreSQL query option %s", (name) => {
    const values = environment();
    const databaseUrl = new URL(values.DATABASE_URL!);
    databaseUrl.searchParams.append(name, "fictional-override");

    expect(() =>
      readJobConfig(
        environment({ DATABASE_URL: databaseUrl.toString() }),
        Date.parse("2026-09-03T00:00:00Z"),
      ),
    ).toThrow("invalid_config");
  });

  it("does not touch the child, Blob, or temp storage when config is missing", async () => {
    const fixture = defaultDependencies();
    const outcome = await runKohoJob({
      environment: environment({ KOHO_JOB_BLOB_URL: undefined }),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.config);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "not_started",
      reason: "invalid_config",
    });
    expect(fixture.dependencies.makeTempRoot).not.toHaveBeenCalled();
    expect(fixture.dependencies.startApplication).not.toHaveBeenCalled();
    expect(fixture.dependencies.downloadBlob).not.toHaveBeenCalled();
  });

  it("tracks and removes a temp root created while an abort arrives", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    let finishCreation: (root: string) => void = () => undefined;
    fixture.dependencies.makeTempRoot.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishCreation = resolve;
        }),
    );

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.dependencies.makeTempRoot).toHaveBeenCalledTimes(1),
    );
    abortController.abort();
    finishCreation("FICTIONAL-LATE-TEMP-ROOT");
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(fixture.dependencies.startApplication).not.toHaveBeenCalled();
    expect(fixture.removeTempRoot).toHaveBeenCalledWith(
      "FICTIONAL-LATE-TEMP-ROOT",
    );
  });

  it("bounds a permanently pending temp-root creation as unknown cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00Z");
    const fixture = defaultDependencies();
    fixture.dependencies.now = () => Date.now();
    fixture.dependencies.makeTempRoot.mockImplementationOnce(
      () => new Promise<string>(() => undefined),
    );

    const run = runKohoJob({
      environment: environment({ KOHO_JOB_TIMEOUT_SECONDS: "11" }),
      dependencies: fixture.dependencies,
    });
    const result = expect(run).resolves.toMatchObject({
      exitCode: JOB_EXIT_CODES.cleanup,
      log: {
        status: "failed",
        result: "unknown",
        reason: "cleanup_failed",
      },
    });
    await vi.advanceTimersByTimeAsync(11_000);

    await result;
    expect(fixture.dependencies.startApplication).not.toHaveBeenCalled();
    expect(fixture.removeTempRoot).not.toHaveBeenCalled();
  });
});

describe("koho one-shot job lifecycle", () => {
  it("streams a Blob once, validates the saved count, and emits aggregate success only", async () => {
    const chunks = [
      new TextEncoder().encode("fictional-"),
      new TextEncoder().encode("package-"),
      new TextEncoder().encode("bytes"),
    ];
    const fixture = defaultDependencies(chunks);
    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.success);
    expect(outcome.log).toEqual({
      component: "koho_private_job",
      schemaVersion: 1,
      status: "succeeded",
      result: "confirmed",
      durationMs: 0,
      peakMemoryBytes: 123_456,
      memorySource: "cgroup_peak",
      peakTempBytes: 23,
      networkBytes: 23,
      retryCount: 0,
      packageType: "JPA",
      packageStatus: "success",
      expectedDocumentCount: 1,
      savedDocumentCount: 1,
      amendmentCount: 0,
      nestedSt26Count: 0,
    });
    expect(fixture.dependencies.downloadBlob).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.sendImport).toHaveBeenCalledTimes(1);
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
    expect(fixture.removeTempRoot).toHaveBeenCalledTimes(1);
  });

  it("rejects an announced Blob larger than the configured maximum before POST", async () => {
    const fixture = defaultDependencies();
    fixture.dependencies.downloadBlob.mockResolvedValueOnce({
      contentLength: 2_000_001,
      readableStreamBody: Readable.from([new Uint8Array([1])]),
    });

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.source);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "not_started",
      reason: "source_failed",
    });
    expect(fixture.dependencies.sendImport).not.toHaveBeenCalled();
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
  });

  it("enforces the measured stream limit when Content-Length is absent", async () => {
    const fixture = defaultDependencies([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ]);
    fixture.dependencies.downloadBlob.mockResolvedValueOnce({
      contentLength: undefined,
      readableStreamBody: Readable.from([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      ]),
    });

    const outcome = await runKohoJob({
      environment: environment({ KOHO_JOB_MAX_SOURCE_BYTES: "5" }),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.source);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "source_failed",
      networkBytes: 6,
      peakTempBytes: 3,
    });
    expect(fixture.dependencies.sendImport).toHaveBeenCalledTimes(1);
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
  });

  it("aborts the stream and child cleanup on an external signal", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    fixture.dependencies.downloadBlob.mockResolvedValueOnce({
      contentLength: undefined,
      readableStreamBody: new Readable({
        read() {
          this.push(new Uint8Array([1, 2, 3]));
        },
      }),
    });
    fixture.dependencies.sendImport.mockImplementationOnce(async ({ body }) => {
      abortController.abort();
      await consumeBody(body);
      return Response.json(successfulPayload());
    });

    const outcome = await runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "interrupted",
    });
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
    expect(fixture.removeTempRoot).toHaveBeenCalledTimes(1);
  });

  it("stops an application that resolves only after an abort", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    const lateChild = controllableApplication();
    let resolveApplication: (
      application: typeof lateChild.application,
    ) => void = () => undefined;
    fixture.dependencies.startApplication.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApplication = resolve;
        }),
    );

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.dependencies.startApplication).toHaveBeenCalledTimes(1),
    );
    abortController.abort();
    resolveApplication(lateChild.application);
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(lateChild.application.stop).toHaveBeenCalledTimes(1);
    expect(fixture.removeTempRoot).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup failure when a late application cannot be stopped", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    const lateChild = controllableApplication();
    lateChild.application.stop.mockRejectedValueOnce(
      new Error("FICTIONAL-LATE-STOP-ERROR"),
    );
    let resolveApplication: (
      application: typeof lateChild.application,
    ) => void = () => undefined;
    fixture.dependencies.startApplication.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApplication = resolve;
        }),
    );

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.dependencies.startApplication).toHaveBeenCalledTimes(1),
    );
    abortController.abort();
    resolveApplication(lateChild.application);
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      reason: "cleanup_failed",
    });
    expect(JSON.stringify(outcome.log)).not.toContain("FICTIONAL-LATE");
  });

  it("destroys a Blob response that resolves only after an abort", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    const lateStream = Readable.from([new Uint8Array([1, 2, 3])]);
    let resolveDownload: (download: {
      contentLength: number;
      readableStreamBody: Readable;
    }) => void = () => undefined;
    fixture.dependencies.downloadBlob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.dependencies.downloadBlob).toHaveBeenCalledTimes(1),
    );
    abortController.abort();
    resolveDownload({ contentLength: 3, readableStreamBody: lateStream });
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(lateStream.destroyed).toBe(true);
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup failure when a late Blob response cannot be destroyed", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    const lateStream = Readable.from([new Uint8Array([1, 2, 3])]);
    const destroy = vi.spyOn(lateStream, "destroy").mockImplementation(() => {
      throw new Error("FICTIONAL-LATE-DESTROY-ERROR");
    });
    let resolveDownload: (download: {
      contentLength: number;
      readableStreamBody: Readable;
    }) => void = () => undefined;
    fixture.dependencies.downloadBlob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.dependencies.downloadBlob).toHaveBeenCalledTimes(1),
    );
    abortController.abort();
    resolveDownload({ contentLength: 3, readableStreamBody: lateStream });
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      reason: "cleanup_failed",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(outcome.log)).not.toContain("FICTIONAL-LATE");
  });

  it("cancels an unlocked HTTP response that resolves after an abort", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    let resolveResponse: (response: Response) => void = () => undefined;
    fixture.dependencies.sendImport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.dependencies.sendImport).toHaveBeenCalledTimes(1),
    );
    abortController.abort();
    resolveResponse(new Response(body));
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(cancelled).toBe(true);
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
  });

  it("bounds a permanently pending HTTP response as unknown cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00Z");
    const fixture = defaultDependencies();
    fixture.dependencies.now = () => Date.now();
    fixture.dependencies.sendImport.mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    );

    const run = runKohoJob({
      environment: environment({ KOHO_JOB_TIMEOUT_SECONDS: "11" }),
      dependencies: fixture.dependencies,
    });
    const result = expect(run).resolves.toMatchObject({
      exitCode: JOB_EXIT_CODES.cleanup,
      log: {
        status: "failed",
        result: "unknown",
        reason: "cleanup_failed",
      },
    });
    await vi.advanceTimersByTimeAsync(11_000);

    await result;
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
    expect(fixture.removeTempRoot).toHaveBeenCalledTimes(1);
  });

  it("waits for a late body read to settle before cancelling its response", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
    fixture.dependencies.sendImport.mockResolvedValueOnce(response);
    let finishRead: () => void = () => undefined;
    const readResponse = vi.fn((received: Response) => {
      const reader = received.body!.getReader();
      return new Promise<ReturnType<typeof successfulPayload>>((resolve) => {
        finishRead = () => {
          reader.releaseLock();
          resolve(successfulPayload());
        };
      });
    });

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: { ...fixture.dependencies, readResponse },
    });
    await vi.waitFor(() => expect(readResponse).toHaveBeenCalledTimes(1));
    expect(response.body!.locked).toBe(true);
    abortController.abort();
    await Promise.resolve();
    expect(cancelled).toBe(false);
    finishRead();
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(cancelled).toBe(true);
  });

  it("reports cleanup failure when a settled late read keeps its body locked", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>());
    fixture.dependencies.sendImport.mockResolvedValueOnce(response);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let finishRead: () => void = () => undefined;
    const readResponse = vi.fn((received: Response) => {
      reader = received.body!.getReader();
      return new Promise<ReturnType<typeof successfulPayload>>((resolve) => {
        finishRead = () => resolve(successfulPayload());
      });
    });

    const run = runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: { ...fixture.dependencies, readResponse },
    });
    await vi.waitFor(() => expect(readResponse).toHaveBeenCalledTimes(1));
    abortController.abort();
    finishRead();
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "cleanup_failed",
    });
    reader!.releaseLock();
    await response.body!.cancel();
  });

  it("bounds a permanently locked response read as unknown cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00Z");
    const fixture = defaultDependencies();
    fixture.dependencies.now = () => Date.now();
    const response = new Response(new ReadableStream<Uint8Array>());
    fixture.dependencies.sendImport.mockResolvedValueOnce(response);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const readResponse = vi.fn((received: Response) => {
      reader = received.body!.getReader();
      return new Promise<ReturnType<typeof successfulPayload>>(
        () => undefined,
      );
    });

    const run = runKohoJob({
      environment: environment({ KOHO_JOB_TIMEOUT_SECONDS: "11" }),
      dependencies: { ...fixture.dependencies, readResponse },
    });
    await vi.waitFor(() => expect(readResponse).toHaveBeenCalledTimes(1));
    const result = expect(run).resolves.toMatchObject({
      exitCode: JOB_EXIT_CODES.cleanup,
      log: {
        status: "failed",
        result: "unknown",
        reason: "cleanup_failed",
      },
    });
    await vi.advanceTimersByTimeAsync(11_000);

    await result;
    reader!.releaseLock();
    await response.body!.cancel();
  });

  it("uses the finite timeout without retrying an unknown import", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00Z");
    const fixture = defaultDependencies();
    fixture.dependencies.now = () => Date.now();
    fixture.dependencies.sendImport.mockImplementationOnce(
      ({ signal }) => pendingResponseUntilAbort(signal),
    );

    const run = runKohoJob({
      environment: environment({ KOHO_JOB_TIMEOUT_SECONDS: "11" }),
      dependencies: fixture.dependencies,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.timeout);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "timed_out",
      retryCount: 0,
    });
    expect(fixture.dependencies.sendImport).toHaveBeenCalledTimes(1);
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
  });

  it("does not queue resource samples while one sample is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00Z");
    const fixture = defaultDependencies();
    fixture.dependencies.now = () => Date.now();
    let resolveMemory: (
      sample: { bytes: number; source: string },
    ) => void = () => undefined;
    fixture.dependencies.readMemorySample.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMemory = resolve;
        }),
    );
    fixture.dependencies.sendImport.mockImplementationOnce(
      ({ signal }) => pendingResponseUntilAbort(signal),
    );

    const run = runKohoJob({
      environment: environment({ KOHO_JOB_TIMEOUT_SECONDS: "11" }),
      dependencies: fixture.dependencies,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.dependencies.readMemorySample).toHaveBeenCalledTimes(1);
    resolveMemory({ bytes: 123, source: "process_rss" });
    const outcome = await run;

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.timeout);
    expect(outcome.log).toMatchObject({
      peakMemoryBytes: 123,
      memorySource: "process_rss",
    });
  });

  it("fails when the application child exits and never retries the import", async () => {
    const fixture = defaultDependencies();
    fixture.dependencies.sendImport.mockImplementationOnce(({ signal }) => {
      fixture.child.exit(1);
      return pendingResponseUntilAbort(signal);
    });

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.child);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "child_failed",
    });
    expect(fixture.dependencies.sendImport).toHaveBeenCalledTimes(1);
    expect(fixture.child.application.stop).toHaveBeenCalledTimes(1);
  });

  it("makes cleanup failure override an otherwise successful result", async () => {
    const fixture = defaultDependencies();
    fixture.removeTempRoot.mockRejectedValueOnce(
      new Error("FICTIONAL-RAW-CLEANUP-ERROR"),
    );

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "cleanup_failed",
    });
    expect(JSON.stringify(outcome.log)).not.toContain("FICTIONAL-RAW");
  });

  it("bounds hanging cleanup and still attempts every cleanup target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00Z");
    const fixture = defaultDependencies();
    fixture.dependencies.now = () => Date.now();
    fixture.child.application.stop.mockImplementationOnce(
      () => new Promise<undefined>(() => undefined),
    );

    const run = runKohoJob({
      environment: environment({ KOHO_JOB_TIMEOUT_SECONDS: "11" }),
      dependencies: fixture.dependencies,
    });
    await vi.waitFor(() =>
      expect(fixture.child.application.stop).toHaveBeenCalledTimes(1),
    );
    const result = expect(run).resolves.toMatchObject({
      exitCode: JOB_EXIT_CODES.cleanup,
      log: {
        status: "failed",
        result: "unknown",
        reason: "cleanup_failed",
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await result;
    expect(fixture.removeTempRoot).toHaveBeenCalledTimes(1);
  });

  it("does not report success when a signal arrives during cleanup", async () => {
    const fixture = defaultDependencies();
    const abortController = new AbortController();
    fixture.child.application.stop.mockImplementationOnce(async () => {
      abortController.abort();
    });

    const outcome = await runKohoJob({
      environment: environment(),
      signal: abortController.signal,
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.signal);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "interrupted",
    });
    expect(fixture.removeTempRoot).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response("not-json", { status: 200 }),
    Response.json({ error: "FICTIONAL-RAW-API-ERROR" }, { status: 500 }),
    Response.json({ ...successfulPayload(), unexpected: "field" }),
  ])("fails closed for a malformed or rejected response", async (response) => {
    const fixture = defaultDependencies();
    fixture.dependencies.sendImport.mockResolvedValueOnce(response);

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.import);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "import_failed",
    });
    expect(JSON.stringify(outcome.log)).not.toContain("FICTIONAL-RAW");
  });

  it("rejects a source hash mismatch without logging either hash", async () => {
    const fixture = defaultDependencies();
    const actualHash = "b".repeat(64);
    fixture.dependencies.sendImport.mockResolvedValueOnce(
      Response.json({ ...successfulPayload(), sourceSha256: actualHash }),
    );

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });
    const serialized = JSON.stringify(outcome.log);

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.import);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "import_failed",
    });
    expect(serialized).not.toContain(HASH);
    expect(serialized).not.toContain(actualHash);
  });

  it("marks a committed count mismatch as confirmed and unsuccessful", async () => {
    const fixture = defaultDependencies();
    fixture.dependencies.sendImport.mockResolvedValueOnce(
      Response.json({
        ...successfulPayload(),
        documentCount: 2,
        savedDocumentCount: 2,
      }),
    );

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.import);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "confirmed_mismatch",
      reason: "count_mismatch",
      expectedDocumentCount: 1,
    });
  });

  it("never includes credentials, URLs, paths, hashes, or raw failures in its JSON log", async () => {
    const fixture = defaultDependencies();
    fixture.dependencies.sendImport.mockRejectedValueOnce(
      new Error(
        `${FICTIONAL_BLOB_SECRET} ${FICTIONAL_DATABASE_SECRET} ` +
          `C:\\private\\package.zip ${HASH}`,
      ),
    );

    const outcome = await runKohoJob({
      environment: environment(),
      dependencies: fixture.dependencies,
    });
    const serialized = JSON.stringify(outcome.log);

    expect(outcome.exitCode).toBe(JOB_EXIT_CODES.import);
    expect(serialized).not.toContain(FICTIONAL_BLOB_SECRET);
    expect(serialized).not.toContain(FICTIONAL_DATABASE_SECRET);
    expect(serialized).not.toContain("private\\package.zip");
    expect(serialized).not.toContain(HASH);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("postgres://");
  });
});

describe("loopback child boundary", () => {
  it("binds Next to loopback, hides child output, and does not pass Blob credentials", async () => {
    class FakeChild extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = undefined;

      kill(signal: NodeJS.Signals) {
        this.signalCode = signal;
        queueMicrotask(() => this.emit("exit", null, signal));
        return true;
      }
    }

    const child = new FakeChild();
    const spawnImpl = vi.fn((...input: unknown[]) => {
      void input;
      return child;
    });
    const config = readJobConfig(
      environment(),
      Date.parse("2026-09-03T00:00:00Z"),
    );
    const application = await startLoopbackApplication(
      {
        config,
        environment: environment({
          AZURE_LOG_LEVEL: "verbose",
          AZURE_API_KEY: "FICTIONAL-AZURE-KEY",
          AZURE_DOCUMENT_INTELLIGENCE_KEY: "FICTIONAL-DOCUMENT-KEY",
          GOOGLE_GENERATIVE_AI_API_KEY: "FICTIONAL-GOOGLE-KEY",
          OPENAI_API_KEY: "FICTIONAL-OPENAI-KEY",
          KOHO_IMPORT_ADMIN_TOKEN: "FICTIONAL-EXTERNAL-TOKEN",
        }),
        token: FICTIONAL_TOKEN,
        tempRoot: "FICTIONAL-TEMP-ROOT",
        signal: new AbortController().signal,
        cwd: "C:\\fictional-app",
      },
      {
        spawn: spawnImpl,
        fetch: vi.fn(async () =>
          Response.json({ database: { ok: true } }),
        ),
      },
    );

    child.stdout.write(FICTIONAL_BLOB_SECRET);
    child.stderr.write(FICTIONAL_DATABASE_SECRET);
    const call = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      {
        stdio: string[];
        env: Record<string, string | undefined>;
      },
    ];
    const [, args, options] = call;
    expect(args).toEqual([
      expect.stringMatching(/scripts[\\/]koho-job[\\/]server\.mjs$/),
    ]);
    expect(args).not.toContain(FICTIONAL_TOKEN);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env.KOHO_JOB_BLOB_URL).toBeUndefined();
    expect(options.env.KOHO_JOB_EXPECTED_SOURCE_SHA256).toBeUndefined();
    expect(options.env.AZURE_LOG_LEVEL).toBeUndefined();
    expect(options.env.AZURE_API_KEY).toBeUndefined();
    expect(options.env.AZURE_DOCUMENT_INTELLIGENCE_KEY).toBeUndefined();
    expect(options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.KOHO_IMPORT_ADMIN_TOKEN).toBe(FICTIONAL_TOKEN);
    expect(options.env.KOHO_LOOPBACK_REQUEST_TIMEOUT_MS).toBe("7190000");
    expect(options.env.TMPDIR).toBe("FICTIONAL-TEMP-ROOT");
    expect(child.stdout.readableFlowing).toBe(true);
    expect(child.stderr.readableFlowing).toBe(true);

    await application.stop();
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("does not mistake a post-spawn kill error for process exit", async () => {
    vi.useFakeTimers();

    class UnkillableChild extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = undefined;
      kill = vi.fn(() => {
        this.emit("error", new Error("FICTIONAL-KILL-ERROR"));
        return false;
      });
    }

    const child = new UnkillableChild();
    const spawnImpl = vi.fn((...input: unknown[]) => {
      void input;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const config = readJobConfig(
      environment(),
      Date.parse("2026-09-03T00:00:00Z"),
    );
    const application = await startLoopbackApplication(
      {
        config,
        environment: environment(),
        token: FICTIONAL_TOKEN,
        tempRoot: "FICTIONAL-TEMP-ROOT",
        signal: new AbortController().signal,
        cwd: "C:\\fictional-app",
      },
      {
        spawn: spawnImpl,
        fetch: vi.fn(async () =>
          Response.json({ database: { ok: true } }),
        ),
      },
    );

    const stopped = expect(application.stop()).rejects.toThrow(
      "cleanup_failed",
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await stopped;
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });
});

describe("custom loopback HTTP server", () => {
  it("requires production config and a finite timeout no longer than 120 minutes", () => {
    expect(
      readLoopbackServerConfig({
        NODE_ENV: "production",
        PORT: "3000",
        KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "7200000",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 3000,
      requestTimeoutMilliseconds: 7_200_000,
    });

    const invalidConfigurations: NodeJS.ProcessEnv[] = [
      {
        NODE_ENV: "development",
        PORT: "3000",
        KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "7200000",
      },
      {
        NODE_ENV: "production",
        PORT: "3000",
        KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "7200001",
      },
      {
        NODE_ENV: "production",
        PORT: "80",
        KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "1000",
      },
    ];
    for (const values of invalidConfigurations) {
      expect(() => readLoopbackServerConfig(values)).toThrow(
        "invalid_loopback_config",
      );
    }
  });

  it("sets requestTimeout on a real Node HTTP server", () => {
    const server = createLoopbackHttpServer(
      (_request: unknown, response: { end: () => void }) => response.end(),
      7_200_000,
    );

    expect(server.requestTimeout).toBe(7_200_000);
  });

  it("maps a synchronous request-handler throw to a sanitized 500 response", async () => {
    const server = createLoopbackHttpServer(() => {
      throw new Error("FICTIONAL-RAW-HANDLER-ERROR");
    }, 1_000);
    const response = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
      destroy: vi.fn(),
    };

    server.emit("request", {}, response);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledTimes(1));

    expect(response.statusCode).toBe(500);
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it.each(["prepare", "handler", "create", "listen"] as const)(
    "cleans partial Next/server state when %s startup fails",
    async (stage) => {
      const application = {
        prepare: vi.fn(async () => {
          if (stage === "prepare") throw new Error("FICTIONAL-PREPARE");
        }),
        getRequestHandler: vi.fn(() => {
          if (stage === "handler") throw new Error("FICTIONAL-HANDLER");
          return () => undefined;
        }),
        close: vi.fn(async () => undefined),
      };
      const fakeServer = { marker: "fictional" };
      const closeServer = vi.fn(async () => undefined);
      const createHttpServer = vi.fn(() => {
        if (stage === "create") throw new Error("FICTIONAL-CREATE");
        return fakeServer;
      });
      const listenServer = vi.fn(async () => {
        if (stage === "listen") throw new Error("FICTIONAL-LISTEN");
      });

      await expect(
        startLoopbackServer(
          {
            NODE_ENV: "production",
            PORT: "3000",
            KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "1000",
          },
          (() => application) as unknown as Parameters<
            typeof startLoopbackServer
          >[1],
          {
            createHttpServer,
            listen: listenServer,
            close: closeServer,
          },
        ),
      ).rejects.toThrow();

      expect(application.close).toHaveBeenCalledTimes(1);
      if (stage === "listen") {
        expect(closeServer).toHaveBeenCalledWith(fakeServer);
      } else {
        expect(closeServer).not.toHaveBeenCalled();
      }
    },
  );

  it("bounds runtime cleanup and attempts both server and Next cleanup", async () => {
    vi.useFakeTimers();
    const application = {
      prepare: vi.fn(async () => undefined),
      getRequestHandler: vi.fn(() => () => undefined),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const fakeServer = { marker: "fictional" };
    const closeServer = vi.fn(() => new Promise<void>(() => undefined));
    const runtime = await startLoopbackServer(
      {
        NODE_ENV: "production",
        PORT: "3000",
        KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "1000",
      },
      (() => application) as unknown as Parameters<
        typeof startLoopbackServer
      >[1],
      {
        createHttpServer: vi.fn(() => fakeServer),
        listen: vi.fn(async () => undefined),
        close: closeServer,
      },
    );

    const closing = expect(runtime.close()).rejects.toThrow(
      "loopback_close_failed",
    );
    await vi.advanceTimersByTimeAsync(4_000);

    await closing;
    expect(closeServer).toHaveBeenCalledWith(fakeServer);
    expect(application.close).toHaveBeenCalledTimes(1);
  });

  it("bounds partial-start cleanup before preserving the startup failure", async () => {
    vi.useFakeTimers();
    const application = {
      prepare: vi.fn(async () => undefined),
      getRequestHandler: vi.fn(() => () => undefined),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const fakeServer = { marker: "fictional" };
    const closeServer = vi.fn(() => new Promise<void>(() => undefined));
    const starting = expect(
      startLoopbackServer(
        {
          NODE_ENV: "production",
          PORT: "3000",
          KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: "1000",
        },
        (() => application) as unknown as Parameters<
          typeof startLoopbackServer
        >[1],
        {
          createHttpServer: vi.fn(() => fakeServer),
          listen: vi.fn(async () => {
            throw new Error("FICTIONAL-STARTUP-ERROR");
          }),
          close: closeServer,
        },
      ),
    ).rejects.toThrow("FICTIONAL-STARTUP-ERROR");
    await vi.advanceTimersByTimeAsync(4_000);

    await starting;
    expect(closeServer).toHaveBeenCalledWith(fakeServer);
    expect(application.close).toHaveBeenCalledTimes(1);
  });
});

describe("bounded response cleanup", () => {
  it("cancels an oversized response before releasing its reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readBoundedJson(new Response(stream), 64),
    ).rejects.toThrow("import_failed");
    expect(cancelled).toBe(true);
  });
});

describe("runner entrypoint", () => {
  it("emits exactly one safe JSON line and exit 2 when config is absent", async () => {
    const childEnvironment = { ...process.env };
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("KOHO_JOB_")) delete childEnvironment[name];
    }
    delete childEnvironment.DATABASE_URL;

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawnProcess(
        process.execPath,
        [fileURLToPath(new URL("./runner.mjs", import.meta.url))],
        {
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    });

    expect(result.code).toBe(JOB_EXIT_CODES.config);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "component",
      "durationMs",
      "memorySource",
      "networkBytes",
      "peakMemoryBytes",
      "peakTempBytes",
      "reason",
      "result",
      "retryCount",
      "schemaVersion",
      "status",
    ]);
    expect(payload).toMatchObject({
      status: "failed",
      result: "not_started",
      reason: "invalid_config",
    });
  });
});

describe("fictional package integration", () => {
  it.each(["JPA", "JPB"] as const)(
    "streams a completely fictional %s ZIP through the existing manual handler",
    async (packageType) => {
      const packageBytes = buildMinimalFictionalPackage(packageType);
      const packageSha256 = createHash("sha256")
        .update(packageBytes)
        .digest("hex");
      const child = controllableApplication();
      const root = await mkdtemp(join(tmpdir(), "patentai-koho-job-test-"));
      const plans: KohoImportPlan[] = [];
      let token = "";
      let maximum = "";
      const handler = createKohoManualImportPostHandler({
        repository: {
          async savePlan(plan: KohoImportPlan): Promise<KohoImportSaveResult> {
            plans.push(plan);
            return {
              run: {
                importId: 1,
                packageType: plan.packageType,
                sourceSha256: plan.sourceSha256,
                packageStatus: plan.packageStatus,
                documentCount: plan.documentCount,
                amendmentCount: plan.amendmentCount,
                nestedSt26Count: plan.nestedSt26Count,
                countsJson: plan.countsJson,
                issuesJson: plan.issuesJson,
                createdAt: "2099-01-01T00:00:00.000Z",
                updatedAt: "2099-01-01T00:00:00.000Z",
              },
              savedDocumentCount: plan.documents.length,
            };
          },
        },
        getEnvironmentValue: (name) =>
          name === "KOHO_IMPORT_ADMIN_TOKEN" ? token : maximum,
        withTempSource: (
          request,
          maxSourceBytes,
          declaredContentLength,
          consumeSource,
        ) =>
          withBoundedKohoTempSource(
            request,
            maxSourceBytes,
            declaredContentLength,
            consumeSource,
            { tempRoot: root },
          ),
      });

      try {
        const outcome = await runKohoJob({
          environment: environment({
            KOHO_JOB_PACKAGE_TYPE: packageType,
            KOHO_JOB_MAX_SOURCE_BYTES: "2000000",
            KOHO_JOB_EXPECTED_SOURCE_SHA256: packageSha256,
          }),
          dependencies: {
            now: () => Date.parse("2026-09-03T00:00:00Z"),
            makeTempRoot: async () => root,
            removeTempRoot: async () => undefined,
            startApplication: async ({
              token: suppliedToken,
              config,
            }: {
              token: string;
              config: { maxSourceBytes: number };
            }) => {
              token = suppliedToken;
              maximum = String(config.maxSourceBytes);
              return child.application;
            },
            downloadBlob: async () => ({
              contentLength: packageBytes.byteLength,
              readableStreamBody: Readable.from([
                packageBytes.subarray(0, Math.floor(packageBytes.byteLength / 2)),
                packageBytes.subarray(Math.floor(packageBytes.byteLength / 2)),
              ]),
            }),
            sendImport: async (input: {
              packageType: "JPA" | "JPB";
              token: string;
              contentLength: number | null;
              body: ReadableStream<Uint8Array>;
              signal: AbortSignal;
            }) =>
              handler(
                new Request(
                  `http://127.0.0.1/api/admin/koho-imports?packageType=${input.packageType}`,
                  {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${input.token}`,
                      "content-type": "application/zip",
                      "content-length": String(input.contentLength),
                    },
                    body: input.body,
                    duplex: "half",
                    signal: input.signal,
                  } as RequestInit & { duplex: "half" },
                ),
              ),
            readMemorySample: async () => ({
              bytes: 1,
              source: "process_rss",
            }),
            directoryBytes: async () => 0,
            randomToken: () => FICTIONAL_TOKEN,
          },
        });

        expect(outcome.exitCode).toBe(JOB_EXIT_CODES.success);
        expect(outcome.log).toMatchObject({
          status: "succeeded",
          result: "confirmed",
          packageType,
          savedDocumentCount: 1,
        });
        expect(plans).toHaveLength(1);
        expect(plans[0].packageType).toBe(packageType);
        expect(plans[0].documentCount).toBe(1);
        expect(await readdir(root)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
