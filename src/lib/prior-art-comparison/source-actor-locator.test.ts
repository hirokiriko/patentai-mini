import { expect, it } from "vitest";
import { sourceActorLocatorFact, sourceActorLocatorSchema, sourceActorLocatorExamples } from "./source-actor-locator";
import { sourceReadingClaim } from "./source-clause-coverage";
import { claimLiteralDictionary, mapClaimLiteralFact } from "./source-claim-literal-refs";

const locator = { first: 0, last: 0, quote: "制御器", focus: null };
const fact = (u: unknown) => ({ m: { u }, O: [null, null, null, null, null], F: null });
it("constrains provider actor elements to typed objects and actual original clause IDs without unsupported string patterns", () => {
  const schema = sourceActorLocatorSchema(3);
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["first", "last", "quote", "focus"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties!.first).toEqual({ type: "integer", enum: [0, 1, 2] });
  expect((sourceActorLocatorSchema(128).properties!.first as {enum:number[]}).enum).toHaveLength(128);
  expect(sourceActorLocatorSchema(129).properties!.first).toEqual({type:"integer"});
  expect(sourceActorLocatorSchema(12000).properties!.first).toEqual({type:"integer"});
  expect(JSON.stringify(schema)).not.toContain('"pattern"');
  expect(sourceActorLocatorExamples('u=["0-0:制御器"] u:null J=[["0-0:制御器"]]'))
    .toBe('u=[{"first":0,"last":0,"quote":"制御器","focus":null}] u:null J=[["0-0:制御器"]]');
});
it("preserves direct/focused/compound old quotations and absent actor without inventing text", () => {
  for (const u of [null, ["0-0:制御器"], [{ reference: "0-0:制御器は", focus: "制御器" }], []]) {
    expect(sourceActorLocatorFact(fact(u))).toEqual(fact(u));
  }
  const raw = fact([locator, { first: 1, last: 2, quote: "青、赤", focus: "赤" }]), before = structuredClone(raw);
  expect(sourceActorLocatorFact(raw)).toEqual(fact(["0-0:制御器", { reference: "1-2:青、赤", focus: "赤" }]));
  expect(raw).toEqual(before);
});
it.each([
  { first: "0" },
  { quote: null }, { focus: 1 }, { extra: true },
])("rejects malformed typed actor locators without fallback: %j", change => {
  expect(() => sourceActorLocatorFact(fact([{ ...locator, ...change }]))).toThrow();
});
it("keeps original exact-substring and ambiguity rejection after lossless actor spelling", () => {
  const c = sourceReadingClaim(1, "制御器と制御器は、赤弁を開く。"), apply = (u: unknown) =>
    mapClaimLiteralFact(sourceActorLocatorFact(fact(u)), claimLiteralDictionary(c));
  for (const u of [[":["], [{ ...locator, quote: "存在しない主体" }], [locator],
    [{ ...locator, quote: "制御器と制御器は", focus: "制御器" }],
    [{...locator,first:-1}], [{...locator,first:1,last:0}], [{...locator,last:2}],
    [{...locator,quote:""}], [{...locator,focus:""}], [{...locator,quote:"制御器".repeat(5000)}]]) expect(() => apply(u)).toThrow();
  expect(() => apply([{ ...locator, quote: "と制御器は", focus: "制御器" }])).not.toThrow();
  expect(() => apply([{ ...locator, last: 12 }])).toThrow();
});
