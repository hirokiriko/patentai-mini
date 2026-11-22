import type { JSONSchema7 } from "ai";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const invalid = () => new Error("comparison_source_actor_locator_invalid");

/** Retain the established transport for a schema already at the provider's
 * property boundary; a syntax aid must not reject an otherwise valid plan. */
export function sourceActorSchemaRoom(schema: JSONSchema7): boolean {
  const used = new Set<string>();
  const count = (v: unknown): number => {
    if (!record(v)) return Array.isArray(v) ? v.reduce((n, child) => n + count(child), 0) : 0;
    let n = 0;
    if (typeof v.$ref === "string" && !used.has(v.$ref)) {
      used.add(v.$ref); n += count(schema.definitions?.[v.$ref.split("/").at(-1)!]);
    }
    n += record(v.properties) ? Object.keys(v.properties).length : 0;
    return n + Object.entries(v).reduce((sum, [key, child]) => sum + (key === "definitions" ? 0 : count(child)), 0);
  };
  return count(schema) + 4 <= 100;
}

/** Convert only this module's fictional direct-actor examples to wire syntax. */
export const sourceActorLocatorExamples = (system: string) => system.replace(/\bu([=:])\["(\d+)-(\d+):([^"\n]+)"\]/gu,
  (_, separator: string, first: string, last: string, quote: string) =>
    `u${separator}[${JSON.stringify({ first: Number(first), last: Number(last), quote, focus: null })}]`);

/** Provider-facing syntax only. Neither clause numbers nor quote text select an
 * actor; the unchanged exact-quote and semantic validators still decide that. */
export function sourceActorLocatorSchema(clauseCount: number): JSONSchema7 {
  // Enumerate small original grids, not all substrings. Large grids retain
  // integer syntax plus the same authoritative resolver, without a new cap.
  const index: JSONSchema7 = { type: "integer", ...(clauseCount <= 128 ?
    { enum: Array.from({ length: clauseCount }, (_, i) => i) } : {}) };
  return { type: "object", properties: {
    first: index, last: structuredClone(index),
    quote: { type: "string" }, focus: { anyOf: [{ type: "string" }, { type: "null" }] },
  }, required: ["first", "last", "quote", "focus"], additionalProperties: false,
  description: "Exact actor/mode locator: first/last are inclusive original clause IDs, quote is the exact outer text, focus is null or a unique exact substring inside quote. Every actor term uses this object, never a bare string. Example: {first:0,last:0,quote:\"制御器は\",focus:\"制御器\"}. Full original context remains authoritative." };
}

/** Lossless spelling of a supplied locator, not actor inference or correction.
 * Existing direct/focus quotations keep their original strict receiving path. */
export function sourceActorLocatorFact(row: Record<string, unknown>): Record<string, unknown> {
  if (!record(row.m) || !Array.isArray(row.m.u)) return row;
  const u = row.m.u.map(value => {
    if (!record(value) || !["first", "last", "quote", "focus"].some(key => Object.hasOwn(value, key)) ||
        Object.hasOwn(value, "reference")) return value;
    if (Object.keys(value).length !== 4 || !["first", "last", "quote", "focus"].every(key => Object.hasOwn(value, key)) ||
        !Number.isSafeInteger(value.first) || !Number.isSafeInteger(value.last) ||
        typeof value.quote !== "string" || (value.focus !== null && typeof value.focus !== "string")) throw invalid();
    const reference = `${value.first}-${value.last}:${value.quote}`;
    return value.focus === null ? reference : { reference, focus: value.focus };
  });
  return { ...row, m: { ...row.m, u } };
}
