import { z } from "zod";
import { ComparisonError, digest } from "./source";
import { comparisonModelSchema } from "./model-schema";

export type DifferenceFact = { id: string; length: number };
type Bundle = { ids: string[]; length: number };

/** Enumerate each side independently. Never construct the Cartesian product of
 * base and candidate bundles. Every selected fact is still printed in full. */
function bundles(facts: readonly DifferenceFact[], required: readonly string[] | undefined, maximum: number): Bundle[] {
  const result: Bundle[] = [];
  const append = (selected: readonly DifferenceFact[]) => {
    const length = selected.reduce((sum, fact) => sum + fact.length, 0);
    if (length > maximum || required && !selected.some(fact => required.includes(fact.id))) return;
    result.push({ ids: selected.map(fact => fact.id), length });
    if (result.length > 1000) throw new ComparisonError("plan_limit");
  };
  const ordered = [...facts].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, fact] of ordered.entries()) {
    append([fact]);
    for (const second of ordered.slice(index + 1)) append([fact, second]);
  }
  return result;
}

type EnumCache = Map<string, z.ZodType<string>>;

function namedEnum(cache: EnumCache, id: string, values: string[]) {
  const existing = cache.get(id);
  if (existing) return existing;
  const schema = z.enum(values).meta({ id });
  cache.set(id, schema);
  return schema;
}

function groups(scope: string, values: readonly Bundle[], cache: EnumCache) {
  const lengths = [...new Set(values.map(value => value.length))].sort((a, b) => a - b);
  return lengths.map(length => {
    const choices = values.filter(value => value.length === length).map(value => JSON.stringify(value.ids)).sort();
    const schema = namedEnum(cache, `DifferenceBundle_${digest({ scope, length, choices })}`, choices);
    return { length, choices, schema };
  });
}

function choice(schemas: z.ZodType[]) {
  if (schemas.length === 1) return schemas[0];
  return z.union(schemas);
}

/** A provider-supported anyOf/enum/$ref contract enforces the combined budget.
 * A bundle is an exact JSON-encoded array of existing IDs, never patent prose.
 * Canonical ordering removes only duplicate permutations, not fact choices. */
export function budgetedDifferences(baseScope: string, candidateScope: string,
  baseFacts: readonly DifferenceFact[], candidateFacts: readonly DifferenceFact[],
  requiredBase: readonly string[] | undefined, requiredCandidate: readonly string[] | undefined,
  enumLayout: "shared" | "flat" = "shared", enums: EnumCache = new Map()) {
  const minimum = (facts: readonly DifferenceFact[], required: readonly string[] | undefined) =>
    Math.min(...facts.filter(fact => !required || required.includes(fact.id)).map(fact => fact.length));
  const base = groups(baseScope, bundles(baseFacts, requiredBase, 200 - minimum(candidateFacts, requiredCandidate)), enums);
  const candidate = groups(candidateScope, bundles(candidateFacts, requiredCandidate, 200 - minimum(baseFacts, requiredBase)), enums);
  const dispatchBase = base.length <= candidate.length;
  const oppositeScope = dispatchBase ? candidateScope : baseScope;
  const thresholds = new Map<number, z.ZodType>();
  const branches = (dispatchBase ? base : candidate).flatMap(group => {
    const others = (dispatchBase ? candidate : base).filter(other => group.length + other.length <= 200);
    if (!others.length) return [];
    // Equal thresholds admit exactly the same opposite bundles. Reuse a single
    // enum instead of repeatedly nesting a union of string-enum references.
    let opposite = thresholds.get(others.length);
    if (!opposite) {
      if (enumLayout === "flat" && others.length > 1) {
        const choices = others.flatMap(other => other.choices);
        opposite = namedEnum(enums, `DifferenceChoices_${digest({ oppositeScope, choices })}`, choices);
      } else {
        opposite = choice(others.map(other => other.schema));
      }
      thresholds.set(others.length, opposite);
    }
    // Distinct branch keys keep the length dispatch unambiguous without an
    // extra object level. The receiver restores the original two side names.
    return [z.object(dispatchBase
      ? { [`baseFactsLength${group.length}`]: group.schema, candidateFacts: opposite }
      : { [`candidateFactsLength${group.length}`]: group.schema, baseFacts: opposite }).strict()];
  });
  if (!branches.length) throw new ComparisonError("plan_limit");
  return choice(branches);
}

/** Azure counts shared definitions once for capacity and expands references for
 * nesting. Reject a whole unrepresentable plan before its generation request. */
export function differenceSchemaBytes(schema: z.ZodType) {
  const wire = comparisonModelSchema<unknown>(schema).jsonSchema;
  let properties = 0, enumValues = 0, oversizedEnum = false;
  const scan = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.properties) properties += Object.keys(node.properties).length;
    if (Array.isArray(node.enum)) {
      enumValues += node.enum.length;
      if (node.enum.length > 250 && node.enum.join("").length > 15000) oversizedEnum = true;
    }
    Object.values(node).forEach(child => Array.isArray(child) ? child.forEach(scan) : scan(child));
  };
  const depth = (value: unknown, current = 0): number => {
    if (!value || typeof value !== "object") return current;
    const node = value as Record<string, unknown>;
    if (typeof node.$ref === "string") {
      const target = node.$ref.split("/").slice(1).reduce<unknown>((item, key) =>
        (item as Record<string, unknown>)[key], wire);
      return depth(target, current);
    }
    const next = current + Number(node.type === "object");
    const children = [Object.values(node.properties ?? {}), node.items, node.anyOf].flat(2).filter(Boolean);
    return Math.max(next, ...children.map(child => depth(child, next)));
  };
  scan(wire);
  const bytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
  return oversizedEnum || properties > 100 || enumValues > 1000 || depth(wire) > 5 || bytes > 120000
    ? Infinity : bytes;
}
