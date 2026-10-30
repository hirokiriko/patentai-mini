import { fictionalInputs } from "./fixtures.test-support";
import { parseComparisonSource } from "./source";
import { fixtureDeclareClauseReading } from "../../../scripts/prior-art-proposition-fixture.mjs";
import { fictionalPropositionSource } from "./proposition-fixtures.test-support";

/** These specific small SDK mocks explicitly declare reading their complete
 * own clauses. This is plumbing, never acceptance of a real model's omission. */
export function fictionalClauseSource(input: Parameters<typeof fictionalPropositionSource>[0]) {
  return fixtureDeclareClauseReading(fictionalPropositionSource(input),input) as ReturnType<typeof fictionalPropositionSource>;
}

/** Small complete hand-authored SDK example. The separate long-original
 * transport fixture remains unchanged; its partial mock is not a complete
 * reading of its hundreds of repeated propositions. Neither is real AI QA. */
export function fictionalClauseInputs() {
  const f = fictionalInputs();
  const text = (low:boolean) => "【請求項1】装置は青色弁を備える。末尾条件は温度が七度を" +
    (low ? "下回ると青色弁を開く" : "超えると青色弁を閉じる") + "ことである。";
  f.inputs.draft = parseComparisonSource(text(false),f.inputs.draft.id,f.inputs.draft.label);
  f.inputs.documents = f.inputs.documents.map((d,i)=>parseComparisonSource(text(i===1),d.id,d.label));
  return f;
}
