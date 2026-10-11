import { readFile, open, unlink, lstat, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Client } from "pg";
import { z } from "zod";
import { TrialError, TRIAL_END, type TrialPolicy } from "./policy";
import { trialHash,trialBinding } from "./ledger";
import { TRIAL_NETWORK_DDL,TRIAL_NETWORK_TABLE,TRIAL_ARM_REQUEST_LIMIT,TRIAL_ARM_RESERVED_BYTES,verifyTrialNetworkTable } from "./network-budget";
import { type OperatorAccess } from "./operator-access";
import { beginOperatorReceipt } from "./operator-journal";
import { connectPermitDatabase } from "./database-client";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
export const bootstrapManifestSchema = z.object({
  schema: z.literal(1), adminCatalog: z.literal("postgres"), adminUser: identifier,
  cases: z.array(z.object({ id: z.number().int().positive().max(2_147_483_646),
    title: z.string().regex(/^FICTIONAL TRIAL SAMPLE [1-9][0-9]*$/) }).strict()).min(1).max(5),
}).strict();
export const bootstrapCredentialsSchema = z.object({ adminUrl: z.string().max(8192),
  migratorPassword: z.string().min(16).max(256), webPassword: z.string().min(16).max(256), workerPassword: z.string().min(16).max(256),
}).strict().refine(v => [v.migratorPassword, v.webPassword, v.workerPassword].every(p => !/[\x00-\x1f\x7f]/.test(p)) &&
  new Set([v.migratorPassword, v.webPassword, v.workerPassword]).size === 3);
export type BootstrapManifest = z.infer<typeof bootstrapManifestSchema>;
export type BootstrapCredentials = z.infer<typeof bootstrapCredentialsSchema>;
type Connection = Awaited<ReturnType<typeof connectPermitDatabase>>;
type Credential = { getToken(): Promise<{ token: string }> };
const quote = (v: string) => '"' + identifier.parse(v) + '"';
// Passwords never enter argv, a receipt, an exception message or a returned plan.
const literal = (v: string) => "'" + v.replace(/'/g, "''") + "'";
const TABLES = ["cases", "comparison_results", "draft_patents", "prior_art_documents", "search_query_sets", "koho_import_documents", "koho_import_runs",
  "case_watch_findings", "case_watch_runs", "case_watch_settings", "managed_publication_claims", "managed_watch_deletions", "managed_watch_deliveries",
  "managed_watch_dispatches", "managed_watch_findings", "managed_watch_runs", "managed_watch_settings", "managed_distribution_snapshots", "managed_import_receipts",
  "managed_watch_job_starts", "managed_watch_backups"] as const;
const READ_TABLES = ["cases", "draft_patents", "prior_art_documents", "koho_import_documents", "koho_import_runs", "managed_publication_claims",
  "managed_import_receipts", "managed_distribution_snapshots", "managed_watch_settings", "managed_watch_runs", "managed_watch_dispatches", "managed_watch_findings", "managed_watch_deliveries"] as const;
// Normalize checkout line endings for source approval. Drizzle's actual stored
// hashes below remain the hashes of the exact files passed to its Node API.
const MIGRATION_HASHES = ["dc1bb0863395a82a7ef09c35aeceb2b42ac6f22e6b2c5e4e3fabe8116bd9e426", "16e4d07e15f538d3d7f1740debb679df06d0543cfdb526b27453db1e20670533",
  "d9592ecb48dd68ec141f16098d4b7f38a94b9a2cfa993c02ef06d1e70029c212", "bb4cb05a8410387712da5357af7019d50698d615d79ce858be43ba5ddec657ce",
  "66ca5e36ec241ef566e9185758c47ff4fbd708f80c3b44a35d76253f84c7acba", "a65483797bf6eab768d087a15ff7da4ea91b023c3e825c6a97809404c12f28fe",
  "fa1be65e0076897d56197d1077a68dc615350cd012dbc019a17cb49f424c2f74", "1b3e237092c9503cda002aaedcbc5540a2bd18c4a1f27ef5ae925930c4aa8b8b",
  "7a96df7b6d42f4b7e4c248e77446afc5506f1fdd266cb8e6577054413a97841a"] as const;
const MIGRATION_TIMES=[1779317966922,1787810352336,1788308618345,1790130246645,1790134041760,1790135478643,1790137307292,1790140467704,1790141320855];

/** Exact verified steps of this invocation. A catalog-verified outer migration
 * step may reconcile earlier SQL uncertainty; old inner unknown receipts are
 * retained unchanged and are not claimed to have received an acknowledgement. */
export async function collectTrialBootstrapReceipts(directory: string, binding: string, steps: string[]) {
  if (!/^[a-f0-9]{64}$/.test(binding) || !steps.length || steps.length > 512 || new Set(steps).size !== steps.length ||
    steps.some(step => !/^[A-Za-z0-9_-]{1,160}$/.test(step))) throw new TrialError("trial_bootstrap_receipt_invalid");
  const receipts: { name: string; sha256: string }[] = [];
  for (const step of steps) {
    const intent = trialHash(JSON.stringify({ operation: "trial-bootstrap-v1", binding, step }));
    const name = `operator-${intent}.jsonl`, path = join(directory, name), st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) throw new TrialError("trial_bootstrap_receipt_invalid");
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > 65536 || bytes.at(-1) !== 10) throw new TrialError("trial_bootstrap_receipt_invalid");
    const rows = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (rows.length < 2 || rows[0]?.schema !== 1 || rows[0]?.intent !== intent || rows[0]?.automaticResend !== false ||
      rows.at(-1)?.terminal !== "completed" || rows.some(row => row.intent !== undefined && (row.intent !== intent || row.automaticResend !== false)))
      throw new TrialError("trial_bootstrap_receipt_invalid");
    receipts.push({ name, sha256: trialHash(bytes) });
  }
  return receipts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** This is a Local-only fixed installer, not a SQL executor. Only the launcher
 * supplies the normal admin binding and existing dedicated credential material.
 * No secret generation, fallback target, DROP, shared ACL edit or admin GRANT. */
export async function bootstrapTrialDatabase(options: { policy: TrialPolicy; access: OperatorAccess;
  manifest: BootstrapManifest; credentials: BootstrapCredentials; recoveryDirectory: string;
  credential: Credential; mode: "apply" | "reconcile" }) {
  const { policy: p, access, recoveryDirectory: directory, credential, mode } = options;
  if(mode!=="apply"&&mode!=="reconcile")throw new TrialError("trial_bootstrap_binding_invalid");
  const manifest = bootstrapManifestSchema.parse(options.manifest), secrets = bootstrapCredentialsSchema.parse(options.credentials), d = p.database;
  const owner = identifier.parse(d.ownerRole), migrator = identifier.parse(d.migratorUser), web = identifier.parse(d.webUser), worker = identifier.parse(d.workerUser);
  const database = identifier.parse(d.database), roles = [owner, migrator, web, worker];
  const window = access.ticket.databaseWindow;
  if (!window || access.policy !== p || !p.localOperator || new Set(roles).size !== 4 || roles.includes(manifest.adminUser) || database === manifest.adminCatalog ||
    manifest.cases.some(c => c.title !== `FICTIONAL TRIAL SAMPLE ${c.id}`) || new Set(manifest.cases.map(c => c.id)).size !== manifest.cases.length ||
    [...manifest.cases.map(c => c.id)].sort((a,b)=>a-b).join() !== p.samples.map(c => c.caseId).sort((a,b)=>a-b).join()) throw new TrialError("trial_bootstrap_binding_invalid");
  let adminUrl:URL;
  try{adminUrl=new URL(secrets.adminUrl);}catch{throw new TrialError("trial_bootstrap_binding_invalid");}
  if (adminUrl.protocol !== "postgresql:" || adminUrl.hostname !== d.host || Number(adminUrl.port || 5432) !== 5432 ||
    decodeURIComponent(adminUrl.pathname.slice(1)) !== manifest.adminCatalog || decodeURIComponent(adminUrl.username) !== manifest.adminUser ||
    !adminUrl.password || adminUrl.search || adminUrl.hash || [secrets.migratorPassword,secrets.webPassword,secrets.workerPassword].includes(decodeURIComponent(adminUrl.password)))
    throw new TrialError("trial_bootstrap_binding_invalid");
  const migrationsFolder = resolve("drizzle"), migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length !== MIGRATION_HASHES.length || migrations.some((m, i) => m.folderMillis!==MIGRATION_TIMES[i] || trialHash(m.sql.join("--> statement-breakpoint").replace(/\r\n/g,"\n")) !== MIGRATION_HASHES[i])) throw new TrialError("trial_bootstrap_migrations_changed");
  // Stable across tickets, credentials and retries. A fresh ticket/password must
  // never produce a fresh intent for an already attempted CREATE.
  const binding = trialHash(JSON.stringify({ schema: 1, host: d.host, database, owner, migrator, web, worker,
    adminCatalog: manifest.adminCatalog, adminUser: manifest.adminUser }));
  if (!isAbsolute(directory) || trialHash(resolve(directory)) !== p.localOperator.recoveryDirectoryDigest) throw new TrialError("trial_operator_journal_unavailable");
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new TrialError("trial_operator_journal_unavailable");
  const lockPath = join(directory, `bootstrap-${binding}.lock`);
  let recoveredStaleLock = false;
  const startupPath=lockPath+".startup";
  let startup;
  try{startup=await open(startupPath,"wx",0o600);await startup.writeFile(JSON.stringify({schema:1,pid:process.pid})+'\n');await startup.sync();}
  catch{throw new TrialError("trial_bootstrap_locked");}
  let lock;
  try{
  // Recovery never steals a live (or access-denied/indeterminate) process lock.
  // A reused PID deliberately blocks. The startup mutex covers stale checking,
  // rename AND new lock acquisition, for apply and reconcile alike. A crashed
  // startup mutex is intentionally a manual-reconciliation stop, not stolen.
  if(mode === "reconcile"){
    try{
      const st=await lstat(lockPath);if(!st.isFile()||st.isSymbolicLink()||st.size>1024)throw new TrialError("trial_bootstrap_locked");
      const oldText=await readFile(lockPath,"utf8"),old=JSON.parse(oldText);
      if(old.schema!==1||!Number.isSafeInteger(old.pid)||old.pid<=0||old.pid===process.pid)throw new TrialError("trial_bootstrap_locked");
      try{process.kill(old.pid,0);throw new TrialError("trial_bootstrap_locked");}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw new TrialError("trial_bootstrap_locked");}
      const stale=lockPath+`.stale-${old.pid}`;
      try{await lstat(stale);throw new TrialError("trial_bootstrap_locked");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      const checkStat=await lstat(lockPath);
      if(checkStat.ino!==st.ino||checkStat.birthtimeMs!==st.birthtimeMs||checkStat.mtimeMs!==st.mtimeMs||checkStat.size!==st.size||
        await readFile(lockPath,"utf8")!==oldText)throw new TrialError("trial_bootstrap_locked");
      await rename(lockPath,stale);recoveredStaleLock=true;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(JSON.stringify({schema:1,pid:process.pid,automaticResend:false})+'\n'); await lock.sync(); }
  catch { throw new TrialError("trial_bootstrap_locked"); }
  }finally{await startup.close();await unlink(startupPath);}
  const connections: Connection[] = [];
  const connected = new Map<string, Client>();
  const now = () => Date.parse(access.ticket.endsAt) - access.check(0);
  const check = () => { access.check(35_000); if (access.signal.aborted || now() + 5_000 >= Date.parse(window.useUntil)) throw new TrialError("trial_bootstrap_window_expired"); };
  const connect = async (user: string, db: string, password?: string) => {
    check();
    const key = `${user}/${db}`, old = connected.get(key); if (old) return old;
    if(connections.length>=4)throw new TrialError("trial_bootstrap_connection_limit");
    const url = new URL(adminUrl.href); url.pathname = `/${db}`; url.username = encodeURIComponent(user);
    if (password !== undefined) url.password = encodeURIComponent(password);
    const connection = await connectPermitDatabase({ url: url.href, host: d.host, database: db, user }, access, credential);
    connections.push(connection);connected.set(key,connection.client); return connection.client;
  };
  const verifiedSteps = new Set<string>();
  const request = (step: string) => ({ operation: "trial-bootstrap-v1", binding, step });
  const removeOrphanStepLock = async(id:string)=>{
    if(!recoveredStaleLock)return;
    const path=join(directory,`operator-${trialHash(JSON.stringify(request(id)))}.jsonl.lock`);
    try{const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size!==0)throw new TrialError("trial_bootstrap_locked");await unlink(path);}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  };
  const state = async (step: string): Promise<"absent" | "unknown" | "completed"> => {
    const file = join(directory, `operator-${trialHash(JSON.stringify(request(step)))}.jsonl`);
    try {
      const st = await lstat(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) throw new TrialError();
      const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (lines[0]?.intent !== trialHash(JSON.stringify(request(step))) || lines[0]?.automaticResend !== false) throw new TrialError();
      return lines.some(line => line.terminal === "completed") ? "completed" : "unknown";
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw new TrialError("trial_bootstrap_receipt_invalid"); }
  };
  const step = async (id: string, write: () => Promise<unknown>, verify: () => Promise<boolean>) => {
    check(); const prior = await state(id);
    if (prior === "completed") { if (!await verify()) throw new TrialError("trial_bootstrap_readback_mismatch"); verifiedSteps.add(id); return; }
    if (prior === "unknown" || mode === "reconcile") {
      if (prior === "absent" || !await verify()) throw new TrialError("trial_bootstrap_reconciliation_required");
      if (mode !== "reconcile") throw new TrialError("trial_bootstrap_reconciliation_required");
      await removeOrphanStepLock(id);
      const receipt = await beginOperatorReceipt(directory, p.localOperator!.recoveryDirectoryDigest, access.ticket, request(id), true);
      await receipt.finish(true); verifiedSteps.add(id); return;
    }
    const receipt = await beginOperatorReceipt(directory, p.localOperator!.recoveryDirectoryDigest, access.ticket, request(id));
    let complete = false;
    try { check(); await write(); complete = await verify(); if (!complete) throw new TrialError("trial_bootstrap_readback_mismatch"); }
    finally { await receipt.finish(complete); }
    verifiedSteps.add(id);
  };
  const readRole = async (client: Client, user: string) => (await client.query(
    "select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolconnlimit,rolvaliduntil,rolconfig from pg_roles where rolname=$1", [user])).rows[0];
  const roleValid = async (client: Client, user: string, login: boolean, until: string | null, limit: number) => {
    const row = await readRole(client,user);
    return Boolean(row && row.rolcanlogin === login && !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolreplication && !row.rolbypassrls &&
      !row.rolinherit && row.rolconnlimit === limit && row.rolconfig === null && (until === null ? row.rolvaliduntil === null : new Date(row.rolvaliduntil).getTime() === Date.parse(until)));
  };
  let activeStep = "preflight";
  try {
    const admin = await connect(manifest.adminUser, manifest.adminCatalog);
    const version = (await admin.query("select current_setting('server_version_num')::int / 10000 as major,current_setting('standard_conforming_strings') as strings")).rows[0];
    if (version.major !== 16 || version.strings !== "on") throw new TrialError("trial_bootstrap_server_invalid");
    const existing = (await admin.query("select rolname from pg_roles where rolname=any($1::text[])", [roles])).rows;
    for (const row of existing) if (await state(`role-${roles.indexOf(row.rolname)}`) === "absent") throw new TrialError("trial_bootstrap_name_occupied");
    const dbRow = async () => (await admin.query("select pg_get_userbyid(datdba) as owner,datistemplate,datallowconn,datconnlimit,pg_encoding_to_char(encoding) as encoding from pg_database where datname=$1", [database])).rows[0];
    if (await dbRow() && await state("database") === "absent") throw new TrialError("trial_bootstrap_name_occupied");
    // This catalog is the admin catalog only. Cross-database business ACL
    // evidence remains a separate launcher preflight; CONNECT/TEMP alone is not failure.
    const hazards = (await admin.query(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace,
      lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a
      where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema' and c.relkind in ('r','p','v','m','S','f') and a.grantee=0`)).rows[0];
    const columnHazards=(await admin.query(`select count(*)::int as n from pg_attribute col join pg_class c on c.oid=col.attrelid join pg_namespace n on n.oid=c.relnamespace,
      lateral aclexplode(col.attacl) a where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema' and col.attnum>0 and not col.attisdropped and a.grantee=0`)).rows[0];
    const escalation = (await admin.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.prosecdef and a.grantee=0 and a.privilege_type='EXECUTE'
      and left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'`)).rows[0];
    if (hazards.n !== 0 || columnHazards.n!==0 || escalation.n !== 0) throw new TrialError("trial_bootstrap_shared_acl_hazard");
    const expiry = [null, window.useUntil, TRIAL_END, TRIAL_END], passwords = [null,secrets.migratorPassword,secrets.webPassword,secrets.workerPassword], limits = [-1,1,3,1];
    for (let i=0;i<roles.length;i++) {
      activeStep = `role-${i}`;
      // Readback of a password is impossible: an unknown CREATE LOGIN is not
      // resolved by mere existence. Only a fixed-credential T-DB login can prove it.
      const verify = async () => {
        if (!await roleValid(admin,roles[i],i!==0,expiry[i],limits[i])) return false;
        if (i!==0 && await state(activeStep)==="unknown") {
          if (!await dbRow()) return false;
          const proof = await connect(roles[i],database,passwords[i]!);
          await proof.query("select current_user");
        }
        return true;
      };
      let acknowledged = false;
      await step(activeStep, async () => {
        await admin.query(`CREATE ROLE ${quote(roles[i])} ${i===0?"NOLOGIN":`LOGIN PASSWORD ${literal(passwords[i]!)} VALID UNTIL ${literal(expiry[i]!)}`} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT ${limits[i]}`);
        acknowledged=true;
      }, async()=> acknowledged ? roleValid(admin,roles[i],i!==0,expiry[i],limits[i]) : verify());
    }
    activeStep = "membership";
    const membershipValid = async () => {
      const rows=(await admin.query(`select pg_get_userbyid(roleid) as role,pg_get_userbyid(member) as member,admin_option,inherit_option,set_option
        from pg_auth_members where roleid=(select oid from pg_roles where rolname=$1) and member=(select oid from pg_roles where rolname=$2)`,[owner,migrator])).rows;
      return rows.length===1 && !rows[0].admin_option && !rows[0].inherit_option && rows[0].set_option;
    };
    await step(activeStep,()=>admin.query(`GRANT ${quote(owner)} TO ${quote(migrator)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`),membershipValid);
    const roleHazards=(await admin.query(`select count(*)::int as n from pg_auth_members where member=any(select oid from pg_roles where rolname=any($1::text[]))
      and not(member=(select oid from pg_roles where rolname=$2) and roleid=(select oid from pg_roles where rolname=$3) and not admin_option and not inherit_option and set_option)`,[roles,migrator,owner])).rows[0];
    if(roleHazards.n!==0)throw new TrialError("trial_bootstrap_membership_hazard");
    activeStep="database";
    await step(activeStep,()=>admin.query(`CREATE DATABASE ${quote(database)} OWNER ${quote(owner)} TEMPLATE template0 ENCODING 'UTF8' CONNECTION LIMIT 5`),async()=>{
      const r=await dbRow();return Boolean(r&&r.owner===owner&&!r.datistemplate&&r.datallowconn&&r.datconnlimit===5&&r.encoding==="UTF8");
    });
    // CONNECT grants precede PUBLIC revocation; all ACL targets are the new DB.
    for(const user of [migrator,web,worker]) {
      activeStep=`connect-${roles.indexOf(user)}`;
      await step(activeStep,()=>admin.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(user)}`),async()=>Boolean((await admin.query(
        "select exists(select 1 from pg_database d,lateral aclexplode(d.datacl) a where d.datname=$1 and a.grantee=(select oid from pg_roles where rolname=$2) and a.privilege_type='CONNECT' and not a.is_grantable) as ok",[database,user])).rows[0].ok));
    }
    activeStep="database-public";
    await step(activeStep,()=>admin.query(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`),async()=>!(await admin.query(
      "select exists(select 1 from pg_database d,lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a where d.datname=$1 and a.grantee=0) as bad",[database])).rows[0].bad);
    const client=await connect(migrator,database,secrets.migratorPassword);
    await client.query(`SET ROLE ${quote(owner)}`);
    const ddl = async(id:string,sql:string,verify:()=>Promise<boolean>)=>{activeStep=id;await step(id,()=>client.query(sql),verify);};
    await ddl("public-schema", "REVOKE ALL ON SCHEMA public FROM PUBLIC",async()=>!(await client.query(
      "select exists(select 1 from pg_namespace n,lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where n.nspname='public' and a.grantee=0) as bad")).rows[0].bad);
    activeStep="migrations";
    const migrationValid=async()=>{
      if(!(await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present")).rows[0].present)return false;
      const rows=(await client.query("select hash,created_at from drizzle.__drizzle_migrations order by created_at")).rows;
      if(rows.length!==migrations.length||rows.some((r,i)=>r.hash!==migrations[i].hash||Number(r.created_at)!==migrations[i].folderMillis))return false;
      const objects=(await client.query("select c.relname,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname<>$1 order by c.relname",[TRIAL_NETWORK_TABLE])).rows;
      return objects.length===TABLES.length&&objects.every(o=>TABLES.includes(o.relname)&&o.owner===owner);
    };
    await step(activeStep,async()=>{
      let n=0, inflight=false;
      const fixedStatements=new Set(migrations.flatMap(m=>m.sql.map(sql=>sql.replace(/\r\n/g,"\n"))));
      const scaffold=new Set(['CREATE SCHEMA IF NOT EXISTS "drizzle"',
        'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" ( id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint )',"begin","commit"]);
      // Drizzle receives this exact guarded client adapter, never a Pool or URL.
      const adapter={query:async(...args:unknown[])=>{
        if(inflight)throw new TrialError("trial_bootstrap_concurrent_query");inflight=true;
        try{
          const text=typeof args[0]==="string"?args[0]:(args[0] as {text:string}).text;
          const normalized=text.trim().replace(/\s+/g," "),params=(args[1]??[]) as unknown[];
          const select=normalized==='select id, hash, created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1';
          const metadata=normalized==='insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values($1, $2)'&&
            params.length===2&&migrations.some(m=>params[0]===m.hash&&params[1]===m.folderMillis);
          const rollback=normalized==="rollback";
          if(!metadata&&!(params.length===0&&(select||rollback||scaffold.has(normalized)||fixedStatements.has(text.replace(/\r\n/g,"\n")))))
            throw new TrialError("trial_bootstrap_migration_statement_denied");
          if(select||rollback)return await Reflect.apply(client.query,client,args);
          check();const id=`migration-statement-${n++}-${trialHash(text)}`;
          const receipt=await beginOperatorReceipt(directory,p.localOperator!.recoveryDirectoryDigest,access.ticket,request(id));
          let ack=false;try{check();const result=await Reflect.apply(client.query,client,args);ack=true;return result;}finally{await receipt.finish(ack);if(ack)verifiedSteps.add(id);}
        }finally{inflight=false;}
      }};
      await migrate(drizzle(adapter as unknown as Client),{migrationsFolder});
    },migrationValid);
    // Trial-only durable communication accounting. Standard migrations and
    // production schemas remain unchanged. Each DDL/seed has the same no-resend
    // intent/readback discipline as the rest of this fixed installer.
    await ddl("network-budget-table",TRIAL_NETWORK_DDL,()=>verifyTrialNetworkTable(client,owner));
    await ddl("network-budget-seed",`INSERT INTO public.trial_network_budget(binding,service,slot,purpose,method,request_bytes,response_limit)
      VALUES (${literal(trialBinding(p))},'blob',0,'quota','QUOTA',0,0),(${literal(trialBinding(p))},'arm',0,'quota','QUOTA',0,0)`,async()=>{
      const rows=(await client.query("select service,requests,reserved_bytes from public.trial_network_budget where binding=$1 and slot=0 order by service",[trialBinding(p)])).rows;
      return rows.length===2&&rows[0].service==="arm"&&rows[1].service==="blob"&&rows.every(r=>Number.isSafeInteger(r.requests)&&r.requests>=0&&r.requests<=(r.service==="arm"?TRIAL_ARM_REQUEST_LIMIT:3403)&&Number(r.reserved_bytes)>=0&&Number(r.reserved_bytes)<=(r.service==="arm"?TRIAL_ARM_RESERVED_BYTES:32*1024**3));
    });
    // Defaults apply solely to objects created by this new owner inside T-DB.
    for(const kind of ["TABLES","SEQUENCES","FUNCTIONS"] as const) await ddl(`defaults-${kind}`,`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner)} REVOKE ALL ON ${kind} FROM PUBLIC`,async()=>{
      const k=kind==="TABLES"?"r":kind==="SEQUENCES"?"S":"f";
      const r=(await client.query("select defaclacl from pg_default_acl where defaclrole=(select oid from pg_roles where rolname=$1) and defaclobjtype=$2 and defaclnamespace=0",[owner,k])).rows[0];
      // An absent default for tables/sequences is already private; functions default EXECUTE is not.
      if(!r)return kind!=="FUNCTIONS";
      return !(await client.query("select exists(select 1 from pg_default_acl d,lateral aclexplode(d.defaclacl) a where d.defaclrole=(select oid from pg_roles where rolname=$1) and d.defaclobjtype=$2 and a.grantee=0) as bad",[owner,k])).rows[0].bad;
    });
    const grants:{user:string;kind:"TABLE"|"SEQUENCE"|"SCHEMA";object:string;privileges:string}[]=[];
    for(const user of [web,worker]){
      grants.push({user,kind:"SCHEMA",object:"public",privileges:"USAGE"});
      for(const table of READ_TABLES)grants.push({user,kind:"TABLE",object:table,privileges:"SELECT"});
    }
    const add=(user:string,object:string,privileges:string)=>grants.push({user,kind:"TABLE",object,privileges});
    for(const user of [web,worker])add(user,TRIAL_NETWORK_TABLE,"SELECT, INSERT, UPDATE (requests, reserved_bytes, observed_bytes, http_status)");
    add(web,"cases","INSERT, UPDATE (title, updated_at)");
    add(web,"draft_patents","INSERT, UPDATE (extracted_claims_json)");
    add(web,"managed_watch_runs","INSERT");
    add(web,"managed_watch_runs","UPDATE (status, error_code, completed_at)");
    add(web,"managed_distribution_snapshots","INSERT");
    add(web,"managed_watch_findings","UPDATE (review_status, review_version)");
    add(web,"managed_watch_deliveries","INSERT, UPDATE (status, blob_manifest_json)");
    add(worker,"managed_watch_runs","UPDATE");add(worker,"managed_watch_dispatches","INSERT, UPDATE");add(worker,"managed_watch_findings","INSERT");
    for(const [user,sequence] of [[web,"cases_case_id_seq"],[web,"draft_patents_draft_id_seq"],[worker,"managed_watch_dispatches_dispatch_id_seq"],[worker,"managed_watch_findings_finding_id_seq"]])
      grants.push({user,kind:"SEQUENCE",object:sequence,privileges:"USAGE"});
    for(let i=0;i<grants.length;i++){
      const g=grants[i],qualified=g.kind==="SCHEMA"?quote(g.object):`public.${quote(g.object)}`;
      await ddl(`grant-${i}`,`GRANT ${g.privileges} ON ${g.kind} ${qualified} TO ${quote(g.user)}`,async()=>{
        const permissions=g.privileges.split(/,\s*(?![^()]*\))/);
        for(const permission of permissions){
          const col=/^(\w+) \(([^)]+)\)$/.exec(permission);
          if(col){for(const column of col[2].split(/,\s*/))if(!(await client.query("select has_column_privilege($1,$2,$3,$4) as ok",[g.user,`public.${g.object}`,column,col[1]])).rows[0].ok)return false;}
          else if(!(await client.query(`select has_${g.kind==="TABLE"?"table":g.kind==="SCHEMA"?"schema":"sequence"}_privilege($1,$2,$3) as ok`,[g.user,g.kind==="SCHEMA"?g.object:`public.${g.object}`,permission])).rows[0].ok)return false;
        }return true;
      });
    }
    const existingCases=(await client.query("select case_id from public.cases order by case_id limit 6")).rows;
    if(existingCases.length>5||existingCases.some(c=>!manifest.cases.some(expected=>expected.id===c.case_id)))throw new TrialError("trial_bootstrap_cases_already_used");
    for(const c of manifest.cases){
      activeStep=`case-${c.id}`;
      await step(activeStep,()=>client.query("insert into public.cases(case_id,title) values($1,$2)",[c.id,c.title]),async()=>{
        const rows=(await client.query("select case_id,title,status,base_application_mode from public.cases where case_id=$1",[c.id])).rows;
        return rows.length===1&&rows[0].title===c.title&&rows[0].status==="draft"&&rows[0].base_application_mode===false;
      });
    }
    activeStep="case-sequence";
    const next=Math.max(...manifest.cases.map(c=>c.id))+1;
    await step(activeStep,()=>client.query("select setval('public.cases_case_id_seq',$1,false)",[next]),async()=>{
      const r=(await client.query("select last_value,is_called from public.cases_case_id_seq")).rows[0];return Number(r.last_value)===next&&!r.is_called;
    });
    // Negative checks are catalog privilege checks, not destructive probe DDL.
    for(const [user,password] of [[web,secrets.webPassword],[worker,secrets.workerPassword]]){
      const runtime=await connect(user,database,password);
      const bad=(await runtime.query(`select has_database_privilege(current_user,current_database(),'CREATE') as dbcreate,
        has_schema_privilege(current_user,'public','CREATE') as schemacreate,
        exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle')
          and (pg_get_userbyid(c.relowner)=current_user or (c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES')))) as destructive`)).rows[0];
      if(bad.dbcreate||bad.schemacreate||bad.destructive)throw new TrialError("trial_bootstrap_runtime_acl_invalid");
    }
    const size=Number((await client.query("select pg_database_size(current_database()) as bytes")).rows[0].bytes);
    if(!Number.isSafeInteger(size)||size<0)throw new TrialError("trial_bootstrap_size_unconfirmed");
    return{status:mode==="apply"?"bootstrapped":"reconciled",databaseBaselineBytes:size,cases:manifest.cases.length,
      requiresExternalBusinessAclAudit:true,automaticResend:false,
      receipts:await collectTrialBootstrapReceipts(directory,binding,[...verifiedSteps])} as const;
  }catch(e){
    // Do not attach a pg error/cause: it may contain SQL, password or a target.
    throw new TrialError(e instanceof TrialError ? e.code : `trial_bootstrap_failed_${activeStep.replace(/[^a-zA-Z0-9_-]/g,"")}`);
  }finally{
    try {for(const connection of connections.reverse())await connection.close();}
    finally{await lock.close();await unlink(lockPath);}
  }
}
