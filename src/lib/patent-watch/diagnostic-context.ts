import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isPatentWatchErrorCode } from "./domain";
import { createDetailObservation, observationNow, parsePatentWatchDiagnosticObservation, type DetailObservation, type PatentWatchDiagnosticObservation } from "./diagnostic-observation";
import {
  PATENT_WATCH_DIAGNOSTIC_HEADER, parsePatentWatchDiagnostic,
  type PatentWatchDiagnostic, type PatentWatchStage, type PatentWatchStopReason,
} from "./diagnostic";

type Execution = { id: string; active: boolean; firstStop?: PatentWatchDiagnostic; observation?: PatentWatchDiagnosticObservation };
type Context = { execution: Execution; stage: PatentWatchStage; active: boolean;
  stageStart?: number | null; counts?: { candidateCount: number; independentClaimCount: number };
  observation?: DetailObservation; observationCount?: number };
const context = new AsyncLocalStorage<Context | undefined>();

export function observePatentWatchDetail(candidateCount: number, independentClaimCount: number): void {
  try {
    const current = context.getStore();
    if (current?.execution.active && current.active && current.stage === "detail") current.counts = { candidateCount, independentClaimCount };
  } catch { /* Optional observation cannot change analysis. */ }
}

export function currentPatentWatchDiagnosticObservation(): PatentWatchDiagnosticObservation | null {
  try {
    const current = context.getStore(), diagnostic = currentPatentWatchDiagnostic();
    return diagnostic ? parsePatentWatchDiagnosticObservation(current?.execution.observation, diagnostic) : null;
  } catch { return null; }
}

export function recordPatentWatchStop(reason: PatentWatchStopReason): void {
  capturePatentWatchDiagnostic()?.stop(reason);
}

export function currentPatentWatchDiagnostic(): PatentWatchDiagnostic | null {
  const current = context.getStore();
  if (!current?.execution.active) return null;
  return parsePatentWatchDiagnostic(current.execution.firstStop ?? {
    id: current.execution.id, stage: "unknown", reason: "unknown",
  });
}

export function capturePatentWatchDiagnostic() {
  const current = context.getStore();
  if (!current) return null;
  const { execution, stage } = current;
  return {
    active: () => execution.active && current.active,
    observation() {
      try {
        if (!execution.active || !current.active || stage !== "detail" || !current.counts) return null;
        const observation = createDetailObservation(execution.id, current.stageStart ?? null, current.counts.candidateCount,
          current.counts.independentClaimCount, () => execution.active && current.active);
        current.observationCount = (current.observationCount ?? 0) + 1;
        // The SDK reads the original response after the guard returns. Retain only
        // numeric checkpoints; omit ambiguous attribution if a stage has several calls.
        current.observation = current.observationCount === 1 ? observation : undefined;
        return observation;
      } catch { return null; }
    },
    stop(reason: PatentWatchStopReason, observation?: DetailObservation | null) {
      if (!execution.active || !current.active || execution.firstStop) return;
      const diagnostic = parsePatentWatchDiagnostic({ id: execution.id, stage, reason });
      if (diagnostic) {
        execution.firstStop = Object.freeze(diagnostic);
        try {
          const value = parsePatentWatchDiagnosticObservation((observation ?? current.observation)?.freeze(), diagnostic);
          if (value) execution.observation = Object.freeze(value);
        } catch { /* Keep the first reason even if observation fails. */ }
      }
    },
    usage(reason: PatentWatchStopReason) {
      if (!execution.active || !current.active) return {};
      const diagnostic = parsePatentWatchDiagnostic({ id: execution.id, stage, reason });
      return diagnostic ? { diagnosticId: diagnostic.id, stage, reason: diagnostic.reason } : {};
    },
  };
}

export function withPatentWatchStage<T>(stage: "screening" | "detail", operation: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current?.execution.active) return operation();
  const scope: Context = { execution: current.execution, stage, active: true, stageStart: observationNow() };
  return context.run(scope, async () => {
    try { return await operation(); } finally { scope.active = false; }
  });
}

/** One server-generated ID per HTTP execution; diagnostics never change its result. */
export async function withPatentWatchDiagnostic(
  operation: () => Promise<{ response: Response; code: string }>,
): Promise<Response> {
  let id: string;
  try { id = randomUUID(); } catch { return context.run(undefined, async () => (await operation()).response); }
  const execution: Execution = { id, active: true };
  return context.run({ execution, stage: "unknown", active: true }, async () => {
    try {
      const result = await operation();
      try { result.response.headers.set(PATENT_WATCH_DIAGNOSTIC_HEADER, id); } catch { /* optional */ }
      const diagnostic = currentPatentWatchDiagnostic();
      const diagnosticObservation = currentPatentWatchDiagnosticObservation();
      execution.active = false;
      try {
        if (diagnostic) console.info("patent_watch_diagnostic", JSON.stringify({
          diagnosticId: id,
          code: result.code === "completed" || isPatentWatchErrorCode(result.code) ? result.code : "watch_internal_error",
          stage: diagnostic.stage, reason: diagnostic.reason,
          ...(diagnosticObservation ? { diagnosticObservation } : {}),
        }));
      } catch { /* Observability cannot alter the business result. */ }
      return result.response;
    } finally { execution.active = false; }
  });
}
