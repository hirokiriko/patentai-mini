import { OperatorAccess, operatorTicketSchema, type AccessClock, type DatabaseAccess, type OperatorTicket } from "./operator-access";
import { readTrialPolicy, TrialError, type TrialPolicy } from "./policy";

/** Verifies the original signed ticket without possessing a signing key. The
 * actual guardian window is an additional restriction, not a replacement signed
 * operator ticket. This object has no storage/ARM/operator methods. */
export class CatalogAccess implements DatabaseAccess {
  readonly ticket: OperatorTicket;
  readonly policy: TrialPolicy;
  readonly signal: AbortSignal;
  private readonly original: OperatorAccess;
  constructor(environment: Record<string, string>, ticket: unknown, window: unknown, signal: AbortSignal, clock?: AccessClock) {
    this.policy = readTrialPolicy(environment);
    const signed = operatorTicketSchema.parse(ticket);
    const actual = operatorTicketSchema.shape.databaseWindow.unwrap().parse(window), prior = signed.databaseWindow;
    this.original = new OperatorAccess(signed, this.policy, clock);
    try {
      if (!prior || this.policy.phase !== "initial" || !this.policy.cost ||
        (["lifecycleId", "guardianNonce", "ruleId", "journalUrl"] as const).some(k => prior[k] !== actual[k])) throw new TrialError();
      const start = Date.parse(actual.jobStartedAt), end = Date.parse(actual.useUntil);
      if (end - start !== 600_000 || start < Date.parse(this.policy.startsAt) || end > Date.parse(this.policy.endsAt) ||
        start < Date.parse(signed.startsAt) || end > Date.parse(signed.endsAt)) throw new TrialError();
      this.ticket = Object.freeze({ ...signed, databaseWindow: Object.freeze(actual) });
      this.signal = AbortSignal.any([signal, this.original.signal]);
      this.check(0);
    } catch {
      this.original.dispose();
      throw new TrialError("trial_catalog_access_invalid");
    }
  }
  check(requiredMs = 20_000) {
    const remaining = this.original.check(requiredMs), now = Date.parse(this.ticket.endsAt) - remaining;
    const window = this.ticket.databaseWindow!;
    if (this.signal.aborted || now < Date.parse(window.jobStartedAt) || now + requiredMs >= Date.parse(window.useUntil))
      throw new TrialError("trial_catalog_access_expired");
    // DatabasePermit derives its monotonic current time from the OWNER end.
    return remaining;
  }
  dispose() { this.original.dispose(); }
}
