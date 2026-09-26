import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { managedHash, managedId, ManagedWatchError } from "./managed-types";
import { generateManagedDeliveryPdf, managedDeliveryCsv, validateManagedDelivery, type ManagedDelivery } from "./managed-delivery";
import type { ManagedDeliveryRepository } from "../../repositories/managed-delivery";
import { configuredManagedArtifactAdmission } from "./managed-artifact-budget";
import { managedArtifactIntentSchema, type ManagedArtifactAdmission, type ManagedArtifactIntent } from "./managed-artifact-contract";
const artifactSchema=z.object({kind:z.enum(["snapshot","pdf","csv"]),sha256:managedHash,bytes:z.number().int().positive().max(16*1024**2)}).strict();
export const managedArtifactManifestSchema=z.object({schema:z.literal(1),caseId:managedId,deliveryId:z.uuidv4(),artifacts:z.array(artifactSchema).length(3)}).strict();
export type ManagedArtifactManifest=z.infer<typeof managedArtifactManifestSchema>;
export type ManagedArtifactKind=ManagedArtifactManifest["artifacts"][number]["kind"];
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
export const managedArtifactName=(caseId:number,id:string,kind:ManagedArtifactKind)=>`cases/${caseId}/managed-deliveries/${id}/${kind}.${kind==="snapshot"?"json":kind}`;
export function validateManagedArtifactManifest(value:unknown,caseId:number,deliveryId:string){
  const manifest=managedArtifactManifestSchema.parse(value);
  if(manifest.caseId!==caseId||manifest.deliveryId!==deliveryId||new Set(manifest.artifacts.map(a=>a.kind)).size!==3)throw new ManagedWatchError("incomplete");
  return manifest;
}
export class ManagedPrivateStorage{
  constructor(private readonly container:ContainerClient,private readonly deadline?:AbortSignal){}
  get location(){return this.container.url;}
  withDeadline(deadline:AbortSignal){return new ManagedPrivateStorage(this.container,this.deadline?AbortSignal.any([this.deadline,deadline]):deadline);}
  private signal(){return this.deadline?AbortSignal.any([this.deadline,AbortSignal.timeout(20_000)]):AbortSignal.timeout(20_000);}
  static configured(deadline?:AbortSignal){
    const connection=process.env.AZURE_STORAGE_CONNECTION_STRING,container=process.env.AZURE_BLOB_CONTAINER_NAME;
    if(!connection||!container)throw new ManagedWatchError("unavailable");
    return new ManagedPrivateStorage(BlobServiceClient.fromConnectionString(connection,{retryOptions:{maxTries:1,tryTimeoutInMs:20_000}}).getContainerClient(container),deadline);
  }
  async assertPrivate(){
    try{const properties=await this.container.getProperties({abortSignal:this.signal()});if(properties.blobPublicAccess)throw Error();}
    catch{throw new ManagedWatchError("unavailable");}
  }
  async write(manifest:ManagedArtifactManifest,kind:ManagedArtifactKind,bytes:Buffer){
    const m=validateManagedArtifactManifest(manifest,manifest.caseId,manifest.deliveryId),a=m.artifacts.find(a=>a.kind===kind)!;
    if(bytes.length!==a.bytes||sha(bytes)!==a.sha256)throw new ManagedWatchError("incomplete");
    try{await this.assertPrivate();await this.container.getBlockBlobClient(managedArtifactName(m.caseId,m.deliveryId,kind)).uploadData(bytes,{conditions:{ifNoneMatch:"*"},abortSignal:this.signal(),
      blobHTTPHeaders:{blobContentType:kind==="pdf"?"application/pdf":kind==="csv"?"text/csv; charset=utf-8":"application/json",blobCacheControl:"private, no-store"}});}
    catch{throw new ManagedWatchError("outcome_unknown");}
  }
  private async readIfPresent(manifest:ManagedArtifactManifest,kind:ManagedArtifactKind):Promise<Buffer|null>{
    const m=validateManagedArtifactManifest(manifest,manifest.caseId,manifest.deliveryId),a=m.artifacts.find(a=>a.kind===kind)!;
    try{await this.assertPrivate();const blob=this.container.getBlobClient(managedArtifactName(m.caseId,m.deliveryId,kind));
      const p=await blob.getProperties({abortSignal:this.signal()});if(p.contentLength!==a.bytes||!p.etag)throw Error();
      const bytes=await blob.downloadToBuffer(0,a.bytes,{conditions:{ifMatch:p.etag},abortSignal:this.signal()});
      if(bytes.length!==a.bytes||sha(bytes)!==a.sha256)throw Error();return bytes;
    }catch(error){
      if(isAzureBlobNotFound(error))return null;
      throw new ManagedWatchError("unavailable");
    }
  }
  async inspect(manifest:ManagedArtifactManifest,kind:ManagedArtifactKind):Promise<"verified"|"missing">{
    return await this.readIfPresent(manifest,kind)===null?"missing":"verified";
  }
  async read(manifest:ManagedArtifactManifest,kind:ManagedArtifactKind){
    const bytes=await this.readIfPresent(manifest,kind);if(bytes===null)throw new ManagedWatchError("unavailable");return bytes;
  }
}
/** Admit the complete creation before opening its preparation transaction. */
export async function createManagedDelivery(repository:ManagedDeliveryRepository,storage:ManagedPrivateStorage,
  value:Extract<ManagedArtifactIntent,{kind:"delivery"}>,deadline:AbortSignal,
  admit:ManagedArtifactAdmission=configuredManagedArtifactAdmission()){
  const input=managedArtifactIntentSchema.parse(value);
  if(input.kind!=="delivery")throw new ManagedWatchError("incomplete");
  await admit(input,storage.location,deadline);deadline.throwIfAborted();
  const report=await repository.prepare(input.caseId,input.period,{distributionTableSha256:input.distributionTableSha256},
    input.reason,input.deliveredOn,input.deliveryId,deadline);
  await storeManagedDelivery(repository,storage,report,deadline);
  return report;
}
/** Reserve exact bytes before the first cloud write. A lost ACK never triggers a repeat upload. */
export async function storeManagedDelivery(repository:ManagedDeliveryRepository,storage:ManagedPrivateStorage,value:ManagedDelivery,deadline?:AbortSignal){
  deadline?.throwIfAborted();
  const report=validateManagedDelivery(value);
  const bytes={snapshot:Buffer.from(JSON.stringify(report)),pdf:await generateManagedDeliveryPdf(report),csv:managedDeliveryCsv(report)};
  deadline?.throwIfAborted();
  const manifest=validateManagedArtifactManifest({schema:1,caseId:report.caseId,deliveryId:report.deliveryId,
    artifacts:(["snapshot","pdf","csv"] as const).map(kind=>({kind,sha256:sha(bytes[kind]),bytes:bytes[kind].length}))},report.caseId,report.deliveryId);
  await repository.reserveArtifacts(report,manifest);
  // The DB reservation permits only a fresh (<60 s) prepared row. This writer
  // stops within 90 s; explicit abandon requires the row to be at least 10 min old.
  const writingDeadline=deadline?AbortSignal.any([deadline,AbortSignal.timeout(90_000)]):AbortSignal.timeout(90_000);
  storage=storage.withDeadline(writingDeadline);
  try{
    for(const kind of ["snapshot","pdf","csv"] as const){writingDeadline.throwIfAborted();await storage.write(manifest,kind,bytes[kind]);await storage.read(manifest,kind);}
    await repository.markArtifacts(report,manifest,"stored");return manifest;
  }catch{
    // A lost commit ACK may already mean stored. Read this exact id before another write.
    const observed=await repository.get(report.caseId,report.deliveryId);
    if(observed.status==="stored"&&JSON.stringify(observed.manifest)===JSON.stringify(manifest))return manifest;
    if(observed.status==="prepared")await repository.markArtifacts(report,manifest,"storage_unknown");
    throw new ManagedWatchError("outcome_unknown");
  }
}
/** Explicit reconciliation performs only reads until all three artifacts are classified.
 * Missing artifacts are never resent. An explicitly abandoned partial version stays
 * in retention manifests; a replacement receives a new id and new immutable keys. */
export async function reconcileManagedDelivery(repository:ManagedDeliveryRepository,storage:ManagedPrivateStorage,
  caseId:number,deliveryId:string,abandonPartial=false){
  const stored=await repository.get(caseId,deliveryId);
  if(stored.status==="abandoned")throw new ManagedWatchError("conflict");
  if(!stored.manifest){
    if(stored.status!=="prepared"||!abandonPartial)throw new ManagedWatchError("conflict");
    await repository.abandonPreparation(caseId,deliveryId);return "abandoned" as const;
  }
  const manifest=validateManagedArtifactManifest(stored.manifest,caseId,deliveryId);
  const states=[];
  for(const kind of ["snapshot","pdf","csv"] as const)states.push(await storage.inspect(manifest,kind));
  if(states.every(state=>state==="verified")){
    await repository.markArtifacts(stored.report,manifest,"stored");return "stored" as const;
  }
  if(stored.status==="stored")throw new ManagedWatchError("incomplete");
  if(abandonPartial){await repository.markArtifacts(stored.report,manifest,"abandoned");return "abandoned" as const;}
  await repository.markArtifacts(stored.report,manifest,"storage_unknown");return "storage_unknown" as const;
}
import { isAzureBlobNotFound } from "../azure-blob-errors";
