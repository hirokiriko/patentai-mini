import { zodSchema, jsonSchema, type JSONSchema7, type Schema } from "ai";
import type { z } from "zod";

// Azure Responses accepts a JSON Schema subset. Zod's draft-7 conversion
// emits oneOf and tuple items unchanged; the SDK does not adapt them for us.
// Keep the exact Zod validator at the receiving boundary. The wire schema is
// only a generation constraint, never permission to accept a weaker answer.
const localKeywords = new Set(["minLength", "maxLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems"]);
const supportedKeywords = new Set(["type", "enum", "const", "properties", "required",
  "additionalProperties", "items", "anyOf", "oneOf", "$ref", "$defs", "definitions",
  "$schema", "id", "description", "title"]);
const invalid = () => new Error("comparison_model_schema_invalid");

function wireSchema(input: JSONSchema7, definitions: JSONSchema7["definitions"]): JSONSchema7 {
  const output: JSONSchema7 = {};
  const local: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (localKeywords.has(key)) { local[key] = value; continue; }
    if (!supportedKeywords.has(key)) throw invalid();
    if (key === "$schema" || key === "id") continue;
    if (key === "properties" || key === "definitions" || key === "$defs") {
      output[key] = Object.fromEntries(Object.entries(value as Record<string, JSONSchema7>)
        .map(([name, child]) => [name, wireSchema(child, definitions)]));
    } else if (key === "oneOf" || key === "anyOf") {
      if (input.oneOf && input.anyOf) throw invalid();
      output.anyOf = (value as JSONSchema7[]).map(child => wireSchema(child, definitions));
    } else if (key === "items") {
      if (Array.isArray(value)) {
        // The only tuple in this domain is the two integer UTF16 coordinates.
        // Do not silently broaden a heterogeneous or future tuple shape.
        const items = value.map(child => wireSchema(child, definitions));
        if (items.length !== 2 || items.some(item => item.type !== "integer")) throw invalid();
        output.items = { type: "integer", description: "UTF16 [start,end) coordinates; exactly two integers." };
      } else {
        if (!value || typeof value !== "object") throw invalid();
        output.items = wireSchema(value as JSONSchema7, definitions);
      }
    } else if (key === "const") {
      output.enum = [value];
    } else {
      Object.assign(output, { [key]: value });
    }
  }
  if (Object.keys(local).length) {
    output.description = [output.description, `Constraints: ${JSON.stringify(local)}`].filter(Boolean).join(" ");
  }
  if (output.type === "object") {
    const fields = Object.keys(output.properties ?? {});
    if (output.additionalProperties !== false || !output.required ||
        fields.length !== output.required.length || fields.some(field => !output.required!.includes(field))) throw invalid();
    if (fields.includes("kind") && fields.includes("guard") && fields.includes("polarity")) {
      const guard = output.properties!.guard;
      if (typeof guard !== "object" || guard.$ref !== "#/definitions/PriorArtGuard" ||
          fields.includes("guardRelation") || fields.includes("guardConditions")) throw invalid();
      const original = definitions?.PriorArtGuard;
      if (!original || typeof original !== "object") throw invalid();
      const converted = wireSchema(original, definitions);
      if (converted.type !== "object" || Object.keys(converted.properties ?? {}).sort().join(",") !== "conditions,relation") throw invalid();
      // The target's meaning is already the fifth object level. Flatten only
      // its guard on the wire, then reconstruct the same guard before validation.
      const properties: NonNullable<JSONSchema7["properties"]> = {};
      for (const [field, definition] of Object.entries(output.properties!)) {
        if (field === "guard") {
          properties.guardRelation = converted.properties!.relation;
          properties.guardConditions = converted.properties!.conditions;
        } else properties[field] = definition;
      }
      output.properties = properties;
      output.required = Object.keys(properties);
    }
  }
  return output;
}

function restoreGuards(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreGuards);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const restored = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, restoreGuards(child)]));
  if (["set", "path", "relation"].includes(String(record.kind)) || "guardRelation" in record || "guardConditions" in record) {
    if ("guard" in record || !("guardRelation" in record) || !("guardConditions" in record)) throw invalid();
    restored.guard = { relation: restored.guardRelation, conditions: restored.guardConditions };
    delete restored.guardRelation; delete restored.guardConditions;
  }
  return restored;
}

export function comparisonModelSchema<T>(schema: z.ZodType<T>): Schema<T> {
  const converted = zodSchema(schema).jsonSchema;
  // The installed Zod conversion is synchronous. Reject an asynchronous
  // schema before estimating or sending rather than serializing a Promise.
  if (typeof (converted as {then?:unknown}).then === "function") throw invalid();
  const original = converted as JSONSchema7;
  const wire = wireSchema(original, original.definitions);
  // Guard fields are now in each meaning. Do not send its unused definition.
  if (!JSON.stringify(wire).includes('"$ref":"#/definitions/PriorArtGuard"')) delete wire.definitions?.PriorArtGuard;
  if (wire.type !== "object" || wire.anyOf) throw invalid();
  return jsonSchema<T>(wire, {
    validate: value => {
      try {
        const parsed = schema.safeParse(restoreGuards(value));
        if (parsed.success) return { success: true, value: parsed.data };
      } catch { /* Never expose invalid model output through the error. */ }
      return { success: false, error: new Error("comparison_answer_schema_invalid") };
    },
  });
}
