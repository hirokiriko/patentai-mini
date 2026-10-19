// Test-process preload only. Product code has no fixture switch or fake provider.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { fixturePropositionSource, fixturePropositionGeneration, fixturePropositionTarget } from "./prior-art-proposition-fixture.mjs";
const directory = process.env.PRIOR_ART_FIXTURE_OUTPUT;
const mode = () => { try { return fs.readFileSync(path.join(directory, "fixture-mode.txt"), "utf8").trim(); } catch { return "ok"; } };
// Real PostgreSQL COMMIT executes first; inject loss of its acknowledgement only.
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const command = String(typeof args[0] === "string" ? args[0] : args[0]?.text || "");
  if (/^delete from "comparison_results"/i.test(command)) this.fixtureFinalizing = true;
  if (mode() === "commit-readback" && this.fixtureAckLost && /^select/i.test(command)) {
    const failure = Error("FICTIONAL_PRIVATE_ERROR_SENTINEL");
    const callback = args.at(-1);
    if (typeof callback === "function") { queueMicrotask(() => callback(failure)); return; }
    return Promise.reject(failure);
  }
  const result = originalQuery.apply(this, args);
  if (/^commit$/i.test(command) && result?.then && ((mode() === "reserve-ack" && !this.fixtureFinalizing) || (mode().startsWith("commit-") && this.fixtureFinalizing))) {
    return result.then(value => {
      if (this.fixtureAckLost) return value;
      this.fixtureAckLost = true;
      fs.appendFileSync(path.join(directory, "fixture-faults.jsonl"), JSON.stringify({ fault: mode() }) + "\n");
      throw Error("FICTIONAL_PRIVATE_ERROR_SENTINEL");
    });
  }
  if (/^begin$/i.test(command)) this.fixtureFinalizing = false;
  return result;
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url));
  if (target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname)) return originalFetch(url, init);
  if (target.origin !== "https://example.invalid" || !target.pathname.endsWith("/responses")) throw Error("external_transport_forbidden");
  const body = JSON.parse(init.body);
  const packed = JSON.parse(body.input[1].content[0].text);
  // Independent lossless inverse. Never import the product's text-table helper.
  const expand = source => ({...source,claims:source.claims.map(c=>({...c,text:c.parts
    ? c.parts.map(index=>packed.textParts[index]).join("")
    : c.segments.map(([,index])=>packed.textParts[index]).join("")}))});
  const chunk=packed.task==="extract_source_propositions"?{...packed,sources:packed.sources.map(s=>({...s,source:expand(s.source)}))}:
    packed.task==="review"?{...packed.originals,task:"review",base:expand(packed.originals.base),documents:packed.originals.documents.map(d=>({...d,source:expand(d.source)}))}:packed;
  const directory = process.env.PRIOR_ART_FIXTURE_OUTPUT;
  if (!directory || !path.isAbsolute(directory)) throw Error("fixture_output_required");
  const fullText = claim => Array.isArray(claim) ? claim[2].map(([, text]) => text).join("") :
    claim.text ?? claim.segments.map(s => Array.isArray(s) ? s[1] : s.text).join("");
  const sources = chunk.task === "extract_source_propositions" ? chunk.sources.map(s => s.source) : [chunk.base, ...chunk.documents.map(d => d.candidate ?? d.source)];
  const event = { phase: chunk.task, bytes: Buffer.byteLength(init.body), baseTailPresent: sources[0].claims.some(c => fullText(c).includes("超えると青色弁を閉じる")),
    candidateTailPresent: sources.slice(1).some(s => s.claims.some(c => /青色弁を(?:開く|閉じる)/.test(fullText(c)))),
    pairs: chunk.task === "extract_source_propositions" ? 0 : chunk.task === "review" ? chunk.pairs.length : chunk.documents.reduce((n,d)=>n+d.pairs.length,0) };
  fs.appendFileSync(path.join(directory, "fixture-sends.jsonl"), JSON.stringify(event) + "\n");
  let mode = "ok";
  try { mode = fs.readFileSync(path.join(directory, "fixture-mode.txt"), "utf8").trim(); } catch { /* default */ }
  if (mode === "fail") return new Response("FICTIONAL_PRIVATE_ERROR_SENTINEL", { status: 429 });
  if (mode === "unknown") return Response.json({ usage: null });
  if (mode === "delay") await new Promise(resolve => setTimeout(resolve, 800));
  const value=packed.task==="extract_source_propositions"?fixturePropositionSource(packed):packed.task==="review"?fixturePropositionTarget(packed):fixturePropositionGeneration(packed);
  if(mode==="review-reject"&&packed.task==="review"){
    const atom=value.targets[0].parts[0].atoms[0];
    if(atom.meaning.kind!=="relation"||atom.meaning.predicate!=="closes")throw Error("fixture_expected_close");
    atom.meaning.predicate="opens";
  }
  return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 100 } });
};
