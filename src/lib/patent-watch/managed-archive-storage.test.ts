import { Readable } from "node:stream";
import { AnonymousCredential, BlobServiceClient, newPipeline } from "@azure/storage-blob";
import { expect, it } from "vitest";
import { archiveSha, ManagedArchiveStorage, managedBackupName } from "./managed-archive-storage";
function transport() {
  const files=new Map<string,Buffer>(),calls:string[]=[];let publicContainer=false,unknownRead=false;
  const pipeline=newPipeline(new AnonymousCredential(),{retryOptions:{maxTries:1},httpClient:{async sendRequest(request){
    const url=new URL(request.url),path=url.pathname.slice("/private/".length),headers=request.headers.clone();
    for(const name of headers.headerNames())headers.remove(name);headers.set("x-ms-request-id","fictional");headers.set("x-ms-version","2025-11-05");calls.push(`${request.method}:${path}`);
    let status=200,data=Buffer.alloc(0),bodyAsText:string|undefined;
    if(url.searchParams.get("comp")==="list") {
      bodyAsText=`<?xml version="1.0"?><EnumerationResults ServiceEndpoint="https://fictional.blob.core.windows.net/" ContainerName="private"><Prefix>${url.searchParams.get("prefix")}</Prefix><Blobs>${[...files.keys()].filter(k=>k.startsWith(url.searchParams.get("prefix")!)).map(k=>`<Blob><Name>${k}</Name><Properties><Content-Length>${files.get(k)!.length}</Content-Length></Properties></Blob>`).join("")}</Blobs><NextMarker /></EnumerationResults>`;
      headers.set("content-type","application/xml");
    } else if(url.searchParams.get("restype")==="container") {if(publicContainer)headers.set("x-ms-blob-public-access","container");}
    else if(request.method==="PUT") {expect(request.headers.get("if-none-match")).toBe("*");if(files.has(path))status=412;else{files.set(path,Buffer.from(request.body as Uint8Array));status=201;}}
    else if(unknownRead)throw Error("FICTIONAL_PRIVATE_SENTINEL");
    else if(!files.has(path)) {status=404;headers.set("x-ms-error-code","BlobNotFound");bodyAsText=request.method==="HEAD"?"":'<?xml version="1.0"?><Error><Code>BlobNotFound</Code><Message>absent</Message></Error>';headers.set("content-type","application/xml");}
    else if(request.method==="DELETE") {expect(request.headers.get("if-match")).toBe('"fictional-etag"');files.delete(path);status=202;}
    else {data=Buffer.from(files.get(path)!);headers.set("content-length",String(data.length));headers.set("etag",'"fictional-etag"');}
    return {request,status,headers,bodyAsText,readableStreamBody:Readable.from(data)};
  }}});
  return {files,calls,storage:new ManagedArchiveStorage(new BlobServiceClient("https://fictional.blob.core.windows.net",pipeline).getContainerClient("private")),makePublic:()=>{publicContainer=true;},failRead:()=>{unknownRead=true;}};
}
it("uses real Blob SDK to list, hash, conditionally remove and reread exact keys including empty legacy originals",async()=>{
  const b=transport(),id="11111111-1111-4111-8111-111111111111",name=managedBackupName(7,id),bytes=Buffer.from("fictional-backup");
  await b.storage.writeBackup(7,id,bytes);const saved=await b.storage.read(7,name);expect(saved?.metadata.sha256).toBe(archiveSha(bytes));
  expect(await b.storage.list(7)).toEqual([name]);await b.storage.remove(7,saved!.metadata);expect(await b.storage.read(7,name)).toBeNull();
  expect(b.calls.filter(c=>c.startsWith("DELETE"))).toHaveLength(1);
  const empty=`cases/7/drafts/main/1700000000000-${id}-empty.txt`;b.files.set(empty,Buffer.alloc(0));
  const read=await b.storage.read(7,empty);expect(read?.metadata.bytes).toBe(0);await b.storage.remove(7,read!.metadata);expect(await b.storage.list(7)).toEqual([]);
});
it("does not reinterpret public storage, unknown reads or changed bytes as safe absence",async()=>{
  const b=transport(),id="11111111-1111-4111-8111-111111111111",name=managedBackupName(7,id);
  await b.storage.writeBackup(7,id,Buffer.from("before"));const saved=await b.storage.read(7,name);b.files.set(name,Buffer.from("changed"));
  await expect(b.storage.remove(7,saved!.metadata)).rejects.toThrow("incomplete");expect(b.calls.filter(c=>c.startsWith("DELETE"))).toHaveLength(0);
  b.failRead();await expect(b.storage.read(7,name)).rejects.toThrow("unavailable");b.makePublic();await expect(b.storage.list(7)).rejects.toThrow("unavailable");
});
