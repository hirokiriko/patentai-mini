/** Resume only a reconciled SDK block prefix, within the remaining upload time. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { BlockBlobClient } from "@azure/storage-blob";
import { z } from "zod";
import { sha256 } from "../src/lib/koho-import/cloud-config";
import { requireManual } from "../src/lib/koho-import/manual-cli-config";

export const tailRecoverySchema=z.object({localCodeSha:z.string().regex(/^[a-f0-9]{40}$/),
  ownerApprovalSha256:z.string().regex(/^[a-f0-9]{64}$/),priorFailureSha256:z.string().regex(/^[a-f0-9]{64}$/),
  priorEvidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),priorRecoveryMarkerSha256:z.string().regex(/^[a-f0-9]{64}$/),
  priorSenderTerminated:z.literal(true),priorStartedAt:z.iso.datetime(),priorTerminatedObservedAt:z.iso.datetime(),
  maxUploadElapsedMs:z.number().int().positive(),blockListSha256:z.string().regex(/^[a-f0-9]{64}$/),blockIdPrefix:z.uuidv4()}).strict();
type Block={name:string;size:number};
type BlockList={committedBlocks?:Block[];uncommittedBlocks?:Block[]};
export function archiveBlockListDigest(list:BlockList){
  const normalize=(blocks:Block[]=[])=>blocks.map(({name,size})=>({name,size})).sort((a,b)=>a.name.localeCompare(b.name));
  return sha256(JSON.stringify({committed:normalize(list.committedBlocks),uncommitted:normalize(list.uncommittedBlocks)}));
}
const BLOCK_BYTES=8*1024**2;
function blockId(prefix:string,index:number){return Buffer.from(prefix+String(index).padStart(12,"0")).toString("base64");}
export async function resumeArchiveTail(args:{
  recovery:z.infer<typeof tailRecoverySchema>;sourcePath:string;sourceBytes:number;blob:BlockBlobClient;
  previous:{data:Buffer;lastModified:Date;maxUploadElapsedMs:number;ownerApprovalSha256:string};
  guard:()=>void;createMarker:(data:Buffer,signal:AbortSignal)=>Promise<unknown>;
}){
  const r=tailRecoverySchema.parse(args.recovery),started=Date.parse(r.priorStartedAt),ended=Date.parse(r.priorTerminatedObservedAt);
  const elapsed=ended-started,remaining=r.maxUploadElapsedMs-elapsed;
  requireManual(sha256(args.previous.data)===r.priorRecoveryMarkerSha256&&
    args.previous.ownerApprovalSha256===r.ownerApprovalSha256&&args.previous.maxUploadElapsedMs===r.maxUploadElapsedMs);
  requireManual(started<=args.previous.lastModified.getTime()&&args.previous.lastModified.getTime()<=ended&&ended<=Date.now()&&elapsed>0&&remaining>0);
  const total=Math.ceil(args.sourceBytes/BLOCK_BYTES);
  requireManual(Number.isSafeInteger(args.sourceBytes)&&args.sourceBytes>0&&total<=1024);
  args.guard();
  const initial=await args.blob.getBlockList("all",{abortSignal:AbortSignal.timeout(20_000)});
  requireManual(!(initial.committedBlocks?.length)&&archiveBlockListDigest(initial)===r.blockListSha256);
  const selected=(initial.uncommittedBlocks??[]).filter(b=>Buffer.from(b.name,"base64").toString("utf8").startsWith(r.blockIdPrefix));
  requireManual(selected.length>0&&selected.length<total&&new Set((initial.uncommittedBlocks??[]).map(b=>b.name)).size===(initial.uncommittedBlocks??[]).length);
  const selectedMap=new Map(selected.map(b=>[b.name,b.size]));
  for(let n=0;n<selected.length;n++)requireManual(selectedMap.get(blockId(r.blockIdPrefix,n))===BLOCK_BYTES);
  const stat=await lstat(args.sourcePath);
  requireManual(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===args.sourceBytes&&stat.nlink===1);
  const handle=await open(args.sourcePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const unchanged=(now:typeof stat)=>requireManual(now.isFile()&&!now.isSymbolicLink()&&now.dev===stat.dev&&now.ino===stat.ino&&now.size===stat.size&&now.mtimeMs===stat.mtimeMs&&now.ctimeMs===stat.ctimeMs&&now.nlink===1);
  try{
    unchanged(await handle.stat());
    const tailStartedAt=Date.now(),deadline=tailStartedAt+remaining,signal=AbortSignal.timeout(remaining);
    const guard=()=>{args.guard();signal.throwIfAborted();requireManual(Date.now()<deadline);};
    const requestSignal=()=>AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
    guard();await args.createMarker(Buffer.from(JSON.stringify({...r,priorElapsedMs:elapsed,remainingUploadMs:remaining,
      tailStartedAt:new Date(tailStartedAt).toISOString(),sendNotAfter:new Date(deadline).toISOString(),
      sourceBytes:args.sourceBytes,reusedBlocks:selected.length,tailBytes:args.sourceBytes-selected.length*BLOCK_BYTES})),requestSignal());
    const expected=new Map((initial.uncommittedBlocks??[]).map(b=>[b.name,b.size]));
    for(let n=selected.length;n<total;n++){
      guard();const start=n*BLOCK_BYTES,length=Math.min(BLOCK_BYTES,args.sourceBytes-start),buffer=Buffer.alloc(length);
      let offset=0;while(offset<length){const read=await handle.read(buffer,offset,length-offset,start+offset);requireManual(read.bytesRead>0);offset+=read.bytesRead;}
      guard();const id=blockId(r.blockIdPrefix,n);
      await args.blob.stageBlock(id,buffer,length,{abortSignal:requestSignal()});expected.set(id,length);
    }
    unchanged(await handle.stat());unchanged(await lstat(args.sourcePath));guard();
    const final=await args.blob.getBlockList("all",{abortSignal:requestSignal()});
    requireManual(archiveBlockListDigest(final)===archiveBlockListDigest({committedBlocks:[],uncommittedBlocks:[...expected].map(([name,size])=>({name,size}))}));
    guard();await args.blob.commitBlockList(Array.from({length:total},(_,n)=>blockId(r.blockIdPrefix,n)),{
      conditions:{ifNoneMatch:"*"},abortSignal:requestSignal(),blobHTTPHeaders:{blobContentType:"application/zip",blobCacheControl:"private, no-store"}});
    guard();
  }finally{await handle.close();}
}
