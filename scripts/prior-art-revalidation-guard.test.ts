import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asSchema, generateObject } from "ai";
import { createRevalidationGuard, REVALIDATION_PLAN as PLAN, REVALIDATION_734_V1 as OLD_PLAN, revalidationFunding, revalidationHash,
  type DiagnosticQa, type RevalidationBinding, type RevalidationDecision, type RevalidationDependencies,
  type RevalidationPacket, type RevalidationStage } from "./prior-art-revalidation-guard";
import { executeComparison } from "../src/lib/prior-art-comparison/execute";
import { makePlan, SYSTEM, validateAnswer, validateSaved } from "../src/lib/prior-art-comparison/comparison";
import { fictionalBatch, fictionalInputs, fictionalSourceAnalysis, fictionalTransportReview } from "../src/lib/prior-art-comparison/fixtures.test-support";
import { parseComparisonSource } from "../src/lib/prior-art-comparison/source";
import { sourceAnalysisInput, sourceReadingSchemaFor, SOURCE_ANALYSIS_SYSTEM } from "../src/lib/prior-art-comparison/source-analysis";
import { batchInput, batchTransportInput, batchSchemaFor } from "../src/lib/prior-art-comparison/generation-batch";
import { separatedGenerationPlan } from "../src/lib/prior-art-comparison/source-separation";
import { decodeGeneration } from "../src/lib/prior-art-comparison/generation";
import { reviewInput, REVIEW_SYSTEM } from "../src/lib/prior-art-comparison/semantic-review";
import { reviewTransportInput, reviewTransportSchemaFor } from "../src/lib/prior-art-comparison/review-transport";
import { getModel } from "../src/lib/ai-model";
import { withPriorArtComparisonBudget } from "../src/lib/ai-operation-budget";
import { comparisonProviderOptions } from "../src/lib/prior-art-comparison/provider-options";

// Every authority, journal, source and response here is fictional. No native
// transport is reachable; this is not an approval artifact or semantic proof.
const binding: RevalidationBinding = { executionId: "a0000000-0000-4000-8000-000000000001", head: "a".repeat(40),
  policyHash: "b".repeat(64), materialsHash: "c".repeat(64), measurementHash: "d".repeat(64),
  approvalHash: "e".repeat(64), publicReadbackHash: "f".repeat(64),
  endpoint: "https://example.invalid/openai/v1/responses?api-version=v1", deployment: "patentai-gpt54" };
const approved: RevalidationDecision = { status: "OWNER_APPROVED", planId: PLAN.id, maximumNewSends: 5,
  maximumReservationYen: 734, maximumAi: 391100000, maximumTotal: 531100000, expiresAt: PLAN.approvedExpiresAt };
const packet = (stage: RevalidationStage): RevalidationPacket => ({ system: "Fictional original-only packet",
  prompt: JSON.stringify({ task: stage.task, phase: stage.phase }), schema: { type: "object", properties: {}, additionalProperties: false } });
function body(stage: RevalidationStage, p = packet(stage)) {
  return { model: binding.deployment, input: [{ role: "system", content: p.system }, { role: "user", content: [{ type: "input_text", text: p.prompt }] }],
    max_output_tokens: stage.output, text: { format: { type: "json_schema", name: "response", strict: true, schema: p.schema } },
    reasoning: { effort: "low" }, service_tier: "default" };
}
function responseBody(answer: unknown = {}) {
  return { object: "response", id: "resp_fixture", created_at: 0, status: "completed", model: "gpt-5.4", service_tier: "default",
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}
function harness(overrides: Partial<RevalidationDependencies> = {}) {
  const events: string[] = [];
  const journal = { claim: vi.fn(async () => { events.push("claim"); }),
    reserve: vi.fn(async (e: { ordinal: number }) => { events.push(`reserve:${e.ordinal}`); }),
    reconcile: vi.fn(async (e: { ordinal: number }) => { events.push(`reconcile:${e.ordinal}`); }),
    stop: vi.fn(async () => { events.push("stop"); }) };
  const transport = vi.fn<typeof fetch>(async () => { events.push("transport"); return Response.json(responseBody()); });
  const deps: RevalidationDependencies = { binding, decision: approved, journal, packet,
    assertAdmission: vi.fn(async () => undefined), validateAnswer: vi.fn(async () => undefined),
    assertDiagnosticQa: vi.fn(async () => undefined), transport, ...overrides };
  const guard = createRevalidationGuard(deps);
  const send = (i: number, wire: unknown = body(PLAN.stages[i]), init: Partial<RequestInit> = {}) => guard.fetch(binding.endpoint,
    { method: "POST", body: JSON.stringify(wire), signal: new AbortController().signal, ...init });
  return { guard, send, deps, journal, transport, events };
}
function qa(h: ReturnType<typeof harness>): DiagnosticQa {
  const events = vi.mocked(h.deps.journal.reconcile).mock.calls;
  return { head: binding.head, sourceResponseHash: events[0][0].responseHash, reviewResponseHash: events[1][0].responseHash,
    artifactHash: "1".repeat(64), reviewers: ["root", "independent-a", "independent-b"],
    checkedUnits: 24, checkedFields: 20, checkedReferences: 14, knownErrorsDetected: 4,
    missedErrors: 0, falseRejections: 0, positiveControlsPreserved: true };
}
async function advance(h: ReturnType<typeof harness>, until: number) {
  for (let i = 0; i < until; i++) { if (i === 2) await h.guard.acceptDiagnosticQa(qa(h)); await h.send(i); }
  if (until === 2) await h.guard.acceptDiagnosticQa(qa(h));
}
describe("inactive finite 734 JPY revalidation guard", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T14:00:00+09:00")); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
  it("retains old limits and unknown exposure while pinning the explicit new decision", () => {
    expect([OLD_PLAN.priorSends, OLD_PLAN.priorRows, OLD_PLAN.approvedAiLimit, OLD_PLAN.approvedTotalLimit]).toEqual([37, 74, 387100000, 527100000]);
    expect(PLAN.stages.map(s => s.ordinal)).toEqual([40, 41, 42, 43, 44]);
    expect(PLAN.status).toBe("OWNER_APPROVED_INACTIVE"); expect(PLAN.currentAiLimit).toBe(387100000);
    expect(PLAN.currentTotalLimit).toBe(527100000); expect(PLAN.unknownHeld).toBe(231300000);
    expect([PLAN.approvedAiLimit, PLAN.approvedTotalLimit, PLAN.approvedExpiresAt]).toEqual([391100000, 531100000, "2026-10-20T14:59:00Z"]);
    expect(revalidationFunding()).toEqual({ reservationYen: 734, requiredAi: 391019640, requiredTotal: 531019640 });
    expect(PLAN.stages.map(s => Math.ceil((5 * s.input + 30 * s.output) * 220 / 1000000))).toEqual([99, 199, 99, 116, 221]);
    expect(Object.isFrozen(PLAN.stages[0])).toBe(true);
  });
  it.each([null, { ...approved, planId: OLD_PLAN.id }, { ...approved, maximumAi: OLD_PLAN.approvedAiLimit, maximumTotal: OLD_PLAN.approvedTotalLimit }, { ...approved, status: "PENDING_OWNER_DECISION" as const },
    { ...approved, maximumAi: PLAN.currentAiLimit }, { ...approved, maximumTotal: PLAN.currentTotalLimit },
    { ...approved, maximumAi: 391019639 }, { ...approved, maximumTotal: 531019639 },
    { ...approved, maximumAi: 391100001 }, { ...approved, maximumTotal: 531100001 },
    { ...approved, expiresAt: PLAN.existingExpiresAt }, { ...approved, expiresAt: "2026-10-20T14:59:01Z" },
    { ...approved, maximumNewSends: 6 }, { ...approved, maximumReservationYen: 958 },
    { ...approved, expiresAt: "2026-10-18T13:59:59+09:00" }, { ...approved, expiresAt: "2026-10-19T15:41:40+09:00" }])("rejects absent, stale or insufficient approval before reservation: %j", async decision => {
    const h = harness({ decision }); await expect(h.send(0)).rejects.toThrow("revalidation_stopped");
    expect(h.journal.claim).not.toHaveBeenCalled(); expect(h.journal.reserve).not.toHaveBeenCalled(); expect(h.transport).not.toHaveBeenCalled();
  });
  it.each(["head", "policyHash", "materialsHash", "measurementHash", "approvalHash", "publicReadbackHash"])("requires the immutable %s binding", async key => {
    const h = harness({ binding: { ...binding, [key]: "" } }); await expect(h.send(0)).rejects.toThrow(); expect(h.events).toEqual([]);
  });
  it("does not accept a caller's approval JSON without protected-parent admission", async () => {
    const h = harness({ assertAdmission: vi.fn(async () => { throw Error("FICTIONAL_SECRET"); }) });
    await expect(h.send(0)).rejects.toThrow(/^revalidation_stopped$/); expect(h.events).toEqual([]);
    await expect(h.send(0)).rejects.toThrow(); expect(h.deps.assertAdmission).toHaveBeenCalledTimes(1);
  });
  it("orders five bounded reservations/ACKs and refuses a sixth send or retry", async () => {
    const h = harness(); await advance(h, 5);
    expect(h.events).toEqual(["claim", ...PLAN.stages.flatMap(s => [`reserve:${s.ordinal}`, "transport", `reconcile:${s.ordinal}`])]);
    expect(h.deps.journal.claim).toHaveBeenCalledWith(binding, { sends: 39, rows: 78, sha256: PLAN.priorLedgerSha256, reservationYen: 734 });
    expect(h.deps.journal.reserve).toHaveBeenCalledTimes(5);
    for (const [i, [event]] of vi.mocked(h.deps.journal.reserve).mock.calls.entries()) expect(event).toMatchObject({ ordinal: PLAN.stages[i].ordinal,
      inputCeiling: PLAN.stages[i].input, outputCeiling: PLAN.stages[i].output, reservedJPY: PLAN.stages[i].reserve });
    await expect(h.send(0)).rejects.toThrow(); expect(h.transport).toHaveBeenCalledTimes(5);
  });
  it.each(PLAN.stages.map((_, i) => i))("uses the serialized UTF-8 body plus framing at stage %i", async i => {
    let exact: RevalidationPacket = packet(PLAN.stages[i]);
    const h = harness({ packet: stage => exact && stage.ordinal === PLAN.stages[i].ordinal ? exact : packet(stage) });
    await advance(h, i); const stage = PLAN.stages[i], original = packet(stage);
    const room = stage.input - PLAN.framingBytes - Buffer.byteLength(JSON.stringify(body(stage, original)));
    exact = { ...original, system: original.system + "x".repeat(room) };
    const wire = body(stage, exact); expect(Buffer.byteLength(JSON.stringify(wire)) + PLAN.framingBytes).toBe(stage.input);
    await h.send(i, wire); expect(h.transport).toHaveBeenCalledTimes(i + 1);
    const tooMuch = harness({ packet: s => s.ordinal === stage.ordinal ? { ...exact!, system: exact!.system + "界" } : packet(s) });
    await advance(tooMuch, i); await expect(tooMuch.send(i, body(stage, { ...exact, system: exact.system + "界" }))).rejects.toThrow();
    expect(tooMuch.transport).toHaveBeenCalledTimes(i); expect(tooMuch.deps.journal.reserve).toHaveBeenCalledTimes(i);
  });
  it.each(["model", "output", "reasoning", "tier", "task", "prompt", "schema", "tools", "stage"])("rejects a changed %s before any reservation", async mode => {
    const h = harness(), wire = body(PLAN.stages[0]);
    if (mode === "model") wire.model = "different";
    if (mode === "output") wire.max_output_tokens++;
    if (mode === "reasoning") wire.reasoning.effort = "medium";
    if (mode === "tier") wire.service_tier = "priority";
    if (mode === "task" || mode === "prompt") wire.input[1].content = [{ type: "input_text", text: JSON.stringify({ task: "compare" }) }];
    if (mode === "schema") wire.text.format.schema = { type: "array" };
    if (mode === "tools") Object.assign(wire, { tools: [] });
    if (mode === "stage") wire.max_output_tokens = PLAN.stages[1].output;
    await expect(h.send(0, wire)).rejects.toThrow(); expect(h.events).toEqual([]);
  });
  it.each(["not-accepted", "wrong-head", "wrong-response", "coverage", "miss", "false-rejection", "positive", "duplicate-reviewer", "parent-refusal"])("holds normal sends until complete independent diagnostic QA: %s", async mode => {
    const h = harness(); await h.send(0); await h.send(1);
    if (mode !== "not-accepted") {
      const evidence = { ...qa(h) };
      if (mode === "wrong-head") evidence.head = "9".repeat(40);
      if (mode === "wrong-response") evidence.reviewResponseHash = "9".repeat(64);
      if (mode === "coverage") evidence.checkedReferences = 13;
      if (mode === "miss") evidence.missedErrors = 1;
      if (mode === "false-rejection") evidence.falseRejections = 1;
      if (mode === "positive") evidence.positiveControlsPreserved = false;
      if (mode === "duplicate-reviewer") evidence.reviewers = ["root", "root", "b"];
      if (mode === "parent-refusal") vi.mocked(h.deps.assertDiagnosticQa).mockRejectedValue(Error("fictional rejection"));
      await expect(h.guard.acceptDiagnosticQa(evidence)).rejects.toThrow();
    }
    await expect(h.send(2)).rejects.toThrow(); expect(h.transport).toHaveBeenCalledTimes(2);
  });
  it("keeps a durable parent claim across restarted instances and competing execution IDs", async () => {
    let claimed = false; const claim = vi.fn(async () => { if (claimed) throw Error(); claimed = true; });
    const h = harness(); h.deps.journal.claim = claim; await h.send(0);
    const second = harness({ journal: h.deps.journal, binding: { ...binding, executionId: "b0000000-0000-4000-8000-000000000002" } });
    await expect(second.send(0)).rejects.toThrow(); expect(second.transport).not.toHaveBeenCalled(); expect(h.journal.reserve).toHaveBeenCalledTimes(1);
  });
  it("snapshots the checked request before awaiting durable ACK", async () => {
    const h = harness(), controller = new AbortController(), wire = body(PLAN.stages[0]);
    const init = { method: "POST", body: JSON.stringify(wire), headers: { "x-fictional": "original" }, signal: controller.signal };
    const original = init.body;
    vi.mocked(h.deps.assertAdmission).mockImplementation(async () => { init.body = "changed"; init.headers["x-fictional"] = "changed"; });
    await h.guard.fetch(binding.endpoint, init);
    expect(h.transport.mock.calls[0][1]?.body).toBe(original);
    expect(new Headers(h.transport.mock.calls[0][1]?.headers).get("x-fictional")).toBe("original");
  });
  it.each(["admission", "claim", "reserve"])("rechecks deadline/abort after the %s await", async point => {
    const h = harness(), ctrl = new AbortController(), abort = async () => { ctrl.abort(); };
    if (point === "admission") vi.mocked(h.deps.assertAdmission).mockImplementation(abort);
    else vi.mocked(h.deps.journal[point as "claim" | "reserve"]).mockImplementation(abort);
    await expect(h.send(0, undefined, { signal: ctrl.signal })).rejects.toThrow(); expect(h.transport).not.toHaveBeenCalled();
    expect(h.journal.reserve).toHaveBeenCalledTimes(point === "reserve" ? 1 : 0);
  });
  it.each(["reserve", "reconcile"] as const)("never retries an ambiguous %s ACK", async point => {
    const h = harness(); vi.mocked(h.deps.journal[point]).mockRejectedValue(Error("FICTIONAL_SECRET"));
    await expect(h.send(0)).rejects.toThrow(/^revalidation_stopped$/); await expect(h.send(0)).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledTimes(point === "reserve" ? 0 : 1);
    expect(h.deps.journal.stop).toHaveBeenCalledWith({ ordinal: 40, claimMayExist: true, reservationMayExist: true, usageReconciled: false });
  });
  it("notifies the parent about an ambiguous durable claim even before a reservation exists", async () => {
    const h = harness(); vi.mocked(h.deps.journal.claim).mockRejectedValue(Error("fictional ACK loss"));
    await expect(h.send(0)).rejects.toThrow(); expect(h.transport).not.toHaveBeenCalled(); expect(h.journal.reserve).not.toHaveBeenCalled();
    expect(h.deps.journal.stop).toHaveBeenCalledWith({ ordinal: 40, claimMayExist: true, reservationMayExist: false, usageReconciled: false });
    await expect(h.send(0)).rejects.toThrow(); expect(h.journal.claim).toHaveBeenCalledTimes(1);
  });
  it.each(["http", "json", "missing-usage", "input-usage", "output-usage", "total-usage", "cached-usage", "reasoning-usage", "model", "tier", "large"])("retains the reservation after %s without another send", async mode => {
    const h = harness(); h.transport.mockImplementation(async () => {
      if (mode === "http") return new Response("FICTIONAL_SECRET", { status: 429 });
      if (mode === "json") return new Response("FICTIONAL_SECRET");
      if (mode === "large") return new Response("x".repeat(PLAN.responseBytes + 1));
      const r = responseBody();
      if (mode === "missing-usage") Object.assign(r, { usage: null });
      if (mode === "input-usage") { r.usage.input_tokens = 40001; r.usage.total_tokens = 40031; }
      if (mode === "output-usage") { r.usage.output_tokens = 8193; r.usage.total_tokens = 8293; }
      if (mode === "total-usage") r.usage.total_tokens = 129;
      if (mode === "cached-usage") r.usage.input_tokens_details.cached_tokens = 101;
      if (mode === "reasoning-usage") r.usage.output_tokens_details.reasoning_tokens = 31;
      if (mode === "model") r.model = "other";
      if (mode === "tier") r.service_tier = "priority";
      return Response.json(r);
    });
    await expect(h.send(0)).rejects.toThrow(/^revalidation_stopped$/); await expect(h.send(1)).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledTimes(1); expect(h.journal.reconcile).not.toHaveBeenCalled();
    expect(h.deps.journal.stop).toHaveBeenCalledWith({ ordinal: 40, claimMayExist: true, reservationMayExist: true, usageReconciled: false });
  });
  it.each(["incomplete", "answer-invalid"])("reconciles known usage before stopping for %s", async mode => {
    const h = harness();
    if (mode === "incomplete") h.transport.mockResolvedValue(Response.json({ ...responseBody(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    else vi.mocked(h.deps.validateAnswer).mockRejectedValue(Error());
    await expect(h.send(0)).rejects.toThrow(); expect(h.journal.reconcile).toHaveBeenCalledTimes(1);
    expect(h.deps.journal.stop).toHaveBeenCalledWith({ ordinal: 40, claimMayExist: true, reservationMayExist: true, usageReconciled: true });
    expect(h.guard.snapshot().completed).toBe(0);
  });
  function timers() {
    vi.restoreAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T14:00:00+09:00"));
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
  }
  it.each(["transport", "body"])("aborts a hung %s after 210 seconds", async point => {
    timers(); const h = harness();
    h.transport.mockImplementation(() => point === "transport" ? new Promise(() => undefined) : Promise.resolve(new Response(new ReadableStream())));
    const pending = expect(h.send(0)).rejects.toThrow(); await vi.advanceTimersByTimeAsync(210001); await pending;
    expect(h.transport.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(h.guard.snapshot().stopped).toBe(true);
  });
  it("does not reset the 230-second diagnostic operation on its second send", async () => {
    timers(); const h = harness(); h.transport.mockImplementation(async () => { await new Promise(r => setTimeout(r, 120000)); return Response.json(responseBody()); });
    const first = h.send(0); await vi.advanceTimersByTimeAsync(120001); await first;
    const second = expect(h.send(1)).rejects.toThrow(); await vi.advanceTimersByTimeAsync(110000); await second;
    expect(h.transport).toHaveBeenCalledTimes(2); expect(h.guard.snapshot().completed).toBe(1);
  });
  it("starts a separate normal operation but retains its deadline across all three sends", async () => {
    timers(); const h = harness(); await advance(h, 2);
    h.transport.mockImplementation(async () => { await new Promise(r => setTimeout(r, 80000)); return Response.json(responseBody()); });
    for (const i of [2, 3]) { const p = h.send(i); await vi.advanceTimersByTimeAsync(80001); await p; }
    const last = expect(h.send(4)).rejects.toThrow(); await vi.advanceTimersByTimeAsync(70000); await last;
    expect(h.guard.snapshot().completed).toBe(4);
  });
  it("the absolute approval expiry stops even a shorter request", async () => {
    timers(); vi.setSystemTime(new Date(Date.parse(PLAN.approvedExpiresAt) - 1000)); const h = harness();
    h.transport.mockImplementation(() => new Promise(() => undefined));
    const pending = expect(h.send(0)).rejects.toThrow(); await vi.advanceTimersByTimeAsync(1001); await pending;
    expect(h.guard.snapshot().stopped).toBe(true);
  });
  it.each([0, 1])("rejects at or after the newly approved expiry (%d ms)", async offset => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(PLAN.approvedExpiresAt) + offset);
    const h = harness(); await expect(h.send(0)).rejects.toThrow();
    expect(h.journal.claim).not.toHaveBeenCalled(); expect(h.transport).not.toHaveBeenCalled();
  });
  it("concurrent calls permanently stop the in-flight request and cannot reserve twice", async () => {
    const h = harness(); let admitted!: () => void;
    vi.mocked(h.deps.assertAdmission).mockImplementation(() => new Promise(resolve => { admitted = resolve; }));
    const first = expect(h.send(0)).rejects.toThrow(); await expect(h.send(0)).rejects.toThrow(); admitted(); await first;
    expect(h.journal.reserve).not.toHaveBeenCalled(); expect(h.transport).not.toHaveBeenCalled();
  });
  it.each(["admission", "claim", "reserve"])("rejects a late %s ACK before timer callbacks run", async point => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const h = harness(), late = async () => { monotonic = 210001; };
    if (point === "admission") vi.mocked(h.deps.assertAdmission).mockImplementation(late);
    else vi.mocked(h.deps.journal[point as "claim" | "reserve"]).mockImplementation(late);
    await expect(h.send(0)).rejects.toThrow(); expect(h.transport).not.toHaveBeenCalled();
  });
  it("wall-clock rollback cannot extend the diagnostic operation", async () => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const h = harness(); await h.send(0); monotonic = 230001;
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-18T13:00:00+09:00"));
    await expect(h.send(1)).rejects.toThrow(); expect(h.transport).toHaveBeenCalledTimes(1);
  });
  it("the installed SDK passes all five sends, including the product's normal three-stage pipeline, with fictional transport", async () => {
    for (const [key, value] of Object.entries({ AI_PROVIDER: "azure", AZURE_OPENAI_BASE_URL: "https://example.invalid/openai",
      AZURE_API_KEY: "fictional", AZURE_OPENAI_DEPLOYMENT_NAME: binding.deployment, AZURE_OPENAI_API_VERSION: "v1" })) vi.stubEnv(key, value);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fixture = fictionalInputs(), text = "【請求項1】\n温度を記録する装置。\n【請求項2】\n請求項1に記載の装置で、青色弁を保持する。\n【請求項3】\n請求項1に記載の装置で、赤色弁を保持する。";
    fixture.inputs.draft = parseComparisonSource("【請求項1】\n温度を記録する基準装置。", 11, "架空基準");
    fixture.inputs.documents = [21, 22].map(id => parseComparisonSource(text, id, `架空${id}`));
    fixture.selection.documents = fixture.inputs.documents.map(d => ({ docId: d.id, claimNos: [2, 3], identity: { publication: d.label, edition: "架空" } }));
    const plan = makePlan(fixture.inputs, fixture.selection), batch = separatedGenerationPlan(plan, SYSTEM);
    const source = sourceAnalysisInput(batch), sourceAnswer = fictionalSourceAnalysis(source);
    const generation = batchTransportInput(batch, sourceAnswer.sourceAnalysis), generated = fictionalBatch(batchInput(batch, sourceAnswer.sourceAnalysis));
    const drafts = plan.flatMap(chunk => {
      const own = new Set(chunk.pairs.map(p => `${p.baseClaimNo}:${p.candidateClaimNo}`));
      const results = generated.results.filter(r => r.docId === chunk.candidateId && own.has(`${r.baseClaimNo}:${r.candidateClaimNo}`)).map(r => ({
        baseClaimNo: r.baseClaimNo, candidateClaimNo: r.candidateClaimNo, baseObservation: r.baseObservation, candidateObservation: r.candidateObservation,
        common: r.common, differences: r.differences, unconfirmed: r.unconfirmed, baseEvidenceId: r.baseEvidenceId, candidateEvidenceId: r.candidateEvidenceId }));
      return validateAnswer(chunk, decodeGeneration(chunk, { results })).map((p, i) => ({ ...p, baseObservation: results[i].baseObservation, candidateObservation: results[i].candidateObservation }));
    });
    const review = reviewInput(plan, drafts, sourceAnswer.sourceAnalysis), reviewWire = reviewTransportInput(review), reviewed = fictionalTransportReview(reviewWire);
    const sourcePacket = { system: SOURCE_ANALYSIS_SYSTEM, prompt: JSON.stringify(source), schema: await asSchema(sourceReadingSchemaFor(batch)).jsonSchema };
    const reviewPacket = { system: REVIEW_SYSTEM, prompt: JSON.stringify(reviewWire), schema: await asSchema(reviewTransportSchemaFor(review)).jsonSchema };
    const packets = [sourcePacket, reviewPacket, sourcePacket,
      { system: SYSTEM, prompt: JSON.stringify(generation), schema: await asSchema(batchSchemaFor(batch)).jsonSchema },
      reviewPacket];
    const answers = [sourceAnswer, reviewed, sourceAnswer, generated, reviewed]; let sent = 0;
    const h = harness({ packet: stage => packets[stage.ordinal - 40],
      validateAnswer: vi.fn(async (stage, answer) => { expect(answer).toEqual(answers[stage.ordinal - 40]); }) });
    h.transport.mockImplementation(async () => Response.json(responseBody(answers[sent++])));
    const captured: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return h.guard.fetch(url, init);
    });
    await withPriorArtComparisonBudget(async signal => {
      for (const i of [0, 1]) {
        const model = getModel(), phase = i === 0 ? "generation" : "review";
        await generateObject({ model, schema: i === 0 ? sourceReadingSchemaFor(batch) : reviewTransportSchemaFor(review),
          system: packets[i].system, prompt: packets[i].prompt, abortSignal: signal, maxRetries: 0,
          maxOutputTokens: PLAN.stages[i].output, providerOptions: comparisonProviderOptions(model, phase) });
      }
    });
    await h.guard.acceptDiagnosticQa(qa(h));
    const result = await executeComparison(fixture.inputs, fixture.selection).catch(error => error);
    expect(captured[0]?.url).toBe(binding.endpoint);
    expect(captured[0]?.body).toEqual({ ...body(PLAN.stages[2], packets[2]), input: [{ role: "developer", content: packets[2].system }, { role: "user", content: [{ type: "input_text", text: packets[2].prompt }] }] });
    expect(result).not.toBeInstanceOf(Error); const saved = result;
    expect(saved.pairs).toHaveLength(4); expect(saved.review).toBe("human_review_required"); expect(validateSaved(saved)).toEqual(saved);
    expect(h.guard.snapshot()).toEqual({ completed: 5, stopped: false, claimed: true, diagnosticQaPassed: true });
    expect(h.transport).toHaveBeenCalledTimes(5);
    expect(h.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).max_output_tokens)).toEqual([8192, 22528, 8192, 8192, 22528]);
    expect(h.journal.reconcile).toHaveBeenCalledTimes(5);
    expect(revalidationHash(String(h.transport.mock.calls[2][1]?.body))).toBe(vi.mocked(h.deps.journal.reserve).mock.calls[2][0].requestHash);
  });
});
