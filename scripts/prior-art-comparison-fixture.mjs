// Test-process preload only. Product code has no fixture switch or fake provider.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
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
  const chunk = JSON.parse(body.input[1].content[0].text);
  const directory = process.env.PRIOR_ART_FIXTURE_OUTPUT;
  if (!directory || !path.isAbsolute(directory)) throw Error("fixture_output_required");
  const fullText = claim => Array.isArray(claim) ? claim[2] : claim.text ?? claim.segments.map(s => Array.isArray(s) ? s[1] : s.text).join("");
  const event = { phase: chunk.task, bytes: Buffer.byteLength(init.body), baseTailPresent: chunk.base.claims.some(c => fullText(c).includes("超えると青色弁を閉じる")),
    candidateTailPresent: chunk.documents.some(d => (d.candidate ?? d.source).claims.some(c => /青色弁を(?:開く|閉じる)/.test(fullText(c)))),
    pairs: chunk.task === "review" ? chunk.pairs.length : chunk.documents.reduce((n,d)=>n+d.pairs.length,0) };
  fs.appendFileSync(path.join(directory, "fixture-sends.jsonl"), JSON.stringify(event) + "\n");
  let mode = "ok";
  try { mode = fs.readFileSync(path.join(directory, "fixture-mode.txt"), "utf8").trim(); } catch { /* default */ }
  if (mode === "fail") return new Response("FICTIONAL_PRIVATE_ERROR_SENTINEL", { status: 429 });
  if (mode === "unknown") return Response.json({ usage: null });
  if (mode === "delay") await new Promise(resolve => setTimeout(resolve, 800));
  const value = chunk.task === "review" ? { draftDigest: chunk.draftDigest,
    referenceChecks:chunk.units.flatMap(unit=>(typeof unit==="string"?[]:unit.filter((_,part)=>part%2===1))).map(()=>({relation:"unspecified",operatorBasis:null})),
    checks: chunk.fields.flatMap(([id,firstUnitId,endUnitId]) => {
      const [docId,baseNo,candidateNo,field]=id.split(":");
      const lastEvidence=(source,no)=>{const claim=source.claims.find(c=>c[0]===Number(no));return claim[3][0]+claim[3].length-2;};
      const ids=[...(field==="candidateObservation"?[]:[lastEvidence(chunk.base,baseNo)]),
        ...(field==="baseObservation"?[]:[lastEvidence(chunk.documents.find(d=>d.docId===Number(docId)).source,candidateNo)])];
      return chunk.units.slice(firstUnitId,endUnitId).map((unit,i)=>({unitId:firstUnitId+i,
        kind:"technical",reference:null,evidenceIds:[...ids],scopeWitness:null,
        sourceComparison:"架空原文との対応。意味品質の実証ではない。",verdict:mode==="review-reject"?"inconsistent":"consistent"}));
    }) } : { results: chunk.documents.flatMap(document => document.pairs.map(pair => {
    const base = chunk.base.claims.find(c => c.claimNo === pair.baseClaimNo);
    const candidate = document.candidate.claims.find(c => c.claimNo === pair.candidateClaimNo);
    const lastId = claim => claim.segments.filter(s => s.quotable).at(-1).id;
    return { docId:document.candidateId, baseClaimNo: pair.baseClaimNo, candidateClaimNo: pair.candidateClaimNo, baseEvidenceId: lastId(base), candidateEvidenceId: lastId(candidate),
      baseObservation: "基準の末尾条件は七度を超えると青色弁を閉じる。",
      candidateObservation: fullText(candidate).includes("下回ると") ? "候補の末尾条件は七度を下回ると青色弁を開く。" : "候補の末尾条件は七度を超えると青色弁を閉じる。",
      common: "引用箇所は温度条件に応じて青色弁を動作させる。",
      differences: fullText(candidate).includes("下回ると") ? "基準の超過・閉動作に対し、文献の引用箇所は低下・開動作である。" : "引用した末尾条件に差は確認できない。",
      unconfirmed: "図面、明細書の全体、作用の意味は人による確認が必要。",
    };
  })) };
  return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 100 } });
};
