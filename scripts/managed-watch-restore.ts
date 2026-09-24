import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { archiveCheck, archiveDigest, MANAGED_CASE_TABLES, readManagedCaseGraph } from "../src/repositories/managed-case-graph";
import { MANAGED_BACKUP_REFERENCES, parseManagedCaseBackup, type ManagedBackupRepository } from "../src/repositories/managed-backup";
import { configuredManagedArtifactAdmission } from "../src/lib/patent-watch/managed-artifact-budget";
import { managedArtifactIntentSchema, type ManagedArtifactAdmission } from "../src/lib/patent-watch/managed-artifact-contract";
import { archiveSha } from "../src/lib/patent-watch/managed-archive-storage";
import * as schema from "../src/db/schema";

/** Only creates a fresh loopback PG16 Docker fixture; accepts no database destination.
 * Input bytes must be the read-back from the private Storage backup, not the buffer
 * used by create(). This never reconnects to or writes to the production database. */
export async function restoreManagedBackup(repository: ManagedBackupRepository, caseId: number, backupId: string,
  recoveryOperationId: string, deadline: AbortSignal, admit: ManagedArtifactAdmission = configuredManagedArtifactAdmission()) {
  deadline.throwIfAborted();
  const metadata = await repository.metadata(caseId, backupId); archiveCheck(metadata.status === "stored");
  const intent = managedArtifactIntentSchema.parse({ kind: "recovery", caseId, backupId, recoveryOperationId, sha256: metadata.sha256, bytes: metadata.bytes });
  archiveCheck(recoveryOperationId !== backupId);
  await admit(intent, repository.location, deadline); deadline.throwIfAborted();
  const saved = await repository.read(caseId, backupId, deadline);
  archiveCheck(saved.row.status === "stored" && saved.row.sha256 === metadata.sha256 && saved.row.bytes === metadata.bytes);
  return verifyManagedBackupRestore(saved.bytes, metadata.sha256, caseId, backupId, deadline);
}
export async function verifyManagedBackupRestore(bytes: Buffer, sha256: string, caseId: number, backupId: string,
  deadline: AbortSignal = AbortSignal.timeout(5 * 60_000)) {
  deadline.throwIfAborted();
  const backup = parseManagedCaseBackup(bytes, sha256, caseId, backupId);
  deadline.throwIfAborted();
  const environment = await isolatedPg16(129, deadline);
  try {
    const tables = [...MANAGED_BACKUP_REFERENCES, ...MANAGED_CASE_TABLES];
    for (const [table] of tables) archiveCheck(Number((await environment.sql(`select count(*) as n from public.${table}`))[0].n) === 0);
    await environment.sql("begin");
    for (const [table, key] of tables) {
      deadline.throwIfAborted();
      const rows = backup.graph[table] ?? backup.references[table];
      const columns = (await environment.sql("select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by column_name", [table])).map(r => r.column_name);
      archiveCheck(rows.every(row => archiveDigest(Object.keys(row).sort()) === archiveDigest(columns)));
      if (rows.length) {
        await environment.sql(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`, [JSON.stringify(rows)]);
        const actual = (await environment.sql(`select to_jsonb(t) as row from public.${table} t order by ${key}`)).map(r => r.row);
        archiveCheck(archiveDigest(actual) === archiveDigest(rows));
      }
      const sequence = (await environment.sql("select pg_get_serial_sequence($1,$2) as name", [`public.${table}`, key]))[0].name;
      if (sequence) await environment.sql(`select setval($1::regclass,greatest(coalesce((select max(${key}) from public.${table}),1),1),exists(select 1 from public.${table}))`, [sequence]);
    }
    const database = drizzle(environment.admin, { schema });
    archiveCheck(archiveDigest(await readManagedCaseGraph(database, caseId)) === archiveDigest(backup.graph));
    await environment.sql("commit");
    const directory = join(environment.directory, "restored-artifacts"); await mkdir(directory);
    for (let i = 0; i < backup.artifacts.length; i++) {
      deadline.throwIfAborted();
      const artifact = backup.artifacts[i], file = join(directory, `${i}.bin`);
      await writeFile(file, Buffer.from(artifact.data, "base64"), { flag: "wx", signal: deadline });
      const readBack = await readFile(file, { signal: deadline }); archiveCheck(readBack.length === artifact.bytes && archiveSha(readBack) === artifact.sha256);
    }
    deadline.throwIfAborted();
    return { verified: true, caseId, backupId, databaseRows: Object.values(backup.graph).reduce((n, rows) => n + rows.length, 0), artifacts: backup.artifacts.length, missingArtifacts: backup.missingArtifacts.length, productionWrite: false };
  } finally { await environment.cleanup(); }
}
