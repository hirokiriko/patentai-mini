import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manualFixture } from "./koho-manual-import-fixtures";

const entry = resolve(".koho-ops/manual/scripts/koho-manual-import.js");
const target = { host: "127.0.0.1", port: 5432, database: "koho_manual_import_test_fictional", user: "fictional" };
const secret = "FICTIONAL_PRIVATE_SENTINEL";
let directory: string, source: string, serial = 0;
const next = (suffix: string) => join(directory, `${++serial}-${suffix}`);
const config = (path: string, apply = false) => ({ files: [{ packageType: "JPA", path: source }],
  maxFileBytes: 1_000_000, maxTotalBytes: 3_000_000, receipt: { path, privateDirectoryConfirmed: true },
  ...(apply ? { mode: "apply", connection: { ...target, password: secret }, expectedTarget: target } : {}) });
const run = (args: string[], input: unknown, timeout = 30_000) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
  const child = spawn(process.execPath, args, { windowsHide: true, env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP } });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(Error("fictional_process_timeout")); }, timeout);
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.once("error", () => { clearTimeout(timer); reject(Error("fictional_process_failed")); });
  child.once("close", code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  child.stdin.on("error", () => undefined); child.stdin.end(JSON.stringify(input));
});
const records = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const propagate = `const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(file,args,options){return fork(file,args,{...options,execArgv:['--require',__filename]});};`;

async function protectWindowsFixture(path: string) {
  if (process.platform !== "win32") return;
  // Operator setup for this newly created test directory only; the CLI never changes ACLs.
  const script = `$ErrorActionPreference='Stop';$phase='identity';try {
    $path=[Console]::In.ReadToEnd();$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $phase='rules';$acl=[System.IO.Directory]::GetAccessControl($path);$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid);
    foreach($old in @($acl.Access)){$acl.RemoveAccessRuleSpecific($old)};
    $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');foreach($id in $allowed){
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule)};$phase='set';[System.IO.Directory]::SetAccessControl($path,$acl);
    $phase='verify';$actual=[System.IO.Directory]::GetAccessControl($path);if(-not $actual.AreAccessRulesProtected){exit 1};
    foreach($rule in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
      if($rule.AccessControlType -ne 'Allow' -or $allowed -notcontains $rule.IdentityReference.Value){exit 1}}
    exit 0
  }catch{[Console]::Out.Write($phase+'|'+$_.Exception.GetType().Name+'|'+$_.CategoryInfo.Category.ToString());exit 1}`;
  let phase = "";
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    const child = spawn(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(Error("fictional_acl_setup_timeout")); }, 15_000);
    child.stdout.on("data", data => { phase += data; }); child.stderr.resume(); child.stdin.on("error", () => undefined);
    child.on("error", () => { clearTimeout(timer); reject(Error("fictional_acl_setup_failed")); });
    child.on("close", result => { clearTimeout(timer); resolvePromise(result); }); child.stdin.end(path);
  });
  expect({ code, phase }).toEqual({ code: 0, phase: "" });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "koho-receipt-tests-"));
  await protectWindowsFixture(directory);
  source = join(directory, "完全架空 公報.zip"); await writeFile(source, manualFixture("JPA", 2));
  const built = await run([resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-manual-import.tsconfig.json"], {}, 60_000);
  expect(built.stdout + built.stderr).toBe(""); expect(built.code).toBe(0);
}, 65_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("private manual receipt through compiled CLI", () => {
  it("binds actual bytes, renames and ordinals while keeping the legacy public projection", async () => {
    const receipt = next("記録.jsonl"), renamed = next("rename.zip"), changed = next("changed.zip");
    const original = await readFile(source); await writeFile(renamed, original);
    await writeFile(changed, manualFixture("JPA", 1, { changed: true }));
    const files = [source, renamed, changed].map(path => ({ packageType: "JPA", path }));
    const input = { ...config(receipt), files };
    const legacy = { files, maxFileBytes: input.maxFileBytes, maxTotalBytes: input.maxTotalBytes };
    const before = await Promise.all(files.map(file => readFile(file.path)));
    const old = await run([entry], legacy), result = await run([entry], input);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const { receiptStatus, ...output } = JSON.parse(result.stdout);
    expect(receiptStatus).toBe("complete"); expect(output).toEqual(JSON.parse(old.stdout));
    const data = await records(receipt), bindings = data.filter(x => x.type === "input_verified");
    expect(data.map(x => x.sequence)).toEqual(data.map((_, i) => i + 1));
    expect(new Set(data.map(x => x.operationId)).size).toBe(1);
    expect(data[0]).toMatchObject({ schemaVersion: 1, type: "batch_started", fileCount: 3 });
    expect(data.at(-1)).toMatchObject({ type: "batch_finished", status: "complete", savedRecordCount: 0 });
    expect(bindings.map(x => x.sha256)).toEqual(before.map(bytes => createHash("sha256").update(bytes).digest("hex")));
    expect(bindings.map(x => x.byteLength)).toEqual(before.map(bytes => bytes.length));
    expect(data.filter(x => x.type === "file_finished").map(x => x.ordinal)).toEqual([1, 2, 3]);
    expect(data.find(x => x.type === "file_finished").summary.publicationDates).toEqual({ scope: "input_publications_only", min: "2099-03-11", max: "2099-03-12" });
    for (const forbidden of [directory, secret, "完全架空の検証用発明"]) {
      expect(result.stdout + result.stderr + await readFile(receipt, "utf8")).not.toContain(forbidden);
    }
    expect(result.stdout).not.toContain(bindings[0].sha256); expect(result.stdout).not.toContain(data[0].operationId);
    expect(await Promise.all(files.map(file => readFile(file.path)))).toEqual(before);
  });

  it("distinguishes invalid config from refusal of an existing receipt without overwriting", async () => {
    const path = next("existing.jsonl"); await writeFile(path, secret);
    for (const receipt of [{ path, privateDirectoryConfirmed: false }, { path }, { path, privateDirectoryConfirmed: true, extra: secret },
      { path: "relative.jsonl", privateDirectoryConfirmed: true }, { path: "\\\\fictional.invalid\\x", privateDirectoryConfirmed: true },
      { path: source, privateDirectoryConfirmed: true }, ...(process.platform === "win32" ?
        [`${source}:stream`, `${path}.`, join(directory, "NUL.jsonl"), "\\receipt.jsonl"].map(path => ({ path, privateDirectoryConfirmed: true })) : [])]) {
      const result = await run([entry], { ...config(path), receipt });
      expect(result.code).toBe(1); expect(JSON.parse(result.stdout)).toEqual({ status: "invalid_input", exitCode: 1 }); expect(result.stderr).toBe("");
    }
    const existing = await run([entry], config(path));
    expect(existing.code).toBe(2); expect(JSON.parse(existing.stdout)).toMatchObject({ receiptStatus: "incomplete", results: [{ outcome: "not_processed" }] });
    expect(await readFile(path, "utf8")).toBe(secret);
  });

  it("records admission failures and every unprocessed ordinal without fabricated summaries", async () => {
    const receipt = next("admission.jsonl");
    const result = await run([entry], { ...config(receipt), files: [
      { packageType: "JPA", path: source }, { packageType: "JPB", path: next("missing.zip") }, { packageType: "JPA", path: source }] });
    expect(result.code).toBe(2); expect(JSON.parse(result.stdout).receiptStatus).toBe("complete");
    const data = await records(receipt);
    expect(data.filter(x => x.type === "input_verified")).toHaveLength(0);
    expect(data.filter(x => x.type === "file_finished").map(x => x.outcome)).toEqual(["not_processed", "failed_before_save", "not_processed"]);
    expect(data.every(x => x.summary === undefined)).toBe(true);
  });

  it("rejects linked parent directories", async () => {
    const link = next("link"); await symlink(directory, link, process.platform === "win32" ? "junction" : "dir");
    const result = await run([entry], config(join(link, "receipt.jsonl")));
    expect(result.code).toBe(2); expect(JSON.parse(result.stdout).receiptStatus).toBe("incomplete");
    expect((await readdir(directory)).includes("receipt.jsonl")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("measures POSIX permissions and refuses a shared output directory", async () => {
    const parent = next("shared"); await mkdir(parent, { mode: 0o700 }); await chmod(parent, 0o755);
    const result = await run([entry], config(join(parent, "receipt.jsonl")));
    expect(result.code).toBe(2); expect(await readdir(parent)).toEqual([]);
  });

  it("never loads DB or connects to the network in receipt preview", async () => {
    const guard = next("network.cjs"), marker = next("network-hit"), receipt = next("preview.jsonl");
    await writeFile(guard, `const fs=require('node:fs'),Module=require('node:module'),load=Module._load;
      const stop=()=>{fs.writeFileSync(${JSON.stringify(marker)},'hit');throw Error('${secret}')};
      Module._load=function(id,...args){if(id==='pg'||id.includes('manual-cli-db'))stop();return load.call(this,id,...args);};
      require('node:net').Socket.prototype.connect=stop;require('node:tls').connect=stop;require('node:dns').lookup=stop;
      require('node:http').request=stop;require('node:https').request=stop;global.fetch=stop;${propagate}`);
    const result = await run(["--require", guard, entry], config(receipt));
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);
  });
});

async function fault(options: { phase?: string; action?: "write" | "sync" | "close" | "short"; outcome?: string; crash?: boolean; parse?: string; extra?: boolean; cleanup?: boolean }) {
  const receipt = next("fault.jsonl"), guard = next("fault.cjs"), loaded = next("db-loaded"), synced = next("input-synced");
  await writeFile(guard, `const fs=require('node:fs'),p=require('node:fs/promises'),Module=require('node:module'),load=Module._load;
    const opts=${JSON.stringify(options)},receipt=${JSON.stringify(receipt)},loaded=${JSON.stringify(loaded)},synced=${JSON.stringify(synced)};
    const open=p.open;p.open=async function(path,...args){const h=await open.call(this,path,...args);if(path!==receipt)return h;
      let phase='';const write=h.write.bind(h),sync=h.sync.bind(h),close=h.close.bind(h);
      h.write=async function(buffer,offset,length,position){try{phase=JSON.parse(buffer.toString()).type}catch{}
        if(opts.action==='write'&&phase===opts.phase)throw Error('${secret}');
        return write(buffer,offset,opts.action==='short'?Math.min(7,length):length,position);};
      h.sync=async()=>{await sync();if(opts.action==='sync'&&phase===opts.phase)throw Error('${secret}');
        if(phase==='input_verified')fs.writeFileSync(synced,'yes');};
      h.close=async()=>{await close();if(opts.action==='close')throw Error('${secret}');};return h;};
    Module._load=function(id,...args){if(id.includes('manual-cli-db')){fs.writeFileSync(loaded,'yes');
      if(!fs.existsSync(synced))throw Error('${secret}');return {saveManualPlan:async(c,plan,onSaving)=>{
        onSaving();return {outcome:opts.outcome||'inserted',savedDocumentCount:2};}};}
      const m=load.call(this,id,...args);if(id==='../src/lib/koho-package'&&opts.parse)return {...m,parseKohoPackage:async(...a)=>{
        if(opts.parse==='throw')throw Error('${secret}');const result=await m.parseKohoPackage(...a);
        if(opts.parse==='mutate'){const bytes=fs.readFileSync(${JSON.stringify(source)});bytes[50]^=1;fs.writeFileSync(${JSON.stringify(source)},bytes);}
        else result.status='failed';return result;}};
      return m;};
    if(opts.cleanup)p.rm=async()=>{throw Error('${secret}');};
    if(opts.extra&&process.send){const send=process.send.bind(process);process.send=(event,...args)=>{
      if(event.result){event.result.privatePath='${secret}';event.result.summary.privateHash='${secret}';
        event.result.summary.publicationDates.counts[0].raw='${secret}';}return send(event,...args);};}
    if(opts.crash&&process.argv.includes('--worker'))process.exit(9);${propagate}`);
  return { receipt, guard, loaded, synced };
}

describe("receipt failure boundaries", () => {
  it.each(["write", "sync"] as const)("fails initial %s without starting a worker", async action => {
    const f = await fault({ phase: "batch_started", action });
    const result = await run(["--require", f.guard, entry], config(f.receipt, true));
    expect(result.code).toBe(2); expect(JSON.parse(result.stdout)).toMatchObject({ receiptStatus: "incomplete", results: [{ outcome: "not_processed" }] });
    expect(await readFile(f.loaded).then(() => true, () => false)).toBe(false);
  });
  it("waits for durable input recording before loading the DB", async () => {
    for (const fail of [false, true]) {
      const f = await fault(fail ? { phase: "input_verified", action: "sync" } : {});
      const input = config(f.receipt, true); input.files.push(input.files[0]);
      const result = await run(["--require", f.guard, entry], input), output = JSON.parse(result.stdout);
      expect(result.stderr).toBe(""); expect(result.stdout).not.toContain(secret);
      expect(await readFile(f.loaded).then(() => true, () => false)).toBe(!fail);
      expect(output.receiptStatus).toBe(fail ? "incomplete" : "complete");
      expect(output.results[0].outcome).toBe(fail ? "failed_before_save" : "inserted");
      expect(output.results[1].outcome).toBe(fail ? "not_processed" : "inserted");
    }
  });
  it.each(["inserted", "reused"])("preserves known %s after result-record failure and stops later input", async outcome => {
    const f = await fault({ phase: "file_finished", action: "write", outcome });
    const input = config(f.receipt, true); input.files.push(input.files[0]);
    const result = await run(["--require", f.guard, entry], input), output = JSON.parse(result.stdout);
    expect(result.code).toBe(2); expect(result.stderr).toBe("");
    expect(output).toMatchObject({ status: "stopped", receiptStatus: "incomplete", cleanup: "complete", savedRecordCount: outcome === "inserted" ? 2 : 0 });
    expect(output.results.map((x: { outcome: string }) => x.outcome)).toEqual([outcome, "not_processed"]);
    expect(output.results[0].savedDocumentCount).toBe(2);
    expect((await records(f.receipt)).some(x => x.type === "batch_finished")).toBe(false);
  });
  it.each(["sync", "close"] as const)("treats final %s failure as incomplete even if a footer remains", async action => {
    const f = await fault({ phase: "batch_finished", action });
    const result = await run(["--require", f.guard, entry], config(f.receipt, true));
    expect(result.code).toBe(2); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ receiptStatus: "incomplete", savedRecordCount: 2, results: [{ outcome: "inserted" }] });
    expect((await records(f.receipt)).at(-1).type).toBe("batch_finished");
  });
  it("handles short writes without losing any record bytes", async () => {
    const f = await fault({ action: "short" });
    const result = await run(["--require", f.guard, entry], config(f.receipt));
    expect(result.code).toBe(0); expect((await records(f.receipt)).map(x => x.type)).toEqual(["batch_started", "input_verified", "file_finished", "batch_finished"]);
  });
  it("keeps a known save but reports incomplete when interrupted during final close", async () => {
    const f = await fault({}), driver = next("close-abort-driver.cjs");
    await writeFile(driver, `const controller=new AbortController();require(${JSON.stringify(f.guard)});
      const p=require('node:fs/promises'),open=p.open;p.open=async function(path,...args){const h=await open.call(this,path,...args);
        if(path===${JSON.stringify(f.receipt)}){const close=h.close.bind(h);h.close=async()=>{controller.abort();await close();};}return h;};
      let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const result=await require(${JSON.stringify(entry)}).runManualBatch(JSON.parse(s),{signal:controller.signal});
        process.stdout.write(JSON.stringify(result));process.exitCode=result.exitCode;});`);
    const result = await run([driver], config(f.receipt, true));
    expect(result.code).toBe(2); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ receiptStatus: "incomplete", savedRecordCount: 2, results: [{ outcome: "inserted" }] });
    expect((await records(f.receipt)).at(-1).type).toBe("batch_finished");
  });
  it.each(["throw", "failed", "mutate"])("distinguishes parser %s from byte verification", async parse => {
    const f = await fault({ parse });
    const original = await readFile(source);
    try {
      const result = await run(["--require", f.guard, entry], config(f.receipt));
      expect(result.code).toBe(2); expect(JSON.parse(result.stdout).receiptStatus).toBe("complete");
      const data = await records(f.receipt);
      expect(data.filter(x => x.type === "input_verified")).toHaveLength(parse === "failed" ? 1 : 0);
      expect(data.find(x => x.type === "file_finished").summary?.packageStatus).toBe(parse === "failed" ? "failed" : undefined);
    } finally { if (parse === "mutate") await writeFile(source, original); }
  });
  it("preserves unknown after a child crash, including when the receipt also fails", async () => {
    for (const action of [undefined, "write"] as const) {
      const f = await fault({ crash: true, action, phase: "file_finished" });
      const result = await run(["--require", f.guard, entry], config(f.receipt, true));
      expect(result.code).toBe(3); expect(JSON.parse(result.stdout)).toMatchObject({ status: "reconciliation_required",
        receiptStatus: action ? "incomplete" : "complete", results: [{ outcome: "save_outcome_unknown" }] });
    }
  });
  it("projects unexpected private IPC fields out of both outputs", async () => {
    const f = await fault({ extra: true });
    const result = await run(["--require", f.guard, entry], config(f.receipt));
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout + await readFile(f.receipt, "utf8")).not.toContain(secret);
  });
  it("keeps cleanup failure separate from a known saved result and complete receipt", async () => {
    const f = await fault({ cleanup: true });
    // Direct all staged files into the fixture-owned directory for independent test cleanup.
    const driver = next("cleanup-driver.cjs");
    await writeFile(driver, `require('node:os').tmpdir=()=>${JSON.stringify(directory)};require(${JSON.stringify(f.guard)});
      let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const result=await require(${JSON.stringify(entry)}).runManualBatch(JSON.parse(s));
        process.stdout.write(JSON.stringify(result));process.exitCode=result.exitCode;});`);
    const result = await run([driver], config(f.receipt, true));
    expect(result.code).toBe(2); expect(JSON.parse(result.stdout)).toMatchObject({ cleanup: "required", receiptStatus: "complete", savedRecordCount: 2,
      results: [{ outcome: "inserted" }] });
    expect((await records(f.receipt)).at(-1)).toMatchObject({ cleanup: "required", status: "stopped" });
  });
  it("rejects late sync completion after abort without sending a successful ACK", async () => {
    const receipt = next("abort.jsonl"), guard = next("abort.cjs"), driver = next("abort-driver.cjs"), marker = next("late-ack-or-db");
    await writeFile(guard, `const fs=require('node:fs'),p=require('node:fs/promises'),Module=require('node:module'),load=Module._load;
      Module._load=function(id,...args){if(id.includes('manual-cli-db'))fs.writeFileSync(${JSON.stringify(marker)},'db');return load.call(this,id,...args);};
      const open=p.open;p.open=async function(path,...args){const h=await open.call(this,path,...args);if(path!==${JSON.stringify(receipt)})return h;
        let phase;const write=h.write.bind(h),sync=h.sync.bind(h);h.write=async function(...a){phase=JSON.parse(a[0].toString()).type;return write(...a);};
        h.sync=async()=>{await sync();if(phase==='input_verified'){global.receiptAbort.abort();await new Promise(r=>setTimeout(r,150));}};return h;};
      const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(file,args,options){const child=fork(file,args,{...options,execArgv:['--require',__filename]});
        const send=child.send.bind(child);child.send=(event,...rest)=>{if(event.type==='binding_ack'&&event.accepted)fs.writeFileSync(${JSON.stringify(marker)},'ack');return send(event,...rest);};return child;};`);
    await writeFile(driver, `global.receiptAbort=new AbortController();require(${JSON.stringify(guard)});
      let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const result=await require(${JSON.stringify(entry)}).runManualBatch(JSON.parse(s),{signal:global.receiptAbort.signal});
        process.stdout.write(JSON.stringify(result));process.exitCode=result.exitCode;});`);
    const input = config(receipt, true); input.files.push(input.files[0]);
    const started = performance.now(), result = await run([driver], input);
    expect(performance.now() - started).toBeLessThan(10_000); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ receiptStatus: "incomplete", results: [{ outcome: "save_outcome_unknown" }, { outcome: "not_processed" }] });
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);
    expect((await records(receipt)).some(x => x.type === "batch_finished")).toBe(false);
  });
});
