import { expect, it, vi } from "vitest";
import { operateManagedBudgetAdministration } from "./managed-budget-admin";
import { managedBudgetStateSchema, MANAGED_SERVICE_KEY } from "../src/lib/patent-watch/managed-service-budget";

const hash = "a".repeat(64), pins = { publicKeySpkiBase64: "FICTIONAL_PUBLIC_KEY", publicKeySha256: hash, ownerBindingHash: hash, targetBindingHash: hash };
function store() { return { snapshot: vi.fn(async () => managedBudgetStateSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY,
  targetBindingHash: hash, activeProfileDigest: null, cases: [1], lastTrustedAt: "2026-09-23T00:00:00Z", releaseTailYen: 2000,
  legacyUnknownYen: 600, openingEvidenceDigest: hash, administration: [], operations: [],
  plans: [{ month: "2026-09", baseYen: 1000, pools: { remaining: 1000, storage: 1000, recovery: 1000 }, pricingDigest: hash, evidenceDigests: [hash] }] })),
  applyReviewedAdministration: vi.fn(async () => ({ status: "applied" as const })),
  settleReviewed: vi.fn(async () => ({ status: "applied" as const })) }; }
it("returns a bounded summary without ledger identifiers or raw evidence", async () => {
  const s = store(), result = await operateManagedBudgetAdministration({ command: "status" }, s, pins);
  expect(result).toMatchObject({ status: "observed", forecastYen: 4600, operationCount: 0, profileActive: false });
  expect(JSON.stringify(result)).not.toContain(hash); expect(result).not.toHaveProperty("cases");
  expect(s.applyReviewedAdministration).not.toHaveBeenCalled(); expect(s.settleReviewed).not.toHaveBeenCalled();
});
it.each(["review-apply", "review-reconcile", "settlement-apply", "settlement-reconcile"])("routes %s using only an evidence digest", async command => {
  const s = store(); await operateManagedBudgetAdministration({ command, evidenceDigest: hash }, s, pins);
  const fn = command.startsWith("review-") ? s.applyReviewedAdministration : s.settleReviewed;
  expect(fn).toHaveBeenCalledWith(hash, pins, command.endsWith("-reconcile"));
});
it.each([{ command: "review-apply", evidenceDigest: hash, actualYen: 0 }, { command: "reset" },
  { command: "settlement-apply", evidenceDigest: hash, publicKey: "FICTIONAL" }, { command: "status", target: hash }])(
  "rejects unreviewed amounts, pins, targets, and reset commands before any storage access", async request => {
    const s = store(); await expect(operateManagedBudgetAdministration(request, s, pins)).rejects.toThrow("managed_budget_stopped");
    expect(s.snapshot).not.toHaveBeenCalled(); expect(s.applyReviewedAdministration).not.toHaveBeenCalled(); expect(s.settleReviewed).not.toHaveBeenCalled();
  });
