import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, chmod, symlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { manualFixture } from "./koho-manual-import-fixtures";
import { protectUpdateTestDirectory, updateTable } from "./koho-update-check-fixtures";
import { parseUpdateConfiguration } from "../src/lib/koho-import/update-check-config";
import { readUpdateReceipt } from "../src/lib/koho-import/update-check-receipts";
import { updateCell } from "../src/lib/koho-import/update-check";
import { DISTRIBUTION_HEADERS } from "../src/lib/koho-distribution-table";
import { buildZip } from "../src/lib/koho-zip/__fixtures__/zip-builder";

describe("compiled regular update checker", () => {
  let directory: string, serial = 0, receiptBytes: Buffer, guard: string;
  const entry = resolve(".koho-ops/update-check/scripts/koho-update-check.js");
  const manual = resolve(".koho-ops/update-check/scripts/koho-manual-import.js");
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const command = (args: string[], input: string | Uint8Array, timeout = 60_000) => new Promise<{ code: number | null; output: string; error: string }>((res, rej) => {
    const p = spawn(process.execPath, args, { windowsHide: true, env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH } });
    let output = "", error = "";
    const timer = setTimeout(() => { p.kill(); rej(Error("fictional_cli_timeout")); }, timeout);
    p.stdout.on("data", b => { output += b; }); p.stderr.on("data", b => { error += b; });
    p.on("error", () => { clearTimeout(timer); rej(Error("fictional_cli_unavailable")); });
    p.on("close", code => { clearTimeout(timer); res({ code, output, error }); }); p.stdin.on("error", () => undefined); p.stdin.end(input);
  });
  const file = async (name: string, bytes: string | Uint8Array) => { const p = join(directory, name); await writeFile(p, bytes); return p; };
  const config = () => ({ period: { from: "2099-03-11", to: "2099-03-25" }, distributionTables: [] as { packageType: "JPA" | "JPB"; path: string }[],
    packages: [] as { packageType: "JPA" | "JPB"; path: string }[], receipts: [] as { path: string }[], maxFileBytes: 2_000_000, maxTotalBytes: 8_000_000,
    output: { path: join(directory, `チェック結果 ${++serial}.md`), privateDirectoryConfirmed: true as const } });
  const run = async (c = config()) => {
    const r = await command(["--require", guard, entry], JSON.stringify(c));
    expect(r.error === "").toBe(true);
    expect(!r.output.includes(directory) && !/[a-f0-9]{64}/.test(r.output) && !r.output.includes("完全架空")).toBe(true);
    expect((await readdir(directory)).includes("forbidden-call")).toBe(false);
    return { result: JSON.parse(r.output), code: r.code, markdown: await readFile(c.output.path, "utf8").catch(() => "") };
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "koho-update-tests-")); await protectUpdateTestDirectory(directory);
    const compiled = await command([resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-update-check.tsconfig.json"], "");
    expect(compiled.code === 0).toBe(true);
    guard = await file("no-network.cjs", `const m=require('node:module'),load=m._load,fs=require('node:fs');
      const fail=()=>{fs.writeFileSync(${JSON.stringify(join(directory, "forbidden-call"))},'attempt');throw Error('FICTIONAL_PRIVATE_SENTINEL');};
      m._load=function(id,...args){if(/^(pg|ai|@ai-sdk|@azure)|manual-cli-db|repositories[\\\\/]drizzle|patent-watch/.test(id))fail();return load.call(this,id,...args)};
      require('node:net').Socket.prototype.connect=fail;
      for(const id of ['node:http','node:https']){require(id).request=fail;require(id).get=fail;}
      global.fetch=fail;
      const cp=require('node:child_process'),fork=cp.fork;cp.fork=function(path,args,options){return fork(path,args,{...options,execArgv:['--require',__filename]});};`);
    const zip = await file("receipt-source.zip", manualFixture("JPA", 1, { publicationDate: "2099-03-11" }));
    const receipt = join(directory, "real-writer.jsonl");
    const r = await command([manual], JSON.stringify({ files: [{ packageType: "JPA", path: zip }], maxFileBytes: 2_000_000,
      maxTotalBytes: 2_000_000, receipt: { path: receipt, privateDirectoryConfirmed: true } }));
    expect(r.code).toBe(0); receiptBytes = await readFile(receipt);
  }, 90_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("accepts empty snapshots as missing, never coverage or acquisition success", async () => {
    const r = await run(); expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ status: "checked", coverageProven: false, attentionRequired: true, counts: { missingTables: 2, targetRows: 0 } });
    expect(r.markdown).toContain("表なし"); expect(r.markdown).toContain("現在の本番DB状態: 未確認");
  });
  it("joins both real parsers and a real writer receipt, retaining unavailable/boundaries and original bytes", async () => {
    const c = config();
    for (const packageType of ["JPA", "JPB"] as const) {
      c.distributionTables.push({ packageType, path: await file(`日本語 ${packageType}.csv`, updateTable(packageType)) });
      c.packages.push({ packageType, path: await file(`日本語 ${packageType}.zip`, manualFixture(packageType, 1, { publicationDate: "2099-03-11" })) });
    }
    c.receipts.push({ path: await file("preview.jsonl", receiptBytes) });
    const before = await Promise.all(c.packages.map(async f => hash(await readFile(f.path))));
    const r = await run(c); expect(r.code).toBe(0);
    expect(r.result.counts).toMatchObject({ targetRows: 6, missingFiles: 4, unavailableRows: 2, recordedPreviews: 1 });
    expect(r.markdown).toContain("年通号 001"); expect(r.markdown).toContain("日件数 公開 00001");
    expect(r.markdown).toContain("日付一致の候補"); expect(r.markdown).toContain("previewのみ"); expect(r.markdown).toContain("終了ACK未確認");
    expect(await Promise.all(c.packages.map(async f => hash(await readFile(f.path))))).toEqual(before);
  });
  it("keeps duplicate bytes, same-date changed bytes and out-of-period files separately", async () => {
    const c = config(); c.distributionTables.push({ packageType: "JPA", path: await file("duplicates.csv", updateTable("JPA")) });
    const bytes = manualFixture("JPA", 1, { publicationDate: "2099-03-11" });
    for (const [name, data] of [["a.zip", bytes], ["alias.zip", bytes], ["changed.zip", manualFixture("JPA", 1, { publicationDate: "2099-03-11", changed: true })],
      ["outside.zip", manualFixture("JPA", 1, { publicationDate: "2099-04-01" })]] as const) c.packages.push({ packageType: "JPA", path: await file(name, data) });
    const r = await run(c); expect(r.result.counts).toMatchObject({ duplicateFiles: 1, conflictingRows: 1, unmatchedPackages: 1 });
    expect(r.markdown).toContain("競合候補"); expect(r.markdown).toContain("期間外");
  });
  it("continues other materials after invalid CSV, missing files, wrong type and unsupported outer ZIP", async () => {
    const c = config(); c.distributionTables.push({ packageType: "JPA", path: await file("bad.csv", "WRONG,HEADER") },
      { packageType: "JPB", path: await file("good.csv", updateTable("JPB")) });
    c.packages.push({ packageType: "JPA", path: join(directory, "missing.zip") },
      { packageType: "JPA", path: await file("wrong-type.zip", manualFixture("JPB")) },
      { packageType: "JPB", path: await file("good.zip", manualFixture("JPB", 1, { publicationDate: "2099-03-11" })) },
      { packageType: "JPA", path: await file("outer.zip", buildZip({ entries: [{ fileName: "inner.zip", data: manualFixture("JPA") }] }).bytes) });
    const r = await run(c); expect(r.code).toBe(2); expect(r.result.counts.targetRows).toBe(3);
    expect(r.markdown).toContain("日付一致の候補"); expect(r.markdown).toContain("発行号ZIP");
  });
  it("does not infer coverage from a header-only table", async () => {
    const c = config(); c.distributionTables.push({ packageType: "JPA", path: await file("header.csv", DISTRIBUTION_HEADERS.JPA.join(",") + "\n") });
    const r = await run(c); expect(r.code).toBe(0); expect(r.result.counts.zeroRowTables).toBe(1); expect(r.markdown).toContain("snapshot対象0行");
  });
  it("keeps date contradictions, unknown issue meaning and review counts", async () => {
    const c = config(); c.distributionTables.push({ packageType: "JPA", path: await file("conflict.csv", updateTable("JPA", ["20990111"])) });
    c.packages.push({ packageType: "JPA", path: await file("review.zip", manualFixture("JPA", 2, { review: true })) });
    const r = await run(c); expect(r.markdown).toContain("発行日が矛盾"); expect(r.markdown).toContain("要確認本文 2");
    expect(r.markdown).toContain("年通号/総通号との対応は未確認");
  });
  it("retains earlier success alongside unknown and incomplete receipts without resending", async () => {
    const records = receiptBytes.toString().trim().split("\n").map(x => JSON.parse(x));
    records[0].mode = "apply"; records[2].outcome = "inserted"; records[2].savedDocumentCount = 1; records[3].savedRecordCount = 1;
    const saved = records.map(x => JSON.stringify(x)).join("\n") + "\n";
    records[2].outcome = "save_outcome_unknown"; records[2].savedDocumentCount = 0; records[3].savedRecordCount = 0; records[3].status = "reconciliation_required";
    const c = config(); c.packages.push({ packageType: "JPA", path: join(directory, "receipt-source.zip") });
    c.receipts.push({ path: await file("saved.jsonl", saved) }, { path: await file("unknown.jsonl", records.map(x => JSON.stringify(x)).join("\n") + "\n") },
      { path: await file("partial.jsonl", receiptBytes.subarray(0, receiptBytes.length - 10)) });
    const r = await run(c); expect(r.code).toBe(2); expect(r.result.counts).toMatchObject({ recordedInserted: 1, unknownReceiptRecords: 1, incompleteReceipts: 1 });
    expect(r.markdown).toContain("記録上inserted"); expect(r.markdown).toContain("保存結果不明"); expect(r.markdown).toContain("自動再送しない");
  });
  it("does not connect records by name, ordinal or mismatching bytes/type", async () => {
    const c = config(); c.packages.push({ packageType: "JPA", path: await file("same-name.zip", manualFixture("JPA", 1, { changed: true })) });
    c.receipts.push({ path: join(directory, "real-writer.jsonl") }); const r = await run(c);
    expect(r.result.counts.recordedPreviews).toBe(0); expect(r.result.counts.unmatchedReceiptRecords).toBe(1);
  });
  it("refuses output overwrite and input/output equality", async () => {
    const c = config(); await writeFile(c.output.path, "FICTIONAL KEEP"); const r = await run(c); expect(r.code).toBe(2); expect(r.markdown).toBe("FICTIONAL KEEP");
    c.packages.push({ packageType: "JPA", path: c.output.path }); expect(() => parseUpdateConfiguration(c)).toThrow();
  });
  it("enforces individual and total byte caps while reporting readable tables", async () => {
    const c = config(); c.maxFileBytes = 10; c.maxTotalBytes = 10;
    c.distributionTables.push({ packageType: "JPA", path: join(directory, "日本語 JPA.csv") });
    c.packages.push({ packageType: "JPA", path: join(directory, "receipt-source.zip") });
    const r = await run(c); expect(r.code).toBe(2); expect(r.result.counts.targetRows).toBe(3);
    const bytes = await readFile(join(directory, "receipt-source.zip")); const total = config();
    total.maxTotalBytes = bytes.length; total.packages.push({ packageType: "JPA", path: join(directory, "receipt-source.zip") },
      { packageType: "JPA", path: await file("total-limit.zip", bytes) });
    const capped = await run(total); expect(capped.code).toBe(2); expect(capped.result.counts.processingErrors).toBe(1);
  });
  it("rejects invalid JSON/UTF8/arguments and oversized stdin with fixed output", async () => {
    for (const input of ["{bad", " ".repeat(262145), Buffer.from([0xff]), JSON.stringify({ ...config(), unknown: true })]) {
      const r = await command([entry], input); expect(r.code).toBe(1); expect(r.output.trim()).toBe('{"status":"invalid_input","exitCode":1}'); expect(r.error).toBe("");
    }
    const r = await command([entry, "--apply"], JSON.stringify(config())); expect(r.code).toBe(1);
  });
  it("validates dates, list/type/key bounds and local paths without data access", () => {
    for (const patch of [{ period: { from: "2099-02-29", to: "2099-03-01" } }, { period: { from: "2099-03-12", to: "2099-03-11" } },
      { period: { from: "2099-03-11", to: "2099-03-12", extra: true } }, { maxFileBytes: 8 * 1024 ** 3 + 1 }, { maxTotalBytes: 0 },
      { packages: Array(65).fill({ packageType: "JPA", path: join(directory, "x") }) }, { packages: [{ packageType: "JPC", path: join(directory, "x") }] },
      { receipts: [{ path: "//server/private" }] }, { receipts: [{ path: "relative" }] }, { receipts: [{ path: join(directory, "x"), ack: true }] },
      { output: { path: join(directory, "x"), privateDirectoryConfirmed: false } }, { distributionTables: Array(2).fill({ packageType: "JPA", path: join(directory, "x") }) }]) {
      expect(() => parseUpdateConfiguration({ ...config(), ...patch })).toThrow();
    }
    if (process.platform === "win32") for (const name of ["nul.zip", "x:stream", "x."]) expect(() => parseUpdateConfiguration({ ...config(), receipts: [{ path: join(directory, name) }] })).toThrow();
  });
  it("validates current writer structure while keeping missing ACK separate", () => {
    expect(readUpdateReceipt(receiptBytes)).toMatchObject({ structuralComplete: true, invalid: false, endAcknowledgement: "unconfirmed" });
    const lines = receiptBytes.toString().trim().split("\n");
    expect(readUpdateReceipt(Buffer.from(lines.slice(0, 3).join("\n") + "\n"))).toMatchObject({ structuralComplete: false, invalid: false });
    const broken = readUpdateReceipt(Buffer.concat([Buffer.from(lines.slice(0, 3).join("\n") + "\n"), Buffer.from([0xff, 10])]));
    expect(broken).toMatchObject({ structuralComplete: false, invalid: true });
    expect(broken.entries[0].result?.outcome).toBe("preview_not_saved");
  });
  it("distinguishes all seven outcomes and rejects processing after a stop", () => {
    for (const outcome of ["preview_not_saved", "inserted", "reused", "review_not_saved", "failed_before_save", "save_outcome_unknown", "not_processed"]) {
      const x = receiptBytes.toString().trim().split("\n").map(line => JSON.parse(line));
      x[0].mode = outcome === "preview_not_saved" ? "preview" : "apply";
      x[2].outcome = outcome;
      x[2].savedDocumentCount = ["inserted", "reused"].includes(outcome) ? 1 : 0;
      if (outcome === "review_not_saved") x[2].summary.packageStatus = "review_required";
      x[3].savedRecordCount = outcome === "inserted" ? 1 : 0;
      x[3].status = outcome === "save_outcome_unknown" ? "reconciliation_required" :
        ["inserted", "reused", "preview_not_saved"].includes(outcome) ? "complete" : "stopped";
      if (outcome === "not_processed") { delete x[2].summary; x.splice(1, 1); }
      x.forEach((r, i) => { r.sequence = i + 1; });
      const parsed = readUpdateReceipt(Buffer.from(x.map(r => JSON.stringify(r)).join("\n") + "\n"));
      expect(parsed.structuralComplete).toBe(true); expect(parsed.entries[0].result?.outcome).toBe(outcome);
    }
    const x = receiptBytes.toString().trim().split("\n").map(line => JSON.parse(line));
    x[0].mode = "apply"; x[0].fileCount = 2; x[0].files.push({ ordinal: 2, packageType: "JPA" });
    x[2].outcome = "save_outcome_unknown";
    const next = [{ ...x[1], ordinal: 2 }, { ...x[2], ordinal: 2, outcome: "inserted", savedDocumentCount: 1 }];
    x.splice(3, 0, ...next); x.forEach((r, i) => { r.sequence = i + 1; });
    expect(readUpdateReceipt(Buffer.from(x.map(r => JSON.stringify(r)).join("\n") + "\n"))).toMatchObject({ structuralComplete: false, invalid: true });
  });
  it("rejects malformed sequences, schemas, ordinals, hashes, counts, modes and footer totals", () => {
    const mutations: ((x: Record<string, unknown>[]) => void)[] = [
      x => { x[0].schemaVersion = 2; }, x => { x[1].sequence = 3; }, x => { x[1].ordinal = 2; }, x => { x[1].operationId = "invalid"; },
      x => { x[1].packageType = "JPB"; }, x => { x[1].sha256 = "x"; }, x => { x[1].byteLength = 0; },
      x => { x[2].savedDocumentCount = 1; }, x => { x[2].includesReviewRequired = true; }, x => { x[2].extra = "private"; },
      x => { x[3].savedRecordCount = 1; }, x => { x[0].fileCount = 2; }, x => { x[2].outcome = "inserted"; },
      x => { x.push(x[3]); }, x => { x[2].observedAt = "2099-02-30T00:00:00.000Z"; },
      x => { x[3].cleanup = "required"; },
      x => { (x[2].summary as Record<string, unknown>).packageStatus = "failed"; },
    ];
    for (const mutate of mutations) {
      const records = receiptBytes.toString().trim().split("\n").map(x => JSON.parse(x)); mutate(records);
      expect(readUpdateReceipt(Buffer.from(records.map(x => JSON.stringify(x)).join("\n") + "\n"))).toMatchObject({ structuralComplete: false, invalid: true });
    }
    for (const b of [Buffer.alloc(1024 * 1024 + 1), Buffer.from([0xff]), Buffer.from('"' + "x".repeat(16384) + '"\n')])
      expect(readUpdateReceipt(b).invalid).toBe(true);
  });
  it("quotes untrusted Markdown instead of rendering links/HTML/control characters", () => {
    const rendered = updateCell('<script>x</script>|[x](https://fiction.invalid)\n=cmd`');
    expect(/[<>|\n`\[\]]/.test(rendered)).toBe(false); expect(rendered.startsWith("&#60;")).toBe(true);
  });
  it("reports review publications, amendments and attachments in distinct units", async () => {
    const c = config(); c.packages.push({ packageType: "JPA", path: await file("mixed.zip", manualFixture("JPA", 1,
      { publicationDate: "2099-03-11", review: true, amendment: true })) });
    const r = await run(c); expect(r.code).toBe(0);
    expect(r.markdown).toContain("本文（要確認含む） 1 / うち要確認本文 1 / 補正 1 / 添付 1");
  });
  it("rejects private IPC fields before stdout projection", async () => {
    const preload = await file("ipc-extra.cjs", `const cp=require('node:child_process'),fork=cp.fork;
      cp.fork=(path,args,opts)=>fork(path,args,{...opts,execArgv:['--require',__filename]});
      if(process.send){const send=process.send.bind(process);process.send=(value,...args)=>send({...value,privatePath:'FICTIONAL_PRIVATE_SENTINEL'},...args);}`);
    const r = await command(["--require", preload, entry], JSON.stringify(config()));
    expect(r.code).toBe(2); expect(r.error).toBe(""); expect(r.output.includes("FICTIONAL_PRIVATE_SENTINEL")).toBe(false);
    expect(JSON.parse(r.output).cleanup).toBe("complete");
  });
  it("bounds a stalled worker, cleans only its stage and does not claim completion", async () => {
    const harness = `const fs=require('node:fs/promises'),mk=fs.mkdtemp;let stage;
      fs.mkdtemp=async(...a)=>{stage=await mk(...a);return stage};
      const cp=require('node:child_process'),fork=cp.fork;cp.fork=(path,args,opts)=>fork(path,args,{...opts,execArgv:['--require',${JSON.stringify(join(directory, "stall.cjs"))}]});
      let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{
        const result=await require(${JSON.stringify(entry)}).runUpdateCheck(JSON.parse(input),{deadlineMs:1000});
        const gone=stage?await fs.stat(stage).then(()=>false,()=>true):false;
        process.stdout.write(JSON.stringify({result,gone}));});`;
    await file("stall.cjs", "require('node:fs/promises').open=()=>new Promise(()=>{});setInterval(()=>{},1000);");
    const r = await command(["-e", harness], JSON.stringify(config()), 10_000);
    expect(r.error).toBe(""); expect(JSON.parse(r.output)).toMatchObject({ gone: true, result: { status: "incomplete", exitCode: 2, cleanup: "complete" } });
  });
  it.skipIf(process.platform === "win32")("refuses unsafe POSIX output directories and symlink inputs", async () => {
    const c = config(); await chmod(directory, 0o755);
    try { expect((await run(c)).code).toBe(2); } finally { await chmod(directory, 0o700); }
    const link = join(directory, "link.zip"); await symlink(join(directory, "receipt-source.zip"), link);
    const next = config(); next.packages.push({ packageType: "JPA", path: link }); expect((await run(next)).code).toBe(2);
  });
});
