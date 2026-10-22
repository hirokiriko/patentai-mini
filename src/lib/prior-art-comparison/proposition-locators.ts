import { z } from "zod";
import { comparisonModelSchema } from "./model-schema";
import { extractionSchema, targetAtomSchema, targetPartSchema,
  targetPropositionSchemaFor, type PropositionTargetInput } from "./proposition-extraction";
import type { Span } from "./propositions";
import { resolvePropositionQuote } from "./proposition-quotes";
export { resolvePropositionQuote } from "./proposition-quotes";
export { sourceClausePropositionModelSchemaFor as sourcePropositionModelSchemaFor } from "./source-clause-wire";

// Quotes live at a shallow level. Nested propositions refer to this table;
// adding a locator object at every span would exceed Azure's five levels.
const index = z.number().int().nonnegative();
const locator = z.object({ quote: z.string().min(1).max(12_000), occurrence: index }).strict();
const spans = {
  basis: z.array(index).min(1).max(12),
  bindings: z.array(z.object({ term: extractionSchema.shape.bindings.element.shape.term,
    spans: z.array(index).min(1).max(4) }).strict()).max(48),
  operators: z.object({ selection:index.nullable(), extent:index.nullable(), polarity:index.nullable(),
    guard:index.nullable(), context:index.nullable() }).strict(),
  routeFrame: z.object({ entry:index, exit:index, route:index,
    exclusions:z.array(index).max(6), controls:z.array(index).max(6) }).strict().nullable(),
};
const wireAtom = targetAtomSchema.extend({...spans, attribution:index.nullable()});
const wirePart = targetPartSchema.extend({span:index.describe("Quote wholly inside one input unitStarts interval; multiple sentences require multiple parts."), atoms:z.array(wireAtom).max(12),
  reservation:z.object({topic:targetPartSchema.shape.reservation.unwrap().shape.topic,
    basis:index.describe("Quote exactly topic, excluding uncertainty suffix; factual clauses are separate parts.")}).strict().nullable()});
export const SOURCE_LOCATOR_MAX_BYTES = 32_000;
export const TARGET_LOCATOR_MAX_BYTES = 64_000;
const invalid = () => new Error("comparison_locator_invalid");

function expandExtraction(raw:Pick<z.infer<typeof wireAtom>,keyof z.infer<typeof extractionSchema>>, get:(index:number)=>Span) {
  const frame=raw.routeFrame;
  return {...raw, basis:raw.basis.map(get), bindings:raw.bindings.map(b=>({...b,spans:b.spans.map(get)})),
    operators:{selection:raw.operators.selection===null?null:get(raw.operators.selection),
      extent:raw.operators.extent===null?null:get(raw.operators.extent),
      polarity:raw.operators.polarity===null?null:get(raw.operators.polarity),
      guard:raw.operators.guard===null?null:get(raw.operators.guard),
      context:raw.operators.context===null?null:get(raw.operators.context)},
    routeFrame:frame?{entry:get(frame.entry),exit:get(frame.exit),route:get(frame.route),
      exclusions:frame.exclusions.map(get),controls:frame.controls.map(get)}:null};
}

function tableReader<T extends z.infer<typeof locator>>(table:T[], text:(entry:T)=>string) {
  const used=new Set<number>(), seen=new Set<string>();
  const resolved=table.map(entry=>{
    const key=JSON.stringify(entry);if(seen.has(key))throw invalid();seen.add(key);
    return resolvePropositionQuote(text(entry),entry.quote,entry.occurrence);
  });
  return {get:(at:number)=>{
    if(!Number.isSafeInteger(at)||at<0||at>=table.length)throw invalid();
    used.add(at);return [...resolved[at]] as Span;
  }, complete:()=>{if(used.size!==table.length)throw invalid();}};
}

export function targetPropositionModelSchemaFor(input:PropositionTargetInput) {
  const local=targetPropositionSchemaFor(input);
  const schema=z.object({locatorVersion:z.literal(1),draftDigest:local.shape.draftDigest,
    targets:z.array(z.object({id:local.shape.targets.element.shape.id,
      locators:z.array(locator).max(512),parts:z.array(wirePart).min(1).max(32)}).strict()).length(input.originals.targets.length)}).strict();
  const originals=new Map(input.originals.targets.map(t=>[t.id,t.text]));
  return comparisonModelSchema(schema,raw=>{
    if(Buffer.byteLength(JSON.stringify(raw),"utf8")>TARGET_LOCATOR_MAX_BYTES)throw invalid();
    const seen=new Set<string>();
    return local.parse({draftDigest:raw.draftDigest,targets:raw.targets.map(t=>{
      const text=originals.get(t.id);if(text===undefined||seen.has(t.id))throw invalid();seen.add(t.id);
      const table=tableReader(t.locators,()=>text),get=table.get;
      const parts=t.parts.map(p=>({...p,span:get(p.span),
        atoms:p.atoms.map(a=>({...expandExtraction(a,get),scope:a.scope,claimNo:a.claimNo,sourceIds:a.sourceIds,
          attribution:a.attribution===null?null:get(a.attribution)})),
        reservation:p.reservation?{...p.reservation,basis:get(p.reservation.basis)}:null}));
      table.complete();return {id:t.id,parts};
    })});
  });
}
