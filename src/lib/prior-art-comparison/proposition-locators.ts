import { z } from "zod";
import { comparisonModelSchema } from "./model-schema";
import { extractionSchema, targetAtomSchema, targetPartSchema,
  targetPropositionSchemaFor, targetAttributionMarker, type PropositionTargetInput } from "./proposition-extraction";
import type { Span } from "./propositions";
import { resolvePropositionQuote } from "./proposition-quotes";
export { resolvePropositionQuote } from "./proposition-quotes";
export { sourceIdentifiedPropositionModelSchemaFor as sourcePropositionModelSchemaFor } from "./source-semantic-wire";

// Ordered exact parts remove global occurrence counting. Nested locators are
// relative to their own part; all existing absolute-domain checks still run.
const locator = z.string().min(3).max(12_020)
  .describe('Occurrence WITHIN THIS PART, then |, then the exact nonempty quote; e.g. 0|青色弁. Preserve every space and punctuation mark.');
const spans = {
  basis: z.array(locator).min(1).max(12),
  bindings: z.array(z.object({ term: extractionSchema.shape.bindings.element.shape.term,
    spans: z.array(locator).min(1).max(4) }).strict()).max(48),
  operators: z.object({ selection:locator.nullable(), extent:locator.nullable(), polarity:locator.nullable(),
    guard:locator.nullable(), context:locator.nullable() }).strict(),
  routeFrame: z.object({ entry:locator, exit:locator, route:locator,
    exclusions:z.array(locator).max(6), controls:z.array(locator).max(6) }).strict().nullable(),
};
const wireAtom = targetAtomSchema.extend({...spans, attribution:z.enum(["基準側","基準","候補側","候補","両側とも","両側","両者とも","両者","双方","どちらも"]).nullable()
  .describe("Plain exact printed attribution marker, no occurrence prefix or particle. It must match the closest marker for this assertion; scope is still checked independently.")});
const wirePart = targetPartSchema.extend({span:z.string().min(1).max(12_000).describe("PLAIN exact quote, NO occurrence prefix. Parts concatenate to the entire unchanged target in order. Each part stays within one unitStarts interval."), atoms:z.array(wireAtom).max(12),
  reservation:z.object({topic:targetPartSchema.shape.reservation.unwrap().shape.topic,
    basis:locator.describe("occurrence|exact topic quote, excluding uncertainty suffix; factual clauses are separate parts.")}).strict().nullable()});
export const SOURCE_LOCATOR_MAX_BYTES = 32_000;
export const TARGET_LOCATOR_MAX_BYTES = 64_000;
const invalid = () => new Error("comparison_locator_invalid");

function expandExtraction(raw:Pick<z.infer<typeof wireAtom>,keyof z.infer<typeof extractionSchema>>, get:(value:string)=>Span) {
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

export function resolveTargetLocator(text:string,value:string):Span {
  const match=/^(0|[1-9][0-9]*)\|([\s\S]+)$/.exec(value);
  if(!match||match[2].length>12_000)throw invalid();
  const occurrence=Number(match[1]);
  // Bound work before resolving even a maliciously large occurrence index.
  if(!Number.isSafeInteger(occurrence)||occurrence>text.length)throw invalid();
  return resolvePropositionQuote(text,match[2],occurrence);
}

export function targetPropositionModelSchemaFor(input:PropositionTargetInput) {
  const local=targetPropositionSchemaFor(input);
  const factIds=[...new Set(input.sourcePropositions.map(f=>f.id))];
  const scopedAtom=wireAtom.extend({
    sourceIds:(factIds.length?z.array(z.enum(factIds)).min(1).max(16):wireAtom.shape.sourceIds)
      .describe("Exact fact IDs from facts.rows column 0 / scopes.factIds, never claim labels or reference-scope IDs."),
    scope:z.enum(input.referenceScopes.map(s=>s.id))
    .describe("Exact source reference-scope ID from scopes, never a target ID. Target-side and claim ownership remain independently checked.")});
  const schema=z.object({locatorVersion:z.literal(3),draftDigest:local.shape.draftDigest,
    targets:z.array(z.object({id:local.shape.targets.element.shape.id,
      parts:z.array(wirePart.extend({atoms:z.array(scopedAtom).max(factIds.length?12:0)})).min(1).max(32)}).strict()).length(input.originals.targets.length)}).strict();
  const originals=new Map(input.originals.targets.map(t=>[t.id,t.text]));
  return comparisonModelSchema(schema,raw=>{
    if(Buffer.byteLength(JSON.stringify(raw),"utf8")>TARGET_LOCATOR_MAX_BYTES)throw invalid();
    const seen=new Set<string>();
    return local.parse({draftDigest:raw.draftDigest,targets:raw.targets.map(t=>{
      const text=originals.get(t.id);if(text===undefined||seen.has(t.id))throw invalid();seen.add(t.id);
      let cursor=0;
      const parts=t.parts.map(p=>{
        if(!text.startsWith(p.span,cursor))throw invalid();
        const start=cursor,span:Span=[start,start+p.span.length];cursor=span[1];
        const get=(value:string):Span=>{const [a,b]=resolveTargetLocator(p.span,value);return [start+a,start+b];};
        const atoms=p.atoms.map(a=>{
          const atom={...expandExtraction(a,get),scope:a.scope,claimNo:a.claimNo,sourceIds:a.sourceIds};
          const marker=a.attribution===null?null:targetAttributionMarker(text,span,atom);
          if(a.attribution!==null&&marker?.text!==a.attribution)throw invalid();
          return {...atom,attribution:marker?.span??null};
        });
        return {...p,span,atoms,reservation:p.reservation?{...p.reservation,basis:get(p.reservation.basis)}:null};
      });
      if(cursor!==text.length)throw invalid();
      return {id:t.id,parts};
    })});
  });
}
