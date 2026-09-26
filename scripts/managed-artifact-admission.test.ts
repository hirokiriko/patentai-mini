import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedBackupRepository } from "../src/repositories/managed-backup";
import type { ManagedDatabase } from "../src/repositories/managed-case-graph";
import type { ManagedArchiveStorage } from "../src/lib/patent-watch/managed-archive-storage";
import { restoreManagedBackup } from "./managed-watch-restore";
const fixture=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("./watch-report-local.test-support",()=>({isolatedPg16:fixture.create}));
afterEach(()=>vi.resetAllMocks());
it.each(["refused","lost-ack","expired"])("stops backup before transaction or Blob IO on %s",async mode=>{
  const transaction=vi.fn(),read=vi.fn(),writeBackup=vi.fn(),withDeadline=vi.fn();
  const storage={location:"https://fictional.blob.core.windows.net/private",read,writeBackup,withDeadline};
  const controller=new AbortController(),admit=vi.fn(async()=>{if(mode==="expired")controller.abort();else throw Error("reconciliation_required");});
  const repository=new ManagedBackupRepository({transaction} as unknown as ManagedDatabase,storage as unknown as ManagedArchiveStorage,admit);
  await expect(repository.create(1,randomUUID(),controller.signal)).rejects.toThrow();
  expect(admit).toHaveBeenCalledTimes(1);
  for(const call of [transaction,read,writeBackup,withDeadline])expect(call).not.toHaveBeenCalled();
});
it.each(["refused","lost-ack","expired"])("stops restore before cloud reads and Docker on %s",async mode=>{
  const backupId=randomUUID(),operationId=randomUUID(),metadata=vi.fn(async()=>({status:"stored",sha256:"a".repeat(64),bytes:100})),read=vi.fn();
  const controller=new AbortController(),admit=vi.fn(async()=>{if(mode==="expired")controller.abort();else throw Error("reconciliation_required");});
  const repository={metadata,read,location:"https://fictional.blob.core.windows.net/private"} as unknown as ManagedBackupRepository;
  await expect(restoreManagedBackup(repository,1,backupId,operationId,controller.signal,admit)).rejects.toThrow();
  expect(admit).toHaveBeenCalledExactlyOnceWith({kind:"recovery",caseId:1,backupId,recoveryOperationId:operationId,sha256:"a".repeat(64),bytes:100},repository.location,controller.signal);
  expect(read).not.toHaveBeenCalled();expect(fixture.create).not.toHaveBeenCalled();
});
it("rejects changed recovery metadata before creating the isolated database",async()=>{
  const repository={location:"https://fictional.blob.core.windows.net/private",
    metadata:vi.fn(async()=>({status:"stored",sha256:"a".repeat(64),bytes:100})),
    read:vi.fn(async()=>({row:{status:"stored",sha256:"b".repeat(64),bytes:100}}))} as unknown as ManagedBackupRepository;
  await expect(restoreManagedBackup(repository,1,randomUUID(),randomUUID(),AbortSignal.timeout(90_000),async()=>undefined)).rejects.toThrow();
  expect(fixture.create).not.toHaveBeenCalled();
});
it("does not reuse a backup operation ID for recovery",async()=>{
  const backupId=randomUUID(),admit=vi.fn(),read=vi.fn();
  const repository={metadata:vi.fn(async()=>({status:"stored",sha256:"a".repeat(64),bytes:100})),read} as unknown as ManagedBackupRepository;
  await expect(restoreManagedBackup(repository,1,backupId,backupId,AbortSignal.timeout(90_000),admit)).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(fixture.create).not.toHaveBeenCalled();
});
