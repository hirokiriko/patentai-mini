import { createHash } from "node:crypto";

/** Inactive Local tooling only. No environment switch, credentials, native
 * fetch, journal writer, or product route is installed by importing this file. */
export const REVALIDATION_734_V1 = Object.freeze({
  id: "ISSUE150_REVALIDATION_734_V1", status: "OWNER_APPROVED_INACTIVE",
  priorSends: 37, priorRows: 74,
  priorLedgerSha256: "a6a423c2350bd67671fd05147689888953060d89e628a17801f258a57b21d34c",
  // Integer units of 0.00001 JPY. Old valuation is a separate history.
  currentExposure: 313691210, unknownHeld: 231300000,
  currentAiLimit: 360000000, currentTotalLimit: 500000000, deploymentReserve: 140000000,
  existingExpiresAt: "2026-10-18T15:41:40+09:00",
  // The explicit three-condition OWNER decision preserves the old values above.
  approvedAiLimit: 387100000, approvedTotalLimit: 527100000,
  approvedExpiresAt: "2026-10-20T14:59:00Z",
  requestMs: 210000, operationMs: 230000, responseBytes: 1048576, framingBytes: 8192,
  stages: Object.freeze([
    { ordinal: 38, phase: "diagnostic_source", task: "read_sources", input: 40000, output: 8192, reserve: 99 },
    { ordinal: 39, phase: "diagnostic_review", task: "review", input: 45000, output: 22528, reserve: 199 },
    { ordinal: 40, phase: "normal_source", task: "read_sources", input: 40000, output: 8192, reserve: 99 },
    { ordinal: 41, phase: "normal_generation", task: "compare", input: 56000, output: 8192, reserve: 116 },
    { ordinal: 42, phase: "normal_review", task: "review", input: 65000, output: 22528, reserve: 221 },
  ].map(stage => Object.freeze(stage))),
});
// New explicit OWNER decision after the terminal 38/39 failure. The prior
// plan, consumed claim and responses remain historical evidence, not rights.
export const CLAIM_LOCAL_734_V1 = Object.freeze({
  ...REVALIDATION_734_V1, id: "ISSUE150_CLAIM_LOCAL_734_V1",
  priorSends: 39, priorRows: 78,
  priorLedgerSha256: "17237ca58c6937fbdcdce8ca209b64cdfa087e90d87d69a1024939c7e93818db",
  currentExposure: 317619640,
  currentAiLimit: 387100000, currentTotalLimit: 527100000,
  approvedAiLimit: 391100000, approvedTotalLimit: 531100000,
  stages: Object.freeze(REVALIDATION_734_V1.stages.map(stage => Object.freeze({ ...stage, ordinal: stage.ordinal + 2 }))),
});
// Separate, explicitly approved operation after the terminal 40/41 failure.
// Neither the old claim nor its unused normal stages grants another send.
export const INDEPENDENT_734_V1 = Object.freeze({
  ...CLAIM_LOCAL_734_V1, id: "ISSUE150_INDEPENDENT_734_V1",
  priorSends: 41, priorRows: 82,
  priorLedgerSha256: "35c104512be0c8e786190a58c50731eb29f41885baa11adad280885e1e62b851",
  currentExposure: 321542845,
  currentAiLimit: 391100000, currentTotalLimit: 531100000,
  approvedAiLimit: 395000000, approvedTotalLimit: 535000000,
  stages: Object.freeze(CLAIM_LOCAL_734_V1.stages.map(stage => Object.freeze({ ...stage, ordinal: stage.ordinal + 2 }))),
});
// New four-condition OWNER approval after the terminal 42/43 failure.
// Preserve the failed operation and its unused normal stages as history.
export const REVALIDATION_PLAN = Object.freeze({
  ...INDEPENDENT_734_V1, id: "ISSUE150_STRUCTURE_734_V1",
  priorSends: 43, priorRows: 86,
  priorLedgerSha256: "9e6d35d473ccb7b81c39e83d8230188caf4a2c28ec2592423b1edec7207230a7",
  currentExposure: 324871720,
  currentAiLimit: 395000000, currentTotalLimit: 535000000,
  approvedAiLimit: 398300000, approvedTotalLimit: 538300000,
  stages: Object.freeze(INDEPENDENT_734_V1.stages.map(stage => Object.freeze({ ...stage, ordinal: stage.ordinal + 2 }))),
});
/** Two explicitly approved slots, still inactive without protected-parent
 * admission. Both retain the initial prefix and reserve the entire program.
 * The parent additionally binds each slot to its current ledger prefix and
 * refuses a second slot after unknown transport, timeout, or ambiguous ACK. */
export const PROPOSITION_REVALIDATION_PLANS = Object.freeze(([1, 2] as const).map(slot => Object.freeze({
  ...REVALIDATION_PLAN, id: "ISSUE150_PROPOSITION_1560_V1", slot,
  priorSends: 45, priorRows: 90,
  priorLedgerSha256: "3b4e68042ba6157b79194f79a0ce2ca3b543ec8c2e15f343d68b30667a6023d5",
  currentExposure: 328286010, currentAiLimit: 398300000, currentTotalLimit: 538300000,
  approvedAiLimit: 484300000, approvedTotalLimit: 624300000,
  programMaximumNewSends: 10, programReservationYen: 1560,
  stages: Object.freeze([
    { phase: "diagnostic_source", task: "extract_source_propositions", input: 40000, output: 8192, reserve: 99 },
    { phase: "diagnostic_review", task: "review", input: 68000, output: 22528, reserve: 224 },
    { phase: "normal_source", task: "extract_source_propositions", input: 40000, output: 8192, reserve: 99 },
    { phase: "normal_generation", task: "compare", input: 55000, output: 8192, reserve: 115 },
    { phase: "normal_review", task: "review", input: 85000, output: 22528, reserve: 243 },
  ].map((stage, index) => Object.freeze({ ...stage, ordinal: 49 + (slot - 1) * 5 + index }))),
})));
export function revalidationPlan(slot?: 1 | 2) {
  if (slot === undefined) return REVALIDATION_PLAN;
  if (slot !== 1 && slot !== 2) throw Error("revalidation_stopped");
  return PROPOSITION_REVALIDATION_PLANS[slot - 1];
}
export type RevalidationStage = typeof REVALIDATION_PLAN.stages[number];
export type RevalidationBinding = Readonly<{
  executionId: string; head: string; policyHash: string; materialsHash: string; measurementHash: string;
  approvalHash: string; publicReadbackHash: string; endpoint: string; deployment: string;
}>;
export type RevalidationDecision = Readonly<{
  status: "PENDING_OWNER_DECISION" | "OWNER_APPROVED";
  planId: string; maximumNewSends: number; maximumReservationYen: number;
  maximumAi: number; maximumTotal: number; expiresAt: string;
}>;
export type RevalidationPacket = { system: string; prompt: string; schema: unknown };
export type RevalidationUsage = { inputTokens: number; outputTokens: number };
export type DiagnosticQa = Readonly<{
  head: string; sourceResponseHash: string; reviewResponseHash: string; artifactHash: string;
  reviewers: readonly string[]; checkedUnits: number; checkedFields: number; checkedReferences: number;
  knownErrorsDetected: number; missedErrors: number; falseRejections: number; positiveControlsPreserved: boolean;
}>;
export type RevalidationJournal = {
  /** Protected parent: atomic durable exclusive claim, rejecting every restart
   * or competing execution ID for this plan/ledger prefix. Verify the exact
   * prior prefix before claiming; a new ID cannot reset the one-shot claim. */
  claim(binding: RevalidationBinding, prior: { sends: number; rows: number; sha256: string; reservationYen: number }): Promise<void>;
  /** Existing parent's durable write + readback ACK, not an in-memory callback. */
  reserve(event: { ordinal: number; requestHash: string; inputCeiling: number; outputCeiling: number; reservedJPY: number }): Promise<void>;
  reconcile(event: RevalidationUsage & { ordinal: number; requestHash: string; responseHash: string }): Promise<void>;
  /** Stop notification only: retain unknown/ambiguous ACK reservations. The
   * parent finalizes STOP and releases its lock only after owned processes exit.
   * Reconcile may already be durable if its ACK was lost: inspect authoritative
   * journal state, never erase known usage or add a second terminal row. */
  stop(event: { ordinal: number; claimMayExist: boolean; reservationMayExist: boolean; usageReconciled: boolean }): Promise<void>;
};
export type RevalidationDependencies = {
  /** Select only a registered fixed slot; never accept caller-defined limits. */
  propositionSlot?: 1 | 2;
  binding: RevalidationBinding; decision: RevalidationDecision | null; journal: RevalidationJournal;
  /** Protected parent verifies authentic OWNER evidence, exact head/materials,
   * policy, fresh public readback, deadline and unchanged prior ledger. This
   * guard does not turn caller-provided JSON or a boolean into authorization. */
  assertAdmission(binding: RevalidationBinding, decision: RevalidationDecision): Promise<void>;
  /** Rebuild from original material and previously validated answers only. */
  packet(stage: RevalidationStage): RevalidationPacket;
  validateAnswer(stage: RevalidationStage, answer: unknown): Promise<void>;
  assertDiagnosticQa(qa: DiagnosticQa): Promise<void>;
  transport: typeof fetch;
};
export const revalidationHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stopError = () => Error("revalidation_stopped");
function requireValue(value: unknown): asserts value { if (!value) throw stopError(); }
const hash = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const integer = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
const keys = (value: unknown, expected: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === expected.sort().join(",");

export function revalidationFunding(slot?: 1 | 2) {
  const plan = revalidationPlan(slot);
  const reservationYen = "programReservationYen" in plan ? plan.programReservationYen : plan.stages.reduce((sum, s) => sum + s.reserve, 0);
  const requiredAi = plan.currentExposure + reservationYen * 100000;
  return { reservationYen, requiredAi, requiredTotal: requiredAi + plan.deploymentReserve };
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(stopError()); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** One process, five finite sends. The existing protected parent owns durable
 * one-shot state/ACKs through the thin Local bridge; no authority on import. */
export function createRevalidationGuard(deps: RevalidationDependencies) {
  const plan = revalidationPlan(deps.propositionSlot);
  const binding = Object.freeze({ ...deps.binding }), decision = deps.decision && Object.freeze({ ...deps.decision });
  const funding = revalidationFunding(deps.propositionSlot), terminal = new AbortController();
  let index = 0, busy = false, stopped = false, claimed = false, qaPassed = false;
  let operationEnds = 0, expiryEnds = 0;
  let operationSignal: AbortSignal;
  const responses: string[] = [];
  const validDecision = () => {
    requireValue(decision?.status === "OWNER_APPROVED" && decision.planId === plan.id &&
      decision.maximumNewSends === ("programMaximumNewSends" in plan ? plan.programMaximumNewSends : 5) && decision.maximumReservationYen === funding.reservationYen &&
      decision.maximumAi === plan.approvedAiLimit && decision.maximumAi >= funding.requiredAi &&
      decision.maximumTotal === plan.approvedTotalLimit && decision.maximumTotal >= funding.requiredTotal &&
      decision.expiresAt === plan.approvedExpiresAt && Date.now() < Date.parse(decision.expiresAt));
    requireValue(/^[a-f0-9]{40}$/.test(binding.head) && /^[a-f0-9-]{36}$/.test(binding.executionId) &&
      [binding.policyHash, binding.materialsHash, binding.measurementHash, binding.approvalHash, binding.publicReadbackHash].every(hash) &&
      binding.deployment.length > 0 && binding.deployment.length <= 100);
    const target = new URL(binding.endpoint);
    requireValue(target.protocol === "https:" && target.pathname.endsWith("/responses") && !target.username && !target.password && !target.hash);
    return decision;
  };
  const fail = () => { stopped = true; terminal.abort(); };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const stage = plan.stages[index];
    let claimMayExist = claimed, reservationMayExist = false, usageReconciled = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      requireValue(!stopped && !busy && stage && (index !== 2 || qaPassed));
      busy = true;
      const approval = validDecision();
      // Copy precisely what is checked so callers cannot mutate across ACK awaits.
      const request = { ...init, headers: new Headers(init?.headers) }, target = String(url);
      requireValue(request.method === "POST" && typeof request.body === "string" && target === binding.endpoint &&
        request.signal && !request.signal.aborted && Buffer.byteLength(request.body, "utf8") + plan.framingBytes <= stage.input);
      const body = JSON.parse(request.body), expected = deps.packet(stage);
      requireValue(keys(body, ["model", "input", "max_output_tokens", "text", "reasoning", "service_tier"]) &&
        body.model === binding.deployment && body.max_output_tokens === stage.output && body.service_tier === "default" &&
        keys(body.reasoning, ["effort"]) && body.reasoning.effort === "low");
      requireValue(Array.isArray(body.input) && body.input.length === 2 && keys(body.input[0], ["role", "content"]) &&
        ["system", "developer"].includes(body.input[0].role) && body.input[0].content === expected.system &&
        keys(body.input[1], ["role", "content"]) && body.input[1].role === "user" && Array.isArray(body.input[1].content) &&
        body.input[1].content.length === 1 && keys(body.input[1].content[0], ["type", "text"]) &&
        body.input[1].content[0].type === "input_text" && body.input[1].content[0].text === expected.prompt &&
        JSON.parse(expected.prompt).task === stage.task);
      requireValue(keys(body.text, ["format"]) && keys(body.text.format, ["type", "name", "strict", "schema"]) &&
        body.text.format.type === "json_schema" && body.text.format.name === "response" && body.text.format.strict === true &&
        body.text.format.schema?.type === "object" && JSON.stringify(body.text.format.schema) === JSON.stringify(expected.schema));
      const started = performance.now(), requestEnds = started + plan.requestMs;
      if (index === 0) expiryEnds = started + Date.parse(approval.expiresAt) - Date.now();
      if (index === 0 || index === 2) {
        operationEnds = started + plan.operationMs;
        operationSignal = AbortSignal.timeout(plan.operationMs);
      }
      const remaining = Math.min(operationEnds, expiryEnds, requestEnds) - started; requireValue(remaining > 0);
      const signal = AbortSignal.any([request.signal, terminal.signal, operationSignal!, AbortSignal.timeout(Math.ceil(remaining))]);
      // Timer callbacks can be late and wall time can move backwards. Enforce
      // monotonic absolute deadlines at every asynchronous boundary as well.
      const checkpoint = () => {
        validDecision(); requireValue(!signal.aborted && !stopped && performance.now() < Math.min(requestEnds, operationEnds, expiryEnds));
      };
      await bounded(deps.assertAdmission(binding, approval), signal);
      checkpoint();
      if (!claimed) {
        claimMayExist = true; // The claim may become durable even when its ACK is lost.
        await bounded(deps.journal.claim(binding, { sends: plan.priorSends, rows: plan.priorRows, sha256: plan.priorLedgerSha256, reservationYen: funding.reservationYen }), signal);
        claimed = true;
      }
      checkpoint();
      const requestHash = revalidationHash(request.body);
      reservationMayExist = true;
      await bounded(deps.journal.reserve({ ordinal: stage.ordinal, requestHash, inputCeiling: stage.input, outputCeiling: stage.output, reservedJPY: stage.reserve }), signal);
      checkpoint();
      const response = await bounded(deps.transport(target, { ...request, signal, redirect: "error" }), signal);
      checkpoint();
      requireValue(response.ok && response.body);
      reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await bounded(reader.read(), signal); checkpoint(); if (next.done) break;
        bytes += next.value.length; requireValue(bytes <= plan.responseBytes); parts.push(next.value);
      }
      const raw = Buffer.concat(parts), responseHash = revalidationHash(raw);
      const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), usage = result.usage;
      requireValue(result.object === "response" && typeof result.id === "string" && /^resp_[A-Za-z0-9_-]+$/.test(result.id) &&
        ["gpt-5.4", "gpt-5.4-2026-03-05", binding.deployment].includes(result.model) && result.service_tier === "default" &&
        ["completed", "incomplete", "failed", "cancelled"].includes(result.status) && Array.isArray(result.output) &&
        integer(usage?.input_tokens, stage.input) && integer(usage?.output_tokens, stage.output) &&
        integer(usage?.total_tokens, stage.input + stage.output) && usage.total_tokens === usage.input_tokens + usage.output_tokens);
      for (const [details, field, maximum] of [[usage.input_tokens_details, "cached_tokens", usage.input_tokens], [usage.output_tokens_details, "reasoning_tokens", usage.output_tokens]] as const)
        requireValue(details === undefined || details === null || (typeof details === "object" && !Array.isArray(details) && integer(details[field], maximum)));
      checkpoint();
      await bounded(deps.journal.reconcile({ ordinal: stage.ordinal, requestHash, responseHash, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }), signal);
      usageReconciled = true;
      checkpoint();
      requireValue(result.status === "completed" && !result.error && !result.incomplete_details);
      const texts = result.output.flatMap((o: { type?: string; content?: { type: string; text?: string }[] }) =>
        o.type === "message" && Array.isArray(o.content) ? o.content.filter(c => c.type === "output_text").map(c => c.text) : []);
      requireValue(texts.length === 1 && typeof texts[0] === "string");
      await bounded(deps.validateAnswer(stage, JSON.parse(texts[0])), signal);
      checkpoint();
      responses.push(responseHash); index++;
      return new Response(raw, { status: response.status, headers: response.headers });
    } catch {
      fail();
      if (stage && claimMayExist) {
        try { await bounded(deps.journal.stop({ ordinal: stage.ordinal, claimMayExist, reservationMayExist, usageReconciled }), AbortSignal.timeout(5000)); } catch { /* Parent retains any ambiguous ACK. */ }
      }
      throw stopError();
    } finally { busy = false; if (reader) void reader.cancel().catch(() => undefined); }
  };
  return Object.freeze({ fetch,
    async acceptDiagnosticQa(qa: DiagnosticQa) {
      try {
        requireValue(!stopped && !busy && index === 2 && !qaPassed); busy = true; validDecision();
        const evidence = Object.freeze({ ...qa, reviewers: Object.freeze([...qa.reviewers]) });
        requireValue(evidence.head === binding.head && evidence.sourceResponseHash === responses[0] && evidence.reviewResponseHash === responses[1] &&
          hash(evidence.artifactHash) && evidence.reviewers.length === 3 && new Set(evidence.reviewers).size === 3 && evidence.reviewers.every(r => r.trim()) &&
          evidence.checkedUnits === 24 && evidence.checkedFields === 20 && evidence.checkedReferences === 14 && evidence.knownErrorsDetected === 4 &&
          evidence.missedErrors === 0 && evidence.falseRejections === 0 && evidence.positiveControlsPreserved === true);
        await bounded(deps.assertDiagnosticQa(evidence), AbortSignal.any([terminal.signal, AbortSignal.timeout(5000)]));
        validDecision(); requireValue(!stopped); qaPassed = true;
      } catch { fail(); throw stopError(); } finally { busy = false; }
    },
    close() { fail(); },
    snapshot: () => Object.freeze({ completed: index, stopped, claimed, diagnosticQaPassed: qaPassed }),
  });
}
