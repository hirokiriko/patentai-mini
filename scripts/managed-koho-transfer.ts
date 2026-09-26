/** One owned transfer slot. User-saved originals are read-only inputs, never cleanup targets. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ContainerClient } from "@azure/storage-blob";
import { copyManualSource, hashManualSource, inspectManualDirectory, resumeManualSourceCopy, verifyManualSnapshot } from "../src/lib/koho-import/manual-cli-source";
import { requireManual } from "../src/lib/koho-import/manual-cli-config";
import { parseManagedCloudImportConfiguration, type CloudConfiguration, type CloudManifest } from "../src/lib/koho-import/cloud-config";
import { readVerifiedArchive } from "../src/lib/koho-import/managed-archive";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdentitySchema=z.object({packageType:z.literal("JPA"),issueNumber:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  publicationDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),distributionTableSha256:digest}).strict();
const ownerSchema = z.object({ schema: z.literal(1), transferId: z.uuidv4(), byteLength: z.number().int().positive().max(8 * 1024**3),
  sha256: digest, acquiredAt: z.iso.datetime({ precision: 3 }),sourceIdentity:sourceIdentitySchema.optional() }).strict();
const copiedSchema = z.object({ ownerDigest: digest, dev: z.number(), ino: z.number(), size: z.number(), mtimeMs: z.number(), ctimeMs: z.number() }).strict();
const createdSchema = z.object({ ownerDigest:digest,dev:z.number(),ino:z.number() }).strict();
const downloadSchema=z.object({schema:z.literal(1),transferId:z.uuidv4(),maxBytes:ownerSchema.shape.byteLength,
  allocatedAt:z.iso.datetime(),sourceIdentity:sourceIdentitySchema}).strict();
type Owner = z.infer<typeof ownerSchema>;
const slot = (projectRoot: string) => join(resolve(projectRoot), "_imports", ".managed-transfer", "current");
async function inspectOwned(path:string){await inspectManualDirectory(path);requireManual(await realpath(path)===path);return path;}
async function inspectSlot(projectRoot: string) {
  const pointer=await inspectOwned(slot(projectRoot));
  const active=z.object({transferId:z.uuidv4()}).strict().parse(await readRecord(pointer,"active.json"));
  return inspectOwned(join(dirname(pointer),active.transferId));
}
async function readRecord(path: string, name: string) {
  const file = join(path, name), stat = await lstat(file);
  requireManual(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 4096);
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
async function prepareRoot(projectRoot:string){
  const root=resolve(projectRoot);await inspectManualDirectory(root);
  for(const path of[join(root,"_imports"),dirname(slot(root))]){
    try{await mkdir(path,{mode:0o700});}catch(e){if(!(e&&typeof e==="object"&&"code"in e&&e.code==="EEXIST"))throw e;}
    await inspectManualDirectory(path);
  }return root;
}
async function allocateSlot(root:string){
  const pointer=slot(root);await mkdir(pointer,{mode:0o700});await inspectOwned(pointer);
  const transferId=randomUUID(),path=join(dirname(pointer),transferId);await mkdir(path,{mode:0o700});await inspectOwned(path);
  await writeFile(join(pointer,"active.json"),JSON.stringify({transferId}),{flag:"wx",mode:0o600});
  return{path,transferId};
}
/** Allocate a destination for one legitimate authenticated manual download.
 * This does not acquire credentials, navigate, or assert download success. */
export async function allocateManagedDownload(value:unknown,projectRoot=process.cwd()){
  const input=z.object({maxBytes:ownerSchema.shape.byteLength,sourceIdentity:sourceIdentitySchema}).strict().parse(value);
  const root=await prepareRoot(projectRoot),{path,transferId}=await allocateSlot(root);
  const record={schema:1,transferId,...input,allocatedAt:new Date().toISOString()};
  await writeFile(join(path,"download.json"),JSON.stringify(record),{flag:"wx",mode:0o600});
  return{status:"download_allocated",transferId:record.transferId,destination:join(path,"source.zip"),maxBytes:input.maxBytes};
}
export async function completeManagedDownload(value:unknown,projectRoot=process.cwd()){
  const input=z.object({transferId:z.uuidv4(),acquiredAt:ownerSchema.shape.acquiredAt}).strict().parse(value);
  const path=await inspectSlot(projectRoot),download=downloadSchema.parse(await readRecord(path,"download.json"));
  requireManual(download.transferId===input.transferId&&Date.parse(download.allocatedAt)<=Date.parse(input.acquiredAt)&&Date.parse(input.acquiredAt)<=Date.now());
  const sourcePath=join(path,"source.zip"),{stat,...hashed}=await hashManualSource(sourcePath,download.maxBytes);requireManual(stat.nlink===1);
  const owner=ownerSchema.parse({schema:1,transferId:input.transferId,...hashed,acquiredAt:input.acquiredAt,sourceIdentity:download.sourceIdentity});
  const copied={ownerDigest:managedDigest(owner),dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  for(const[name,record]of [["owner.json",owner],["copied.json",copied]] as const){
    let previous:unknown;try{previous=await readRecord(path,name);}catch(e){if(!(e&&typeof e==="object"&&"code"in e&&e.code==="ENOENT"))throw e;}
    if(previous)requireManual(managedDigest(previous)===managedDigest(record));
    else await writeFile(join(path,name),JSON.stringify(record),{flag:"wx",mode:0o600});
  }
  return{...owner,sourcePath};
}
export async function managedTransferStatus(projectRoot=process.cwd()){
  const path=await inspectSlot(projectRoot);let record:unknown;
  try{record=ownerSchema.parse(await readRecord(path,"owner.json"));}
  catch(e){if(!(e&&typeof e==="object"&&"code"in e&&e.code==="ENOENT"))throw e;record=downloadSchema.parse(await readRecord(path,"download.json"));}
  return{status:"transfer_pending",record};
}
export async function copyManagedTransfer(value: unknown, projectRoot = process.cwd()) {
  const input = z.object({ sourcePath: z.string().max(4096).refine(isAbsolute), byteLength: ownerSchema.shape.byteLength,
    sha256: digest, acquiredAt: ownerSchema.shape.acquiredAt, transferId:z.uuidv4().optional() }).strict().parse(value);
  requireManual(Date.parse(input.acquiredAt) <= Date.now());
  await verifyManualSnapshot(input.sourcePath,input.byteLength,input.sha256);
  const root=await prepareRoot(projectRoot);
  // A failed/interrupted copy intentionally occupies the slot until reconciled.
  const allocated=input.transferId?{path:await inspectSlot(root),transferId:input.transferId}:await allocateSlot(root),path=allocated.path;
  const owner: Owner = input.transferId ? ownerSchema.parse(await readRecord(path,"owner.json")) :
    { schema: 1, transferId: allocated.transferId, byteLength: input.byteLength, sha256: input.sha256, acquiredAt: input.acquiredAt };
  requireManual(owner.byteLength===input.byteLength&&owner.sha256===input.sha256&&owner.acquiredAt===input.acquiredAt&&(!input.transferId||owner.transferId===input.transferId));
  if(!input.transferId)await writeFile(join(path,"owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  const sourcePath = join(path,"source.zip");
  const createdRecord=async(stat:{dev:number|bigint;ino:number|bigint})=>{
    await writeFile(join(path,"created.json"),JSON.stringify({ownerDigest:managedDigest(owner),dev:stat.dev,ino:stat.ino}),{flag:"wx",mode:0o600});
  };
  let created:z.infer<typeof createdSchema>|undefined;
  if(input.transferId){
    try{created=createdSchema.parse(await readRecord(path,"created.json"));}
    catch(e){if(!(e&&typeof e==="object"&&"code"in e&&e.code==="ENOENT"))throw e;
      let empty;try{empty=await lstat(sourcePath);}catch(error){if(!(error&&typeof error==="object"&&"code"in error&&error.code==="ENOENT"))throw error;}
      if(empty){requireManual(empty.isFile()&&!empty.isSymbolicLink()&&empty.nlink===1&&empty.size===0);await createdRecord(empty);
        created=createdSchema.parse(await readRecord(path,"created.json"));}
    }
  }
  if(created){requireManual(created.ownerDigest===managedDigest(owner));await resumeManualSourceCopy(input.sourcePath,sourcePath,input.byteLength,input.sha256,created);}
  else requireManual(await copyManualSource(input.sourcePath,sourcePath,input.byteLength,createdRecord)===input.sha256);
  const stat = await lstat(sourcePath); requireManual(stat.nlink === 1);
  const copied={ownerDigest:managedDigest(owner),dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  try{const previous=copiedSchema.parse(await readRecord(path,"copied.json"));requireManual(managedDigest(previous)===managedDigest(copied));}
  catch(e){if(!(e&&typeof e==="object"&&"code"in e&&e.code==="ENOENT"))throw e;
    await writeFile(join(path,"copied.json"),JSON.stringify(copied),{flag:"wx",mode:0o600});}
  return { ...owner, sourcePath };
}
/** Called only after confirmed archive+budget stage. Rechecks Azure proof and
 * exact owned inode before deleting one fixed file. No recursive deletion. */
export async function releaseManagedTransfer(value: { transferId: string; config: CloudConfiguration;
  package: Extract<CloudManifest,{approval:"STANDARD_MANAGED_WATCH_RELEASE_V1"}>["packages"][number] }, container: ContainerClient,
  projectRoot = process.cwd()) {
  z.uuidv4().parse(value.transferId);
  const config = parseManagedCloudImportConfiguration(value.config),pointer=slot(projectRoot),completed=join(dirname(pointer),`released-${value.transferId}`);
  let alreadyReleased = false;
  try { await lstat(completed); alreadyReleased = true; }
  catch(e) { if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e; }
  const path=await inspectOwned(join(dirname(pointer),value.transferId));
  const pointerId=async(p:string)=>{await inspectOwned(p);return z.object({transferId:z.uuidv4()}).strict().parse(await readRecord(p,"active.json")).transferId;};
  requireManual(await pointerId(alreadyReleased?completed:pointer)===value.transferId);
  const owner = ownerSchema.parse(await readRecord(path,"owner.json")), copied = copiedSchema.parse(await readRecord(path,"copied.json"));
  requireManual(owner.transferId === value.transferId && copied.ownerDigest === managedDigest(owner) && owner.sha256 === value.package.sha256 &&
    owner.byteLength === value.package.byteLength && owner.acquiredAt === value.package.acquiredAt &&
    container.url === `https://${config.storageAccount}.blob.core.windows.net/${config.container}` &&
    !(await container.getProperties({ abortSignal: AbortSignal.timeout(20_000) })).blobPublicAccess);
  if(owner.sourceIdentity)requireManual(managedDigest(owner.sourceIdentity)===managedDigest(sourceIdentitySchema.parse({packageType:value.package.packageType,
    issueNumber:value.package.issueNumber,publicationDate:value.package.publicationDate,distributionTableSha256:value.package.distributionTableSha256})));
  const archive = await readVerifiedArchive(container, config, value.package);
  requireManual(value.package.archive?.operationId === config.operationId && archive.receipt.requestDigest === config.serviceBudget.requestDigest);
  const source = join(path,"source.zip"), same = async () => {
    await inspectOwned(path); const s = await lstat(source);
    requireManual(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.dev === copied.dev && s.ino === copied.ino &&
      s.size === copied.size && s.mtimeMs === copied.mtimeMs && s.ctimeMs === copied.ctimeMs);
  };
  const release = { transferId: owner.transferId, archive: value.package.archive, sha256: owner.sha256, byteLength: owner.byteLength };
  let approved: unknown;
  try { approved = await readRecord(path,"release.json"); }
  catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e; }
  if (approved) requireManual(managedDigest(approved) === managedDigest(release));
  if (alreadyReleased) {
    requireManual(approved);
    try { await lstat(source); throw Error("transfer_not_released"); }
    catch(e) { if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e; }
    return {status:"released",transferId:owner.transferId,archive:value.package.archive};
  }
  if (!approved) { await same(); await verifyManualSnapshot(source,owner.byteLength,owner.sha256); await same();
    await writeFile(join(path,"release.json"),JSON.stringify(release),{flag:"wx",mode:0o600}); }
  try { await same(); await verifyManualSnapshot(source,owner.byteLength,owner.sha256); await same(); await unlink(source); }
  catch (e) { if (!(approved && e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e; }
  // ZIP paths are never reused. Atomically retire the nonempty pointer directory;
  // its unique nonempty destination prevents a duplicate release moving a new slot.
  requireManual(dirname(completed) === dirname(pointer) && resolve(completed) === completed);
  try { requireManual(await pointerId(pointer)===value.transferId);await rename(pointer,completed); }
  catch { requireManual(await pointerId(completed)===value.transferId); }
  return { status: "released", transferId: owner.transferId, archive: value.package.archive };
}
if (require.main === module) {
  const watchdog = setTimeout(() => { process.stdout.write('{"status":"transfer_incomplete"}\n'); process.exit(2); },65*60_000);
  void (async () => { try {
    requireManual(process.argv.length === 2); const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; requireManual(size <= 32768); chunks.push(Buffer.from(chunk)); }
    const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const request=z.discriminatedUnion("command",[
      z.object({command:z.literal("copy"),input:z.unknown()}).strict(),z.object({command:z.literal("allocate-download"),input:z.unknown()}).strict(),
      z.object({command:z.literal("complete-download"),input:z.unknown()}).strict(),z.object({command:z.literal("status")}).strict()]).parse(input);
    const result=request.command==="status"?await managedTransferStatus():request.command==="copy"?await copyManagedTransfer(request.input):
      request.command==="allocate-download"?await allocateManagedDownload(request.input):await completeManagedDownload(request.input);
    process.stdout.write(JSON.stringify(result)+"\n");
  } catch { process.stdout.write('{"status":"transfer_incomplete"}\n'); process.exitCode = 2; }
  finally { clearTimeout(watchdog); } })();
}
