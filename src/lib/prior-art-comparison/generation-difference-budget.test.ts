import { expect, it } from "vitest";
import { z } from "zod";
import { budgetedDifferences, assertDifferenceSchemaCapacity } from "./generation-difference-budget";
import { comparisonModelSchema } from "./model-schema";

const bundle = (...ids: string[]) => JSON.stringify([...ids].sort((a, b) => a.localeCompare(b)));
type Node = { $ref?: string; enum?: unknown[]; anyOf?: Node[]; type?: string;
  properties?: Record<string, Node>; additionalProperties?: boolean };

// Match the actual provider enum/anyOf/ref structure, including the constraint
// that survives conversion. No local Zod refine or description can pass here.
function matches(node: Node, value: unknown, root: Node = node): boolean {
  if (node.$ref) {
    const target = node.$ref.split("/").slice(1).reduce<unknown>((item, key) =>
      (item as Record<string, unknown>)[key], root);
    return matches(target as Node, value, root);
  }
  if (node.anyOf) return node.anyOf.some(child => matches(child, value, root));
  if (node.enum && !node.enum.includes(value)) return false;
  if (node.type === "string") return typeof value === "string";
  if (node.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>, fields = node.properties ?? {};
    return Object.keys(record).sort().join() === Object.keys(fields).sort().join() &&
      Object.entries(fields).every(([key, schema]) => matches(schema, record[key], root));
  }
  return true;
}

it.each(["base", "candidate", "both"])("keeps independently meaningful short additions on either side with %s mandatory", required => {
  const base = [{ id: "b.parent", length: 65 }, { id: "b.condition", length: 20 }];
  const candidate = [{ id: "c.parent", length: 75 }, { id: "c.other", length: 25 }];
  const before = JSON.stringify({ base, candidate });
  const differences = budgetedDifferences("base", "candidate", base, candidate,
    required === "candidate" ? undefined : ["b.parent"], required === "base" ? undefined : ["c.parent"]);
  const schema = z.object({ differences }).strict(), wire = comparisonModelSchema(schema).jsonSchema as Node;
  const value = { differences: { baseFacts: bundle("b.parent", "b.condition"), candidateFacts: bundle("c.parent", "c.other") } };
  expect(schema.safeParse(value).success).toBe(true);
  expect(matches(wire, value)).toBe(true);
  expect(JSON.stringify({ base, candidate })).toBe(before);
  assertDifferenceSchemaCapacity(schema);
});

it("accepts combined200 and refuses201,260,wrong scope,duplicates at the provider wire", () => {
  const differences = budgetedDifferences("base", "candidate", [{ id: "b", length: 85 }], [
    { id: "c.parent", length: 110 }, { id: "c.five", length: 5 },
    { id: "c.six", length: 6 }, { id: "c.child", length: 65 },
  ], undefined, ["c.parent"]);
  const schema = z.object({ differences }).strict(), wire = comparisonModelSchema(schema).jsonSchema as Node;
  const value = (candidateFacts: string) => ({ differences: { baseFacts: bundle("b"), candidateFacts } });
  for (const ids of [["c.parent"], ["c.parent", "c.five"]]) {
    expect(schema.safeParse(value(bundle(...ids))).success).toBe(true);
    expect(matches(wire, value(bundle(...ids)))).toBe(true);
  }
  for (const ids of [["c.parent", "c.six"], ["c.parent", "c.child"], ["c.parent", "b"], ["c.parent", "c.parent"], ["c.child"]]) {
    expect(schema.safeParse(value(bundle(...ids))).success).toBe(false);
    expect(matches(wire, value(bundle(...ids)))).toBe(false);
  }
});

it("preserves different-length mandatory choices and either ordering of source metadata", () => {
  const base = [{ id: "b", length: 85 }], candidate = [
    { id: "c.long", length: 110 }, { id: "c.short", length: 70 }, { id: "c.extra", length: 35 },
  ];
  const first = budgetedDifferences("base", "candidate", base, candidate, undefined, ["c.long", "c.short"]);
  const second = budgetedDifferences("base", "candidate", base, [...candidate].reverse(), undefined, ["c.short", "c.long"]);
  expect(first.safeParse({ baseFacts: bundle("b"), candidateFacts: bundle("c.short", "c.extra") }).success).toBe(true);
  expect(first.safeParse({ baseFacts: bundle("b"), candidateFacts: bundle("c.long", "c.extra") }).success).toBe(false);
  expect(comparisonModelSchema(z.object({ differences: first })).jsonSchema).toEqual(
    comparisonModelSchema(z.object({ differences: second })).jsonSchema);
});

it("refuses an unrepresentable full selection rather than silently dropping choices", () => {
  const facts = Array.from({ length: 46 }, (_, index) => ({ id: `b${index}`, length: 10 }));
  expect(() => budgetedDifferences("base", "candidate", facts, [{ id: "c", length: 10 }], undefined, ["c"]))
    .toThrow("plan_limit");
});

it("enforces Azure capacity before a generation request, including shared references", () => {
  const tooManyProperties = z.object(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, z.string()]))).strict();
  expect(() => assertDifferenceSchemaCapacity(tooManyProperties)).toThrow("plan_limit");
  expect(() => assertDifferenceSchemaCapacity(z.object({ id: z.enum(Array.from({ length: 1001 }, (_, index) => `f${index}`)) }).strict()))
    .toThrow("plan_limit");
  let nested: z.ZodType = z.string();
  for (let depth = 0; depth < 6; depth++) nested = z.object({ child: nested }).strict();
  expect(() => assertDifferenceSchemaCapacity(nested)).toThrow("plan_limit");
});
