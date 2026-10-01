import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pathToFileURL } from "node:url";

export const JOB_EXIT_CODES = Object.freeze({
  success: 0,
  internal: 1,
  config: 2,
  source: 3,
  child: 4,
  timeout: 5,
  import: 6,
  signal: 7,
  cleanup: 8,
});

const MAX_SOURCE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 120 * 60;
const CLEANUP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_LOOPBACK_PORT = 3000;
const REQUIRED_DATABASE_SCOPE = "issue-75-dedicated-staging";
const SAS_EXPIRY_MARGIN_MS = 5 * 60 * 1_000;
const MAX_SAS_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const TEMP_PREFIX = "patentai-koho-job-";
const IMPORT_RESULT_FIELDS = Object.freeze([
  "amendmentCount",
  "documentCount",
  "importId",
  "nestedSt26Count",
  "packageStatus",
  "packageType",
  "savedDocumentCount",
  "sourceSha256",
]);
const CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "Path",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TZ",
  "WINDIR",
]);

const FAILURE_REASONS = Object.freeze({
  config: "invalid_config",
  source: "source_failed",
  child: "child_failed",
  timeout: "timed_out",
  import: "import_failed",
  signal: "interrupted",
  cleanup: "cleanup_failed",
  internal: "internal_error",
});

class JobFailure extends Error {
  constructor(kind, reason = FAILURE_REASONS[kind]) {
    super(reason);
    this.name = "JobFailure";
    this.kind = kind;
    this.reason = reason;
  }
}

function invalidConfig() {
  return new JobFailure("config");
}

function parseInteger(raw, minimum, maximum) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw invalidConfig();
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidConfig();
  }
  return value;
}

function exactlyOneSearchParameter(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0].length === 0) {
    throw invalidConfig();
  }
  return values[0];
}

function parseBlobUrl(raw, timeoutMilliseconds, nowMilliseconds) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8_192) {
    throw invalidConfig();
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidConfig();
  }

  const pathSegments = url.pathname.split("/").filter(Boolean);
  const storageAccount = url.hostname.slice(
    0,
    -".blob.core.windows.net".length,
  );
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".blob.core.windows.net") ||
    !/^[a-z0-9]{3,24}$/.test(storageAccount) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    pathSegments.length < 2
  ) {
    throw invalidConfig();
  }

  const permissions = exactlyOneSearchParameter(url, "sp");
  const resource = exactlyOneSearchParameter(url, "sr");
  const protocol = exactlyOneSearchParameter(url, "spr");
  const signature = exactlyOneSearchParameter(url, "sig");
  const expiry = exactlyOneSearchParameter(url, "se");
  const expiryMilliseconds = Date.parse(expiry);

  if (
    permissions !== "r" ||
    resource !== "b" ||
    protocol !== "https" ||
    signature.length < 8 ||
    !Number.isFinite(expiryMilliseconds) ||
    expiryMilliseconds <=
      nowMilliseconds + timeoutMilliseconds + SAS_EXPIRY_MARGIN_MS ||
    expiryMilliseconds > nowMilliseconds + MAX_SAS_LIFETIME_MS
  ) {
    throw invalidConfig();
  }

  return raw;
}

export function parseDatabaseIdentity(environment) {
  const databaseScope = environment.KOHO_JOB_DATABASE_SCOPE;
  const expectedHost = environment.KOHO_JOB_EXPECTED_DATABASE_HOST;
  const expectedName = environment.KOHO_JOB_EXPECTED_DATABASE_NAME;
  const rawDatabaseUrl = environment.DATABASE_URL;

  if (
    databaseScope !== REQUIRED_DATABASE_SCOPE ||
    typeof expectedHost !== "string" ||
    expectedHost.length === 0 ||
    expectedHost.length > 253 ||
    typeof expectedName !== "string" ||
    expectedName.length === 0 ||
    expectedName.length > 128 ||
    expectedName.toLowerCase() === "patentai" ||
    typeof rawDatabaseUrl !== "string" ||
    rawDatabaseUrl.length === 0 ||
    rawDatabaseUrl.length > 8_192
  ) {
    throw invalidConfig();
  }

  let databaseUrl;
  let actualName;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
    actualName = decodeURIComponent(databaseUrl.pathname.slice(1));
  } catch {
    throw invalidConfig();
  }

  if (
    (databaseUrl.protocol !== "postgres:" &&
      databaseUrl.protocol !== "postgresql:") ||
    !databaseUrl.hostname.endsWith(".postgres.database.azure.com") ||
    (databaseUrl.port !== "" && databaseUrl.port !== "5432") ||
    databaseUrl.username.length === 0 ||
    databaseUrl.password.length === 0 ||
    databaseUrl.hash !== "" ||
    databaseUrl.host !== expectedHost ||
    actualName !== expectedName ||
    actualName.includes("/") ||
    actualName.toLowerCase() === "patentai"
  ) {
    throw invalidConfig();
  }

  const queryEntries = [...databaseUrl.searchParams.entries()];
  const sslModes = databaseUrl.searchParams.getAll("sslmode");
  if (
    queryEntries.length !== 1 ||
    queryEntries[0][0] !== "sslmode" ||
    sslModes.length !== 1 ||
    !["require", "verify-ca", "verify-full"].includes(sslModes[0])
  ) {
    throw invalidConfig();
  }

  return rawDatabaseUrl;
}

export function readJobConfig(
  environment = process.env,
  nowMilliseconds = Date.now(),
) {
  const packageType = environment.KOHO_JOB_PACKAGE_TYPE;
  if (packageType !== "JPA" && packageType !== "JPB") {
    throw invalidConfig();
  }

  const expectedDocumentCount = parseInteger(
    environment.KOHO_JOB_EXPECTED_DOCUMENT_COUNT,
    1,
    10_000_000,
  );
  const maxSourceBytes = parseInteger(
    environment.KOHO_JOB_MAX_SOURCE_BYTES,
    1,
    MAX_SOURCE_BYTES,
  );
  const timeoutSeconds = parseInteger(
    environment.KOHO_JOB_TIMEOUT_SECONDS,
    Math.floor(CLEANUP_TIMEOUT_MS / 1_000) + 1,
    MAX_TIMEOUT_SECONDS,
  );
  const timeoutMilliseconds = timeoutSeconds * 1_000;
  const operationTimeoutMilliseconds =
    timeoutMilliseconds - CLEANUP_TIMEOUT_MS;
  const loopbackPort =
    environment.KOHO_JOB_LOOPBACK_PORT === undefined
      ? DEFAULT_LOOPBACK_PORT
      : parseInteger(environment.KOHO_JOB_LOOPBACK_PORT, 1_024, 65_535);
  const databaseUrl = parseDatabaseIdentity(environment);
  const blobUrl = parseBlobUrl(
    environment.KOHO_JOB_BLOB_URL,
    timeoutMilliseconds,
    nowMilliseconds,
  );
  const expectedSourceSha256 = environment.KOHO_JOB_EXPECTED_SOURCE_SHA256;
  if (
    typeof expectedSourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedSourceSha256)
  ) {
    throw invalidConfig();
  }

  return Object.freeze({
    packageType,
    expectedDocumentCount,
    maxSourceBytes,
    timeoutMilliseconds,
    operationTimeoutMilliseconds,
    loopbackPort,
    databaseUrl,
    blobUrl,
    expectedSourceSha256,
  });
}

function abortFailure(signal, fallback = "internal") {
  const reason = signal.reason;
  if (reason instanceof JobFailure) return reason;
  return new JobFailure(fallback);
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(abortFailure(signal));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortFailure(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function wait(milliseconds, signal) {
  return raceWithAbort(
    new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, milliseconds);
      timer.unref?.();
    }),
    signal,
  );
}

export async function readBoundedJson(
  response,
  maximumBytes = MAX_RESPONSE_BYTES,
) {
  if (response.body === null) throw new JobFailure("import");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let observedBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximumBytes - observedBytes) {
        throw new JobFailure("import");
      }
      observedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof JobFailure) throw error;
    throw new JobFailure("import");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // No durable resource remains after the response is consumed.
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new JobFailure("import");
  }
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateImportResult(payload, config) {
  const fields =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    fields.length !== IMPORT_RESULT_FIELDS.length ||
    fields.some((field, index) => field !== IMPORT_RESULT_FIELDS[index]) ||
    payload.packageType !== config.packageType ||
    (payload.packageStatus !== "success" &&
      payload.packageStatus !== "review_required") ||
    !Number.isSafeInteger(payload.importId) ||
    payload.importId < 1 ||
    payload.sourceSha256 !== config.expectedSourceSha256 ||
    !isNonNegativeInteger(payload.documentCount) ||
    !isNonNegativeInteger(payload.savedDocumentCount) ||
    !isNonNegativeInteger(payload.amendmentCount) ||
    !isNonNegativeInteger(payload.nestedSt26Count)
  ) {
    throw new JobFailure("import");
  }

  if (
    payload.documentCount !== config.expectedDocumentCount ||
    payload.savedDocumentCount !== config.expectedDocumentCount
  ) {
    throw new JobFailure("import", "count_mismatch");
  }

  return Object.freeze({
    packageStatus: payload.packageStatus,
    savedDocumentCount: payload.savedDocumentCount,
    amendmentCount: payload.amendmentCount,
    nestedSt26Count: payload.nestedSt26Count,
  });
}

function createChildEnvironment(environment, config, token, tempRoot) {
  const childEnvironment = {};
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = environment[name];
    if (typeof value === "string") childEnvironment[name] = value;
  }

  return {
    ...childEnvironment,
    DATABASE_URL: config.databaseUrl,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NO_PROXY: "127.0.0.1,localhost",
    KOHO_LOOPBACK_REQUEST_TIMEOUT_MS: String(
      config.operationTimeoutMilliseconds,
    ),
    HOSTNAME: "127.0.0.1",
    PORT: String(config.loopbackPort),
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    KOHO_IMPORT_ADMIN_TOKEN: token,
    KOHO_IMPORT_MAX_SOURCE_BYTES: String(config.maxSourceBytes),
  };
}

function trackChild(child) {
  let exited = false;
  let spawned = child.pid !== undefined;
  let resolveExit;
  const exit = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const settle = (value) => {
    if (exited) return;
    exited = true;
    resolveExit(value);
  };

  child.once("spawn", () => {
    spawned = true;
  });
  child.on("error", () => {
    // A pre-spawn error means no child exists. After spawn, however, `error`
    // can also report a failed kill/send operation while the process remains
    // alive, so only exit/close may confirm its termination.
    if (!spawned && child.pid === undefined) {
      settle({ code: null, signal: null });
    }
  });
  child.once("exit", (code, signal) => settle({ code, signal }));
  child.once("close", (code, signal) => settle({ code, signal }));
  child.stdout?.resume();
  child.stderr?.resume();

  return { exit, hasExited: () => exited };
}

function sendChildSignal(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

async function waitForChildExit(exit, milliseconds) {
  let timer;
  const timedOut = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), milliseconds);
    timer.unref?.();
  });
  const exited = exit.then(() => true);
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  return result;
}

async function stopChild(child, tracker) {
  if (tracker.hasExited()) return;
  try {
    sendChildSignal(child, "SIGTERM");
  } catch {
    // A simultaneous exit is confirmed by the bounded wait below.
  }
  if (await waitForChildExit(tracker.exit, 5_000)) return;

  try {
    sendChildSignal(child, "SIGKILL");
  } catch {
    // A simultaneous exit is confirmed by the bounded wait below.
  }
  if (!(await waitForChildExit(tracker.exit, 5_000))) {
    throw new JobFailure("cleanup");
  }
}

async function isApplicationReady(fetchImpl, port, signal) {
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      method: "GET",
      redirect: "error",
      signal,
    });
    if (!response.ok) return false;
    const payload = await readBoundedJson(response, 16 * 1024);
    return (
      payload !== null &&
      typeof payload === "object" &&
      payload.database !== null &&
      typeof payload.database === "object" &&
      payload.database.ok === true
    );
  } catch {
    if (signal.aborted) throw abortFailure(signal);
    return false;
  } finally {
    if (response?.body !== null && response?.body?.locked === false) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}

export async function startLoopbackApplication(input, dependencies = {}) {
  const spawnImpl = dependencies.spawn ?? spawn;
  const fetchImpl = dependencies.fetch ?? fetch;
  const serverPath = resolve(
    input.cwd ?? process.cwd(),
    "scripts",
    "koho-job",
    "server.mjs",
  );
  let child;
  try {
    child = spawnImpl(
      process.execPath,
      [serverPath],
      {
        cwd: input.cwd ?? process.cwd(),
        detached: process.platform !== "win32",
        env: createChildEnvironment(
          input.environment,
          input.config,
          input.token,
          input.tempRoot,
        ),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch {
    throw new JobFailure("child");
  }
  const tracker = trackChild(child);

  try {
    while (true) {
      const ready = await Promise.race([
        isApplicationReady(
          fetchImpl,
          input.config.loopbackPort,
          input.signal,
        ),
        tracker.exit.then(() => {
          throw new JobFailure("child");
        }),
      ]);
      if (ready) break;
      await Promise.race([
        wait(250, input.signal),
        tracker.exit.then(() => {
          throw new JobFailure("child");
        }),
      ]);
    }
  } catch (error) {
    try {
      await stopChild(child, tracker);
    } catch {
      throw new JobFailure("cleanup");
    }
    if (error instanceof JobFailure) throw error;
    throw new JobFailure("child");
  }

  return Object.freeze({
    exited: tracker.exit,
    stop: () => stopChild(child, tracker),
  });
}

async function downloadBlob(config, signal) {
  delete process.env.AZURE_LOG_LEVEL;
  let BlobClient;
  try {
    ({ BlobClient } = await import("@azure/storage-blob"));
  } catch {
    throw new JobFailure("source");
  }

  try {
    const client = new BlobClient(config.blobUrl, undefined, {
      retryOptions: { maxTries: 1 },
    });
    return await client.download(0, undefined, {
      abortSignal: signal,
      maxRetryRequests: 0,
    });
  } catch {
    if (signal.aborted) throw abortFailure(signal);
    throw new JobFailure("source");
  }
}

export function createBoundedUpload(source, maximumBytes, signal, onBytes) {
  if (
    source === null ||
    typeof source !== "object" ||
    typeof source.pipe !== "function" ||
    typeof source.destroy !== "function"
  ) {
    throw new JobFailure("source");
  }

  let receivedBytes = 0;
  let acceptedBytes = 0;
  let sourceFailed = false;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);
      receivedBytes += bytes.byteLength;
      if (bytes.byteLength > maximumBytes - acceptedBytes) {
        sourceFailed = true;
        onBytes(receivedBytes, acceptedBytes);
        callback(new JobFailure("source"));
        return;
      }
      acceptedBytes += bytes.byteLength;
      onBytes(receivedBytes, acceptedBytes);
      callback(null, bytes);
    },
  });
  const body = Readable.toWeb(limiter);
  const onSourceError = () => {
    sourceFailed = true;
    limiter.destroy(new JobFailure("source"));
  };
  const onAbort = () => {
    // The control-plane promise already carries the stable failure kind.
    // Cancel an unowned Web stream first so its adapter observes the close. A
    // locked stream is owned by fetch, which receives the same AbortSignal.
    if (!body.locked) {
      void body.cancel().catch(() => undefined);
      return;
    }
    source.destroy();
    limiter.destroy();
  };

  source.once("error", onSourceError);
  signal.addEventListener("abort", onAbort, { once: true });
  source.pipe(limiter);

  return Object.freeze({
    body,
    get receivedBytes() {
      return receivedBytes;
    },
    get acceptedBytes() {
      return acceptedBytes;
    },
    get sourceFailed() {
      return sourceFailed;
    },
    async cleanup() {
      signal.removeEventListener("abort", onAbort);
      source.removeListener("error", onSourceError);
      if (!body.locked) {
        await body.cancel().catch(() => undefined);
      }
      source.unpipe(limiter);
      if (!source.destroyed) source.destroy();
      if (!limiter.destroyed) limiter.destroy();
    },
  });
}

async function sendImport(input) {
  const headers = new Headers({
    authorization: `Bearer ${input.token}`,
    "content-type": "application/zip",
  });
  if (input.contentLength !== null) {
    headers.set("content-length", String(input.contentLength));
  }

  return fetch(
    `http://127.0.0.1:${input.port}/api/admin/koho-imports?packageType=${input.packageType}`,
    {
      method: "POST",
      headers,
      body: input.body,
      duplex: "half",
      redirect: "error",
      signal: input.signal,
    },
  );
}

async function directoryBytes(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        total += (await stat(entryPath)).size;
      }
    }
  }
  return total;
}

async function readMemorySample() {
  try {
    const raw = await readFile("/sys/fs/cgroup/memory.peak", "utf8");
    const value = Number(raw.trim());
    if (Number.isSafeInteger(value) && value >= 0) {
      return { bytes: value, source: "cgroup_peak" };
    }
  } catch {
    // Non-Linux Local runs fall back to the runner process RSS.
  }
  return { bytes: process.memoryUsage().rss, source: "process_rss" };
}

function startResourceSampler(tempRoot, metrics, dependencies) {
  let stopped = false;
  let activeSample = null;
  const sample = () => {
    if (stopped || activeSample !== null) return;
    const task = (async () => {
      const [memory, temp] = await Promise.all([
        dependencies.readMemorySample().catch(() => null),
        dependencies.directoryBytes(tempRoot).catch(() => null),
      ]);
      if (
        memory !== null &&
        Number.isSafeInteger(memory.bytes) &&
        memory.bytes >= 0 &&
        (memory.source === "cgroup_peak" || memory.source === "process_rss")
      ) {
        if (memory.bytes >= metrics.peakMemoryBytes) {
          metrics.peakMemoryBytes = memory.bytes;
          metrics.memorySource = memory.source;
        }
      }
      if (temp !== null) {
        metrics.peakTempBytes = Math.max(metrics.peakTempBytes, temp);
      }
    })().catch(() => undefined);
    activeSample = task;
    void task.finally(() => {
      if (activeSample === task) activeSample = null;
    });
  };
  sample();
  const interval = setInterval(sample, 250);
  interval.unref?.();

  return async () => {
    stopped = true;
    clearInterval(interval);
    if (activeSample !== null) await activeSample;
  };
}

function makeLog(config, failure, resultState, result, metrics, durationMs) {
  const common = {
    component: "koho_private_job",
    schemaVersion: 1,
    status: failure === null ? "succeeded" : "failed",
    result: resultState,
    durationMs,
    peakMemoryBytes: metrics.peakMemoryBytes,
    memorySource: metrics.memorySource,
    peakTempBytes: metrics.peakTempBytes,
    networkBytes: metrics.networkBytes,
    retryCount: 0,
  };

  if (config === null) {
    return { ...common, reason: failure.reason };
  }
  if (failure !== null) {
    return {
      ...common,
      reason: failure.reason,
      packageType: config.packageType,
      expectedDocumentCount: config.expectedDocumentCount,
    };
  }
  return {
    ...common,
    packageType: config.packageType,
    packageStatus: result.packageStatus,
    expectedDocumentCount: config.expectedDocumentCount,
    savedDocumentCount: result.savedDocumentCount,
    amendmentCount: result.amendmentCount,
    nestedSt26Count: result.nestedSt26Count,
  };
}

function normalizeFailure(error, signal) {
  if (error instanceof JobFailure) return error;
  if (signal.aborted) return abortFailure(signal);
  return new JobFailure("internal");
}

async function raceWithApplication(promise, application, signal) {
  return raceWithAbort(
    Promise.race([
      promise,
      application.exited.then(() => {
        throw new JobFailure("child");
      }),
    ]),
    signal,
  );
}

function trackLateResource(promise, cleanup) {
  return promise.then(
    async (resource) => {
      try {
        await cleanup(resource);
        return true;
      } catch {
        return false;
      }
    },
    () => true,
  );
}

async function trackLateSettlement(promise, cleanup) {
  try {
    await promise;
  } catch {
    // The resource still needs cleanup after either settlement outcome.
  }
  try {
    await cleanup();
    return true;
  } catch {
    return false;
  }
}

async function cancelResponseBody(response) {
  const body = response?.body;
  if (body === null || body === undefined) return;
  if (body.locked || typeof body.cancel !== "function") {
    throw new JobFailure("cleanup");
  }
  await body.cancel();
}

function destroyDownloadedResponse(response) {
  const stream = response?.readableStreamBody;
  if (stream !== undefined && typeof stream.destroy === "function") {
    stream.destroy();
  }
}

export async function runKohoJob(options = {}) {
  const dependencies = {
    now: () => Date.now(),
    makeTempRoot: () => mkdtemp(join(tmpdir(), TEMP_PREFIX)),
    removeTempRoot: (root) => rm(root, { recursive: true, force: true }),
    startApplication: startLoopbackApplication,
    downloadBlob,
    createBoundedUpload,
    sendImport,
    readResponse: readBoundedJson,
    readMemorySample,
    directoryBytes,
    randomToken: () => randomBytes(32).toString("base64url"),
    ...options.dependencies,
  };
  const environment = options.environment ?? process.env;
  const startedAt = dependencies.now();
  const metrics = {
    peakMemoryBytes: 0,
    memorySource: "not_sampled",
    peakTempBytes: 0,
    networkBytes: 0,
  };
  let config = null;

  try {
    config = readJobConfig(environment, startedAt);
  } catch (error) {
    const failure =
      error instanceof JobFailure ? error : new JobFailure("config");
    return {
      exitCode: JOB_EXIT_CODES[failure.kind],
      log: makeLog(
        null,
        failure,
        "not_started",
        null,
        metrics,
        Math.max(0, dependencies.now() - startedAt),
      ),
    };
  }

  const controller = new AbortController();
  const abort = (failure) => {
    if (!controller.signal.aborted) controller.abort(failure);
  };
  const externalSignal = options.signal;
  const onExternalAbort = () => abort(new JobFailure("signal"));
  if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal.aborted) onExternalAbort();
  }
  const operationTimeout = setTimeout(
    () => abort(new JobFailure("timeout")),
    config.operationTimeoutMilliseconds,
  );

  let tempRoot = null;
  let application = null;
  let downloadedStream = null;
  let boundedUpload = null;
  let response = null;
  let responseCleanupTracked = false;
  let stopSampler = null;
  const lateCleanupTasks = [];
  let failure = null;
  let result = null;
  let resultState = "not_started";

  try {
    if (controller.signal.aborted) throw abortFailure(controller.signal);
    const tempRootPromise = Promise.resolve().then(() =>
      dependencies.makeTempRoot(),
    );
    try {
      tempRoot = await raceWithAbort(tempRootPromise, controller.signal);
    } catch (error) {
      lateCleanupTasks.push(
        trackLateResource(tempRootPromise, (lateTempRoot) =>
          dependencies.removeTempRoot(lateTempRoot),
        ),
      );
      throw error;
    }
    stopSampler = startResourceSampler(tempRoot, metrics, dependencies);
    const token = dependencies.randomToken();
    if (typeof token !== "string" || Buffer.byteLength(token, "utf8") < 32) {
      throw new JobFailure("internal");
    }

    const applicationPromise = Promise.resolve().then(() =>
      dependencies.startApplication({
        config,
        environment,
        token,
        tempRoot,
        signal: controller.signal,
      }),
    );
    try {
      application = await raceWithAbort(
        applicationPromise,
        controller.signal,
      );
    } catch (error) {
      lateCleanupTasks.push(
        trackLateResource(applicationPromise, (lateApplication) =>
          lateApplication.stop(),
        ),
      );
      throw error;
    }

    let download;
    const downloadPromise = Promise.resolve().then(() =>
      dependencies.downloadBlob(config, controller.signal),
    );
    try {
      download = await raceWithApplication(
        downloadPromise,
        application,
        controller.signal,
      );
    } catch (error) {
      lateCleanupTasks.push(
        trackLateResource(downloadPromise, destroyDownloadedResponse),
      );
      if (controller.signal.aborted) throw abortFailure(controller.signal);
      if (error instanceof JobFailure) throw error;
      throw new JobFailure("source");
    }

    const contentLength = download.contentLength;
    downloadedStream = download.readableStreamBody ?? null;
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 1 ||
        contentLength > config.maxSourceBytes)
    ) {
      download.readableStreamBody?.destroy?.();
      throw new JobFailure("source");
    }
    if (download.readableStreamBody === undefined) {
      throw new JobFailure("source");
    }

    boundedUpload = dependencies.createBoundedUpload(
      download.readableStreamBody,
      config.maxSourceBytes,
      controller.signal,
      (receivedBytes, acceptedBytes) => {
        metrics.networkBytes = receivedBytes;
        // The manual handler can write only bytes accepted downstream. Keep
        // that lower bound separate from a rejected over-limit network chunk.
        metrics.peakTempBytes = Math.max(metrics.peakTempBytes, acceptedBytes);
      },
    );
    resultState = "unknown";

    const responsePromise = Promise.resolve().then(() =>
      dependencies.sendImport({
        port: config.loopbackPort,
        packageType: config.packageType,
        token,
        body: boundedUpload.body,
        contentLength: contentLength ?? null,
        signal: controller.signal,
      }),
    );
    try {
      response = await raceWithApplication(
        responsePromise,
        application,
        controller.signal,
      );
    } catch (error) {
      lateCleanupTasks.push(
        trackLateResource(responsePromise, cancelResponseBody),
      );
      responseCleanupTracked = true;
      if (controller.signal.aborted) throw abortFailure(controller.signal);
      if (boundedUpload.sourceFailed) throw new JobFailure("source");
      if (error instanceof JobFailure) throw error;
      throw new JobFailure("import");
    }

    let payload;
    const readResponsePromise = Promise.resolve().then(() =>
      dependencies.readResponse(response),
    );
    try {
      payload = await raceWithApplication(
        readResponsePromise,
        application,
        controller.signal,
      );
    } catch (error) {
      lateCleanupTasks.push(
        trackLateSettlement(readResponsePromise, () =>
          cancelResponseBody(response),
        ),
      );
      responseCleanupTracked = true;
      if (controller.signal.aborted) throw abortFailure(controller.signal);
      if (error instanceof JobFailure) throw error;
      throw new JobFailure("import");
    }
    if (!response.ok) throw new JobFailure("import");

    try {
      result = validateImportResult(payload, config);
    } catch (error) {
      if (error instanceof JobFailure && error.reason === "count_mismatch") {
        resultState = "confirmed_mismatch";
      }
      throw error;
    }
    resultState = "confirmed";
  } catch (error) {
    failure = normalizeFailure(error, controller.signal);
  } finally {
    if (failure !== null) abort(failure);
    const cleanupTasks = [...lateCleanupTasks];
    const attemptCleanup = (callback) =>
      Promise.resolve()
        .then(callback)
        .then(
          () => true,
          () => false,
        );
    if (boundedUpload !== null) {
      cleanupTasks.push(attemptCleanup(() => boundedUpload.cleanup()));
    } else if (downloadedStream !== null) {
      cleanupTasks.push(attemptCleanup(() => downloadedStream.destroy()));
    }
    if (response !== null && !responseCleanupTracked) {
      cleanupTasks.push(attemptCleanup(() => cancelResponseBody(response)));
    }
    if (application !== null) {
      cleanupTasks.push(attemptCleanup(() => application.stop()));
    }
    if (stopSampler !== null) {
      cleanupTasks.push(attemptCleanup(() => stopSampler()));
    }
    if (tempRoot !== null) {
      cleanupTasks.push(
        attemptCleanup(() => dependencies.removeTempRoot(tempRoot)),
      );
    }
    let cleanupFailed = false;
    const cleanupWork = Promise.all(cleanupTasks).then((outcomes) => {
      cleanupFailed = outcomes.some((outcome) => outcome === false);
    });
    const elapsedMilliseconds = Math.max(
      0,
      dependencies.now() - startedAt,
    );
    const cleanupBudgetMilliseconds = Math.max(
      1,
      Math.min(
        CLEANUP_TIMEOUT_MS,
        config.timeoutMilliseconds - elapsedMilliseconds,
      ),
    );
    let cleanupDeadline;
    const cleanupTimedOut = new Promise((resolvePromise) => {
      cleanupDeadline = setTimeout(
        () => resolvePromise(true),
        cleanupBudgetMilliseconds,
      );
    });
    const cleanupCompleted = cleanupWork.then(() => false);
    const didCleanupTimeOut = await Promise.race([
      cleanupCompleted,
      cleanupTimedOut,
    ]);
    clearTimeout(cleanupDeadline);
    clearTimeout(operationTimeout);
    if (didCleanupTimeOut) {
      cleanupFailed = true;
      resultState = "unknown";
    }
    if (failure === null && controller.signal.aborted) {
      failure = abortFailure(controller.signal);
      resultState = "unknown";
    }
    if (cleanupFailed) {
      failure = new JobFailure("cleanup");
      resultState = "unknown";
    }
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  const durationMs = Math.max(0, dependencies.now() - startedAt);
  return {
    exitCode:
      failure === null ? JOB_EXIT_CODES.success : JOB_EXIT_CODES[failure.kind],
    log: makeLog(
      config,
      failure,
      resultState,
      result,
      metrics,
      durationMs,
    ),
  };
}

async function main() {
  // The SDK logger is intentionally disabled before its dynamic import so a
  // credential-bearing Blob URL cannot reach stdout/stderr through diagnostics.
  delete process.env.AZURE_LOG_LEVEL;
  const signalController = new AbortController();
  const onSignal = () => signalController.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let outcome;
  try {
    outcome = await runKohoJob({ signal: signalController.signal });
  } catch {
    outcome = {
      exitCode: JOB_EXIT_CODES.internal,
      log: {
        component: "koho_private_job",
        schemaVersion: 1,
        status: "failed",
        result: "unknown",
        reason: "internal_error",
        durationMs: 0,
        peakMemoryBytes: 0,
        memorySource: "not_sampled",
        peakTempBytes: 0,
        networkBytes: 0,
        retryCount: 0,
      },
    };
  }

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await new Promise((resolvePromise) => {
    process.stdout.write(`${JSON.stringify(outcome.log)}\n`, resolvePromise);
  });
  process.exit(outcome.exitCode);
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main();
}
