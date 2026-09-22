import { parsePatentWatchDiagnostic, type PatentWatchDiagnostic } from "./diagnostic";

const phases = ["before_dispatch", "awaiting_response", "reading_response", "validating_response", "response_validated", "unknown"] as const;
type Phase = typeof phases[number];
const numbers = ["candidateCount", "independentClaimCount", "requestBytes", "attempt", "stageElapsedMs", "requestElapsedMs", "phaseElapsedMs"] as const;
export type PatentWatchDiagnosticObservation = {
  id: string; stage: "detail"; phase: Phase;
} & Record<typeof numbers[number], number | null>;

/** Project data properties only; optional diagnostics never invoke accessors. */
export function parsePatentWatchDiagnosticObservation(value: unknown, diagnostic: PatentWatchDiagnostic): PatentWatchDiagnosticObservation | null {
  try {
    const parent = parsePatentWatchDiagnostic(diagnostic);
    if (!value || typeof value !== "object" || Array.isArray(value) || !parent || parent.stage !== "detail") return null;
    const keys = ["id", "stage", "phase", ...numbers];
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => !descriptors[key] || !("value" in descriptors[key]))) return null;
    const id = descriptors.id.value, stage = descriptors.stage.value, phase = descriptors.phase.value;
    if (id !== parent.id || stage !== "detail" || !phases.some(item => item === phase)) return null;
    const result: PatentWatchDiagnosticObservation = { id, stage, phase, candidateCount: null, independentClaimCount: null,
      requestBytes: null, attempt: null, stageElapsedMs: null, requestElapsedMs: null, phaseElapsedMs: null };
    for (const key of numbers) {
      const number = descriptors[key].value;
      if (number !== null && (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)) return null;
      result[key] = number;
    }
    return result;
  } catch { return null; }
}

export function observationNow(): number | null {
  try { const now = performance.now(); return Number.isFinite(now) && now >= 0 ? now : null; } catch { return null; }
}
function elapsed(start: number | null, now: number | null): number | null {
  if (start === null || now === null || now < start) return null;
  const value = Math.floor(now - start);
  return Number.isSafeInteger(value) ? value : null;
}

/** Numeric checkpoints only. No body, response, timer, or extra I/O is retained. */
export function createDetailObservation(id: string, stageStart: number | null, candidateCount: number, independentClaimCount: number, active: () => boolean) {
  let phase: Phase = "before_dispatch", phaseStart = observationNow(), requestStart: number | null = null;
  let requestBytes: number | null = null, attempt: number | null = null;
  let frozen: PatentWatchDiagnosticObservation | null = null;
  return {
    bytes(value: number) { if (!frozen && active()) requestBytes = value; },
    dispatch(value: number) {
      if (frozen || !active()) return;
      attempt = value; requestStart = observationNow(); phaseStart = requestStart; phase = "awaiting_response";
    },
    phase(value: Phase) {
      if (frozen || !active()) return;
      phase = value; phaseStart = observationNow();
    },
    snapshot() {
      if (frozen) return frozen;
      const now = observationNow();
      return parsePatentWatchDiagnosticObservation({ id, stage: "detail", phase, candidateCount, independentClaimCount,
        requestBytes, attempt, stageElapsedMs: elapsed(stageStart, now), requestElapsedMs: elapsed(requestStart, now),
        phaseElapsedMs: elapsed(phaseStart, now) }, { id, stage: "detail", reason: "unknown" });
    },
    freeze() { frozen ??= this.snapshot(); return frozen; },
  };
}
export type DetailObservation = ReturnType<typeof createDetailObservation>;
