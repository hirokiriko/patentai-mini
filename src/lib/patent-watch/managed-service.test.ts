import { describe, expect, it } from "vitest";
import { validateManagedScreening } from "./managed-service";
import { managedBaseDigest, type ManagedRun } from "./managed-types";
import { managedClaimContext } from "./managed-claims";
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
