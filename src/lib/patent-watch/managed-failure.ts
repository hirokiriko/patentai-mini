import { ManagedClaimsError } from "./managed-claims";
import { ManagedWatchError } from "./managed-types";

const phases = ["no_change", "screening_input", "screening_request", "screening_selection", "screening_save", "detail_request", "detail_save", "finalize"] as const;
export type ManagedFailurePhase = typeof phases[number];
const reasons = new Set(["schema", "pair_unknown", "pair_duplicate", "pair_missing", "evidence_claim", "evidence_bounds", "evidence_quote", "surrogate_boundary"]);
const codes = new Set(["claims_missing", "claims_invalid", "reference_missing", "coverage_invalid", "split_limit", "invalid_setting", "not_found", "unavailable", "in_progress", "limit", "incomplete", "outcome_unknown", "expired", "conflict"]);

/** Persist only finite internal classifications. Never inspect an exception's
 * message, stack, SDK payload, source text or credential-bearing cause. */
export function managedFailureCode(phase: ManagedFailurePhase, error: unknown): string {
  if (!phases.includes(phase)) return "incomplete";
  let reason = "unclassified";
  try {
    const claimsError = error instanceof ManagedClaimsError;
    if (claimsError || error instanceof ManagedWatchError) {
      // Read each own data property once; diagnostic accessors must never run.
      const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
      const detail: unknown = Object.getOwnPropertyDescriptor(error, "reason")?.value;
      if (claimsError && code === "coverage_invalid" && typeof detail === "string" && reasons.has(detail)) reason = detail;
      else if (typeof code === "string" && codes.has(code)) reason = code;
    }
  } catch { /* Hostile exception proxies cannot prevent recording the failure. */ }
  return `incomplete:${phase}:${reason}`;
}

export function isManagedFailureCode(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts[0] === "incomplete" && phases.includes(parts[1] as ManagedFailurePhase) &&
    (parts[2] === "unclassified" || reasons.has(parts[2]) || codes.has(parts[2]));
}
