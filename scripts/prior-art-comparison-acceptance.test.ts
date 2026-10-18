import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedComparisonPg16, isolatedChildEnv } from "./prior-art-comparison-local.test-support";
import { fictionalInputs } from "../src/lib/prior-art-comparison/fixtures.test-support";
import { makePlan, SYSTEM, type Selection } from "../src/lib/prior-art-comparison/comparison";
import { generationBatches } from "../src/lib/prior-art-comparison/generation-batch";
import { comparisonBlocks } from "../src/lib/prior-art-comparison/report";
import { neutralizeFormula } from "../src/lib/patent-watch/csv";
import { parse } from "csv-parse/sync";

// Fully fictional data + transport; actual PG16, built Next application and browser.
describe.skipIf(process.env.PRIOR_ART_COMPARISON_ACCEPTANCE !== "1")("Issue150 isolated actual application", () => {
  let pg: Awaited<ReturnType<typeof isolatedComparisonPg16>>;
  let app: ChildProcess | undefined, proxy: Server | undefined, blob: Server | undefined;
  const fictionalOriginals = new Map<string,Buffer>();
  let appOrigin = "", browserOrigin = "", appPort = 0;
  let env: NodeJS.ProcessEnv;
  let logs = "";
  let completed = 0, expected = 0, nextCase = 9;
  const check = (name: string, run: () => Promise<void>, timeout = 60_000) => { expected++; it(name, async()=>{await run();completed++;},timeout); };
  const output = resolve("_imports", `issue150-acceptance-${Date.now()}`);
  const tenant = "11111111-1111-1111-1111-111111111111", owner = "22222222-2222-2222-2222-222222222222", client = "33333333-3333-3333-3333-333333333333";
  const identity = Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [{typ:"tid",val:tenant},{typ:"oid",val:owner},{typ:"aud",val:client}] })).toString("base64");
  const headers = { "x-ms-client-principal": identity, origin: "https://fictional.invalid", "Content-Type": "application/json" };
  const counts = async () => { try { return (await readFile(join(output,"fixture-sends.jsonl"),"utf8")).trim().split("\n").length; } catch { return 0; } };
  const fixture = fictionalInputs();
  const completeSends = generationBatches(makePlan(fixture.inputs, fixture.selection), SYSTEM).length + 2;
  const post = (caseId: number, selection: Selection) => fetch(`${appOrigin}/api/cases/${caseId}/analyze`, {method:"POST",headers,body:JSON.stringify(selection)});
  const mode = (value: string) => writeFile(join(output,"fixture-mode.txt"),value);
  async function freshCase() {
    const caseId=nextCase++;
    await pg.sql("insert into cases(case_id,title) values($1,'完全架空・障害確認')",[caseId]);
    await pg.sql("insert into draft_patents(case_id,kind,parsed_text) select $1,'main',parsed_text from draft_patents where draft_id=11",[caseId]);
    await pg.sql("insert into prior_art_documents(case_id,publication_no,title,claims_text) select $1,publication_no,title,claims_text from prior_art_documents where doc_id in(21,22) order by doc_id",[caseId]);
    const data=await(await fetch(`${appOrigin}/api/cases/${caseId}/analyze`,{headers})).json();
    const selection:Selection={operationId:crypto.randomUUID(),inputDigest:data.catalog.inputDigest,draftClaimNos:[1],draftIdentity:{publication:"架空基準",edition:"架空版1"},originalsConfirmed:true,
      documents:data.catalog.documents.map((d:{id:number;publicationNo:string})=>({docId:d.id,claimNos:[1],identity:{publication:d.publicationNo,edition:"架空版1"}}))};
    return {caseId,selection};
  }
  async function waitForSend(before: number) { for(let n=0;n<100;n++){if(await counts()>before)return;await new Promise(r=>setTimeout(r,30));}throw Error("fixture_send_not_seen"); }
  async function freePort() { const server = createServer(); server.listen(0,"127.0.0.1"); await once(server,"listening"); const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; await new Promise<void>(done=>server.close(()=>done())); return port; }
  async function startApp() {
    const child = spawn(process.execPath, ["--import",pathToFileURL(resolve("scripts/prior-art-comparison-fixture.mjs")).href,resolve("node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(appPort)], { cwd: process.cwd(), env, windowsHide:true });
    app = child;
    child.stdout?.on("data", data => { logs = (logs + String(data)).slice(-100_000); }); child.stderr?.on("data", data => { logs = (logs + String(data)).slice(-100_000); });
    for(let attempt=0;attempt<100;attempt++) { try { if((await fetch(appOrigin+"/api/health",{signal:AbortSignal.timeout(500)})).ok) return; }catch{} await new Promise(done=>setTimeout(done,150)); }
    const codes=[...logs.matchAll(/\bERR_[A-Z_]+\b/g)].map(m=>m[0]);
    throw Error(`isolated_app_start_failed:${codes.join(",") || "readiness"}`);
  }
  async function stopApp() { if(app && app.exitCode === null) { const closed=once(app,"close"); app.kill(); await closed; } app=undefined; }
  beforeAll(async () => {
    if (!process.env.PRIOR_ART_PLAYWRIGHT_MODULE) throw Error("isolated_browser_runtime_required");
    await mkdir(output,{recursive:true});
    pg = await isolatedComparisonPg16();
    expect((await pg.watchClient.query("select has_table_privilege(current_user,'comparison_results','UPDATE') as allowed")).rows[0].allowed).toBe(false);
    const { inputs } = fictionalInputs();
    const original = (source: typeof inputs.draft) => source.source.claims.map(c=>`【請求項${c.claimNo}】\n${c.text}`).join("\n");
    await pg.sql("insert into cases(case_id,title) values(7,'完全架空・温度調整の指定比較'),(8,'完全架空の別案件')");
    // Deliberately short legacy extraction cannot become the authoritative comparison.
    await pg.sql("insert into draft_patents(draft_id,case_id,kind,parsed_text,extracted_claims_json) values(10,7,'main','【請求項1】古い装置。',null),(11,7,'main',$1,$2)",
      [original(inputs.draft),JSON.stringify({title:"架空",abstract:"架空",claims:[{claimNo:1,text:inputs.draft.source.claims[0].text.slice(0,1200),isIndependent:true,dependsOn:null,elements:[]}],solvedProblems:[],effects:[]})]);
    for(const d of inputs.documents) await pg.sql("insert into prior_art_documents(doc_id,case_id,publication_no,title,claims_text) values($1,7,$2,$3,$4)",[d.id,d.label,"完全架空の文献",original(d)]);
    await pg.sql("insert into prior_art_documents(doc_id,case_id,publication_no,title,claims_text) values(23,8,'FICTIONAL-OTHER','別案件','【請求項1】\n別案件の装置。')");
    await pg.sql("select setval('draft_patents_draft_id_seq',11),setval('prior_art_documents_doc_id_seq',23)");
    const connection=(pg.watchClient as unknown as {connectionParameters:{user:string;password:string;port:number;database:string}}).connectionParameters;
    const url = new URL("postgresql://127.0.0.1"); url.username=connection.user;url.password=connection.password;url.port=String(connection.port);url.pathname=connection.database;
    appPort = await freePort(); appOrigin=`http://127.0.0.1:${appPort}`;
    // Loopback fixture Blob transport: real SDK, private headers, fictional bytes.
    // This checks TXT parsing/registration; it is not Azure Storage acceptance.
    blob=createServer(async(req,res)=>{
      const data:Buffer[]=[];for await(const part of req)data.push(Buffer.from(part));
      if(req.method==="PUT" && !req.url?.includes("restype=container"))fictionalOriginals.set(req.url!,Buffer.concat(data));
      res.writeHead(req.method==="PUT"?201:200,{"x-ms-request-id":"fictional","x-ms-version":"2023-11-03",etag:'"fictional"',"last-modified":new Date().toUTCString(),"content-length":"0"});res.end();
    });blob.listen(0,"127.0.0.1");await once(blob,"listening");const blobAddress=blob.address();if(!blobAddress||typeof blobAddress==="string")throw Error("isolated_blob_fixture_failed");
    env={...isolatedChildEnv(), NODE_ENV:"production",DATABASE_URL:url.toString(),NEXT_TELEMETRY_DISABLED:"1",OWNER_AUTH_MODE:"azure-easy-auth",OWNER_APP_ORIGIN:"https://fictional.invalid",OWNER_TENANT_ID:tenant,OWNER_OBJECT_ID:owner,OWNER_CLIENT_ID:client,
      AZURE_STORAGE_CONNECTION_STRING:`DefaultEndpointsProtocol=http;AccountName=fictional;AccountKey=${Buffer.from("fictional").toString("base64")};BlobEndpoint=http://127.0.0.1:${blobAddress.port}/fictional;`,AZURE_BLOB_CONTAINER_NAME:"fictional-originals",
      AI_PROVIDER:"azure",AZURE_OPENAI_BASE_URL:"https://example.invalid/openai",AZURE_API_KEY:"fictional",AZURE_OPENAI_DEPLOYMENT_NAME:"fictional",AZURE_OPENAI_API_VERSION:"v1",PRIOR_ART_FIXTURE_OUTPUT:output};
    await startApp();
    proxy=createServer(async(req,res)=>{
      try {
        if(req.headers.host!==new URL(browserOrigin).host || (req.method!=="GET" && req.method!=="HEAD" && req.headers.origin!==browserOrigin)) {res.writeHead(403);res.end();return;}
        const data:Buffer[]=[]; for await(const part of req) data.push(Buffer.from(part));
        const forward=new Headers();for(const [key,value] of Object.entries(req.headers)) if(value && !["host","content-length","connection","x-ms-client-principal","origin"].includes(key))forward.set(key,Array.isArray(value)?value.join(","):value);
        forward.set("x-ms-client-principal",identity);forward.set("origin","https://fictional.invalid");
        const response=await fetch(appOrigin+(req.url||"/"),{method:req.method,headers:forward,...(data.length?{body:Buffer.concat(data)}:{}),redirect:"manual"});
        res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>!["content-encoding","transfer-encoding","content-length"].includes(key))));res.end(Buffer.from(await response.arrayBuffer()));
      }catch{res.writeHead(503);res.end("isolated_proxy_unavailable");}
    });
    proxy.listen(0,"127.0.0.1");await once(proxy,"listening");const address=proxy.address();if(!address||typeof address==="string")throw Error("isolated_proxy_failed");browserOrigin=`http://127.0.0.1:${address.port}`;
  },120_000);
  afterAll(async()=>{ await stopApp(); if(proxy)await new Promise<void>(done=>proxy!.close(()=>done()));if(blob)await new Promise<void>(done=>blob!.close(()=>done()));await pg?.cleanup();
    await writeFile(join(output,"acceptance.json"),JSON.stringify({status:completed===expected?"LOCAL_APPLICATION_PASS_PENDING_REPORT_QA":"FAILED",completed,expected,ai:"fictional_transport",production:false,cleanup:true},null,2)); },60_000);

  check("selects, compares, persists, reloads, restarts and downloads through the real browser",async()=>{
    const playwright=createRequire(import.meta.url)(process.env.PRIOR_ART_PLAYWRIGHT_MODULE!);
    const browser=await playwright.chromium.launch({headless:true,channel:"chrome"});
    try {
      const context=await browser.newContext({viewport:{width:1360,height:980},acceptDownloads:true});const page=await context.newPage();
      await page.goto(browserOrigin+"/cases/7");await page.getByRole("link",{name:"文献・請求項を選んで根拠付き比較"}).click();
      await page.locator('[name="draft-publication"]').fill("架空基準");await page.locator('[name="draft-edition"]').fill("架空版1");await page.locator('[name="draft-claims"][value="1"]').check();
      for(const id of [21,22]) {await page.locator(`[name="doc-${id}"]`).check();await page.locator(`[name="edition-${id}"]`).fill("架空版1");await page.locator(`[name="claims-${id}"][value="1"]`).check();}
      await page.locator('[name="originals-confirmed"]').check();await page.screenshot({path:join(output,"selection.png"),fullPage:true});
      await page.getByRole("button",{name:"指定範囲を比較して保存"}).click();
      await page.getByText("根拠付き比較を保存しました。下の保存結果からPDF/CSVを取得できます。",{exact:true}).waitFor({timeout:55_000});
      await page.getByRole("link",{name:"PDFを取得"}).waitFor();
      expect(await counts()).toBe(completeSends);
      const sends = (await readFile(join(output,"fixture-sends.jsonl"),"utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(sends.map(s => s.phase)).toEqual(["read_sources","compare","review"]);
      expect(sends.every(s => s.baseTailPresent && s.candidateTailPresent)).toBe(true);
      const rows=await pg.sql("select matched_elements_json from comparison_results where case_id=7 order by result_id");expect(rows).toHaveLength(2);
      const saved=JSON.parse(rows[0].matched_elements_json).priorArtComparison;expect(saved.inputs.draft.id).toBe(11);expect(saved.pairs.every((p:{baseEvidence:{start:number}})=>p.baseEvidence.start>15000)).toBe(true);
      await writeFile(join(output,"saved-fictional-result.json"),JSON.stringify(saved,null,2));
      await page.reload();await page.getByRole("link",{name:"PDFを取得"}).waitFor();
      await stopApp();await startApp();await page.reload();await page.getByRole("link",{name:"PDFを取得"}).waitFor();
      for(const format of ["PDF","CSV"]) {
        const waiting=page.waitForEvent("download");await page.getByRole("link",{name:`${format}を取得`}).click();const download=await waiting;expect(download.suggestedFilename()).toBe(`comparison-${saved.operationId}.${format.toLowerCase()}`);await download.saveAs(join(output,`comparison.${format.toLowerCase()}`));
      }
      const pdf=await readFile(join(output,"comparison.pdf"));expect(pdf.subarray(0,5).toString()).toBe("%PDF-");
      const csv=await readFile(join(output,"comparison.csv"),"utf8");expect(csv).toContain("超えると青色弁を閉じる");expect(csv).toContain("下回ると青色弁を開く");
      const blocks=comparisonBlocks(saved,false);
      expect(parse(csv,{bom:true})).toEqual([["区分","内容"],...blocks.map(b=>[b.heading?"見出し":"本文",neutralizeFormula(b.text)])]);
      await writeFile(join(output,"report-blocks.json"),JSON.stringify(blocks));
      for(const format of ["pdf","csv"]) expect((await fetch(`${appOrigin}/api/cases/7/analyze/${saved.operationId}/${format}`,{headers})).status).toBe(200);
      expect(await counts()).toBe(completeSends);
      await page.getByRole("heading",{name:"保存済み比較結果",exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,"saved-result.png")});
      await writeFile(join(output,"browser-evidence.json"),JSON.stringify({caseId:7,operationId:saved.operationId,aiSends:completeSends,serverRestart:true,reload:true,pdfBytes:pdf.length,csvCharacters:csv.length,csvAllRows:true},null,2));
      await context.close();
    } finally {await browser.close();}
  },120_000);

  check("enforces auth, CSRF, input validation, replay and unknown-usage preservation across restart",async()=>{
    const endpoint=appOrigin+"/api/cases/7/analyze";
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint,{method:"POST",headers:{...headers,origin:"https://other.invalid"},body:"{}"})).status).toBe(403);
    const loaded=await (await fetch(endpoint,{headers})).json();
    const saved=loaded.saved.results[0];const count=await counts();
    expect((await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(saved.selection)})).status).toBe(200);expect(await counts()).toBe(count);
    const selection:Selection={...saved.selection,operationId:crypto.randomUUID(),inputDigest:loaded.catalog.inputDigest};
    selection.documents=[{...selection.documents[0],docId:23},selection.documents[1]];
    expect((await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(selection)})).status).toBe(422);expect(await counts()).toBe(count);
    const before=JSON.stringify(await pg.sql("select * from comparison_results where case_id=7 order by result_id"));
    for(const body of ["{",JSON.stringify({...saved.selection,operationId:crypto.randomUUID(),draftClaimNos:[1,1]})," ".repeat(9000)]) expect((await fetch(endpoint,{method:"POST",headers,body})).status).toBe(422);
    expect((await fetch(`${appOrigin}/api/cases/8/analyze/${saved.operationId}/csv`,{headers})).status).toBe(404);
    expect(await counts()).toBe(count);
    await mode("unknown");
    const failedSelection={...saved.selection,operationId:crypto.randomUUID()};
    const failure=await post(7,failedSelection);expect(failure.status).toBe(422);
    expect(await failure.text()).not.toContain("FICTIONAL_PRIVATE_ERROR_SENTINEL");
    expect(JSON.stringify(await pg.sql("select * from comparison_results where case_id=7 and (matched_elements_json::json->'priorArtComparison'->>'status')='complete' order by result_id"))).toBe(before);
    const after=await counts();await mode("ok");await stopApp();await startApp();
    expect((await post(7,failedSelection)).status).toBe(409);
    expect((await post(7,{...failedSelection,operationId:crypto.randomUUID()})).status).toBe(409);expect(await counts()).toBe(after);
    expect((await fetch(`${endpoint}/${failedSelection.operationId}/csv`,{headers})).status).toBe(404);
    expect(logs).not.toContain("FICTIONAL_PRIVATE_ERROR_SENTINEL");
  },60_000);

  check("rejects an inconsistent final review without replacing a saved result or allowing redispatch",async()=>{
    const {caseId,selection}=await freshCase();await mode("ok");
    expect((await post(caseId,selection)).status).toBe(200);
    const old=JSON.stringify(await pg.sql("select * from comparison_results where case_id=$1 order by result_id",[caseId]));
    const failed={...selection,operationId:crypto.randomUUID()};const before=await counts();
    try {
      await mode("review-reject");
      const response=await post(caseId,failed);expect(response.status).toBe(422);expect(await response.text()).not.toContain("FICTIONAL_PRIVATE_ERROR_SENTINEL");
      expect(await counts()).toBe(before+completeSends);
      expect(JSON.stringify(await pg.sql("select * from comparison_results where case_id=$1 and (matched_elements_json::json->'priorArtComparison'->>'status')='complete' order by result_id",[caseId]))).toBe(old);
      expect((await fetch(`${appOrigin}/api/cases/${caseId}/analyze/${failed.operationId}/pdf`,{headers})).status).toBe(404);
      expect((await fetch(`${appOrigin}/api/cases/${caseId}/analyze/${selection.operationId}/pdf`,{headers})).status).toBe(200);
      expect((await post(caseId,{...failed,operationId:crypto.randomUUID()})).status).toBe(409);expect(await counts()).toBe(before+completeSends);
    } finally {await mode("ok");}
  });

  check("rolls back reservation and final write failures without replacing old success",async()=>{
    const {caseId,selection}=await freshCase();const before=await counts();
    await pg.sql("create function issue150_fail_insert() returns trigger language plpgsql as $$ begin raise exception 'FICTIONAL_PRIVATE_ERROR_SENTINEL'; end $$");
    await pg.sql("create trigger issue150_fail_insert before insert on comparison_results for each row execute function issue150_fail_insert()");
    try {expect((await post(caseId,selection)).status).toBe(409);expect(await counts()).toBe(before);expect(await pg.sql("select * from comparison_results where case_id=$1",[caseId])).toHaveLength(0);}
    finally {await pg.sql("drop trigger issue150_fail_insert on comparison_results");}
    expect((await post(caseId,selection)).status).toBe(200);
    const old=JSON.stringify(await pg.sql("select * from comparison_results where case_id=$1 order by result_id",[caseId]));
    await pg.sql("create trigger issue150_fail_update before insert on comparison_results for each row when ((NEW.matched_elements_json::json->'priorArtComparison'->>'status')='complete') execute function issue150_fail_insert()");
    try {expect((await post(caseId,{...selection,operationId:crypto.randomUUID()})).status).toBe(409);}
    finally {await pg.sql("drop trigger issue150_fail_update on comparison_results");await pg.sql("drop function issue150_fail_insert()");}
    expect(JSON.stringify(await pg.sql("select * from comparison_results where case_id=$1 and (matched_elements_json::json->'priorArtComparison'->>'status')='complete' order by result_id",[caseId]))).toBe(old);
    const sent=await counts();expect((await post(caseId,{...selection,operationId:crypto.randomUUID()})).status).toBe(409);expect(await counts()).toBe(sent);
  });

  check("blocks concurrent requests and rejects source changes during AI",async()=>{
    const first=await freshCase();await mode("delay");const before=await counts();
    const running=post(first.caseId,first.selection);await waitForSend(before);
    expect((await post(first.caseId,first.selection)).status).toBe(409);
    expect((await post(first.caseId,{...first.selection,operationId:crypto.randomUUID()})).status).toBe(409);
    expect((await running).status).toBe(200);expect(await counts()).toBe(before+completeSends);
    expect((await post(first.caseId,first.selection)).status).toBe(200);expect(await counts()).toBe(before+completeSends);
    const second=await freshCase();const beforeStale=await counts();const stale=post(second.caseId,second.selection);await waitForSend(beforeStale);
    await pg.sql("update draft_patents set parsed_text=parsed_text || E'\n' where case_id=$1",[second.caseId]);
    expect((await stale).status).toBe(409);
    const loaded=await(await fetch(`${appOrigin}/api/cases/${second.caseId}/analyze`,{headers})).json();expect(loaded.saved.results).toHaveLength(0);expect(loaded.saved.reservedCount).toBe(1);
    await mode("ok");
  });

  check("reconciles a lost final COMMIT acknowledgement and never dispatches after lost reservation acknowledgement",async()=>{
    await stopApp();await startApp();
    const final=await freshCase();await mode("commit-ack");const before=await counts();
    expect((await post(final.caseId,final.selection)).status).toBe(200);
    expect(await counts()).toBe(before+completeSends);expect(await readFile(join(output,"fixture-faults.jsonl"),"utf8")).toContain("commit-ack");
    await mode("ok");expect((await post(final.caseId,final.selection)).status).toBe(200);expect(await counts()).toBe(before+completeSends);
    await stopApp();await startApp();const reserve=await freshCase();await mode("reserve-ack");const sent=await counts();
    expect((await post(reserve.caseId,reserve.selection)).status).toBe(409);expect(await counts()).toBe(sent);
    await mode("ok");await stopApp();await startApp();
    expect((await post(reserve.caseId,{...reserve.selection,operationId:crypto.randomUUID()})).status).toBe(409);expect(await counts()).toBe(sent);
    await stopApp();await startApp();const unknown=await freshCase();await mode("commit-readback");const unknownBefore=await counts();
    expect((await post(unknown.caseId,unknown.selection)).status).toBe(409);
    await mode("ok");await stopApp();await startApp();
    expect((await post(unknown.caseId,unknown.selection)).status).toBe(200);expect(await counts()).toBe(unknownBefore+completeSends);
  });

  check("keeps dispatch reservations across process loss and rejects altered reservations",async()=>{
    const crashed=await freshCase();await mode("delay");const before=await counts();
    const inFlight=post(crashed.caseId,crashed.selection).catch(()=>null);await waitForSend(before);await stopApp();await inFlight;
    await mode("ok");await startApp();const sent=await counts();
    expect((await post(crashed.caseId,{...crashed.selection,operationId:crypto.randomUUID()})).status).toBe(409);expect(await counts()).toBe(sent);
    const changed=await freshCase();await mode("delay");const changedBefore=await counts();const running=post(changed.caseId,changed.selection);await waitForSend(changedBefore);
    await pg.sql("update comparison_results set matched_elements_json=$1 where case_id=$2 and prior_doc_id=$3",[JSON.stringify({priorArtComparison:null}),changed.caseId,changed.selection.documents[0].docId]);
    expect((await running).status).toBe(409);await mode("ok");
    const loaded=await(await fetch(`${appOrigin}/api/cases/${changed.caseId}/analyze`,{headers})).json();expect(loaded.saved.results).toHaveLength(0);expect(loaded.saved.invalidCount).toBeGreaterThan(0);
    const after=await counts();expect((await post(changed.caseId,{...changed.selection,operationId:crypto.randomUUID()})).status).toBe(422);expect(await counts()).toBe(after);
  });

  check("preserves old snapshots after source removal and fails closed on corrupt groups",async()=>{
    const old=JSON.parse(await readFile(join(output,"saved-fictional-result.json"),"utf8"));const before=await counts();
    expect((await fetch(appOrigin+"/api/cases/7/prior-art",{method:"DELETE",headers,body:JSON.stringify({docIds:[21,22]})})).status).toBe(200);
    const exported=await fetch(`${appOrigin}/api/cases/7/analyze/${old.operationId}/csv`,{headers});expect(exported.status).toBe(200);expect(exported.headers.get("cache-control")).toContain("no-store");
    const text=await exported.text();expect(text).toContain("現在の入力と異なる保存結果");expect(text).toContain(old.inputs.documents[0].source.claims[0].text);
    const rows=await pg.sql("select prior_doc_id,matched_elements_json from comparison_results where case_id=7");expect(rows.some(r=>r.prior_doc_id===null&&JSON.parse(r.matched_elements_json).detachedPriorDocId===21)).toBe(true);
    const playwright=createRequire(import.meta.url)(process.env.PRIOR_ART_PLAYWRIGHT_MODULE!);
    const browser=await playwright.chromium.launch({headless:true,channel:"chrome"});
    try {const page=await browser.newPage();await page.goto(browserOrigin+"/cases/7");await page.getByRole("link",{name:"文献・請求項を選んで根拠付き比較"}).click();await page.getByRole("link",{name:"CSVを取得"}).waitFor();}
    finally{await browser.close();}
    await pg.sql("update comparison_results set matched_elements_json=$1 where case_id=7 and matched_elements_json::json->>'detachedPriorDocId'='22'",[JSON.stringify({priorArtComparison:null})]);
    expect((await fetch(`${appOrigin}/api/cases/7/analyze/${old.operationId}/pdf`,{headers})).status).toBe(404);expect(await counts()).toBe(before);
  });

  check("imports full TXT originals through actual APIs without extraction truncation",async()=>{
    const caseId=nextCase++;await pg.sql("insert into cases(case_id,title) values($1,'完全架空・実取り込み')",[caseId]);
    const {inputs}=fictionalInputs();const original=(source:typeof inputs.draft)=>source.source.claims.map(c=>`【請求項${c.claimNo}】\n${c.text}`).join("\n");
    for(const [route,sources] of [["draft",[inputs.draft]],["prior-art",inputs.documents]] as const){
      const form=new FormData();for(const source of sources)form.append("file",new File([original(source)],`${source.label}.txt`,{type:"text/plain"}));
      const response=await fetch(`${appOrigin}/api/cases/${caseId}/${route}`,{method:"POST",headers:{origin:headers.origin,"x-ms-client-principal":identity},body:form});expect(response.status).toBe(201);
    }
    const draft=await pg.sql("select parsed_text from draft_patents where case_id=$1",[caseId]);expect(draft[0].parsed_text).toBe(original(inputs.draft));
    const documents=await pg.sql("select claims_text from prior_art_documents where case_id=$1 order by doc_id",[caseId]);expect(documents.map(d=>d.claims_text)).toEqual(inputs.documents.map(original));
    expect([...fictionalOriginals.values()].map(b=>b.toString())).toEqual([original(inputs.draft),...inputs.documents.map(original)]);
    const loaded=await(await fetch(`${appOrigin}/api/cases/${caseId}/analyze`,{headers})).json();expect(loaded.catalog.draft.source.source.claims[0].text.length).toBeGreaterThan(15000);expect(loaded.catalog.documents.every((d:{source:unknown})=>d.source)).toBe(true);
  });
});
