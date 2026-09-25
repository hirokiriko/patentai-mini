import { z } from "zod";
import { ManagedWatchError } from "./managed-types";

// Reviewed, tax/margin-inclusive rates rounded up to whole JPY per million.
// Integer numerators avoid rounding down each request. These are estimates,
// not a guarantee about delayed provider billing or observed token counts.
export const managedWatchAiRatesSchema = z.object({
  inputYenPerMillion: z.number().int().positive().max(1_000_000),
  outputYenPerMillion: z.number().int().positive().max(1_000_000),
}).strict();
export const managedWatchAiBudgetSchema = managedWatchAiRatesSchema.extend({
  maximumYen: z.number().int().positive().max(30_000),
}).strict();
export type ManagedWatchAiBudget = z.infer<typeof managedWatchAiBudgetSchema>;
const quantity = z.object({ estimatedInputTokens: z.number().int().positive().max(150_000),
  maximumOutputTokens: z.number().int().positive().max(8192) });

/** Include every previous reservation, even reconciled or unknown dispatches.
 * The caller holds the run lock and writes the next request in that transaction. */
export function requireManagedWatchCost(value: ManagedWatchAiBudget,
  entries: readonly { estimatedInputTokens: number; maximumOutputTokens: number }[]) {
  const budget = managedWatchAiBudgetSchema.parse(value);
  if (!entries.length || entries.length > 41) throw new ManagedWatchError("limit");
  let numerator = 0;
  for (const entry of entries) {
    const q = quantity.parse(entry);
    numerator += q.estimatedInputTokens * budget.inputYenPerMillion + q.maximumOutputTokens * budget.outputYenPerMillion;
  }
  if (!Number.isSafeInteger(numerator) || numerator > budget.maximumYen * 1_000_000) throw new ManagedWatchError("limit");
}
