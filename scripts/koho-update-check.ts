/** Read-only reconciliation. Private stdin in, private Markdown + aggregate JSON out. */
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MANUAL_DEADLINE_MS, MANUAL_INPUT_BYTES, requireManual } from "../src/lib/koho-import/manual-cli-config";
import { inspectManualPrivateDirectory } from "../src/lib/koho-import/manual-cli-receipt";
import { inspectManualDirectory } from "../src/lib/koho-import/manual-cli-source";
import { collectUpdateCheck } from "../src/lib/koho-import/update-check";
import { parseUpdateConfiguration, projectUpdateAggregate } from "../src/lib/koho-import/update-check-config";
import { manualChildEnvironment, until } from "./koho-manual-import";

const incomplete = (cleanup: string) => ({ status: "incomplete", coverageProven: false, productionState: "unconfirmed",
  attentionRequired: true, cleanup, exitCode: 2 });
type Aggregate = Awaited<ReturnType<typeof collectUpdateCheck>>["aggregate"];
export async function runUpdateCheck(input: unknown, options: { signal?: AbortSignal; deadlineMs?: number } = {}) {
  const config = parseUpdateConfiguration(input);
  const budget = options.deadlineMs ?? MANUAL_DEADLINE_MS;
  requireManual(Number.isFinite(budget) && budget > 0 && budget <= MANUAL_DEADLINE_MS);
  const deadline = performance.now() + budget;
  let directory: string | undefined, child: ChildProcess | undefined, childExited = false;
  let result: Aggregate | undefined, cleanup = "complete", stagingUnconfirmed = false;
  try {
    const parent = resolve(tmpdir()); await until(inspectManualDirectory(parent), deadline);
    stagingUnconfirmed = true;
    directory = await until(mkdtemp(join(parent, "koho-update-")).then(async d => {
      if (performance.now() >= deadline || options.signal?.aborted) {
        await rm(d, { recursive: true, force: true }); throw Error("update_stopped");
      }
      return d;
    }), deadline);
    stagingUnconfirmed = false;
    requireManual(directory && dirname(directory) === parent && !options.signal?.aborted);
    await new Promise<void>(done => {
      let killTimer: NodeJS.Timeout | undefined, settled = false, stopped = false;
      const finish = () => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", stop); done();
      };
      const stop = () => {
        if (settled || killTimer) return;
        stopped = true; result = undefined;
        child?.kill("SIGKILL");
        killTimer = setTimeout(() => {
          cleanup = "required";
          child?.unref(); child?.stdin?.destroy();
          if (child?.connected) child.disconnect();
          finish();
        }, 5_000);
      };
      const timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
      options.signal?.addEventListener("abort", stop, { once: true });
      try {
        child = fork(__filename, ["--worker"], { silent: true,
          env: manualChildEnvironment(), execArgv: [], stdio: ["pipe", "ignore", "ignore", "ipc"] });
        child.on("message", message => {
          if (settled || stopped) return;
          if (performance.now() >= deadline || options.signal?.aborted) { stop(); return; }
          try { result = projectUpdateAggregate(message); } catch { stop(); }
        });
        child.on("error", stop);
        child.on("exit", code => { childExited = true; if (code !== 0) result = undefined; finish(); });
        child.stdin!.on("error", stop);
        child.stdin!.end(JSON.stringify({ config, directory, budget: Math.max(1, deadline - performance.now()) }));
      } catch { stop(); }
    });
  } catch { result = undefined; if (stagingUnconfirmed) cleanup = "required"; }
  finally {
    if (directory && (!child || childExited)) {
      try { await until(rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }), performance.now() + 5_000); }
      catch { cleanup = "required"; }
    } else if (directory) cleanup = "required";
  }
  return result && cleanup === "complete" && !options.signal?.aborted ? { ...result, cleanup } : incomplete(cleanup);
}
async function worker(input: { config: unknown; directory: string; budget: number }) {
  const config = parseUpdateConfiguration(input.config);
  requireManual(Number.isFinite(input.budget) && input.budget > 0 && input.budget <= MANUAL_DEADLINE_MS &&
    dirname(input.directory) === resolve(tmpdir()) && input.directory.startsWith(join(resolve(tmpdir()), "koho-update-")));
  await inspectManualDirectory(input.directory);
  await inspectManualPrivateDirectory(dirname(config.output.path));
  const output = await open(config.output.path, "wx", 0o600);
  try {
    const stat = await output.stat(); requireManual(stat.isFile() && stat.nlink === 1);
    if (process.platform !== "win32") requireManual(stat.uid === process.getuid!() && (stat.mode & 0o077) === 0);
    const result = await collectUpdateCheck(config, input.directory, performance.now() + input.budget);
    await output.writeFile(result.markdown, "utf8"); await output.sync(); await output.close();
    return result.aggregate;
  } finally { await output.close(); }
}
async function readInput() {
  requireManual(!process.stdin.isTTY);
  const buffers: Buffer[] = []; let size = 0;
  for await (const part of process.stdin) {
    const buffer = Buffer.from(part); size += buffer.length; requireManual(size <= MANUAL_INPUT_BYTES); buffers.push(buffer);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers))) as unknown;
}
if (require.main === module) {
  const isWorker = process.argv.length === 3 && process.argv[2] === "--worker";
  const invalid = () => { if (!isWorker) process.stdout.write('{"status":"invalid_input","exitCode":1}\n'); };
  const inputTimer = setTimeout(() => { invalid(); process.exit(1); }, 10_000);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  void (async () => {
    try {
      requireManual(isWorker ? typeof process.send === "function" : process.argv.length === 2);
      const input = await readInput(); clearTimeout(inputTimer);
      if (isWorker) {
        const result = await worker(input as Parameters<typeof worker>[0]);
        process.send!(result, () => process.disconnect());
      } else {
        const result = await runUpdateCheck(input, { signal: controller.signal });
        process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.exitCode;
      }
    } catch { invalid(); process.exitCode = 1; if (isWorker && process.connected) process.disconnect(); }
    finally { clearTimeout(inputTimer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  })();
}
