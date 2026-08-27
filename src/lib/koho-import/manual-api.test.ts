import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildMinimalFictionalPackage,
  FICTIONAL_PACKAGE_LIMITS,
} from "../koho-package/__fixtures__/fictional-package";
import { parseKohoPackage, type KohoPackageParseResult } from "../koho-package";
import {
  buildKohoManualImportLimits,
  createKohoManualImportPostHandler,
  withBoundedKohoTempSource,
} from "./manual-api";
import { KohoImportPlanValidationError, type KohoImportPlan } from "./types";
import type {
  KohoImportRepository,
  KohoImportSaveResult,
} from "@/repositories/types";

const TOKEN = "FICTIONAL-ADMIN-TOKEN-0123456789-ABCDEFG";
const DEFAULT_MAX_SOURCE_BYTES = "2000000";

function environment(
  overrides: Partial<
    Record<
      "KOHO_IMPORT_ADMIN_TOKEN" | "KOHO_IMPORT_MAX_SOURCE_BYTES",
      string | undefined
    >
  > = {},
) {
  const values = {
    KOHO_IMPORT_ADMIN_TOKEN: TOKEN,
    KOHO_IMPORT_MAX_SOURCE_BYTES: DEFAULT_MAX_SOURCE_BYTES,
    ...overrides,
  };
  return (name: keyof typeof values) => values[name];
}

function chunkStream(
  chunks: readonly Uint8Array[],
  onPull?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

function splitBytes(bytes: Uint8Array): Uint8Array[] {
  const first = Math.max(1, Math.floor(bytes.byteLength / 3));
  const second = Math.max(first + 1, Math.floor((bytes.byteLength * 2) / 3));
  return [bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)];
}

function requestWithBody(input: {
  packageType?: string;
  chunks?: readonly Uint8Array[];
  contentType?: string;
  contentLength?: string;
  authorization?: string | null;
  signal?: AbortSignal;
  onPull?: () => void;
} = {}): Request {
  const params = new URLSearchParams();
  if (input.packageType !== undefined) params.append("packageType", input.packageType);
  const headers = new Headers();
  headers.set("content-type", input.contentType ?? "application/zip");
  if (input.contentLength !== undefined) {
    headers.set("content-length", input.contentLength);
  }
  if (input.authorization !== null) {
    headers.set("authorization", input.authorization ?? `Bearer ${TOKEN}`);
  }
  const body = chunkStream(input.chunks ?? [new TextEncoder().encode("fictional")], input.onPull);

  return new Request(
    `http://localhost/api/admin/koho-imports?${params.toString()}`,
    {
      method: "POST",
      headers,
      body,
      signal: input.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
}

class FakeKohoImportRepository
  implements Pick<KohoImportRepository, "savePlan">
{
  readonly calls: KohoImportPlan[] = [];
  private readonly idsBySource = new Map<string, number>();
  private nextId = 1;

  async savePlan(plan: KohoImportPlan): Promise<KohoImportSaveResult> {
    this.calls.push(plan);
    const key = `${plan.packageType}:${plan.sourceSha256}`;
    let importId = this.idsBySource.get(key);
    if (importId === undefined) {
      importId = this.nextId;
      this.nextId += 1;
      this.idsBySource.set(key, importId);
    }
    return {
      run: {
        importId,
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
  }
}

async function parseFictionalResult(packageType: "JPA" | "JPB") {
  return parseKohoPackage({
    packageType,
    source: {
      type: "buffer",
      bytes: buildMinimalFictionalPackage(packageType),
      sourceName: "fictional-package.zip",
    },
    limits: FICTIONAL_PACKAGE_LIMITS,
  });
}

function errorBody(response: Response): Promise<{ error: string }> {
  return response.json() as Promise<{ error: string }>;
}

describe("manual koho import validation ordering", () => {
  it.each([
    [undefined, DEFAULT_MAX_SOURCE_BYTES],
    ["short", DEFAULT_MAX_SOURCE_BYTES],
    [TOKEN, undefined],
    [TOKEN, "0"],
    [TOKEN, "68719476737"],
  ] as const)(
    "disables before body, temp, parser, or repository access",
    async (configuredToken, configuredMax) => {
      let bodyPulls = 0;
      const withTempSource = vi.fn();
      const parsePackage = vi.fn();
      const repository = new FakeKohoImportRepository();
      const handler = createKohoManualImportPostHandler({
        repository,
        withTempSource,
        parsePackage,
        getEnvironmentValue: environment({
          KOHO_IMPORT_ADMIN_TOKEN: configuredToken,
          KOHO_IMPORT_MAX_SOURCE_BYTES: configuredMax,
        }),
      });

      const response = await handler(
        requestWithBody({ packageType: "JPA", onPull: () => bodyPulls += 1 }),
      );

      expect(response.status).toBe(503);
      expect(await errorBody(response)).toEqual({ error: "koho_import_disabled" });
      expect(bodyPulls).toBe(0);
      expect(withTempSource).not.toHaveBeenCalled();
      expect(parsePackage).not.toHaveBeenCalled();
      expect(repository.calls).toHaveLength(0);
    },
  );

  it.each([null, "Basic FICTIONAL", "Bearer", "Bearer wrong-token"])(
    "rejects bad authorization before body access",
    async (authorization) => {
      let bodyPulls = 0;
      const withTempSource = vi.fn();
      const repository = new FakeKohoImportRepository();
      const handler = createKohoManualImportPostHandler({
        repository,
        withTempSource,
        getEnvironmentValue: environment(),
      });

      const response = await handler(
        requestWithBody({
          packageType: "JPA",
          authorization,
          onPull: () => bodyPulls += 1,
        }),
      );

      expect(response.status).toBe(401);
      expect(await errorBody(response)).toEqual({ error: "unauthorized" });
      expect(bodyPulls).toBe(0);
      expect(withTempSource).not.toHaveBeenCalled();
      expect(repository.calls).toHaveLength(0);
    },
  );

  it.each([
    [{ packageType: "jpa" }, 400, "invalid_package_type"],
    [{ packageType: "JPA", contentType: "text/plain" }, 415, "unsupported_content_type"],
    [{ packageType: "JPA", contentLength: "0" }, 400, "invalid_content_length"],
    [{ packageType: "JPA", contentLength: "not-a-number" }, 400, "invalid_content_length"],
    [{ packageType: "JPA", contentLength: "2000001" }, 413, "package_too_large"],
  ] as const)("validates request metadata before body access", async (options, status, code) => {
    let bodyPulls = 0;
    const withTempSource = vi.fn();
    const repository = new FakeKohoImportRepository();
    const handler = createKohoManualImportPostHandler({
      repository,
      withTempSource,
      getEnvironmentValue: environment(),
    });

    const response = await handler(
      requestWithBody({ ...options, onPull: () => bodyPulls += 1 }),
    );

    expect(response.status).toBe(status);
    expect(await errorBody(response)).toEqual({ error: code });
    expect(bodyPulls).toBe(0);
    expect(withTempSource).not.toHaveBeenCalled();
    expect(repository.calls).toHaveLength(0);
  });
});

describe("bounded request streaming", () => {
  it("writes multiple chunks exactly, hashes them, and removes the temp directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "patentai-koho-stream-test-"));
    const chunks = [
      new TextEncoder().encode("fictional-"),
      new TextEncoder().encode("zip-"),
      new TextEncoder().encode("bytes"),
    ];
    const expected = new TextEncoder().encode("fictional-zip-bytes");
    const request = requestWithBody({
      packageType: "JPA",
      chunks,
      contentLength: String(expected.byteLength),
    });

    try {
      const observed = await withBoundedKohoTempSource(
        request,
        1_000,
        expected.byteLength,
        async (source) => ({
          bytes: await readFile(source.path),
          digest: source.sourceSha256,
          byteLength: source.byteLength,
        }),
        { tempRoot: root },
      );

      expect(observed.bytes).toEqual(Buffer.from(expected));
      expect(observed.byteLength).toBe(expected.byteLength);
      expect(observed.digest).toBe(
        createHash("sha256").update(expected).digest("hex"),
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports an absent Content-Length while enforcing the measured limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "patentai-koho-stream-test-"));
    const request = requestWithBody({
      packageType: "JPA",
      chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
    });

    try {
      await expect(
        withBoundedKohoTempSource(
          request,
          5,
          null,
          async () => "unreachable",
          { tempRoot: root },
        ),
      ).rejects.toMatchObject({ status: 413, code: "package_too_large" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [[], null, { status: 400, code: "empty_body" }],
    [[new Uint8Array([1, 2, 3])], 4, { status: 400, code: "content_length_mismatch" }],
  ] as const)("cleans up empty and mismatched bodies", async (chunks, declared, expectedError) => {
    const root = await mkdtemp(join(tmpdir(), "patentai-koho-stream-test-"));
    const request = requestWithBody({ packageType: "JPA", chunks });
    try {
      await expect(
        withBoundedKohoTempSource(
          request,
          100,
          declared,
          async () => "unreachable",
          { tempRoot: root },
        ),
      ).rejects.toMatchObject(expectedError);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up after a stream error", async () => {
    const root = await mkdtemp(join(tmpdir(), "patentai-koho-stream-test-"));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("fictional stream failure"));
      },
    });
    const request = new Request("http://localhost/api/admin/koho-imports?packageType=JPA", {
      method: "POST",
      headers: { "content-type": "application/zip", authorization: `Bearer ${TOKEN}` },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    try {
      await expect(
        withBoundedKohoTempSource(
          request,
          100,
          null,
          async () => "unreachable",
          { tempRoot: root },
        ),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up when the request is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "patentai-koho-stream-test-"));
    const abortController = new AbortController();
    const request = requestWithBody({
      packageType: "JPA",
      signal: abortController.signal,
    });
    abortController.abort();

    try {
      await expect(
        withBoundedKohoTempSource(
          request,
          100,
          null,
          async () => "unreachable",
          { tempRoot: root },
        ),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not use whole-body request APIs or body concatenation", async () => {
    const source = await readFile(new URL("./manual-api.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/request\.(arrayBuffer|formData)\s*\(/);
    expect(source).not.toContain("Buffer.concat");
    expect(source).not.toContain("new File(");
  });
});

describe("manual koho import orchestration", () => {
  it.each(["JPA", "JPB"] as const)(
    "parses a fictional %s ZIP from the HTTP body and saves the plan",
    async (packageType) => {
      const repository = new FakeKohoImportRepository();
      const handler = createKohoManualImportPostHandler({
        repository,
        getEnvironmentValue: environment(),
      });
      const packageBytes = buildMinimalFictionalPackage(packageType);
      const response = await handler(
        requestWithBody({ packageType, chunks: splitBytes(packageBytes) }),
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(repository.calls).toHaveLength(1);
      expect(repository.calls[0].packageType).toBe(packageType);
      expect(repository.calls[0].documentCount).toBe(1);
      expect(Object.keys(body)).toEqual([
        "packageType",
        "packageStatus",
        "sourceSha256",
        "importId",
        "documentCount",
        "savedDocumentCount",
        "amendmentCount",
        "nestedSt26Count",
      ]);
      expect(body.packageType).toBe(packageType);
      expect(body.packageStatus).toBe("success");
      expect(body.documentCount).toBe(1);
      expect(body.savedDocumentCount).toBe(1);
      expect(body.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("uses the same source digest and repository import id on an identical resend", async () => {
    const repository = new FakeKohoImportRepository();
    const handler = createKohoManualImportPostHandler({
      repository,
      getEnvironmentValue: environment(),
    });
    const packageBytes = buildMinimalFictionalPackage("JPA");

    const first = await handler(
      requestWithBody({ packageType: "JPA", chunks: splitBytes(packageBytes) }),
    );
    const second = await handler(
      requestWithBody({ packageType: "JPA", chunks: splitBytes(packageBytes) }),
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.sourceSha256).toBe(secondBody.sourceSha256);
    expect(firstBody.importId).toBe(secondBody.importId);
    expect(repository.calls).toHaveLength(2);
  });

  it("saves review_required and never saves failed packages", async () => {
    const success = await parseFictionalResult("JPA");
    const repository = new FakeKohoImportRepository();
    const reviewRequired: KohoPackageParseResult = {
      ...success,
      status: "review_required",
    };
    const reviewHandler = createKohoManualImportPostHandler({
      repository,
      parsePackage: async () => reviewRequired,
      getEnvironmentValue: environment(),
    });
    const reviewResponse = await reviewHandler(
      requestWithBody({ packageType: "JPA" }),
    );

    expect(reviewResponse.status).toBe(200);
    expect(repository.calls).toHaveLength(1);
    expect(repository.calls[0].packageStatus).toBe("review_required");

    const buildPlan = vi.fn();
    const failedHandler = createKohoManualImportPostHandler({
      repository,
      parsePackage: async () => ({ ...success, status: "failed" }),
      buildPlan,
      getEnvironmentValue: environment(),
    });
    const failedResponse = await failedHandler(
      requestWithBody({ packageType: "JPA" }),
    );

    expect(failedResponse.status).toBe(422);
    expect(await errorBody(failedResponse)).toEqual({ error: "package_parse_failed" });
    expect(buildPlan).not.toHaveBeenCalled();
    expect(repository.calls).toHaveLength(1);
  });

  it("returns only stable sanitized errors for parser, builder, and storage failures", async () => {
    const success = await parseFictionalResult("JPA");
    const cases = [
      {
        expectedStatus: 500,
        expectedCode: "koho_import_internal_error",
        dependencies: {
          repository: new FakeKohoImportRepository(),
          parsePackage: async () => {
            throw new Error("FICTIONAL-RAW-PARSER-MESSAGE");
          },
        },
      },
      {
        expectedStatus: 422,
        expectedCode: "package_validation_failed",
        dependencies: {
          repository: new FakeKohoImportRepository(),
          parsePackage: async () => success,
          buildPlan: () => {
            throw new KohoImportPlanValidationError("invalid_package_type");
          },
        },
      },
      {
        expectedStatus: 503,
        expectedCode: "koho_import_storage_unavailable",
        dependencies: {
          repository: {
            async savePlan() {
              throw new Error("FICTIONAL-RAW-DB-MESSAGE");
            },
          },
          parsePackage: async () => success,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const handler = createKohoManualImportPostHandler({
        ...testCase.dependencies,
        getEnvironmentValue: environment(),
      });
      const response = await handler(requestWithBody({ packageType: "JPA" }));
      const text = await response.text();
      expect(response.status).toBe(testCase.expectedStatus);
      expect(text).toBe(JSON.stringify({ error: testCase.expectedCode }));
      expect(text).not.toContain("FICTIONAL-RAW");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("patentai-koho-import-");
    }
  });
});

describe("manual import package limits", () => {
  it("returns only positive finite safe integers at the 64 GiB configuration ceiling", () => {
    const limits = buildKohoManualImportLimits(64 * 1024 * 1024 * 1024);
    const values = [
      ...Object.values(limits.zip),
      ...Object.values(limits.csv),
      ...Object.values(limits.xml),
    ];

    expect(values.every((value) => Number.isFinite(value))).toBe(true);
    expect(values.every((value) => Number.isSafeInteger(value))).toBe(true);
    expect(values.every((value) => value > 0)).toBe(true);
    expect(limits.zip.maxTotalUncompressedBytes).toBe(64 * 1024 * 1024 * 1024 * 8);
    expect(limits.zip.maxTotalReadUncompressedBytes).toBe(64 * 1024 * 1024 * 1024 * 4);
  });
});
