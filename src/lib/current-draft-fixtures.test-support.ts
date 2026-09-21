import type { DraftKind, DraftPatent } from "../repositories/types";
import type { ExtractedClaims } from "./extract-claims";

export const fictionalClaims = (label: string): ExtractedClaims => ({ title: label, abstract: "完全架空の比較試験",
  solvedProblems: [], effects: [], claims: [{ claimNo: 1, text: `${label}の架空請求項`, isIndependent: true,
    dependsOn: null, elements: [{ type: "component", text: "架空プリズム", importance: "core" }] }] });
export const fictionalDraft = (draftId: number, kind: DraftKind = "main", changes: Partial<DraftPatent> = {}): DraftPatent => ({
  draftId, caseId: 7, kind, sourceFilePath: `fictional-${kind}-${draftId}.txt`, parsedText: `架空本文${draftId}`,
  extractedClaimsJson: JSON.stringify(fictionalClaims(`抽出結果${draftId}`)), ...changes,
});
export const mixedDrafts = () => [fictionalDraft(2), fictionalDraft(90, "base"), fictionalDraft(9),
  fictionalDraft(60, "addition"), fictionalDraft(4), fictionalDraft(10, "base"), fictionalDraft(11, "addition")];
