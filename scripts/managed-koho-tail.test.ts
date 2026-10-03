import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockBlobClient } from "@azure/storage-blob";
import { afterEach, expect, it, vi } from "vitest";
import { archiveBlockListDigest, resumeArchiveTail } from "./managed-koho-tail";
import { sha256 } from "../src/lib/koho-import/cloud-config";
const temporary:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const p of temporary.splice(0))await rm(p,{recursive:true,force:true});});
const prefix="11111111-1111-4111-8111-111111111111",old="22222222-2222-4222-8222-222222222222",BLOCK=8*1024**2;
const id=(p:string,n:number)=>Buffer.from(p+String(n).padStart(12,"0")).toString("base64");
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"fictional-tail-"));temporary.push(dir);
  const sourcePath=join(dir,"fictional.zip"),data=Buffer.concat([Buffer.alloc(BLOCK,11),Buffer.alloc(BLOCK,22),Buffer.alloc(103,33)]);
  await writeFile(sourcePath,data);
  const blocks=new Map([[id(prefix,0),data.subarray(0,BLOCK)],[id(old,0),Buffer.alloc(BLOCK,99)]]);
  let committed:Buffer|undefined,marker:Buffer|undefined;
  const getBlockList=vi.fn(async():Promise<{committedBlocks:{name:string;size:number}[];uncommittedBlocks:{name:string;size:number}[]}>=>({committedBlocks:[],uncommittedBlocks:[...blocks].map(([name,b])=>({name,size:b.length}))}));
  const stageBlock=vi.fn(async(name:string,body:Buffer,length:number,options:{abortSignal:AbortSignal})=>{
    options.abortSignal.throwIfAborted();expect(body.length).toBe(length);blocks.set(name,Buffer.from(body));return{};
  });
  const commitBlockList=vi.fn(async(names:string[],options:{conditions:{ifNoneMatch:string};abortSignal:AbortSignal})=>{
    options.abortSignal.throwIfAborted();expect(options.conditions).toEqual({ifNoneMatch:"*"});expect(committed).toBeUndefined();
    committed=Buffer.concat(names.map(n=>blocks.get(n)!));return{};
  });
  const previous=Buffer.from("fictional immutable previous marker"),now=Date.now();
  const recovery={localCodeSha:"f".repeat(40),ownerApprovalSha256:"a".repeat(64),priorFailureSha256:"b".repeat(64),priorEvidenceSha256:"c".repeat(64),
    priorRecoveryMarkerSha256:sha256(previous),priorSenderTerminated:true as const,priorStartedAt:new Date(now-20_000).toISOString(),
    priorTerminatedObservedAt:new Date(now-10_000).toISOString(),maxUploadElapsedMs:15_000,blockListSha256:archiveBlockListDigest(await getBlockList()),blockIdPrefix:prefix};
  const createMarker=vi.fn(async(bytes:Buffer,signal:AbortSignal)=>{signal.throwIfAborted();if(marker)throw Error("conflict");marker=bytes;return{};});
  const args={recovery,sourcePath,sourceBytes:data.length,blob:{getBlockList,stageBlock,commitBlockList} as unknown as BlockBlobClient,
    previous:{data:previous,lastModified:new Date(now-19_000),maxUploadElapsedMs:15_000,ownerApprovalSha256:recovery.ownerApprovalSha256},guard:vi.fn(),createMarker};
  return{args,data,blocks,getBlockList,stageBlock,commitBlockList,createMarker,committed:()=>committed,marker:()=>marker};
}
it("sends only missing bytes and commits the selected prefix in file order",async()=>{
  const f=await fixture();await resumeArchiveTail(f.args);
  expect(f.stageBlock.mock.calls.map(c=>[c[0],c[2]])).toEqual([[id(prefix,1),BLOCK],[id(prefix,2),103]]);
  expect(f.committed()?.equals(f.data)).toBe(true);expect((await readFile(f.args.sourcePath)).equals(f.data)).toBe(true);
  expect(JSON.parse(f.marker()!.toString())).toMatchObject({priorElapsedMs:10_000,remainingUploadMs:5_000,reusedBlocks:1,tailBytes:BLOCK+103});
});
it.each(["gap","size","new-block","committed","marker","approval","elapsed","time","source-size","prefix"])("refuses %s without writes",async(kind)=>{
  const f=await fixture();
  if(kind==="gap"){f.blocks.delete(id(prefix,0));f.blocks.set(id(prefix,1),Buffer.alloc(BLOCK));}
  if(kind==="size")f.blocks.set(id(prefix,0),Buffer.alloc(3));
  if(kind==="new-block")f.blocks.set(id(old,1),Buffer.alloc(3));
  if(kind==="committed")f.getBlockList.mockImplementation(async()=>({committedBlocks:[{name:id(prefix,0),size:BLOCK}],uncommittedBlocks:[]}));
  if(kind==="marker")f.args.previous.data=Buffer.from("changed");
  if(kind==="approval")f.args.previous.ownerApprovalSha256="d".repeat(64);
  if(kind==="elapsed"){f.args.recovery.maxUploadElapsedMs=10_000;f.args.previous.maxUploadElapsedMs=10_000;}
  if(kind==="time")f.args.previous.lastModified=new Date(Date.parse(f.args.recovery.priorStartedAt)-1);
  if(kind==="source-size")f.args.sourceBytes++;
  if(kind==="prefix")f.args.recovery.blockIdPrefix="33333333-3333-4333-8333-333333333333";
  if(["gap","size"].includes(kind))f.args.recovery.blockListSha256=archiveBlockListDigest(await f.getBlockList());
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();
  expect(f.createMarker).not.toHaveBeenCalled();expect(f.stageBlock).not.toHaveBeenCalled();expect(f.commitBlockList).not.toHaveBeenCalled();
});
it("keeps the marker and never replays after an unknown marker acknowledgement",async()=>{
  const f=await fixture(),create=f.createMarker.getMockImplementation()!;
  f.createMarker.mockImplementation(async(...args)=>{await create(...args);throw Error("lost ACK");});
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();f.createMarker.mockImplementation(create);
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();expect(f.stageBlock).not.toHaveBeenCalled();
});
it("uses the same remaining deadline after each block and never commits after it expires",async()=>{
  const f=await fixture(),stage=f.stageBlock.getMockImplementation()!,now=Date.now();
  f.stageBlock.mockImplementation(async(...args)=>{await stage(...args);vi.spyOn(Date,"now").mockReturnValue(now+6_000);return{};});
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();expect(f.stageBlock).toHaveBeenCalledOnce();expect(f.commitBlockList).not.toHaveBeenCalled();
});
it.each(["block","commit"])("does not automatically retry an unknown %s acknowledgement",async(where)=>{
  const f=await fixture();
  if(where==="block"){const stage=f.stageBlock.getMockImplementation()!;f.stageBlock.mockImplementation(async(...args)=>{await stage(...args);throw Error("lost ACK");});}
  else{const commit=f.commitBlockList.getMockImplementation()!;f.commitBlockList.mockImplementation(async(...args)=>{await commit(...args);throw Error("lost ACK");});}
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();
  expect(f.stageBlock).toHaveBeenCalledTimes(where==="block"?1:2);expect(f.commitBlockList).toHaveBeenCalledTimes(where==="commit"?1:0);
  expect(f.marker()).toBeDefined();
});
it("refuses a changed block set before commit",async()=>{
  const f=await fixture(),stage=f.stageBlock.getMockImplementation()!;
  f.stageBlock.mockImplementation(async(...args)=>{await stage(...args);f.blocks.set(id(old,1),Buffer.alloc(1));return{};});
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();expect(f.commitBlockList).not.toHaveBeenCalled();
});
it("allows only one concurrent marker winner",async()=>{
  const f=await fixture();const results=await Promise.allSettled([resumeArchiveTail(f.args),resumeArchiveTail(f.args)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.commitBlockList).toHaveBeenCalledOnce();
});
it("does not send after expiry during marker acknowledgement",async()=>{
  const f=await fixture(),create=f.createMarker.getMockImplementation()!,now=Date.now();
  f.createMarker.mockImplementation(async(...args)=>{await create(...args);vi.spyOn(Date,"now").mockReturnValue(now+6_000);return{};});
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();expect(f.stageBlock).not.toHaveBeenCalled();
});
it("does not commit a source modified during transfer",async()=>{
  const f=await fixture(),stage=f.stageBlock.getMockImplementation()!;
  f.stageBlock.mockImplementation(async(...args)=>{await stage(...args);await writeFile(f.args.sourcePath,Buffer.alloc(f.data.length,44));return{};});
  await expect(resumeArchiveTail(f.args)).rejects.toThrow();expect(f.commitBlockList).not.toHaveBeenCalled();
});
