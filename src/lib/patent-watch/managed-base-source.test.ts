import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fictionalManagedBase } from "../../../scripts/managed-base.test-support";
import { verifyManagedBaseOriginal } from "./managed-base-source";
it.each(["A1","P1","B1","B2"] as const)("binds %s original, bibliographic identity and every claim beyond 2,000 characters",kind=>{
  const initial=fictionalManagedBase(kind),f=fictionalManagedBase(kind,{...initial.base,claims:[{claimNo:1,text:"完全架空の検出条件。".repeat(300)+"末尾条件。",dependsOn:[]},
    {claimNo:2,text:"請求項1に記載の装置。",dependsOn:[1]}]}),source={...f.source,documentId:1};
  expect(verifyManagedBaseOriginal(f.bytes,source,f.base)).toEqual(f.base);
  expect(()=>verifyManagedBaseOriginal(f.bytes,source,{...f.base,claims:f.base.claims.map(c=>({...c,text:c.text.slice(0,2000)}))})).toThrow();
  expect(()=>verifyManagedBaseOriginal(f.bytes,{...source,applicationNumber:"OTHER"},f.base)).toThrow();
  expect(()=>verifyManagedBaseOriginal(f.bytes,{...source,publicationDate:"20250112"},f.base)).toThrow();
  const changed=Buffer.from(f.bytes);changed[changed.length-1]^=1;
  expect(()=>verifyManagedBaseOriginal(changed,source,f.base)).toThrow();
  expect(()=>verifyManagedBaseOriginal(changed,{...source,sha256:createHash("sha256").update(changed).digest("hex")},f.base)).toThrow();
});
