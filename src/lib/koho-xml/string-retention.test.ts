import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { createFictionalKohoInput } from "./__fixtures__/fictional-koho";

const childProgram = String.raw`
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const sha = x => crypto.createHash("sha256").update(x).digest("hex");
function memory() {
  return { ...process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS };
}
async function afterGc() {
  for (let i = 0; i < 3; i++) {
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
  return memory();
}
async function main() {
  assert.equal(typeof global.gc, "function");
  assert.deepEqual(process.execArgv.slice(0, 2), ["--expose-gc", "--max-old-space-size=256"]);
  const raw = fs.readFileSync(0, "utf8");
  assert.ok(Buffer.byteLength(raw) <= 128 * 1024);
  const input = JSON.parse(raw);
  assert.equal(process.execPath, input.execPath);
  assert.equal(sha(input.code), input.codeSha256);
  assert.equal(sha(input.baseXml), input.baseXmlSha256);
  // Evaluate only the parent-transpiled xml-tree module. No source loading/eval loop.
  const module = { exports: {} };
  const controlledRequire = name => {
    assert.ok(name === "saxes" || name === "node:buffer");
    return require(name);
  };
  new Function("require", "module", "exports", input.code)(controlledRequire, module, module.exports);
  const { parseXmlTree, rawTextContent } = module.exports;
  assert.equal(typeof parseXmlTree, "function");

  // One small fixture covers UTF-16 pairs, combining marks, namespace/attributes,
  // adjacent text + CDATA merging, source paths, string/byte inputs, and limits.
  function checkSemantics() {
    const namespace = "urn:fictional:\u65e5\u672c:\ud83d\ude00";
    const attribute = " A\ud83d\ude00e\u0301 ";
    const expectedText = "A\ud83d\ude00e\u0301Z";
    const xml = '<n:root xmlns:n="' + namespace + '" n:label="' + attribute + '">' +
      '<n:item>A\ud83d\ude00<![CDATA[e\u0301]]>Z</n:item><n:item/></n:root>';
    const limits = { maxXmlBytes: 4096, maxDepth: 4, maxElements: 8, maxTextBytes: 64 };
    const stringResult = parseXmlTree(xml, limits);
    const byteResult = parseXmlTree(Buffer.from(xml, "utf8"), limits);
    assert.equal(stringResult.ok, true); assert.equal(byteResult.ok, true);
    const root = stringResult.root;
    assert.equal(root.namespaceUri, namespace);
    assert.equal(root.localName, "root"); assert.equal(root.sourceName, "n:root");
    assert.equal(root.sourcePath, "/root[1]");
    const label = root.attributes.find(a => a.localName === "label");
    assert.equal(label.namespaceUri, namespace); assert.equal(label.sourceName, "n:label");
    assert.equal(label.value, attribute);
    assert.equal(root.attributes.find(a => a.sourceName === "xmlns:n").value, namespace);
    const children = root.children.filter(c => c.type === "element").map(c => c.element);
    assert.equal(children.length, 2);
    assert.equal(children[0].sourcePath, "/root[1]/item[1]");
    assert.equal(children[1].sourcePath, "/root[1]/item[2]");
    assert.deepEqual(children[0].children, [{ type: "text", value: expectedText }]);
    assert.equal(rawTextContent(children[0]), expectedText);
    const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
    assert.deepEqual(units(label.value), units(attribute));
    assert.deepEqual(units(children[0].children[0].value), units(expectedText));
    // Tiny-tree value comparison only; no whole-result cloning in the memory path.
    assert.deepEqual(JSON.parse(JSON.stringify(byteResult)), JSON.parse(JSON.stringify(stringResult)));
    assert.equal(parseXmlTree(xml, { ...limits, maxDepth: 1 }).code, "xml_depth_limit_exceeded");
    assert.equal(parseXmlTree(xml, { ...limits, maxElements: 2 }).code, "xml_element_limit_exceeded");
    assert.equal(parseXmlTree(xml, { ...limits, maxTextBytes: 1 }).code, "xml_text_limit_exceeded");
    assert.equal(parseXmlTree(xml, { ...limits, maxXmlBytes: Buffer.byteLength(xml) - 1 }).code, "xml_byte_limit_exceeded");
    assert.equal(parseXmlTree(xml.replace("Z", "\ud800Z"), limits).code, "invalid_utf8");
    assert.equal(parseXmlTree(Buffer.from([0xff]), limits).code, "invalid_utf8");
    return true;
  }
  assert.equal(checkSemantics(), true);
  const limits = { maxXmlBytes: 4 * 1024 * 1024, maxDepth: 64, maxElements: 10000, maxTextBytes: 524288 };
  assert.equal(parseXmlTree(input.baseXml, limits).ok, true);
  const baseline = await afterGc();
  const roots = [], fixtures = [];
  function one(index) {
    const comment = "<!--" + String(index) + "x".repeat(2 * 1024 * 1024 - 8) + "-->";
    assert.equal(Buffer.byteLength(comment), 2 * 1024 * 1024);
    const bytes = Buffer.from(input.baseXml + comment, "utf8");
    const result = parseXmlTree(bytes, limits);
    assert.equal(result.ok, true);
    return { root: result.root, fixture: { index, byteLength: bytes.length, sha256: sha(bytes) } };
  }
  for (let i = 0; i < 8; i++) {
    const value = one(i);
    roots.push(value.root); fixtures.push(value.fixture);
  }
  const retained = await afterGc();
  // Keep all eight roots observably live across the full GC calls above.
  assert.equal(roots.length, 8);
  assert.ok(roots.every(root => root.localName === "UnexaminedPatentPublication"));
  process.stdout.write(JSON.stringify({ ok: true, nodeVersion: process.version,
    execPath: process.execPath, sourceSha256: input.sourceSha256, codeSha256: input.codeSha256,
    baseXmlSha256: input.baseXmlSha256, fixtures, semanticFixturePassed: true,
    gc: "3 full GC calls with setImmediate after warm-up and after retaining eight small trees",
    baseline, retained, heapDeltaBytes: retained.heapUsed - baseline.heapUsed,
    rssDeltaBytes: retained.rss - baseline.rss, retainedCount: roots.length }) + "\n");
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, reason: "synthetic_xml_tree_check_failed",
    errorClass: error?.constructor?.name ?? "Unknown" }) + "\n");
  process.exitCode = 2;
});
`;

it("does not retain complete XML inputs through strings stored in small XML trees", () => {
  const source = readFileSync(new URL("./xml-tree.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  expect(transpiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []).toEqual([]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const baseXml = createFictionalKohoInput("A1").xml;
  expect(typeof baseXml).toBe("string");
  const payload = JSON.stringify({ code: transpiled.outputText, codeSha256: digest(transpiled.outputText),
    sourceSha256: digest(source), baseXml, baseXmlSha256: digest(baseXml as string), execPath: process.execPath });
  expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(128 * 1024);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawnSync(process.execPath,
    ["--expose-gc", "--max-old-space-size=256", "-e", childProgram],
    { cwd: process.cwd(), input: payload, env, encoding: "utf8", timeout: 30000,
      maxBuffer: 1024 * 1024, windowsHide: true });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  const result = JSON.parse(child.stdout);
  expect(result.ok).toBe(true);
  expect(result.nodeVersion).toBe(process.version);
  expect(result.execPath).toBe(process.execPath);
  expect(result.sourceSha256).toBe(digest(source));
  expect(result.codeSha256).toBe(digest(transpiled.outputText));
  expect(result.baseXmlSha256).toBe(digest(baseXml as string));
  expect(result.semanticFixturePassed).toBe(true);
  expect(result.fixtures).toHaveLength(8);
  expect(new Set(result.fixtures.map((f: { sha256: string }) => f.sha256)).size).toBe(8);
  expect(result.retainedCount).toBe(8);
  // Old whole-input backing is about 32 MiB for these eight inputs. The 8 MiB
  // threshold leaves room for engine noise while detecting that regression.
  expect(result.heapDeltaBytes).toBeLessThan(8 * 1024 * 1024);
}, 40000);
