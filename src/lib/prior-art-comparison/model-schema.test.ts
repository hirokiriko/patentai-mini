import { describe, expect, it } from "vitest";
import { asSchema } from "ai";
import { z } from "zod";
import { comparisonModelSchema } from "./model-schema";
import { sourcePropositionSchema, targetPropositionSchema } from "./proposition-extraction";
import { meaningSchema, spanSchema, type Meaning } from "./propositions";

describe("comparison Responses schema and unchanged local validation", () => {
  it.each<z.ZodType>([sourcePropositionSchema, targetPropositionSchema])("removes unsupported generated keywords, retaining required fields and strict objects", schema => {
    const before = JSON.stringify(asSchema(schema).jsonSchema);
    expect(before).toContain('"oneOf"');
    const wire = comparisonModelSchema(schema).jsonSchema;
    let objects = 0, alternatives = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const object = value as Record<string, unknown>;
      for (const unsupported of ["oneOf", "const", "prefixItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems"])
        expect(object).not.toHaveProperty(unsupported);
      if (object.type === "object") {
        objects++;
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(Object.keys(object.properties as object));
      }
      if (object.anyOf) alternatives++;
      if (object.items) expect(Array.isArray(object.items)).toBe(false);
      Object.values(object).forEach(visit);
    };
    visit(wire); expect(objects).toBeGreaterThan(5); expect(alternatives).toBeGreaterThan(0);
    const depth = (node: unknown, current = 0): number => {
      if (!node || typeof node !== "object") return current;
      const x = node as Record<string, unknown>;
      if (typeof x.$ref === "string") {
        const definition = x.$ref.split("/").slice(1).reduce<unknown>((v,k) => (v as Record<string,unknown>)[k], wire);
        expect(definition).toBeDefined(); return depth(definition,current);
      }
      const next = current + Number(x.type === "object");
      const children = [Object.values(x.properties ?? {}), x.items, x.anyOf].flat(2).filter(Boolean);
      return Math.max(next, ...children.map(child => depth(child, next)));
    };
    expect(depth(wire)).toBeLessThanOrEqual(5);
    expect(JSON.stringify(asSchema(schema).jsonSchema)).toBe(before);
  });

  const semantic = { kind: "set", subject: "架空装置", context: "capability", guard: { relation: "unconditional", conditions: [] },
    polarity: "positive", selection: "required", extent: "closed", members: ["架空機能"] };
  const local = z.object({ span: spanSchema, meaning: meaningSchema }).strict();
  const {guard,...meaning} = semantic;
  const wireMeaning = {...meaning,guardRelation:guard.relation,guardConditions:guard.conditions};
  it("accepts and returns the identical valid semantic object", async () => {
    const value = { span: [0, 4], meaning: semantic };
    expect(await comparisonModelSchema(local).validate!({...value,meaning:wireMeaning})).toEqual({ success: true, value });
  });
  it.each([
    { span: [0] }, { span: [0, 4, 8] }, { span: [-1, 4] }, { span: [0, 0] }, { span: [0, 1.5] },
    { meaning: { ...semantic, subject: "x".repeat(81) } },
    { meaning: { ...semantic, members: [] } },
    { meaning: { ...semantic, members: Array(13).fill("架空") } },
    { meaning: { ...semantic, predicate: "has" } },
    { meaning: { ...semantic, kind: "path" } },
    { meaning: { ...semantic, guard: { relation: "unconditional" } } },
    { meaning: { ...semantic, subject: "private\u0000sentinel" } },
    { extra: "private_sentinel" },
  ])("rejects invalid local constraints without retaining the answer in its error", async change => {
    const original = { span: [0, 4], meaning: semantic, ...change };
    const m = original.meaning as Record<string, unknown>;
    const {guard:g,...rest} = m;
    const converted = g as {relation:unknown;conditions:unknown};
    const result = await comparisonModelSchema(local).validate!({...original,meaning:{...rest,guardRelation:converted.relation,guardConditions:converted.conditions}});
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sentinel");
    if (!result.success) expect(result.error.message).toBe("comparison_answer_schema_invalid");
  });
  it.each([semantic, {...wireMeaning,guard}, {...wireMeaning,guardRelation:undefined}, {...wireMeaning,guardConditions:undefined}])("rejects legacy or mixed guard shapes", async meaning => {
    expect((await comparisonModelSchema(local).validate!({span:[0,4],meaning})).success).toBe(false);
  });
  it.each(["unconditional", "when", "only_when", "unresolved"] as const)("preserves %s guards for every meaning kind, without changing raw wire", async relation => {
    const common = {subject:"架空装置",context:"capability" as const,polarity:"positive" as const};
    const variants: Meaning[] = [
      {...common,kind:"set",guard:{relation,conditions:["温度", "温度", "圧力"]},selection:"required",extent:"closed",members:["機能"]},
      {...common,kind:"path",guard:{relation,conditions:["温度", "温度", "圧力"]},origin:"入口",destination:"出口",via:["弁"],bypass:[],extent:"whole",relation:"route"},
      {...common,kind:"relation",guard:{relation,conditions:["温度", "温度", "圧力"]},predicate:"has",objects:["機能"]},
    ];
    for(const meaning of variants) {
      const {guard,...rest} = meaning;
      const schema = z.object({meaning:meaningSchema,operators:z.object({guard:spanSchema.nullable()}).strict()}).strict();
      const raw = {meaning:{...rest,guardRelation:guard.relation,guardConditions:guard.conditions},operators:{guard:[1,2]}};
      const before = JSON.stringify(raw);
      expect(await comparisonModelSchema(schema).validate!(raw)).toEqual({success:true,value:{meaning,operators:{guard:[1,2]}}});
      expect(JSON.stringify(raw)).toBe(before);
    }
  });
  it("refuses unhandled schemas before a send", () => {
    expect(() => comparisonModelSchema(z.object({ a: z.string().optional() }))).toThrow();
    expect(() => comparisonModelSchema(z.object({ a: z.tuple([z.string(), z.number()]) }).strict())).toThrow();
    expect(() => comparisonModelSchema(z.array(z.string()))).toThrow();
  });
});
