import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isPatentWatchErrorCode } from "./domain";
import {
  PATENT_WATCH_DIAGNOSTIC_HEADER, parsePatentWatchDiagnostic,
  type PatentWatchDiagnostic, type PatentWatchStage, type PatentWatchStopReason,
} from "./diagnostic";

type Execution = { id: string; active: boolean; firstStop?: PatentWatchDiagnostic };
type Context = { execution: Execution; stage: PatentWatchStage; active: boolean };
const context = new AsyncLocalStorage<Context | undefined>();

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
    stop(reason: PatentWatchStopReason) {
      if (!execution.active || !current.active || execution.firstStop) return;
      const diagnostic = parsePatentWatchDiagnostic({ id: execution.id, stage, reason });
      if (diagnostic) execution.firstStop = Object.freeze(diagnostic);
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
  const scope: Context = { execution: current.execution, stage, active: true };
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
      execution.active = false;
      try {
        if (diagnostic) console.info("patent_watch_diagnostic", JSON.stringify({
          diagnosticId: id,
          code: result.code === "completed" || isPatentWatchErrorCode(result.code) ? result.code : "watch_internal_error",
          stage: diagnostic.stage, reason: diagnostic.reason,
        }));
      } catch { /* Observability cannot alter the business result. */ }
      return result.response;
    } finally { execution.active = false; }
  });
}
