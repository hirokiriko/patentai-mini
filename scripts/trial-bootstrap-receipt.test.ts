import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectTrialBootstrapReceipts } from "../src/lib/trial/bootstrap";
import { trialHash } from "../src/lib/trial/ledger";

let directory: string;
const binding = "a".repeat(64);
const intent = (step:string) => trialHash(JSON.stringify({ operation:"trial-bootstrap-v1", binding, step }));
const name = (step:string) => `operator-${intent(step)}.jsonl`;
async function receipt(step:string, tail='{"terminal":"completed"}\n') {
  const raw=JSON.stringify({ schema:1, intent:intent(step), automaticResend:false, status:"outcome_unknown" })+"\n"+tail;
  await writeFile(join(directory,name(step)),raw); return raw;
}
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"trial-bootstrap-receipt-"));});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
describe("verified bootstrap receipt manifest",()=>{
  it("hashes every selected completed file in deterministic filename order",async()=>{
    const a=await receipt("role-0"),b=await receipt("database");
    const result=await collectTrialBootstrapReceipts(directory,binding,["database","role-0"]);
    expect(result).toEqual([{name:name("role-0"),sha256:trialHash(a)},{name:name("database"),sha256:trialHash(b)}].sort((a,b)=>a.name<b.name?-1:1));
  });
  it.each(["",'{"terminal":"completed"}', '{"terminal":"completed"}\n{"status":"outcome_unknown"}\n'])("rejects an unknown or partial selected step",async tail=>{
    await receipt("database",tail);
    await expect(collectTrialBootstrapReceipts(directory,binding,["database"])).rejects.toThrow();
  });
  it("does not rewrite old inner uncertainty when a current outer step has catalog verification",async()=>{
    const unknown=await receipt("migration-statement-0-"+"b".repeat(64),""); await receipt("migrations");
    const result=await collectTrialBootstrapReceipts(directory,binding,["migrations"]);
    expect(result).toHaveLength(1);
    expect(await readFile(join(directory,name("migration-statement-0-"+"b".repeat(64))),"utf8")).toBe(unknown);
  });
  it("rejects duplicate steps and wrong intent",async()=>{
    await receipt("database");
    await expect(collectTrialBootstrapReceipts(directory,binding,["database","database"])).rejects.toThrow();
    await writeFile(join(directory,name("database")),JSON.stringify({schema:1,intent:"b".repeat(64),automaticResend:false})+'\n{"terminal":"completed"}\n');
    await expect(collectTrialBootstrapReceipts(directory,binding,["database"])).rejects.toThrow();
  });
});
