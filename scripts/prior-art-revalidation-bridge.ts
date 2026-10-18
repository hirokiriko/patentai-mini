import { createRevalidationGuard, REVALIDATION_PLAN, revalidationHash,
  type RevalidationDependencies } from "./prior-art-revalidation-guard";

/** Local harness adapter. The protected parent owns approval, the exclusive
 * ledger, and process cleanup. No environment switch or native fetch here. */
export function createRevalidationBridge(deps: Omit<RevalidationDependencies,
  "journal" | "assertAdmission" | "assertDiagnosticQa" | "transport"> & {
  parent(command: "admit" | "claim" | "reserve" | "reconcile" | "qa" | "stop", value: unknown): Promise<void>;
  record(name: string, bytes: Uint8Array): Promise<void>;
  transport: typeof fetch;
}) {
  let body = "", response: Uint8Array | undefined, busy = false;
  const guard = createRevalidationGuard({ ...deps,
    assertAdmission: (binding, decision) => deps.parent("admit", { binding, decision }),
    assertDiagnosticQa: qa => deps.parent("qa", qa),
    journal: {
      claim: (binding, prior) => deps.parent("claim", { binding, prior }),
      reserve: async event => {
        if (revalidationHash(body) !== event.requestHash) throw Error("bridge_request_changed");
        await deps.record(`request-${event.ordinal}.json`, Buffer.from(body));
        await deps.parent("reserve", event);
      },
      reconcile: async event => {
        if (!response || revalidationHash(response) !== event.responseHash) throw Error("bridge_response_changed");
        await deps.parent("reconcile", event);
      },
      stop: event => deps.parent("stop", event),
    },
    transport: async (url, init) => {
      const stage = REVALIDATION_PLAN.stages[guard.snapshot().completed];
      const received = await deps.transport(url, init);
      if (!received.ok) {
        void received.body?.cancel().catch(() => undefined);
        return new Response(null, { status: received.status, headers: received.headers });
      }
      // Tee to disk as the guard consumes the response; do not pre-buffer an
      // unbounded body or weaken the guard's deadline/size/usage checks.
      if (!received.body) return received;
      const reader = received.body.getReader(), chunks: Uint8Array[] = [];
      const abort = () => { void reader.cancel().catch(() => undefined); };
      init?.signal?.addEventListener("abort", abort, { once: true });
      if (init?.signal?.aborted) abort();
      let bytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              init?.signal?.removeEventListener("abort", abort);
              response = Buffer.concat(chunks);
              await deps.record(`provider-response-${stage.ordinal}.json`, response);
              controller.close(); return;
            }
            bytes += next.value.length;
            if (bytes > REVALIDATION_PLAN.responseBytes) throw Error("bridge_response_limit");
            chunks.push(next.value); controller.enqueue(next.value);
          } catch (error) { init?.signal?.removeEventListener("abort", abort); controller.error(error); void reader.cancel().catch(() => undefined); }
        },
        cancel: reason => { init?.signal?.removeEventListener("abort", abort); return reader.cancel(reason); },
      });
      return new Response(stream, { status: received.status, headers: received.headers });
    },
    validateAnswer: async (stage, answer) => {
      await deps.validateAnswer(stage, answer);
      await deps.record(`answer-${stage.ordinal}.json`, Buffer.from(JSON.stringify(answer)));
    },
  });
  return Object.freeze({ ...guard,
    fetch: (async (url, init) => {
      if (busy) { guard.close(); throw Error("revalidation_stopped"); }
      busy = true; body = typeof init?.body === "string" ? init.body : ""; response = undefined;
      try { return await guard.fetch(url, init); } finally { busy = false; }
    }) as typeof fetch,
  });
}
