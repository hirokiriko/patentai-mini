import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manualFixture } from "./koho-manual-import-fixtures";
import { MANUAL_MAX_BYTES, parseManualConfiguration } from "../src/lib/koho-import/manual-cli-config";
import { copyManualSource, verifyManualSnapshot } from "../src/lib/koho-import/manual-cli-source";

const cwd = process.cwd();
const entry = resolve(".koho-ops/manual/scripts/koho-manual-import.js");
const target = { host: "127.0.0.1", port: 5432, database: "koho_manual_import_test_fictional", user: "fictional" };
const secret = "FICTIONAL_PRIVATE_SENTINEL";
let directory: string, path: string;
export function executeNode(args: string[], input: unknown, env: Record<string, string | undefined> = {}, timeout = 30_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env: {
      NODE_ENV: "test",
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, ...env,
    } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("fictional_process_timeout")); }, timeout);
    child.stdout.on("data", x => { stdout += x; }); child.stderr.on("data", x => { stderr += x; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("fictional_process_start_failed")); });
    child.on("close", code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
const config = () => ({ files: [{ packageType: "JPA", path }], maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000 });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "koho-manual-tests-"));
  path = join(directory, "完全架空 公報.zip"); await writeFile(path, manualFixture("JPA", 2));
  const compiled = await executeNode([resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-manual-import.tsconfig.json"], "", {}, 60_000);
  expect(compiled.code).toBe(0);
}, 65_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("manual CLI admission", () => {
  it("defaults to preview and rejects remote or mismatched apply targets before I/O", () => {
    expect(parseManualConfiguration(config()).mode).toBe("preview");
    const apply = { ...config(), mode: "apply", connection: { ...target, password: secret }, expectedTarget: target };
    expect(parseManualConfiguration(apply).mode).toBe("apply");
    for (const host of ["localhost", "example.invalid", "127.0.0.2", "::ffff:127.0.0.1"]) {
      expect(() => parseManualConfiguration({ ...apply, connection: { ...apply.connection, host }, expectedTarget: { ...target, host } })).toThrow("manual_import_stopped");
    }
    expect(() => parseManualConfiguration({ ...apply, expectedTarget: { ...target, database: "other" } })).toThrow();
    expect(() => parseManualConfiguration({ ...apply, connection: { ...apply.connection, connectionString: secret } })).toThrow();
    expect(() => parseManualConfiguration({ ...apply, connection: { ...apply.connection, database: "patentai" }, expectedTarget: { ...target, database: "patentai" } })).toThrow();
  });
  it("rejects unknown fields, invalid types, counts, limits and network paths", () => {
    for (const bad of [null, [], { ...config(), files: [] }, { ...config(), files: Array(65).fill(config().files[0]) },
      { ...config(), mode: "production" }, { ...config(), allowReviewRequired: "true" }, { ...config(), other: secret },
      { ...config(), connection: target }, { ...config(), files: [{ packageType: "PAJ", path }] },
      { ...config(), files: [{ packageType: "JPA", path: "\\\\remote\\private.zip" }] },
      ...[0, -1, 1.5, "123", MANUAL_MAX_BYTES + 1].flatMap(n => [
        { ...config(), maxFileBytes: n }, { ...config(), maxTotalBytes: n },
      ])]) expect(() => parseManualConfiguration(bad)).toThrow("manual_import_stopped");
  });
});

describe("compiled manual CLI", () => {
  it("previews variable issues/counts, renamed identical bytes and Japanese paths without changing originals", async () => {
    const second = join(directory, "second"); await mkdir(second);
    const b = join(second, "完全架空 公報.zip"), renamed = join(directory, "renamed.zip");
    await writeFile(b, manualFixture("JPB", 3, { issue: "FICTIONAL-OTHER-ISSUE" })); await writeFile(renamed, await readFile(path));
    const before = await Promise.all([path, b, renamed].map(x => readFile(x)));
    const run = await executeNode([entry], { ...config(), files: [config().files[0], { packageType: "JPB", path: b }, { packageType: "JPA", path: renamed }] });
    expect(run.code).toBe(0); expect(run.stderr).toBe("");
    const output = JSON.parse(run.stdout);
    expect(output.results.map((r: { summary: { documentCount: number } }) => r.summary.documentCount)).toEqual([2, 3, 2]);
    expect(output.results[0]).toMatchObject({ outcome: "preview_not_saved", savedDocumentCount: 0,
      summary: { publicationDates: { min: "2099-03-11", max: "2099-03-12", counts: [{ date: "2099-03-11", count: 1 }, { date: "2099-03-12", count: 1 }] } } });
    expect(output.savedRecordCount).toBe(0);
    expect(await Promise.all([path, b, renamed].map(x => readFile(x)))).toEqual(before);
    for (const forbidden of [path, b, "完全架空の検証用発明", createHash("sha256").update(before[0]).digest("hex")]) expect(run.stdout).not.toContain(forbidden);
  });
  it("never loads a DB driver or reaches any network entrypoint on successful or failed preview", async () => {
    const guard = join(directory, "network-guard.cjs"), marker = join(directory, "guard-hit");
    await writeFile(guard, `const Module=require('node:module'),fs=require('node:fs');
      const stop=()=>{fs.writeFileSync(${JSON.stringify(marker)},'hit');throw Error('${secret}');};
      const load=Module._load;Module._load=function(id,...rest){if(id==='pg'||id.includes('manual-cli-db')||id.endsWith('repositories/drizzle'))stop();return load.call(this,id,...rest);};
      require('node:net').Socket.prototype.connect=stop;require('node:tls').connect=stop;
      require('node:dns').lookup=stop;require('node:http').request=stop;require('node:https').request=stop;global.fetch=stop;
      const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(file,args,options){return fork(file,args,{...options,execArgv:['--require',__filename]});};`);
    const corrupt = join(directory, "broken.zip"); await writeFile(corrupt, "FICTIONAL-TSV\tTEXT");
    for (const p of [path, corrupt]) {
      const output = await executeNode(["--require", guard, entry], { ...config(), files: [{ packageType: "JPA", path: p }] }, { DATABASE_URL: secret });
      expect(output.stderr).toBe(""); expect(output.stdout).not.toContain(secret);
      expect(output.code).toBe(p === path ? 0 : 2);
    }
    expect((await readdir(directory)).includes("guard-hit")).toBe(false);
  });
  it("distinguishes failed, review and unprocessed packages and blocks review apply before connecting", async () => {
    const review = join(directory, "review.zip"); await writeFile(review, manualFixture("JPA", 1, { review: true }));
    const checked = await executeNode([entry], { ...config(), files: [{ packageType: "JPA", path: review }] });
    expect(JSON.parse(checked.stdout).results[0]).toMatchObject({ outcome: "preview_not_saved", summary: { packageStatus: "review_required", reviewDocumentCount: 1 } });
    const apply = await executeNode([entry], { ...config(), mode: "apply", files: [{ packageType: "JPA", path: review }, config().files[0]],
      connection: { ...target, password: secret }, expectedTarget: target });
    expect(apply.code).toBe(2); expect(apply.stderr).toBe("");
    expect(JSON.parse(apply.stdout).results.map((x: { outcome: string }) => x.outcome)).toEqual(["review_not_saved", "not_processed"]);
    for (const bytes of [Buffer.from("FICTIONAL TSV\tDATA"), manualFixture("JPA").subarray(0, 80),
      manualFixture("JPA", 1, { unknown: true }), manualFixture("JPA", 1, { indexMismatch: true })]) {
      const bad = join(directory, "bad.zip"); await writeFile(bad, bytes);
      const r = await executeNode([entry], { ...config(), files: [{ packageType: "JPA", path: bad }] });
      const out = JSON.parse(r.stdout);
      expect(out.results[0].summary?.packageStatus === "success").toBe(false);
      expect(out.savedRecordCount).toBe(0);
    }
  });
  it("rejects per-file/aggregate oversize and malformed private input with fixed output", async () => {
    for (const x of ["{", secret, { ...config(), maxFileBytes: 10 }, { ...config(), maxTotalBytes: 10 },
      { ...config(), files: [{ packageType: "JPA", path: join(directory, secret) }] }]) {
      const r = await executeNode([entry], x); expect(r.code).not.toBe(0); expect(r.stderr).toBe("");
      expect(r.stdout).not.toContain(secret); expect(r.stdout).not.toContain(directory);
    }
  });
  it("treats an apply child crash before IPC as unknown and stops later files", async () => {
    const guard = join(directory, "crash-guard.cjs");
    await writeFile(guard, `if(process.argv.includes('--worker'))process.exit(9);
      const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(file,args,options){return fork(file,args,{...options,execArgv:['--require',__filename]});};`);
    const result = await executeNode(["--require", guard, entry], { ...config(), mode: "apply", files: [config().files[0], config().files[0]],
      connection: { ...target, password: secret }, expectedTarget: target });
    expect(result.code).toBe(3); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).results.map((r: { outcome: string }) => r.outcome)).toEqual(["save_outcome_unknown", "not_processed"]);
    expect(JSON.parse(result.stdout).cleanup).toBe("complete");
  });
  it("rejects original content mutation during parsing and cleans its snapshot", async () => {
    const original = await readFile(path), guard = join(directory, "mutation-guard.cjs");
    await writeFile(guard, `const Module=require('node:module'),fs=require('node:fs'),load=Module._load;
      Module._load=function(id,...args){const m=load.call(this,id,...args);if(id==='../src/lib/koho-package')return {...m,parseKohoPackage:async(...input)=>{
        const r=await m.parseKohoPackage(...input);const b=fs.readFileSync(${JSON.stringify(path)});b[50]^=1;fs.writeFileSync(${JSON.stringify(path)},b);return r;}};return m;};
      const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(file,args,options){return fork(file,args,{...options,execArgv:['--require',__filename]});};`);
    try {
      const result = await executeNode(["--require", guard, entry], config());
      expect(result.code).toBe(2); expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).results[0].outcome).toBe("failed_before_save");
      expect(JSON.parse(result.stdout).cleanup).toBe("complete");
    } finally { await writeFile(path, original); }
  });
  it("terminates a stalled child within the batch deadline and cleans its copy", async () => {
    const driver = join(directory, "deadline.cjs");
    await writeFile(driver, `if(process.argv.includes('--worker')) { setInterval(()=>{},1000); }
      else {const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(file,args,options){return fork(__filename,args,options);};
      let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const r=await require(${JSON.stringify(entry)}).runManualBatch(JSON.parse(s),{deadlineMs:500});process.stdout.write(JSON.stringify(r));});}`);
    const started = performance.now(); const result = await executeNode([driver], config());
    expect(performance.now() - started).toBeLessThan(10_000); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "stopped", cleanup: "complete", exitCode: 2 });
  });
  it("reports unconfirmed cleanup when staging completes after its deadline", async () => {
    const driver = join(directory, "late-staging.cjs");
    await writeFile(driver, `const fs=require('node:fs/promises');
      fs.mkdtemp=prefix=>new Promise(r=>setTimeout(()=>r(prefix+'fictional'),1500));
      fs.rm=async()=>{throw Error('${secret}');};
      let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const r=await require(${JSON.stringify(entry)}).runManualBatch(JSON.parse(s),{deadlineMs:400});process.stdout.write(JSON.stringify(r));});`);
    const result = await executeNode([driver], config());
    expect(result.stderr).toBe(""); expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "stopped", cleanup: "required", exitCode: 2 });
  });
});

describe("exclusive bounded source snapshot", () => {
  it("refuses overwrite, nonregular files, growth and snapshot mutation", async () => {
    const snapshot = join(directory, "snapshot.zip"), original = await readFile(path);
    const hash = await copyManualSource(path, snapshot, original.length);
    await expect(copyManualSource(path, snapshot, original.length)).rejects.toThrow();
    await expect(copyManualSource(directory, join(directory, "nonregular"), 10)).rejects.toThrow();
    await expect(copyManualSource(path, join(directory, "bounded"), 10)).rejects.toThrow();
    await verifyManualSnapshot(snapshot, original.length, hash);
    const changed = Buffer.from(original); changed[50] ^= 1; await writeFile(snapshot, changed);
    await expect(verifyManualSnapshot(snapshot, original.length, hash)).rejects.toThrow("manual_import_stopped");
    expect(await readFile(path)).toEqual(original);
  });
  it("refuses symbolic directory links", async () => {
    const link = join(directory, "directory-link");
    await symlink(directory, link, process.platform === "win32" ? "junction" : "dir");
    await expect(copyManualSource(join(link, "完全架空 公報.zip"), join(directory, "linked"), (await readFile(path)).length)).rejects.toThrow();
  });
});
