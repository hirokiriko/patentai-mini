import { z } from "zod";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { comparisonModelSchema } from "./model-schema";
import { extractionSchema, targetAtomSchema, targetPartSchema, propositionSourceInput,
  sourcePropositionSchemaFor, targetPropositionSchemaFor, type PropositionTargetInput } from "./proposition-extraction";
import type { Span } from "./propositions";

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
const wireExtraction = extractionSchema.extend(spans);
const wireAtom = targetAtomSchema.extend({...spans, attribution:index.nullable()});
const wirePart = targetPartSchema.extend({span:index, atoms:z.array(wireAtom).max(12),
  reservation:z.object({topic:targetPartSchema.shape.reservation.unwrap().shape.topic,basis:index}).strict().nullable()});
export const SOURCE_LOCATOR_MAX_BYTES = 32_000;
export const TARGET_LOCATOR_MAX_BYTES = 64_000;
const invalid = () => new Error("comparison_locator_invalid");

/** Exact matching only. Count every match start (including overlaps), starting
 * at zero, within this one frozen claim or target. Never normalize or search a
 * different claim, infer a first occurrence, or widen a basis. */
export function resolvePropositionQuote(text:string, quote:string, occurrence:number):Span {
  if (!quote.length || !Number.isSafeInteger(occurrence) || occurrence < 0) throw invalid();
  let start = -1;
  for (let i=0;i<=occurrence;i++) {
    start = text.indexOf(quote,start+1);
    if (start < 0) throw invalid();
  }
  const end=start+quote.length;
  const splits=(at:number)=>/[\uD800-\uDBFF]/u.test(text[at-1]??"")&&/[\uDC00-\uDFFF]/u.test(text[at]??"");
  if (splits(start)||splits(end)||text.slice(start,end)!==quote) throw invalid();
  return [start,end];
}

function expandExtraction(raw:z.infer<typeof wireExtraction>, get:(index:number)=>Span) {
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

/** The wire result is converted once to the unchanged internal span schema.
 * The domain decoder still checks containment, scope, terms and semantics. */
export function sourcePropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[]) {
  const local=sourcePropositionSchemaFor(chunks),input=propositionSourceInput(chunks);
  const schema=z.object({locatorVersion:z.literal(1),sources:z.array(z.object({
    sourceDigest:local.shape.sources.element.shape.sourceDigest,
    locators:z.array(locator.extend({claimNo:z.number().int().positive()})).max(512),
    facts:z.array(wireExtraction.extend({claimNo:z.number().int().positive()})).max(48),
  }).strict()).length(input.sources.length)}).strict();
  const originals=input.sources.map(s=>new Map(s.source.claims.map(c=>[c.claimNo,c.segments.map(p=>p.text).join("")])));
  return comparisonModelSchema(schema,raw=>{
    if(Buffer.byteLength(JSON.stringify(raw),"utf8")>SOURCE_LOCATOR_MAX_BYTES)throw invalid();
    return local.parse({sources:raw.sources.map((s,i)=>{
      if(s.sourceDigest!==input.sources[i].sourceDigest)throw invalid();
      const table=tableReader(s.locators,l=>{const text=originals[i].get(l.claimNo);if(text===undefined)throw invalid();return text;});
      const facts=s.facts.map(f=>({...expandExtraction(f,at=>{
        if(s.locators[at]?.claimNo!==f.claimNo)throw invalid();return table.get(at);
      }),claimNo:f.claimNo}));
      table.complete();return {sourceDigest:s.sourceDigest,facts};
    })});
  });
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
