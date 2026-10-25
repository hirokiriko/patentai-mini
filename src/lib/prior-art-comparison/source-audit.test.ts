import { expect, it } from "vitest";
import { digest } from "./source";
import { sourceAudit, validateSourceAudit } from "./source-audit";
const operationId="12345678-1234-4234-8234-123456789abc", inputDigest="a".repeat(64);
const tasks=[{id:"b".repeat(64)+":1",sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1},{id:"c".repeat(64)+":2",sourceIndex:1,sourceDigest:"c".repeat(64),claimNo:2}];
it("retains arbitrary generation wire unchanged with exact task identity and digest",()=>{
 const raw={v:999,quoted:"原文",facts:[{value:"受動状態"}]};
 const a=sourceAudit(operationId,inputDigest,tasks,[{taskId:tasks[0].id,value:raw}]);
 expect(a.answers[0].value).toEqual(raw); raw.quoted="変更";
 expect(a.answers[0].value).not.toEqual(raw);
 expect(validateSourceAudit(a,operationId,inputDigest,tasks)).toEqual(a);
});
it("retains failure text and successful prefix without fabricating an accepted answer",()=>{
 const a=sourceAudit(operationId,inputDigest,tasks,[{taskId:tasks[0].id,value:{v:999}}],{taskId:tasks[1].id,text:"{invalid 原文"});
 expect(a.failure?.text).toBe("{invalid 原文"); expect(a.answers).toHaveLength(1);
});
it.each(["operation","input","task","duplicate","order","bytes","failure","digest"])("rejects %s corruption",kind=>{
 const a=sourceAudit(operationId,inputDigest,tasks,[{taskId:tasks[0].id,value:{v:999}}]);
 if(kind==="operation")a.operationId="another";
 if(kind==="input")a.inputDigest="d".repeat(64);
 if(kind==="task")a.tasks[0].claimNo=3;
 if(kind==="duplicate")a.tasks[1].id=a.tasks[0].id;
 if(kind==="order")a.answers[0].taskId=tasks[1].id;
 if(kind==="bytes")a.answers[0].value={text:"あ".repeat(22000)};
 if(kind==="failure")a.failure={taskId:tasks[0].id,text:"bad"};
 const body={version:a.version,operationId:a.operationId,inputDigest:a.inputDigest,tasks:a.tasks,answers:a.answers,...(a.failure?{failure:a.failure}:{})}; a.auditDigest=kind==="digest"?"wrong":digest(body);
 expect(()=>validateSourceAudit(a,operationId,inputDigest,tasks)).toThrow("save_unconfirmed");
});
it("rejects oversized failure text instead of silently truncating evidence",()=>{
 expect(()=>sourceAudit(operationId,inputDigest,tasks,[],{taskId:tasks[0].id,text:"x".repeat(1_000_001)})).toThrow();
});
it("retains complete partition identities and a failed prefix without treating it as a whole claim",()=>{
 const base=tasks[0],parts=[1,2].map(i=>({...base,id:`${base.id}:part${i}of2`}));
 const a=sourceAudit(operationId,inputDigest,parts,[{taskId:parts[0].id,value:{partial:true}}],{taskId:parts[1].id,text:"not complete"});
 expect(validateSourceAudit(a,operationId,inputDigest,parts)).toEqual(a);
 for(const bad of [[parts[0]],[parts[1]],[parts[1],parts[0]],[base,...parts]])expect(()=>sourceAudit(operationId,inputDigest,bad,[])).toThrow();
});
