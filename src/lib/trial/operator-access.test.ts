import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContainerClient } from "@azure/storage-blob";
import { OperatorAccess, artifactKeys, guardOperatorDatabase, operatorBlobCondition, operatorTicketDigest, operatorPolicyBinding, type OperatorTicket } from "./operator-access";
import { trialHash } from "./ledger";
import { beginOperatorReceipt } from "./operator-journal";
import { trialFixture, signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START } from "./policy";
import { trialStorageHttp } from "./storage";

const start = Date.parse(TRIAL_START), hash = "a".repeat(64), delivery = "33333333-3333-4333-8333-333333333333";
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(start + 1000);
  const p = structuredClone(trialFixture); p.samples = [{caseId: 1, from: "2026-01-01", through: "2026-02-01"}];
  const ticket: OperatorTicket = {schema:1,id:"11111111-1111-4111-8111-111111111111",policyDigest:operatorPolicyBinding(p),
    startsAt:new Date(start).toISOString(),endsAt:new Date(start+3_600_000).toISOString(),packages:[hash],
    samples:[{caseId:1,sha256:hash,key:`cases/1/prior-art/1792195200000-${delivery}-sample.xml`}],artifacts:[{caseId:1,deliveryId:delivery}]};
  p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:"a".repeat(64)};
  const access = new OperatorAccess(ticket,p,{utc:()=>Date.now(),monotonic:()=>Date.now()-start});
  for(const[k,v]of Object.entries(signedTrialEnvironment(p)))vi.stubEnv(k,v);
  return {p,ticket,access};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe("Local operator permission boundary",()=>{
  it("binds the existing numeric case and original filename format, plus three exact artifact paths",()=>{
    const {access}=setup(); expect(access.sampleKey(1,hash)).toMatch(/cases\/1\/prior-art\/\d{13}-.*-sample.xml$/);
    expect(()=>access.sampleKey(2,hash)).toThrow(); expect(()=>access.sampleKey(1,"b".repeat(64))).toThrow();
    expect(access.keys("artifacts")).toEqual(artifactKeys(1,delivery)); access.dispose();
  });
  it("rejects extended windows, UUID case keys and policy substitutions",()=>{
    const {p,ticket,access}=setup();access.dispose();
    expect(()=>new OperatorAccess({...ticket,endsAt:new Date(start+3_600_001).toISOString()},p)).toThrow();
    expect(()=>new OperatorAccess({...ticket,samples:[{...ticket.samples[0],key:`cases/${delivery}/prior-art/sample.xml`}]},p)).toThrow();
    expect(()=>new OperatorAccess({...ticket,policyDigest:"b".repeat(64)},p)).toThrow();
  });
  it.each([0,3_580_000,3_600_000,3_600_001])("refuses exact start, insufficient margin and expiry at %s ms",delta=>{
    const {access}=setup();vi.setSystemTime(start+delta);expect(()=>access.check()).toThrow();access.dispose();
  });
  it("does not extend on clock rollback or a restarted process",()=>{
    const {access,p,ticket}=setup();access.check();vi.setSystemTime(start+500);expect(()=>access.check()).toThrow();access.dispose();
    vi.setSystemTime(start+3_600_001);const restarted=new OperatorAccess(ticket,p);expect(()=>restarted.check()).toThrow();restarted.dispose();
  });
  it.each(["?comp=list","?versionid=one","?snapshot=one","?timeout=20&timeout=20"])("rejects blob query %s",query=>{
    const {p,access}=setup();expect(()=>access.storage("budget",`https://${p.storage.account}.blob.core.windows.net/${p.storage.budget}/trial-v1/state.json${query}`,"GET")).toThrow();access.dispose();
  });
  it("permits private container metadata only and denies artifact writes and different keys",()=>{
    const {p,access}=setup(),base=`https://${p.storage.account}.blob.core.windows.net/`;
    access.storage("originals",`${base}${p.storage.originals}?restype=container`,"GET");
    expect(()=>access.storage("artifacts",`${base}${p.storage.artifacts}/${access.keys("artifacts")[0]}`,"PUT")).toThrow();
    expect(()=>access.storage("originals",`${base}${p.storage.originals}/packages/${"b".repeat(64)}.zip`,"PUT")).toThrow();access.dispose();
  });
  it("rejects after token acquisition crosses expiry, including budget settlement",async()=>{
    const {p,access}=setup(),network=vi.fn();
    const credential={getToken:async()=>{vi.setSystemTime(start+3_600_000);return{token:"fictional",expiresOnTimestamp:start+7_200_000};}};
    const c=new ContainerClient(`https://${p.storage.account}.blob.core.windows.net/${p.storage.budget}`,credential,
      {retryOptions:{maxTries:1},httpClient:trialStorageHttp("budget",p,network,access)});
    await expect(c.getBlockBlobClient("trial-v1/state.json").uploadData(Buffer.from("{}"))).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();access.dispose();
  });
  it("aborts an in-flight request at the fixed deadline",async()=>{
    const {access}=setup();const stopped=vi.fn();access.signal.addEventListener("abort",stopped);
    await vi.advanceTimersByTimeAsync(3_599_000);expect(stopped).toHaveBeenCalledOnce();expect(()=>access.check(0)).toThrow();access.dispose();
  });
  it("refuses dispatch after asynchronous request-body collection crosses expiry",async()=>{
    const {p,access}=setup(),network=vi.fn();
    const body={async *[Symbol.asyncIterator](){yield Buffer.from("{");await Promise.resolve();vi.setSystemTime(start+3_600_000);yield Buffer.from("}");}};
    const request={url:`https://${p.storage.account}.blob.core.windows.net/${p.storage.budget}/trial-v1/state.json`,method:"PUT",body,
      headers:{get:()=>"Bearer fictional",headerNames:()=>["authorization"]}};
    await expect(trialStorageHttp("budget",p,network,access).sendRequest(request as never)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();access.dispose();
  });
  it("guards nested transaction COMMIT after an awaited statement; permits rollback cleanup",()=>{
    const {access}=setup(),query=vi.fn(),end=vi.fn();const client={query,end};const detach=guardOperatorDatabase(client,access);
    client.query("BEGIN" as never);vi.setSystemTime(start+3_600_000);
    expect(()=>client.query("COMMIT" as never)).toThrow();client.query("ROLLBACK" as never);
    expect(query.mock.calls.map(c=>c[0])).toEqual(["BEGIN","ROLLBACK"]);detach();access.dispose();
  });
  it("builds exact-path time conditions, denies list, and never grants artifact write",()=>{
    const {access}=setup();for(const purpose of ["originals","budget","artifacts"] as const){
      const c=operatorBlobCondition(access,purpose);expect(c).toContain("DateTimeLessThan");expect(c).toContain("Blob.List");
      expect(c).not.toContain("StringLike");for(const key of access.keys(purpose))expect(c).toContain(`'${key}'`);
    }expect(operatorBlobCondition(access,"artifacts")).toContain("AND (!(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'}))");access.dispose();
  });
  it("writes unknown before dispatch and refuses a duplicate even with a new ticket",async()=>{
    const {ticket,access}=setup();access.dispose();vi.useRealTimers();
    const dir=await mkdtemp(join(tmpdir(),"trial-operator-"));
    try{const fixed=trialHash(resolve(dir)),receipt=await beginOperatorReceipt(dir,fixed,ticket,{command:"sample-save",caseId:1,sha256:hash});await receipt.finish(false);
      await expect(beginOperatorReceipt(dir,fixed,{...ticket,id:delivery},{command:"sample-save",caseId:1,sha256:hash})).rejects.toThrow("reconciliation_required");
      await expect(beginOperatorReceipt(dir,"b".repeat(64),ticket,{command:"initialize-ledger"})).rejects.toThrow("journal_unavailable");
      const {readdir}=await import("node:fs/promises"),files=await readdir(dir);
      expect(await readFile(join(dir,files[0]),"utf8")).toContain('"status":"outcome_unknown"');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it("allows repeated explicit reconciliation while excluding concurrent attempts",async()=>{
    const {ticket,access}=setup();access.dispose();vi.useRealTimers();const dir=await mkdtemp(join(tmpdir(),"trial-reconcile-")),fixed=trialHash(resolve(dir));
    try{const request={command:"job-reconcile",caseId:1,runId:delivery};
      const first=await beginOperatorReceipt(dir,fixed,ticket,request,true);
      await expect(beginOperatorReceipt(dir,fixed,ticket,request,true)).rejects.toThrow("journal_locked");await first.finish(false);
      const second=await beginOperatorReceipt(dir,fixed,ticket,request,true);await second.finish(true);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
