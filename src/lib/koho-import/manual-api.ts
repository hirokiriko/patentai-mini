import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseKohoPackage,
  type KohoPackageLimits,
  type KohoPackageParseResult,
  type KohoPackageType,
} from "../koho-package";
import { buildKohoImportPlan } from "./builder";
import {
  KohoImportPlanValidationError,
  type KohoImportPlan,
} from "./types";
import type {
  KohoImportRepository,
  KohoImportSaveResult,
} from "@/repositories/types";

const MAX_CONFIGURED_SOURCE_BYTES = 64 * 1024 * 1024 * 1024;
const TOKEN_MIN_BYTES = 32;
const TEMP_PREFIX = "patentai-koho-import-";

export type KohoManualImportErrorCode =
  | "koho_import_disabled"
  | "unauthorized"
  | "invalid_package_type"
  | "unsupported_content_type"
  | "invalid_content_length"
  | "package_too_large"
  | "empty_body"
  | "content_length_mismatch"
  | "package_parse_failed"
  | "package_validation_failed"
  | "koho_import_storage_unavailable"
  | "koho_import_internal_error";

class KohoManualImportHttpError extends Error {
  readonly status: number;
  readonly code: KohoManualImportErrorCode;

  constructor(status: number, code: KohoManualImportErrorCode) {
    super(code);
    this.name = "KohoManualImportHttpError";
    this.status = status;
    this.code = code;
  }
}

interface KohoManualImportConfig {
  token: string;
  maxSourceBytes: number;
}

export interface KohoBoundedTempSource {
  path: string;
  sourceSha256: string;
  byteLength: number;
}

export interface KohoBoundedTempSourceOptions {
  tempRoot?: string;
  removeTempDirectory?: (directory: string) => Promise<void>;
}

export type KohoBoundedTempSourceRunner = <T>(
  request: Request,
  maxSourceBytes: number,
  declaredContentLength: number | null,
  consumeSource: (source: KohoBoundedTempSource) => Promise<T>,
  options?: KohoBoundedTempSourceOptions,
) => Promise<T>;

export interface KohoManualImportHandlerDependencies {
  repository: Pick<KohoImportRepository, "savePlan">;
  parsePackage?: typeof parseKohoPackage;
  buildPlan?: (input: {
    packageResult: KohoPackageParseResult;
    sourceSha256: string;
  }) => KohoImportPlan;
  withTempSource?: KohoBoundedTempSourceRunner;
  getEnvironmentValue?: (
    name: "KOHO_IMPORT_ADMIN_TOKEN" | "KOHO_IMPORT_MAX_SOURCE_BYTES",
  ) => string | undefined;
  isValidationError?: (error: unknown) => boolean;
}

function jsonError(status: number, error: KohoManualImportErrorCode): Response {
  return Response.json({ error }, { status });
}

function readConfig(
  getEnvironmentValue: NonNullable<
    KohoManualImportHandlerDependencies["getEnvironmentValue"]
  >,
): KohoManualImportConfig | null {
  const token = getEnvironmentValue("KOHO_IMPORT_ADMIN_TOKEN");
  const maxSourceBytesRaw = getEnvironmentValue(
    "KOHO_IMPORT_MAX_SOURCE_BYTES",
  );

  if (
    typeof token !== "string" ||
    new TextEncoder().encode(token).byteLength < TOKEN_MIN_BYTES ||
    typeof maxSourceBytesRaw !== "string" ||
    !/^[1-9]\d*$/.test(maxSourceBytesRaw)
  ) {
    return null;
  }

  const maxSourceBytes = Number(maxSourceBytesRaw);
  if (
    !Number.isSafeInteger(maxSourceBytes) ||
    maxSourceBytes < 1 ||
    maxSourceBytes > MAX_CONFIGURED_SOURCE_BYTES
  ) {
    return null;
  }

  return { token, maxSourceBytes };
}

function isAuthorized(header: string | null, configuredToken: string): boolean {
  if (header === null) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (match === null) return false;

  const suppliedDigest = createHash("sha256").update(match[1], "utf8").digest();
  const configuredDigest = createHash("sha256")
    .update(configuredToken, "utf8")
    .digest();
  return timingSafeEqual(suppliedDigest, configuredDigest);
}

function parsePackageType(request: Request): KohoPackageType {
  const values = new URL(request.url).searchParams.getAll("packageType");
  if (values.length !== 1 || (values[0] !== "JPA" && values[0] !== "JPB")) {
    throw new KohoManualImportHttpError(400, "invalid_package_type");
  }
  return values[0];
}

function assertSupportedContentType(request: Request): void {
  const raw = request.headers.get("content-type");
  const baseMediaType = raw?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    baseMediaType !== "application/zip" &&
    baseMediaType !== "application/octet-stream"
  ) {
    throw new KohoManualImportHttpError(415, "unsupported_content_type");
  }
}

function parseDeclaredContentLength(
  request: Request,
  maxSourceBytes: number,
): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new KohoManualImportHttpError(400, "invalid_content_length");
  }

  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new KohoManualImportHttpError(400, "invalid_content_length");
  }
  if (length > maxSourceBytes) {
    throw new KohoManualImportHttpError(413, "package_too_large");
  }
  return length;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("bounded temp write failed");
    }
    offset += bytesWritten;
  }
}

export async function withBoundedKohoTempSource<T>(
  request: Request,
  maxSourceBytes: number,
  declaredContentLength: number | null,
  consumeSource: (source: KohoBoundedTempSource) => Promise<T>,
  options: KohoBoundedTempSourceOptions = {},
): Promise<T> {
  const removeTempDirectory =
    options.removeTempDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  const directory = await mkdtemp(
    join(options.tempRoot ?? tmpdir(), TEMP_PREFIX),
  );
  const sourcePath = join(directory, randomUUID());
  let handle: FileHandle | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let abortBodyRead: (() => void) | null = null;
  let cancelBodyRead: (() => void) | null = null;
  let bodyComplete = false;

  try {
    handle = await open(sourcePath, "wx", 0o600);
    const body = request.body;
    if (body === null) {
      throw new KohoManualImportHttpError(400, "empty_body");
    }

    const bodyReader = body.getReader();
    reader = bodyReader;
    let rejectAbortedRead: (reason: Error) => void = () => undefined;
    const abortedRead = new Promise<never>((_resolve, reject) => {
      rejectAbortedRead = reject;
    });
    let bodyCancelRequested = false;
    cancelBodyRead = () => {
      if (bodyCancelRequested) return;
      bodyCancelRequested = true;
      void bodyReader.cancel().catch(() => undefined);
    };
    let abortTriggered = false;
    abortBodyRead = () => {
      if (abortTriggered) return;
      abortTriggered = true;
      rejectAbortedRead(new Error("request aborted"));
      cancelBodyRead?.();
    };
    request.signal.addEventListener("abort", abortBodyRead, { once: true });
    if (request.signal.aborted) abortBodyRead();

    const hash = createHash("sha256");
    let observedBytes = 0;

    while (true) {
      const { done, value } = await Promise.race([
        bodyReader.read(),
        abortedRead,
      ]);
      if (request.signal.aborted) {
        throw new Error("request aborted");
      }
      if (done) {
        bodyComplete = true;
        break;
      }
      if (value.byteLength > maxSourceBytes - observedBytes) {
        cancelBodyRead();
        throw new KohoManualImportHttpError(413, "package_too_large");
      }

      observedBytes += value.byteLength;
      hash.update(value);
      await writeAll(handle, value);
    }

    if (observedBytes === 0) {
      throw new KohoManualImportHttpError(400, "empty_body");
    }
    if (
      declaredContentLength !== null &&
      observedBytes !== declaredContentLength
    ) {
      throw new KohoManualImportHttpError(400, "content_length_mismatch");
    }

    await handle.close();
    handle = null;

    return await consumeSource({
      path: sourcePath,
      sourceSha256: hash.digest("hex"),
      byteLength: observedBytes,
    });
  } finally {
    let cleanupFailed = false;
    if (abortBodyRead !== null) {
      request.signal.removeEventListener("abort", abortBodyRead);
    }
    if (reader !== null) {
      if (!bodyComplete) cancelBodyRead?.();
      try {
        reader.releaseLock();
      } catch {
        // The body stream owns no durable state after the request finishes.
      }
    }
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await removeTempDirectory(directory);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new KohoManualImportHttpError(
        500,
        "koho_import_internal_error",
      );
    }
  }
}

export function buildKohoManualImportLimits(
  maxSourceBytes: number,
): KohoPackageLimits {
  if (
    !Number.isSafeInteger(maxSourceBytes) ||
    maxSourceBytes < 1 ||
    maxSourceBytes > MAX_CONFIGURED_SOURCE_BYTES
  ) {
    throw new KohoManualImportHttpError(503, "koho_import_disabled");
  }

  return {
    zip: {
      maxSourceBytes,
      maxCentralDirectoryBytes: Math.min(maxSourceBytes, 134_217_728),
      maxEntries: 250_000,
      maxTotalCompressedBytes: maxSourceBytes,
      maxTotalUncompressedBytes: maxSourceBytes * 8,
      maxEntryCompressedBytes: Math.min(maxSourceBytes, 2_147_483_648),
      maxEntryUncompressedBytes: 2_147_483_648,
      maxTotalReadUncompressedBytes: maxSourceBytes * 4,
    },
    csv: {
      maxInputBytes: 134_217_728,
      maxRecords: 250_000,
      maxColumnsPerRecord: 512,
      maxCellCharacters: 8_388_608,
      maxTotalCharacters: 268_435_456,
    },
    xml: {
      maxXmlBytes: 67_108_864,
      maxDepth: 256,
      maxElements: 5_000_000,
      maxTextBytes: 67_108_864,
    },
  };
}

function isPlanValidationError(error: unknown): boolean {
  return error instanceof KohoImportPlanValidationError;
}

export function createKohoManualImportPostHandler(
  dependencies: KohoManualImportHandlerDependencies,
): (request: Request) => Promise<Response> {
  const parsePackage = dependencies.parsePackage ?? parseKohoPackage;
  const buildPlan = dependencies.buildPlan ?? buildKohoImportPlan;
  const withTempSource =
    dependencies.withTempSource ?? withBoundedKohoTempSource;
  const getEnvironmentValue =
    dependencies.getEnvironmentValue ?? ((name) => process.env[name]);
  const isValidationError =
    dependencies.isValidationError ?? isPlanValidationError;

  return async function post(request: Request): Promise<Response> {
    const config = readConfig(getEnvironmentValue);
    if (config === null) {
      return jsonError(503, "koho_import_disabled");
    }
    if (!isAuthorized(request.headers.get("authorization"), config.token)) {
      return jsonError(401, "unauthorized");
    }

    let packageType: KohoPackageType;
    let declaredContentLength: number | null;
    try {
      packageType = parsePackageType(request);
      assertSupportedContentType(request);
      declaredContentLength = parseDeclaredContentLength(
        request,
        config.maxSourceBytes,
      );
    } catch (error) {
      if (error instanceof KohoManualImportHttpError) {
        return jsonError(error.status, error.code);
      }
      return jsonError(500, "koho_import_internal_error");
    }

    const limits = buildKohoManualImportLimits(config.maxSourceBytes);

    try {
      return await withTempSource(
        request,
        config.maxSourceBytes,
        declaredContentLength,
        async ({ path, sourceSha256 }) => {
          let packageResult: KohoPackageParseResult;
          try {
            packageResult = await parsePackage({
              packageType,
              source: { type: "file", path },
              limits,
            });
          } catch {
            throw new KohoManualImportHttpError(
              500,
              "koho_import_internal_error",
            );
          }

          if (packageResult.status === "failed") {
            throw new KohoManualImportHttpError(422, "package_parse_failed");
          }

          let plan: KohoImportPlan;
          try {
            plan = buildPlan({ packageResult, sourceSha256 });
          } catch (error) {
            if (isValidationError(error)) {
              throw new KohoManualImportHttpError(
                422,
                "package_validation_failed",
              );
            }
            throw new KohoManualImportHttpError(
              500,
              "koho_import_internal_error",
            );
          }

          let saveResult: KohoImportSaveResult;
          try {
            saveResult = await dependencies.repository.savePlan(plan);
          } catch (error) {
            if (isValidationError(error)) {
              throw new KohoManualImportHttpError(
                422,
                "package_validation_failed",
              );
            }
            throw new KohoManualImportHttpError(
              503,
              "koho_import_storage_unavailable",
            );
          }

          return Response.json({
            packageType: plan.packageType,
            packageStatus: plan.packageStatus,
            sourceSha256: plan.sourceSha256,
            importId: saveResult.run.importId,
            documentCount: plan.documentCount,
            savedDocumentCount: saveResult.savedDocumentCount,
            amendmentCount: plan.amendmentCount,
            nestedSt26Count: plan.nestedSt26Count,
          });
        },
      );
    } catch (error) {
      if (error instanceof KohoManualImportHttpError) {
        return jsonError(error.status, error.code);
      }
      return jsonError(500, "koho_import_internal_error");
    }
  };
}
