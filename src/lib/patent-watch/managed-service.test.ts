import { afterEach, describe, expect, it, vi } from "vitest";
import { managedAzureAnalysis, validateManagedScreening } from "./managed-service";
import { managedBaseDigest, type ManagedRun, type managedScreeningInput } from "./managed-types";
import { managedClaimContext } from "./managed-claims";
import { isAiOperationStopped, withManagedWatchBudget, type ManagedWatchDispatchJournal } from "../ai-operation-budget";
const run = { snapshot: { candidates: [{ candidateId: 1 }, { candidateId: 2 }] } } as ManagedRun;
describe("managed screening completeness", () => {
  it("requires every candidate exactly once and preserves explicit exclusions", () => {
    expect(validateManagedScreening(run, { decisions: [{ candidateId: 1, selected: true, reason: "technical_overlap" },
      { candidateId: 2, selected: false, reason: "limited_overlap" }] })).toEqual([1]);
    for (const ids of [[], [1], [1,1], [1,3], [1,2,3]]) expect(() => validateManagedScreening(run, {
      decisions: ids.map(candidateId => ({ candidateId, selected: true, reason: "technical_overlap" })),
    })).toThrow("incomplete");
  });
  it("uses the same specified set identity regardless of input ordering", () => {
    const base = { publicationNumber: "JP-FICTIONAL", version: "A1", claims: [
      { claimNo: 1, text: "架空の装置。", dependsOn: [] }, { claimNo: 2, text: "請求項1に記載の装置。", dependsOn: [1] },
    ] };
    expect(managedBaseDigest({ base, selectedClaimNos: [1,2] })).toBe(managedBaseDigest({ base, selectedClaimNos: [2,1] }));
    expect(managedClaimContext(base, [2]).claims.map(c => c.claimNo)).toEqual([1,2]);
  });
});

describe("managed screening real SDK input boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const input = (): ReturnType<typeof managedScreeningInput> => ({
    base: { publicationNumber: "JP-FICTIONAL", version: "A1", claims: [{ claimNo: 1, text: "架空の装置。", dependsOn: [] }] },
    candidates: Array.from({ length: 100 }, (_, i) => ({ candidateId: i + 1, inventionTitle: "架空の検証候補",
      abstract: "説明文".repeat(100), lexicalScore: 0.1, claimsStatus: "complete" as const })),
  });
  function fixture() {
    for (const [name, value] of Object.entries({ AI_PROVIDER: "azure", AZURE_OPENAI_BASE_URL: "https://example.invalid/openai",
      AZURE_API_KEY: "fictional", AZURE_OPENAI_API_VERSION: "v1", AZURE_OPENAI_DEPLOYMENT_NAME: "fictional" })) vi.stubEnv(name, value);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const decisions = Array.from({ length: 100 }, (_, i) => ({ candidateId: i + 1, selected: false, reason: "limited_overlap" }));
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: "resp_fixture", created_at: 0,
      model: "fictional", status: "completed", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ decisions }), annotations: [] }] }],
      usage: { input_tokens: 1000, output_tokens: 1000 } }));
    vi.stubGlobal("fetch", transport);
    const journal: ManagedWatchDispatchJournal = { reserve: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    return { decisions, transport, journal, run: (value: ReturnType<typeof managedScreeningInput>) =>
      withManagedWatchBudget({ consumed: 0, deadlineAt: Date.now() + 60_000, journal }, () => managedAzureAnalysis.screening(value)) };
  }
  it("screens all 100 Japanese candidates above 90k without truncation under the approved request limit", async () => {
    const f = fixture(), value = input(), bytes = Buffer.byteLength(JSON.stringify(value));
    expect(bytes).toBeGreaterThan(90_000); expect(bytes).toBeLessThan(130_000);
    expect(await f.run(value)).toEqual({ decisions: f.decisions });
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.journal.reserve).toHaveBeenCalledTimes(1);
    const reservation = vi.mocked(f.journal.reserve).mock.calls[0][0];
    expect(reservation.estimatedInputTokens).toBeLessThanOrEqual(150_000); expect(reservation.maximumOutputTokens).toBe(8192);
    const request = JSON.parse(f.transport.mock.calls[0][1]!.body as string);
    const sent = request.input.find((entry: { role: string }) => entry.role === "user").content[0].text;
    expect(JSON.parse(sent)).toEqual(value); expect(f.journal.reconcile).toHaveBeenCalledTimes(1);
  });
  it("still refuses oversized screening before reservation or transport", async () => {
    const f = fixture(), value = input(); value.candidates.forEach(c => { c.abstract = "文".repeat(500); });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(130_000);
    await expect(f.run(value)).rejects.toThrow("limit");
    expect(f.journal.reserve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("counts SDK escaping and framing before dispatch even when the prompt itself fits", async () => {
    const f = fixture(), value = input(); value.candidates = [];
    value.base = { ...value.base, claims: [{ claimNo: 1, text: '"'.repeat(40_000), dependsOn: [] }] };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(130_000);
    const error = await f.run(value).catch(e => e);
    expect(isAiOperationStopped(error)).toBe(true);
    expect(f.journal.reserve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
});
