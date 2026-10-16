import { open, lstat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { trialHash } from "./ledger";
import { TrialError } from "./policy";
import type { OperatorTicket } from "./operator-access";

/** Owner-private directory is provisioned and ACL-checked by the Local launcher.
 * Never logs inputs, tokens, SQL, credentials, paths, or remote error bodies.
 * Exclusive creation is the durable no-resend gate even after process loss. */
export async function beginOperatorReceipt(directory: string, expectedDirectoryDigest: string, ticket: OperatorTicket, request: unknown, reconcile = false) {
  if (!isAbsolute(directory) || trialHash(resolve(directory)) !== expectedDirectoryDigest) throw new TrialError("trial_operator_journal_unavailable");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TrialError("trial_operator_journal_unavailable");
  const intent = trialHash(JSON.stringify(request));
  // Bind retries to the request, not a fresh ticket ID or a fresh storage key.
  const path = join(directory, `operator-${intent}.jsonl`);
  const lockPath = path + ".lock";
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new TrialError("trial_operator_journal_locked"); }
  let handle;
  try { handle = await open(path, reconcile ? "a" : "wx", 0o600); }
  catch { await lock.close(); await unlink(lockPath); throw new TrialError("trial_operator_reconciliation_required"); }
  const base = { schema: 1, intent, ticketDigest: trialHash(JSON.stringify(ticket)),
    startsAt: ticket.startsAt, endsAt: ticket.endsAt, status: "outcome_unknown", automaticResend: false };
  try { await handle.writeFile(JSON.stringify(base) + "\n"); await handle.sync(); }
  catch { await handle.close(); await lock.close(); await unlink(lockPath); throw new TrialError("trial_operator_journal_unavailable"); }
  return { async finish(completed: boolean) {
    // Unknown is written BEFORE network dispatch. A failed completion update stays unknown.
    try { if (completed) { await handle.writeFile('\n{"terminal":"completed"}\n'); await handle.sync(); } }
    finally { await handle.close(); await lock.close(); await unlink(lockPath); }
  }};
}
