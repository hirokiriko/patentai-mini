/** Private Local preparation: exact public XML -> verified setting input, no AI. */
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseKohoXml } from "../src/lib/koho-xml";
import { extractManagedClaimSet } from "../src/lib/koho-import/managed-claim-source";
import { MANAGED_BASE_XML_BYTES, managedBaseSourceSchema, verifyManagedBaseOriginal } from "../src/lib/patent-watch/managed-base-source";
import { sha256 } from "../src/lib/koho-import/cloud-config";
const schema=z.object({sourcePath:z.string().max(4096).refine(isAbsolute),documentId:z.number().int().positive().max(2147483647),
  packageType:z.enum(["JPA","JPB"]),entryPath:z.string().max(2048),kind:z.enum(["A1","P1","B1","B2"]),
  publicationNumber:z.string().max(100),publicationDate:z.string().regex(/^\d{8}$/),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function previewManagedBase(value:unknown){
  const input=schema.parse(value),stat=await lstat(input.sourcePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MANAGED_BASE_XML_BYTES)throw Error();
  const bytes=await readFile(input.sourcePath);if(bytes.length!==stat.size||sha256(bytes)!==input.sha256)throw Error();
  const parsed=parseKohoXml({packageType:input.packageType,entryPath:input.entryPath,xml:bytes,
    indexHint:{kindCode:["A1","P1"].includes(input.kind)?"A":input.kind,publicationNumber:input.publicationNumber,publicationDate:input.publicationDate},
    limits:{maxXmlBytes:MANAGED_BASE_XML_BYTES,maxTextBytes:MANAGED_BASE_XML_BYTES,maxDepth:128,maxElements:100_000}});
  if(!("document"in parsed)||!parsed.document||!("identityConfirmed"in parsed)||!parsed.identityConfirmed)throw Error();
  const base=extractManagedClaimSet(parsed.document),source=managedBaseSourceSchema.parse({documentId:input.documentId,packageType:input.packageType,
    entryPath:input.entryPath,sha256:input.sha256,publicationDate:input.publicationDate,applicationNumber:parsed.document.applicationNumber.value});
  verifyManagedBaseOriginal(bytes,source,base);return{base,source};
}
if(require.main===module){
  const watchdog=setTimeout(()=>{process.stdout.write('{"status":"preview_incomplete"}\n');process.exit(2);},30_000);
  void(async()=>{try{
    if(process.argv.length!==2)throw Error();let size=0;const parts:Buffer[]=[];
    for await(const part of process.stdin){size+=part.length;if(size>16384)throw Error();parts.push(Buffer.from(part));}
    process.stdout.write(JSON.stringify(await previewManagedBase(JSON.parse(Buffer.concat(parts).toString("utf8"))))+"\n");
  }catch{process.stdout.write('{"status":"preview_incomplete"}\n');process.exitCode=2;}finally{clearTimeout(watchdog);}})();
}
