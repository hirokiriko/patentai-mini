import { afterEach, expect, it, vi } from "vitest";
import { Client } from "pg";
import { managedArtifactDatabaseTarget } from "./managed-artifact-budget";
const url="postgresql://fictional_app:FICTIONAL_PASSWORD@fictional.postgres.database.azure.com:5432/fictional";
afterEach(()=>vi.unstubAllEnvs());
it("binds the same database identity that pg would use without connecting",()=>{
  const value=managedArtifactDatabaseTarget(url+"?sslmode=verify-full"),client=new Client({connectionString:url+"?sslmode=verify-full"});
  expect(value).toEqual({host:client.host,port:client.port,database:client.database,user:client.user});
});
it("checks the actual PGPORT fallback when the URL omits a port",()=>{
  vi.stubEnv("PGPORT","6432");
  expect(()=>managedArtifactDatabaseTarget(url.replace(":5432/","/"))).toThrow("managed_budget_stopped");
  expect(managedArtifactDatabaseTarget(url).port).toBe(5432);
  vi.stubEnv("PGPORT","5432");
  expect(managedArtifactDatabaseTarget(url.replace(":5432/","/")).port).toBe(5432);
});
it.each(["host=other.postgres.database.azure.com","user=other","port=6432","database=other","dbname=other",
  "options=-crole%3Dother","sslmode=no-verify","sslmode=require&sslmode=disable","hostaddr=127.0.0.1"])("rejects a query override %s without exposing credentials",query=>{
  expect(()=>managedArtifactDatabaseTarget(url+"?"+query)).toThrow("managed_budget_stopped");
});
