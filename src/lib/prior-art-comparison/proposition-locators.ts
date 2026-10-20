import { z } from "zod";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { comparisonModelSchema } from "./model-schema";
import { extractionSchema, targetAtomSchema, targetPartSchema, propositionSourceInput,
  sourcePropositionSchemaFor, targetPropositionSchemaFor, type PropositionTargetInput } from "./proposition-extraction";
import { guardSchema, meaningSchema, propositionKey, type Meaning, type Span } from "./propositions";
import { sourceCitationParts, sourceCitationRange } from "./source-citation-parts";

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
// Source terms are quoted once. The model selects their locators for semantic
// roles instead of independently repeating a term and a purported binding.
const termRefs=z.array(index).min(1).max(4).meta({id:"PriorArtSourceTerm"}),termLists=z.array(termRefs).max(12);
const boundCommon={
  subject:termRefs.nullable(),context:meaningSchema.options[0].shape.context,
  guard:z.object({relation:guardSchema.shape.relation,conditions:termLists}).strict().meta({id:"PriorArtGuard"}),
  polarity:meaningSchema.options[0].shape.polarity,
};
const boundMeaning=z.discriminatedUnion("kind",[
  meaningSchema.options[0].extend({...boundCommon,members:termLists.min(1)}),
  meaningSchema.options[1].extend({...boundCommon,origin:termRefs.nullable(),destination:termRefs.nullable(),via:termLists,bypass:termLists}),
  meaningSchema.options[2].extend({...boundCommon,objects:termLists.min(1)}),
]);
const boundSourceExtraction=wireExtraction.omit({bindings:true}).extend({meaning:boundMeaning,
  routeFrame:z.union([index,spans.routeFrame.unwrap()]).nullable()});
const sourceLocator=z.object({id:index.max(511),claimNo:z.number().int().positive(),firstPart:index,lastPart:index,
  quote:locator.shape.quote.nullable(),occurrence:index}).strict();
const sourceBasis=z.object({firstPart:index,lastPart:index}).strict();
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

function expandSource(raw:Omit<z.infer<typeof boundSourceExtraction>,"routeFrame">&{routeFrame:z.infer<typeof spans.routeFrame>},get:(at:number)=>Span,text:string,basis:Span[]) {
  const bindings:z.infer<typeof extractionSchema>["bindings"]=[];
  const term=(refs:number[]):string=>{
    const positions=refs.map(get);
    // Check every role before coalescing identical terms. A second occurrence
    // outside the basis must not disappear behind an earlier valid binding.
    if(positions.some(s=>!basis.some(([a,b])=>s[0]>=a&&s[1]<=b)))throw invalid();
    const value=positions.map(([a,b])=>text.slice(a,b)).join("");
    if(!bindings.some(b=>b.term===value))bindings.push({term:value,spans:positions});
    return value;
  };
  const m=raw.meaning,common={subject:m.subject===null?null:term(m.subject),context:m.context,
    guard:{relation:m.guard.relation,conditions:m.guard.conditions.map(term)},polarity:m.polarity};
  const meaning:Meaning=m.kind==="set"?{...common,kind:m.kind,selection:m.selection,extent:m.extent,members:m.members.map(term)}:
    m.kind==="path"?{...common,kind:m.kind,origin:m.origin===null?null:term(m.origin),
      destination:m.destination===null?null:term(m.destination),via:m.via.map(term),bypass:m.bypass.map(term),extent:m.extent,relation:m.relation}:
    {...common,kind:m.kind,predicate:m.predicate,objects:m.objects.map(term)};
  return {...expandExtraction({...raw,basis:[],meaning,bindings:[]},get),basis,bindings};
}

/** The wire result is converted once to the unchanged internal span schema.
 * The domain decoder still checks containment, scope, terms and semantics. */
export function sourcePropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[]) {
  const local=sourcePropositionSchemaFor(chunks),input=propositionSourceInput(chunks);
  const fact=boundSourceExtraction.extend({basis:z.array(sourceBasis).min(1).max(12)}).meta({id:"PriorArtSourceFact"});
  const reading=z.object({claimNo:z.number().int().positive(),
    locators:z.array(sourceLocator.omit({claimNo:true})).max(512),
    requiredLoops:z.array(fact).max(48).describe("One independently extracted whole path for each recognizedLoopRoutes entry in THIS claim, in source inventory order. numeric routeFrame is the original inventory id."),
    facts:z.array(fact).max(48).describe("Additional literal propositions in THIS claim. Explicit frame or null, never numeric routeFrame. Canonical-only or unrepresentable content may yield no additional facts; never invent one."),
  }).strict();
  const schema=z.object({locatorVersion:z.literal(6),sources:z.array(z.object({
    sourceDigest:local.shape.sources.element.shape.sourceDigest,
    claims:z.array(reading).describe("Every input claim exactly once in input order, including all ancestors. Each claim has its own locator IDs; never borrow a locator from another claim."),
  }).strict()).length(input.sources.length)}).strict();
  const originals=input.sources.map(s=>new Map(s.source.claims.map(c=>[c.claimNo,{text:c.segments.map(p=>p.text).join(""),parts:sourceCitationParts(c.segments.map(p=>p.text))}])));
  return comparisonModelSchema(schema,raw=>{
    if(Buffer.byteLength(JSON.stringify(raw),"utf8")>SOURCE_LOCATOR_MAX_BYTES)throw invalid();
    return local.parse({sources:raw.sources.map((s,i)=>{
      if(s.sourceDigest!==input.sources[i].sourceDigest)throw invalid();
      const expected=input.sources[i].source.claims;
      if(s.claims.length!==expected.length||s.claims.some((c,n)=>c.claimNo!==expected[n].claimNo)||
        s.claims.reduce((n,c)=>n+c.locators.length,0)>512||
        s.claims.reduce((n,c)=>n+c.requiredLoops.length+c.facts.length,0)>48)throw invalid();
      const facts=s.claims.flatMap(c=>{
      const claim=originals[i].get(c.claimNo)!;
      const loops=input.sources[i].recognizedLoopRoutes.map((r,id)=>({...r,id})).filter(r=>r.claimNo===c.claimNo);
      if(c.requiredLoops.length!==loops.length||c.requiredLoops.some((f,n)=>f.routeFrame!==loops[n].id)||
        c.facts.some(f=>typeof f.routeFrame==="number"))throw invalid();
      const seen=new Set<string>(),used=new Set<number>(),resolved=new Map<number,Span>();
      for(const l of c.locators){
        if(resolved.has(l.id))throw invalid();
        const [a,b]=sourceCitationRange(claim.parts,l.firstPart,l.lastPart);
        if(l.quote===null&&l.occurrence!==0)throw invalid();
        const position:Span=l.quote===null?[a,b]:resolvePropositionQuote(claim.text.slice(a,b),l.quote,l.occurrence).map(n=>n+a) as Span;
        // Different anchors must not disguise duplicate positions.
        const key=JSON.stringify(position);if(seen.has(key))throw invalid();seen.add(key);
        resolved.set(l.id,position);
      }
      const facts=[...c.requiredLoops,...c.facts].map(f=>{
        const get=(at:number):Span=>{
          const entry=resolved.get(at);
          if(!Number.isSafeInteger(at)||!entry)throw invalid();used.add(at);return [...entry];
        };
        const indexed=typeof f.routeFrame==="number",r=indexed?input.sources[i].recognizedLoopRoutes[f.routeFrame as number]:undefined;
        // The model explicitly selects complete part ranges. Never derive or
        // enlarge its basis from a role, a frame, or a failed quote lookup.
        const basis=f.basis.map(b=>sourceCitationRange(claim.parts,b.firstPart,b.lastPart));
        const expanded=expandSource({...f,basis:[],routeFrame:indexed?null:f.routeFrame as z.infer<typeof spans.routeFrame>},get,claim.text,basis);
        if(indexed){
          const m=expanded.meaning,same=(t:string|null,span:Span)=>t!==null&&propositionKey(t)===propositionKey(claim.text.slice(...span));
          if(!r||r.claimNo!==c.claimNo||m.kind!=="path"||m.extent!=="whole"||m.relation!=="route"||
            !same(m.subject,r.mode)||!same(m.origin,r.entry)||!same(m.destination,r.exit))throw invalid();
          const frame={entry:r.entry,exit:r.exit,route:r.route,exclusions:[r.definition],controls:[r.control]};
          if([r.mode,r.entry,r.exit,r.route,r.definition,r.control].some(span=>!expanded.basis.some(([a,b])=>span[0]>=a&&span[1]<=b)))throw invalid();
          expanded.routeFrame=structuredClone(frame);
        }
        return {...expanded,claimNo:c.claimNo};
      });
      if(used.size!==c.locators.length)throw invalid();return facts;
      });return {sourceDigest:s.sourceDigest,facts};
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
