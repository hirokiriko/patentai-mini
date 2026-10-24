import { describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { fictionalSaved, fictionalAnswer } from "./fixtures.test-support";
import { makePlan, savedDigest, validateAnswer } from "./comparison";
import { parseComparisonSource } from "./source";
import { comparisonBlocks, comparisonCsv } from "./report";
import { neutralizeFormula } from "../patent-watch/csv";

describe("complete comparison export", () => {
  it.each(["=", "+", "-", "@", "\u200b="])("preserves whole cells and neutralizes formula prefix %s", prefix => {
    const saved = fictionalSaved();
    const text = `${prefix}架空(\"Unicode𠮷,é\")\n温度を測定する装置。`;
    saved.inputs.draft = parseComparisonSource(`【請求項1】\n${text}`, 11, "draft-11");
    saved.pairs = makePlan(saved.inputs,saved.selection).flatMap(chunk => validateAnswer(chunk,fictionalAnswer(chunk)));
    saved.snapshotDigest = savedDigest(saved);
    const expected = [["区分","内容"],...comparisonBlocks(saved,true).map(b => [b.heading?"見出し":"本文",neutralizeFormula(b.text)])];
    const rows = parse(comparisonCsv(saved,true),{bom:true});
    expect(rows).toEqual(expected);
    expect(rows.some((r:string[])=>r[1] === "'"+text)).toBe(true);
  });
});
