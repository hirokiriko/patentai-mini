/** Operator CLI. Configuration and credentials arrive only through private stdin. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoImportPlan } from "../src/lib/koho-import/builder";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { MANUAL_DEADLINE_MS, MANUAL_INPUT_BYTES, parseManualConfiguration, requireManual,
  type ManualConfiguration } from "../src/lib/koho-import/manual-cli-config";
import { copyManualSource, inspectManualDirectory, inspectManualSource, verifyManualSnapshot } from "../src/lib/koho-import/manual-cli-source";
import { projectManualResult, summarizeManualPackage, type ManualFileResult } from "../src/lib/koho-import/manual-cli-summary";
import { ManualReceipt, type ManualBinding, type ManualCleanup } from "../src/lib/koho-import/manual-cli-receipt";

type WorkerInput = { config: ManualConfiguration; index: number; size: number; directory: string };
type WorkerEvent = { type: "progress" | "result"; result: ManualFileResult } |
  { type: "input_verified"; requestId: string; binding: ManualBinding };
const emptyResult = (config: ManualConfiguration, index: number): ManualFileResult => ({
  ordinal: index + 1, packageType: config.files[index].packageType, outcome: "not_processed",
  savedDocumentCount: 0, includesReviewRequired: false,
});

export async function runManualWorker(input: WorkerInput, emit: (event: WorkerEvent) => void,
  verify?: (binding: ManualBinding) => Promise<void>) {
  const config = parseManualConfiguration(input.config);
  requireManual(Number.isInteger(input.index) && input.index >= 0 && input.index < config.files.length &&
    Number.isSafeInteger(input.size) && input.size > 0 && input.size <= config.maxFileBytes && input.size <= config.maxTotalBytes);
  const file = config.files[input.index];
  const result = emptyResult(config, input.index); result.outcome = "failed_before_save";
  try {
    const snapshot = join(input.directory, "source.zip");
    const digest = await copyManualSource(file.path, snapshot, input.size);
    await verifyManualSnapshot(snapshot, input.size, digest);
    const parsed = await parseKohoPackage({ packageType: file.packageType,
      source: { type: "file", path: snapshot }, limits: buildKohoManualImportLimits(input.size) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: digest });
    result.summary = summarizeManualPackage(parsed, plan);
    await verifyManualSnapshot(snapshot, input.size, digest);
    await verifyManualSnapshot(file.path, input.size, digest);
    if (config.receipt) {
      requireManual(verify);
      await verify({ ordinal: input.index + 1, packageType: file.packageType, byteLength: input.size, sha256: digest });
    }
    if (plan.packageStatus === "failed" || (plan.documentCount === 0 && plan.packageStatus === "review_required")) return result;
    if (config.mode === "preview") { result.outcome = "preview_not_saved"; return result; }
    if (plan.packageStatus === "review_required" && !config.allowReviewRequired) {
      result.outcome = "review_not_saved"; return result;
    }
    const { saveManualPlan } = await import("../src/lib/koho-import/manual-cli-db");
    const saved = await saveManualPlan(config, plan, () => {
      result.outcome = "save_outcome_unknown"; emit({ type: "progress", result });
    });
    result.outcome = saved.outcome; result.savedDocumentCount = saved.savedDocumentCount;
    result.includesReviewRequired = (saved.outcome === "inserted" || saved.outcome === "reused") && plan.packageStatus === "review_required";
    return result;
  } catch { return result; }
}

export function manualChildEnvironment() {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  // In particular, do not pass DATABASE_URL, PG*, NODE_OPTIONS or provider settings.
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function until<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("manual_deadline")), Math.max(1, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function superviseFile(input: WorkerInput, deadline: number, signal?: AbortSignal, receipt?: ManualReceipt) {
  let result = emptyResult(input.config, input.index);
  // Even a crash before the progress IPC arrives must never assert no write.
  result.outcome = input.config.mode === "apply" ? "save_outcome_unknown" : "failed_before_save";
  let child: ChildProcess | undefined;
  let cleanupRequired = false;
  let receiptFailed = false;
  await new Promise<void>(resolvePromise => {
    let finished = false;
    let verificationPending = false, verificationSeen = false, acknowledged = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (finished || killTimer) return;
      child?.kill("SIGKILL");
      killTimer = setTimeout(() => {
        cleanupRequired = true;
        child?.unref(); child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
        if (child?.connected) child.disconnect();
        finish();
      }, 5_000);
    };
    const timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
    const finish = () => { if (finished) return;
      if (verificationPending) { receipt?.invalidate(); receiptFailed = true; }
      finished = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop); resolvePromise(); };
    try {
      const forkOptions = { silent: true, execArgv: [], env: manualChildEnvironment(), windowsHide: true };
      child = fork(__filename, ["--worker"], forkOptions);
      // Worker output is never relayed. Only internally constructed IPC records leave the supervisor.
      child.stdout?.resume(); child.stderr?.resume();
      child.on("message", (event: WorkerEvent) => {
        if (finished || !event || typeof event !== "object") return;
        if (event.type === "input_verified") {
          if (!receipt || verificationSeen || !event.binding || event.binding.ordinal !== input.index + 1 ||
            event.binding.byteLength !== input.size || typeof event.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(event.requestId)) {
            receipt?.invalidate(); receiptFailed = !!receipt; stop(); return;
          }
          verificationSeen = true; verificationPending = true;
          void receipt.verify(event.binding).then(() => {
            verificationPending = false;
            if (finished || killTimer || signal?.aborted || performance.now() >= deadline || !child?.connected) {
              receipt.invalidate(); receiptFailed = true; stop(); return;
            }
            acknowledged = true;
            try {
              child.send({ type: "binding_ack", ordinal: event.binding.ordinal, requestId: event.requestId, accepted: true }, error => {
                if (error) { receipt.invalidate(); receiptFailed = true; stop(); }
              });
            } catch { receipt.invalidate(); receiptFailed = true; stop(); }
          }).catch(() => {
            verificationPending = false; receiptFailed = true;
            if (!finished && !killTimer && !signal?.aborted && performance.now() < deadline && child?.connected) {
              try { child.send({ type: "binding_ack", ordinal: event.binding.ordinal, requestId: event.requestId, accepted: false }, error => { if (error) stop(); }); }
              catch { stop(); }
            } else stop();
          });
        } else if (event.type === "progress" || event.type === "result") {
          try {
            const projected = projectManualResult(event.result, input.index + 1, input.config.files[input.index].packageType);
            requireManual(!receipt || acknowledged || !["inserted", "reused", "save_outcome_unknown"].includes(projected.outcome));
            result = projected;
          } catch { receipt?.invalidate(); receiptFailed = !!receipt; stop(); }
        }
      });
      child.once("error", () => { stop(); });
      child.once("close", finish);
      child.stdin!.on("error", () => { stop(); });
      child.stdin!.end(JSON.stringify(input));
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    } catch { finish(); }
  });
  return { result, cleanupRequired, receiptFailed };
}

async function requestBinding(binding: ManualBinding) {
  requireManual(process.connected && process.send);
  const requestId = randomUUID();
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return; settled = true;
      clearTimeout(timer); process.removeListener("message", message); process.removeListener("disconnect", disconnected);
      if (accepted) resolvePromise(); else reject(new Error("manual_receipt_stopped"));
    };
    const message = (event: unknown) => {
      const ack = event as { type?: string; ordinal?: number; requestId?: string; accepted?: boolean };
      if (ack?.type === "binding_ack" && ack.ordinal === binding.ordinal && ack.requestId === requestId) finish(ack.accepted === true);
    };
    const disconnected = () => finish(false);
    const timer = setTimeout(disconnected, MANUAL_DEADLINE_MS);
    process.on("message", message); process.once("disconnect", disconnected);
    try { process.send!({ type: "input_verified", requestId, binding }, error => { if (error) finish(false); }); }
    catch { finish(false); }
  });
}

export async function runManualBatch(value: unknown, options: { deadlineMs?: number; signal?: AbortSignal } = {}) {
  const config = parseManualConfiguration(value);
  const results = config.files.map((_, i) => emptyResult(config, i));
  const deadline = performance.now() + Math.min(options.deadlineMs ?? MANUAL_DEADLINE_MS, MANUAL_DEADLINE_MS);
  let cleanup: ManualCleanup = "complete", stopped = false;
  const receipt = config.receipt ? new ManualReceipt(config, deadline, options.signal) : undefined;
  let receiptFailed = false, recordedFiles = 0;
  if (receipt) {
    try { await receipt.start(); }
    catch { receiptFailed = true; stopped = true; }
  }
  const sizes: number[] = [];
  // Admit the whole list before any snapshot or database write.
  try {
    let total = 0;
    for (const f of stopped ? [] : config.files) {
      requireManual(performance.now() < deadline && !options.signal?.aborted);
      const stat = await until(inspectManualSource(f.path, config.maxFileBytes), deadline);
      total += stat.size; requireManual(total <= config.maxTotalBytes); sizes.push(stat.size);
    }
  } catch {
    results[Math.min(sizes.length, results.length - 1)].outcome = "failed_before_save";
    stopped = true;
  }
  for (let index = 0; index < config.files.length && !stopped; index++) {
    let directory: string | undefined;
    let childCleanupRequired = false;
    let stagingUnconfirmed = false;
    try {
      requireManual(performance.now() < deadline && !options.signal?.aborted);
      const parent = resolve(tmpdir());
      await until(inspectManualDirectory(parent), deadline);
      stagingUnconfirmed = true;
      directory = await until<string>(mkdtemp(join(parent, "koho-manual-")).then(async created => {
        // A late filesystem completion still owns its exact directory and must clean it.
        if (performance.now() >= deadline || options.signal?.aborted) {
          await rm(created, { recursive: true, force: true });
          throw new Error("manual_deadline");
        }
        return created;
      }), deadline);
      stagingUnconfirmed = false;
      requireManual(dirname(directory) === parent);
      const child = await superviseFile({ config, index, size: sizes[index], directory }, deadline, options.signal, receipt);
      results[index] = child.result; childCleanupRequired = child.cleanupRequired;
      if (child.receiptFailed) { receiptFailed = true; stopped = true; }
      if (childCleanupRequired) { cleanup = "required"; stopped = true; }
    } catch {
      results[index].outcome = "failed_before_save";
      if (stagingUnconfirmed) { cleanup = "required"; stopped = true; }
    }
    finally {
      // Only this exact mkdtemp child is removed, after its process has exited.
      if (directory && !childCleanupRequired) {
        try { await until(rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }), performance.now() + 5_000); }
        catch { cleanup = "required"; stopped = true; }
      }
    }
    // Keep audit I/O outside the catch that classifies pre-save failures.
    if (receipt && !receiptFailed) {
      try { await receipt.finishFile(results[index], cleanup); recordedFiles++; }
      catch { receiptFailed = true; stopped = true; }
    }
    if (!["preview_not_saved", "inserted", "reused"].includes(results[index].outcome)) stopped = true;
  }
  const unknown = results.some(r => r.outcome === "save_outcome_unknown");
  const savedRecordCount = results.filter(r => r.outcome === "inserted").reduce((n, r) => n + r.savedDocumentCount, 0);
  if (receipt) {
    try {
      requireManual(!receiptFailed);
      for (; recordedFiles < results.length; recordedFiles++) await receipt.finishFile(results[recordedFiles], cleanup);
      await receipt.finishBatch(unknown ? "reconciliation_required" : stopped ? "stopped" : "complete", cleanup, savedRecordCount);
    } catch { receiptFailed = true; stopped = true; receipt.invalidate(); }
    finally { try { await receipt.close(); } catch { receiptFailed = true; stopped = true; } }
  }
  return { status: unknown ? "reconciliation_required" : stopped ? "stopped" : "complete", mode: config.mode,
    results, savedRecordCount,
    countMeaning: "new_records_not_distinct_patents", cleanup,
    ...(receipt ? { receiptStatus: receiptFailed ? "incomplete" : "complete" } : {}),
    exitCode: unknown ? 3 : stopped ? 2 : 0 };
}

async function readPrivateInput() {
  requireManual(!process.stdin.isTTY);
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk; requireManual(Buffer.byteLength(input) <= MANUAL_INPUT_BYTES);
  }
  return JSON.parse(input) as unknown;
}
if (require.main === module) {
  const worker = process.argv.length === 3 && process.argv[2] === "--worker";
  const inputTimer = setTimeout(() => {
    if (!worker) process.stdout.write('{"status":"invalid_input","exitCode":1}\n');
    process.exit(1);
  }, 10_000);
  void (async () => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try {
      requireManual(worker ? typeof process.send === "function" : process.argv.length === 2);
      const input = await readPrivateInput(); clearTimeout(inputTimer);
      if (worker) {
        const emit = (event: WorkerEvent) => process.send?.(event);
        const result = await runManualWorker(input as WorkerInput, emit, requestBinding);
        process.send!({ type: "result", result }, () => process.disconnect());
      } else {
        const result = await runManualBatch(input, { signal: controller.signal });
        process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.exitCode;
      }
    } catch {
      if (!worker) process.stdout.write('{"status":"invalid_input","exitCode":1}\n');
      process.exitCode = 1;
      if (worker && process.connected) process.disconnect();
    } finally {
      clearTimeout(inputTimer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    }
  })();
}
