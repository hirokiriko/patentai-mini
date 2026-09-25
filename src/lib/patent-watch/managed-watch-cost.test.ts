import { afterEach, expect, it, vi } from "vitest";
import { boundedAzureFetch, withManagedWatchBudget } from "../ai-operation-budget";
import { requireManagedWatchCost, type ManagedWatchAiBudget } from "./managed-watch-cost";
import { executeManagedRun } from "./managed-service";
import type { ManagedWatchRepository } from "../../repositories/managed-watch";

const rates = { inputYenPerMillion: 500, outputYenPerMillion: 3000 };
afterEach(() => vi.unstubAllGlobals());
it("accepts the exact integer boundary and rejects the next input token", () => {
  const entry = { estimatedInputTokens: 2000, maximumOutputTokens: 1000 }, budget = { ...rates, maximumYen: 4 };
  expect(() => requireManagedWatchCost(budget, [entry])).not.toThrow();
  expect(() => requireManagedWatchCost(budget, [{ ...entry, estimatedInputTokens: 2001 }])).toThrow("limit");
  expect(() => requireManagedWatchCost(budget, [entry, entry])).toThrow("limit");
});
it.each([undefined, { ...rates, maximumYen: 0 }, { ...rates, maximumYen: 1.1 },
  { ...rates, maximumYen: 400, inputYenPerMillion: Number.MAX_SAFE_INTEGER },
  { ...rates, maximumYen: 400, outputYenPerMillion: 0 }])("rejects missing or invalid reviewed rates/cap %#", value => {
  expect(() => requireManagedWatchCost(value as ManagedWatchAiBudget, [{ estimatedInputTokens: 1, maximumOutputTokens: 1 }])).toThrow();
});
it("rejects an unpriced worker before claiming a run", async () => {
  const claim = vi.fn();
  await expect(executeManagedRun({ claim } as unknown as ManagedWatchRepository, 1, "fictional", "fictional")).rejects.toThrow();
  expect(claim).not.toHaveBeenCalled();
});
it.each(["reconciled", "ack-lost"])("keeps %s reservations and stops before any excess transport", async mode => {
  const entries: { estimatedInputTokens: number; maximumOutputTokens: number }[] = [];
  const transport = vi.fn(async () => new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }));
  vi.stubGlobal("fetch", transport);
  const reconcile = vi.fn(async () => {});
  await withManagedWatchBudget({ consumed: 0, deadlineAt: Date.now() + 60_000,
    journal: { reserve: async entry => {
      requireManagedWatchCost({ ...rates, maximumYen: 40 }, [...entries, entry]); entries.push(entry);
      if (mode === "ack-lost") throw Error("FICTIONAL_ACK_LOST");
    }, reconcile } }, async () => {
    const send = () => boundedAzureFetch("normal")("https://fictional.openai.azure.com/openai/responses", {
      method: "POST", body: JSON.stringify({ model: "fictional", input: [], max_output_tokens: 8192,
        text: { format: { type: "json_schema", schema: { type: "object" } } } }) });
    if (mode === "reconciled") await expect(send()).resolves.toBeInstanceOf(Response);
    else await expect(send()).rejects.toThrow();
    await expect(send()).rejects.toThrow(); await expect(send()).rejects.toThrow();
  });
  expect(entries).toHaveLength(1);
  expect(transport).toHaveBeenCalledTimes(mode === "reconciled" ? 1 : 0);
  expect(reconcile).toHaveBeenCalledTimes(mode === "reconciled" ? 1 : 0);
});
