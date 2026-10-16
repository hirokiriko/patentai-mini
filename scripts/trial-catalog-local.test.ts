import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { writeFile } from "node:fs/promises";
import { isAbsolute,resolve,join } from "node:path";
import { Client } from "pg";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { CATALOG_PACK,CATALOG_QUERIES,CATALOG_QUERY_SET_SHA256,CATALOG_ROW_LIMIT,CATALOG_QUERY_BYTES,CATALOG_SNAPSHOT_BYTES,catalogCanonical,catalogDigest } from "../src/lib/trial/catalog-queries";
import { builtinManifestSchema,catalogPlanSchema,catalogSnapshotSchema,type BuiltinManifest,type CatalogPlan } from "../src/lib/trial/catalog-schema";
import { evaluateCatalogSnapshot,freezeCatalogInventory } from "../src/lib/trial/catalog-evaluate";

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST!=="1")("catalog isolation against real local PG16",()=>{
  let env:Awaited<ReturnType<typeof isolatedPg16>>,stock:Client,builtins:BuiltinManifest,plan:CatalogPlan;
  const clients:Client[]=[];
  async function read(client:Client){
    await client.query(CATALOG_QUERIES.begin);
    try{
      const identity=(await client.query(CATALOG_QUERIES.identity)).rows[0];
      const inventory=(await client.query(CATALOG_QUERIES.inventory)).rows;
      const data:Record<string,unknown>={};for(const key of CATALOG_PACK)data[key]=(await client.query(CATALOG_QUERIES[key])).rows;
      const parsed=catalogSnapshotSchema.safeParse({schema:1,identity,database:inventory.find(d=>d.datname===identity.database),...data});
      if(!parsed.success)throw Error(JSON.stringify(parsed.error.issues.slice(0,10)));
      const snapshot=parsed.data;
      await client.query(CATALOG_QUERIES.commit);return{snapshot,inventory};
    }catch(e){await client.query("ROLLBACK");throw e;}
  }
  beforeAll(async()=>{
    env=await isolatedPg16(129);
    const password=(env.admin as unknown as {connectionParameters:{password:string}}).connectionParameters.password;
    stock=new Client({host:env.connection.host,port:env.connection.port,database:"postgres",user:"postgres",password,
      options:"-c search_path=pg_catalog -c default_transaction_read_only=on"});clients.push(stock);await stock.connect();
    const {snapshot}=await read(stock);
    const data=Object.fromEntries(CATALOG_PACK.map(k=>[k,snapshot[k]]));
    // This capture operates solely on an unmodified stock image in an isolated
    // container. Live acceptance never infers builtin status from an OID/name.
    data.roles=snapshot.roles.filter(r=>r.rolname==="postgres"||r.rolname.startsWith("pg_"));
    builtins=builtinManifestSchema.parse({schema:1,sourcePgVersion:snapshot.identity.version,querySetSha256:CATALOG_QUERY_SET_SHA256,
      bootstrapSuperuserOid:snapshot.roles.find(r=>r.rolname==="postgres")!.oid,catalogs:data});
    plan=catalogPlanSchema.parse({schema:1,server:"fixture.postgres.database.azure.com",adminUser:"postgres",targetDatabase:"trial_catalog_fixture",
      roles:{owner:"trial_owner",migrator:"trial_migrator",web:"trial_web",worker:"trial_worker"},excludedDatabases:[{name:"template0",template:true,allowConnect:false}],
      maximumAuditConnections:6,builtinManifestSha256:catalogDigest(builtins),querySetSha256:CATALOG_QUERY_SET_SHA256,
      limits:{rowsPerQuery:CATALOG_ROW_LIMIT,bytesPerQuery:CATALOG_QUERY_BYTES,bytesPerSnapshot:CATALOG_SNAPSHOT_BYTES}});
    const target=process.env.TRIAL_CATALOG_CAPTURE_DIRECTORY;
    if(target){
      const allowed=resolve("..","output","issue148","local-ready-20261012");
      if(!isAbsolute(target)||resolve(target)!==allowed)throw Error("capture_directory_invalid");
      await writeFile(join(target,"pg16-builtins.json"),catalogCanonical(builtins)+"\n",{flag:"wx"});
    }
  },120000);
  afterAll(async()=>{for(const client of clients)await client.end().catch(()=>undefined);await env?.cleanup();},60000);
  it("accepts the actual stock catalog and includes connectable template1",async()=>{
    const{snapshot,inventory}=await read(stock);
    expect(evaluateCatalogSnapshot(snapshot,builtins,plan,"before").status).toBe("verified");
    expect(freezeCatalogInventory(inventory,plan).audited.map(d=>d.datname)).toContain("template1");
  });
  it("accepts an ordinary business table and rejects PUBLIC column-only access without reading rows",async()=>{
    await env.sql("CREATE TABLE catalog_probe (secret_text text)");
    const password=(env.admin as unknown as {connectionParameters:{password:string}}).connectionParameters.password;
    const db=new Client({host:env.connection.host,port:env.connection.port,database:env.connection.database,user:"postgres",password,
      options:"-c search_path=pg_catalog -c default_transaction_read_only=on"});clients.push(db);await db.connect();
    const before=(await read(db)).snapshot;
    expect(evaluateCatalogSnapshot(before,builtins,plan,"before").status).toBe("verified");
    await env.sql("GRANT SELECT(secret_text) ON catalog_probe TO PUBLIC");
    const after=(await read(db)).snapshot;
    expect(()=>evaluateCatalogSnapshot(after,builtins,plan,"before")).toThrow("trial_catalog_unconfirmed");
    await env.sql("REVOKE SELECT(secret_text) ON catalog_probe FROM PUBLIC");
  });
  it("detects the non-superuser CREATE DATABASE OWNER requirement without adding privileges",async()=>{
    await env.sql("CREATE ROLE catalog_creator LOGIN CREATEDB CREATEROLE NOINHERIT PASSWORD 'fictional-catalog-fixture-only'");
    const client=new Client({host:env.connection.host,port:env.connection.port,database:"postgres",user:"catalog_creator",password:"fictional-catalog-fixture-only"});
    clients.push(client);await client.connect();
    await client.query("CREATE ROLE catalog_new_owner NOLOGIN NOINHERIT");
    const rows=(await client.query("SELECT m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname='catalog_new_owner' AND u.rolname='catalog_creator'")).rows;
    expect(rows).toEqual([{admin_option:true,inherit_option:false,set_option:false}]);
    await expect(client.query("CREATE DATABASE catalog_should_not_exist OWNER catalog_new_owner")).rejects.toMatchObject({code:"42501"});
    expect((await client.query("SELECT datname FROM pg_database WHERE datname='catalog_should_not_exist'")).rows).toEqual([]);
  });
});
