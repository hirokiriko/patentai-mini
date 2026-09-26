import { createHash } from "node:crypto";
import { z } from "zod";
import { parseKohoXml } from "../koho-xml";
import { extractManagedClaimSet } from "../koho-import/managed-claim-source";
import { managedDigest, type ManagedClaimSet } from "./managed-claims";
export const managedBaseSourceSchema=z.object({documentId:z.number().int().positive().max(2147483647),packageType:z.enum(["JPA","JPB"]),
  entryPath:z.string().min(1).max(2048),sha256:z.string().regex(/^[a-f0-9]{64}$/),publicationDate:z.string().regex(/^\d{8}$/),applicationNumber:z.string().min(1).max(100)}).strict();
export type ManagedBaseSource=z.infer<typeof managedBaseSourceSchema>;
export const MANAGED_BASE_XML_BYTES=4*1024**2;
/** Reparse the exact retained XML; operator-provided claim text is only an expectation. */
export function verifyManagedBaseOriginal(bytes:Buffer,source:ManagedBaseSource,expected:ManagedClaimSet){
  if(!bytes.length||bytes.length>MANAGED_BASE_XML_BYTES||createHash("sha256").update(bytes).digest("hex")!==source.sha256)throw Error("invalid_base_source");
  const result=parseKohoXml({packageType:source.packageType,entryPath:source.entryPath,xml:bytes,
    indexHint:{kindCode:["A1","P1"].includes(expected.version)?"A":expected.version,publicationNumber:expected.publicationNumber,publicationDate:source.publicationDate},
    limits:{maxXmlBytes:MANAGED_BASE_XML_BYTES,maxTextBytes:MANAGED_BASE_XML_BYTES,maxDepth:128,maxElements:100_000}});
  if(!("document"in result)||!result.document||!("identityConfirmed"in result)||!result.identityConfirmed||
    !["A1","P1","B1","B2"].includes(result.document.kind)||result.document.applicationNumber.value!==source.applicationNumber||
    result.document.publicationDate.value.replaceAll("-","")!==source.publicationDate)throw Error("invalid_base_source");
  const actual=extractManagedClaimSet(result.document);
  if(managedDigest(actual)!==managedDigest(expected))throw Error("invalid_base_source");
  return actual;
}
