import { jsonSchema, type JSONSchema7, type Schema } from "ai";

// Source-only wire spelling. Values, quoted text and evidence selections are
// unchanged; target v1 and the internal domain validator use their own schema.
const names: Record<string, string> = {
  locatorVersion:"v", sources:"ss", sourceDigest:"sd", claims:"cc", claimNo:"cn",
  requiredLoops:"rr", facts:"ff", basis:"bb", firstPart:"fp", lastPart:"lp",
  locators:"ll", basisIndex:"bi", quote:"q", occurrence:"o", meaning:"mm",
  operators:"op", routeFrame:"rf", subject:"su", context:"cx", guardRelation:"gr",
  guardConditions:"gc", polarity:"po", kind:"ki", selection:"se", extent:"ex",
  members:"me", origin:"or", destination:"de", via:"vi", bypass:"by",
  relation:"re", predicate:"pr", objects:"ob", guard:"gu",
  entry:"en", exit:"et", route:"rt", exclusions:"ec", controls:"ct",
};
const reverse = new Map(Object.entries(names).map(([full, short]) => [short, full]));
const invalid = () => new Error("comparison_source_wire_invalid");
function spelling(name: string) { const short=names[name]; if(!short)throw invalid();return short; }
function schemaSpelling(value: unknown): unknown {
  if(Array.isArray(value))return value.map(schemaSpelling);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).map(([key,child]) => {
    if(key==="properties")return [key,Object.fromEntries(Object.entries(child as Record<string,unknown>)
      .map(([name,definition])=>[spelling(name),schemaSpelling(definition)]))];
    if(key==="required")return [key,(child as string[]).map(spelling)];
    return [key,schemaSpelling(child)];
  }));
}
export function expandSourceWire(value: unknown): unknown {
  if(Array.isArray(value))return value.map(expandSourceWire);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).map(([key,child])=>{
    const full=reverse.get(key);if(!full)throw invalid();
    return [full,expandSourceWire(child)];
  }));
}
export function compactSourceWire(value: unknown): unknown {
  if(Array.isArray(value))return value.map(compactSourceWire);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).map(([key,child])=>[spelling(key),compactSourceWire(child)]));
}
export function sourceWireSchema<T>(base: Schema<T>): Schema<T> {
  return jsonSchema<T>(schemaSpelling(base.jsonSchema) as JSONSchema7, { validate: async value => {
    try {
      if(Buffer.byteLength(JSON.stringify(value),"utf8")>32_000)throw invalid();
      if(!base.validate)throw invalid();
      return await base.validate(expandSourceWire(value));
    } catch { return {success:false,error:invalid()}; }
  } });
}
