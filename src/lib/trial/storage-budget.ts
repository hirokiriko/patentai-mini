import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { operatorTicketDigest, type OperatorAccess } from "./operator-access";
import { TrialError } from "./policy";

export const OWNER_STORAGE_REQUEST_LIMIT = 3_403;
export const OWNER_STORAGE_BODY_LIMIT = 4 * 1024 ** 2;
export const OWNER_STORAGE_RESERVED_BODY_LIMIT = 32 * 1024 ** 3;
const budgets = new Map<string, OwnerStorageBudget>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Limits = { requests?: number; reservedBodyBytes?: number };

/** One Local session, shared by all operator commands. Existing files are never
 * reopened/reset after process loss: the OWNER must reconcile the old session.
 * Directory privacy/ACL is a launcher prerequisite, as for operator receipts.
 * Reservations cover accepted application bodies, not transport/header bytes. */
export class OwnerStorageBudget {
  private readonly path: string;
  private readonly ticket: string;
  private readonly directoryDigest: string;
  private readonly requestLimit: number;
  private readonly byteLimit: number;
  private readonly fd: number;
  private requests = 0;
  private reservedBodyBytes = 0;
  private fileBytes = 0;
  private stopped = false;
  private closed = false;

  constructor(private readonly directory: string, access: OperatorAccess, limits: Limits = {}) {
    this.ticket = operatorTicketDigest(access.ticket);
    this.directoryDigest = access.policy.localOperator?.recoveryDirectoryDigest ?? "";
    this.requestLimit = limits.requests ?? OWNER_STORAGE_REQUEST_LIMIT;
    this.byteLimit = limits.reservedBodyBytes ?? OWNER_STORAGE_RESERVED_BODY_LIMIT;
    if (!Number.isSafeInteger(this.requestLimit) || this.requestLimit < 1 || this.requestLimit > OWNER_STORAGE_REQUEST_LIMIT ||
        !Number.isSafeInteger(this.byteLimit) || this.byteLimit < OWNER_STORAGE_BODY_LIMIT || this.byteLimit > OWNER_STORAGE_RESERVED_BODY_LIMIT)
      throw new TrialError("trial_owner_storage_budget_invalid");
    this.path = join(directory, "owner-storage-budget.jsonl");
    this.assertAccess(access);
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "wx", 0o600);
      this.fd = fd;
      this.append({ schema: 1, ticketDigest: this.ticket, requestLimit: this.requestLimit,
        bodyLimit: OWNER_STORAGE_BODY_LIMIT, reservedBodyLimit: this.byteLimit, automaticResume: false });
    } catch {
      this.stopped = true;
      if (fd !== undefined) try { closeSync(fd); } catch { /* retain the intent file */ }
      throw new TrialError("trial_owner_storage_budget_unavailable");
    }
  }

  private assertAccess(access: OperatorAccess) {
    access.check();
    if (!isAbsolute(this.directory) || resolve(this.directory) !== this.directory ||
        hash(this.directory) !== this.directoryDigest || access.policy.localOperator?.recoveryDirectoryDigest !== this.directoryDigest ||
        operatorTicketDigest(access.ticket) !== this.ticket) throw new TrialError("trial_owner_storage_budget_binding");
    try {
      const stat = lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    } catch { throw new TrialError("trial_owner_storage_budget_unavailable"); }
  }

  private append(record: object) {
    const stat = fstatSync(this.fd), pathStat = lstatSync(this.path);
    if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || stat.ino !== pathStat.ino ||
        stat.dev !== pathStat.dev || stat.size !== this.fileBytes) throw new Error("journal_changed");
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    writeFileSync(this.fd, bytes);
    fsyncSync(this.fd);
    this.fileBytes += bytes.length;
  }

  /** Called synchronously immediately before EACH actual SDK transport send,
   * including retries/challenges. Failure/unknown response never refunds it. */
  reserve(access: OperatorAccess, requestBodyBytes: number) {
    if (this.stopped) throw new TrialError("trial_owner_storage_budget_stopped");
    this.assertAccess(access);
    if (!Number.isSafeInteger(requestBodyBytes) || requestBodyBytes < 0 || requestBodyBytes > OWNER_STORAGE_BODY_LIMIT)
      throw new TrialError("trial_owner_storage_body_limit");
    const bytes = requestBodyBytes + OWNER_STORAGE_BODY_LIMIT;
    if (this.requests >= this.requestLimit || this.reservedBodyBytes + bytes > this.byteLimit)
      throw new TrialError("trial_owner_storage_budget_exhausted");
    // Consume in memory before append/fsync; a partial or failed journal write
    // permanently stops this object. A new process cannot reopen its file.
    this.requests++;
    this.reservedBodyBytes += bytes;
    try { this.append({ sequence: this.requests, requestBodyBytes, maximumResponseBytes: OWNER_STORAGE_BODY_LIMIT,
      reservedBodyBytes: this.reservedBodyBytes, outcome: "unknown_before_send" }); }
    catch { this.stopped = true; throw new TrialError("trial_owner_storage_budget_unavailable"); }
  }

  snapshot() { return { requests: this.requests, reservedBodyBytes: this.reservedBodyBytes, stopped: this.stopped }; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopped = true;
    try { closeSync(this.fd); } catch { throw new TrialError("trial_owner_storage_budget_unavailable"); }
  }
}

/** Reuses the first budget across commands in this one process. A changed
 * ticket/directory binding cannot create a fresh allowance in the same folder. */
export function ownerStorageBudget(directory: string, access: OperatorAccess, limits: Limits = {}) {
  if (!isAbsolute(directory)) throw new TrialError("trial_owner_storage_budget_binding");
  const canonical = resolve(directory);
  const existing = budgets.get(canonical);
  if (existing) {
    // A zero-byte reservation would consume quota, so compare the immutable
    // signed ticket and directory via a dedicated no-I/O factory key instead.
    if (factoryBindings.get(canonical) !== JSON.stringify([operatorTicketDigest(access.ticket), access.policy.localOperator?.recoveryDirectoryDigest, limits]))
      throw new TrialError("trial_owner_storage_budget_binding");
    return existing;
  }
  const budget = new OwnerStorageBudget(canonical, access, limits);
  budgets.set(canonical, budget);
  factoryBindings.set(canonical, JSON.stringify([operatorTicketDigest(access.ticket), access.policy.localOperator?.recoveryDirectoryDigest, limits]));
  return budget;
}
const factoryBindings = new Map<string, string>();
