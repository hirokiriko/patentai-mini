import { Client } from "pg";
import { assertTrialDatabase, readTrialPolicy, trialConfigured } from "./trial/policy";

export async function checkDatabaseHealth(): Promise<boolean> {
  if (trialConfigured()) {
    // Trial health is a minimal process/configuration check, not a new DB connection.
    try { assertTrialDatabase(readTrialPolicy(), process.env.DATABASE_URL); return true; } catch { return false; }
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return false;

  let client: Client | undefined;
  let healthy = false;
  let driverError = false;

  try {
    client = new Client({
      connectionString,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
      query_timeout: 3000,
    });
    // Keep the listener on this disposable client for late/repeated errors,
    // including errors after a failed end(). Never retain the error value.
    client.on("error", () => { driverError = true; });
    await client.connect();
    if (!driverError) {
      const result = await client.query("SELECT 1 AS ok");
      const rows = result?.rows;
      healthy = Array.isArray(rows) && rows.length === 1 && rows[0]?.ok === 1;
    }
  } catch {
    healthy = false;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        healthy = false;
      }
    }
  }

  return healthy && !driverError;
}
