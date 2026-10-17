/** A marker only, never a claim of validity; full readers validate the envelope. */
export function hasSavedComparisonMarker(json: string | null): boolean {
  try {
    const value = JSON.parse(json || "null");
    return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "priorArtComparison");
  } catch { return /"priorArtComparison"\s*:/.test(json || ""); }
}
