import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { batchSchemaFor, batchTransportInput, generationBatches, requestBytes } from "./generation-batch";
import { LIMITS } from "./limits";
import { ComparisonError } from "./source";
import { sourceAnalysisInput, sourceReadingSchemaFor, SOURCE_ANALYSIS_SYSTEM } from "./source-analysis";

/** Fix one complete batch before reading anything. No post-read repacking,
 * fourth call, partial selection, or reuse of a previous run's index. */
export function separatedGenerationPlan(plan: readonly ManagedComparisonChunk[], system: string) {
  const batches = generationBatches(plan, system);
  if (batches.length !== 1) throw new ComparisonError("plan_limit");
  const batch = batches[0], input = sourceAnalysisInput(batch);
  const maximum = input.sources.map(s => ({ sourceDigest: s.sourceDigest, reading: "\ud800".repeat(90) }));
  if (requestBytes(SOURCE_ANALYSIS_SYSTEM, JSON.stringify(input), sourceReadingSchemaFor(batch)) > LIMITS.inputBytes ||
      requestBytes(system, JSON.stringify(batchTransportInput(batch, maximum)), batchSchemaFor(batch)) > LIMITS.inputBytes) {
    throw new ComparisonError("plan_limit");
  }
  return batch;
}
