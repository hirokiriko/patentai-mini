/** Server-owned admission switch. Existing operations and saved reads are unaffected. */
export function comparisonEnabled(): boolean {
  return process.env.PRIOR_ART_COMPARISON_ENABLED === "1";
}
