import { randomUUID, createHash } from "node:crypto";
import { buildFictionalFullPublicationXml, createFictionalKohoInput, type FictionalFullPublicationKind } from "../src/lib/koho-xml/__fixtures__/fictional-koho";
import { parseKohoXml } from "../src/lib/koho-xml";
import { extractManagedClaimSet } from "../src/lib/koho-import/managed-claim-source";
import { managedBaseSourceSchema } from "../src/lib/patent-watch/managed-base-source";
import type { ManagedClaimSet } from "../src/lib/patent-watch/managed-claims";
export function fictionalManagedBase(kind:FictionalFullPublicationKind="A1",expected?:ManagedClaimSet){
  const ordinary=createFictionalKohoInput(kind),publicationNumber=expected?.publicationNumber??ordinary.indexHint!.publicationNumber!;
  const xml=buildFictionalFullPublicationXml(kind,{publicationNumber,publicationDate:"2025-01-11",applicationDate:"2024-01-11",
    claims:expected?.claims.map(c=>({number:String(c.claimNo),text:c.text}))??[{number:"1",text:"完全架空の検出装置。"}]});
  const entryPath=ordinary.entryPath.replaceAll(ordinary.indexHint!.publicationNumber!,publicationNumber);
  const parsed=parseKohoXml({...ordinary,entryPath,xml,indexHint:{...ordinary.indexHint,publicationNumber,publicationDate:"20250111"}});
  if(!("document"in parsed)||!parsed.document||!("identityConfirmed"in parsed)||!parsed.identityConfirmed)throw Error("fictional_xml_failed");
  return{bytes:Buffer.from(xml),base:extractManagedClaimSet(parsed.document),source:{packageType:ordinary.packageType,entryPath,
    sha256:createHash("sha256").update(xml).digest("hex"),publicationDate:"20250111",applicationNumber:parsed.document.applicationNumber.value}};
}
export async function addFictionalManagedOriginal(caseId:number,sql:(text:string,values?:unknown[])=>Promise<Record<string,unknown>[]>,blobs:Map<string,Buffer>,expected?:ManagedClaimSet){
  const f=fictionalManagedBase((expected?.version??"A1") as FictionalFullPublicationKind,expected);
  const name=`cases/${caseId}/prior-art/1700000000000-${randomUUID()}-fictional.xml`;blobs.set(name,f.bytes);
  const row=(await sql("insert into prior_art_documents(case_id,publication_no,title,claims_text,source_csv_row_json) values($1,null,'FICTIONAL XML',$2,$3) returning doc_id",
    [caseId,f.bytes.toString(),JSON.stringify({source:"uploaded-file",originalFileName:"fictional.xml",blobName:name,contentType:"application/xml",size:f.bytes.length})]))[0];
  return{...f,name,source:managedBaseSourceSchema.parse({...f.source,documentId:row.doc_id})};
}
