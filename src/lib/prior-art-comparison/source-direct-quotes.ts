import { z } from "zod";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { jsonSchema } from "ai";
import { comparisonModelSchema } from "./model-schema";
import { extractionSchema, propositionSourceInput, sourcePropositionSchemaFor } from "./proposition-extraction";
import { guardSchema, meaningSchema, propositionKey, type Meaning, type Span } from "./propositions";
import { ComparisonError } from "./source";
import { sourceWireSchema } from "./source-wire-compact";
import { sourceCitationGrid, resolveSourceCellRef } from "./source-citation-grid";
import { LEGACY_SOURCE_CAPACITY, type SourceWireCapacity } from "./source-capacity";

const index=z.number().int().nonnegative();
const contextQuote=z.object({
  quote:z.string().min(1).max(12_000),
  before:z.string().max(12_000),after:z.string().max(12_000),edge:z.enum(["none","start","end","both"]),
}).strict().meta({id:"PriorArtSourceQuote"});
const partQuote=z.object({part:index,quote:z.string().min(1).max(12_000)}).strict()
  .meta({id:"PriorArtSourcePartQuote"});
const cellQuote=z.object({cells:z.array(index).length(4)}).strict().meta({id:"PriorArtSourceCellQuote"});
function directShapes(mode:"quotes"|"cells") {
const quote=mode==="cells"?cellQuote:z.union([partQuote,contextQuote]);
const evidence=z.union([quote,
  z.object({quote:z.null(),before:z.literal(""),after:z.literal(""),edge:z.literal("both")}).strict()])
  .meta({id:"PriorArtSourceEvidence"});
// The decoder enforces the same 80-character limit on the concatenated term.
// Reuse the quote definition to stay within the provider's property budget.
const term=z.array(quote).min(1).max(4)
  .describe("Exact noun/condition quotes concatenated in this order, at most 80 characters in total.")
  .meta({id:"PriorArtSourceTerm"});
const terms=z.array(term).max(12);
const common={
  subject:term.nullable(),
  context:meaningSchema.options[0].shape.context,
  guard:z.object({relation:guardSchema.shape.relation,conditions:terms}).strict().meta({id:"PriorArtGuard"}),
  polarity:meaningSchema.options[0].shape.polarity,
};
const meaning=z.discriminatedUnion("kind",[
  meaningSchema.options[0].extend({...common,members:terms.min(1)}),
  meaningSchema.options[1].extend({...common,origin:term.nullable(),destination:term.nullable(),via:terms,bypass:terms}),
  meaningSchema.options[2].extend({...common,objects:terms.min(1)}),
]).meta({id:"PriorArtSourceMeaning"});
const frame=z.object({entry:evidence,exit:evidence,route:evidence,
  exclusions:z.array(evidence).max(6),controls:z.array(evidence).max(6)}).strict().meta({id:"PriorArtSourceFrame"});
const fact=z.object({
  claimNo:z.number().int().positive(),
  basis:z.object({firstPart:index,lastPart:index}).strict()
    .describe("Inclusive parts containing ALL roles, guards and frame.")
    .meta({id:"PriorArtSourceBasis"}),
  meaning,
  operators:z.object({selection:evidence.nullable(),extent:evidence.nullable(),polarity:evidence.nullable(),
    guard:evidence.nullable(),context:evidence.nullable()}).strict().nullable()
    .describe("null abbreviates five null fields; required operator evidence must still be supplied.")
    .meta({id:"PriorArtSourceOperators"}),
  routeFrame:z.union([index,frame]).nullable(),
}).strict();
return {term,evidence,frame,fact};
}
const invalid=()=>new Error("comparison_locator_invalid");
/** Resolve only the supplied context. Never choose another repeated occurrence,
 * normalize text or repair an answer. A location is not semantic proof. */
export function resolveSourceContextQuote(text:string,q:{quote:string;before:string;after:string;edge:"none"|"start"|"end"|"both"}):Span {
  if(!q.quote.length)throw invalid();
  const {before,after}=q,context=before+q.quote+after;
  let found=-1;
  for(let at=text.indexOf(context);at>=0;at=text.indexOf(context,at+1)){
    if(["start","both"].includes(q.edge)&&at!==0||["end","both"].includes(q.edge)&&at+context.length!==text.length)continue;
    if(found!==-1)throw invalid();found=at;
  }
  if(found<0)throw invalid();
  const start=found+before.length,end=start+q.quote.length;
  // Check both enclosing and inner boundaries against the complete original.
  for(const p of [found,start,end,found+context.length])
    if(/[\uD800-\uDBFF]/u.test(text[p-1]??"")&&/[\uDC00-\uDFFF]/u.test(text[p]??""))throw invalid();
  return [start,end];
}
/** A part is an input coordinate, never a semantic boundary or inferred role.
 * Require the model's exact quote to be unique inside that exact part. */
export function resolveSourcePartQuote(parts:readonly string[],q:{part:number;quote:string}):Span {
  if(!Number.isSafeInteger(q.part)||q.part<0||q.part>=parts.length)throw invalid();
  const offset=parts.slice(0,q.part).join("").length,text=parts.join("");
  const span=resolveSourceContextQuote(parts[q.part],{quote:q.quote,before:"",after:"",edge:"none"})
    .map(n=>n+offset) as Span;
  for(const p of span)if(/[\uD800-\uDBFF]/u.test(text[p-1]??"")&&/[\uDC00-\uDFFF]/u.test(text[p]??""))throw invalid();
  return span;
}
/** Conditions may omit a demonstrative, not part of a Han word such as its
 * negative prefix. Adjacent fragments are checked as one intact quotation. */
function assertConditionBoundaries(text:string,positions:Span[]) {
  const ranges:Span[]=[];
  for(const [a,b] of positions){
    const last=ranges.at(-1);
    if(last?.[1]===a)last[1]=b;else ranges.push([a,b]);
  }
  for(const [a,b] of ranges){
    const han=(s:string)=>/\p{Script=Han}/u.test(s);
    const next=(p:number)=>p<text.length?String.fromCodePoint(text.codePointAt(p)!):"";
    const previous=(p:number)=>text.slice(0,p).match(/[\s\S]$/u)?.[0]??"";
    if(han(next(a))&&han(previous(a))){
      const prefix=text.slice(0,a).match(/\p{Script=Han}+$/u)?.[0];
      if(!["前記","当該","該"].includes(prefix??""))throw invalid();
    }
    if(han(previous(b))&&han(next(b)))throw invalid();
  }
}
function propertyCount(value:unknown):number {
  if(!value||typeof value!=="object")return 0;
  if(Array.isArray(value))return value.reduce((n,v)=>n+propertyCount(v),0);
  const record=value as Record<string,unknown>;
  return (record.properties?Object.keys(record.properties).length:0)+
    Object.values(record).reduce<number>((n,v)=>n+propertyCount(v),0);
}

/** Source-only v12. Each semantic role carries its own exact quotation, avoiding
 * a model-generated locator table and a second address space of role indexes.
 * Flat facts keep quote objects within Azure's five object levels. */
export function directSourceModel(chunks:readonly ManagedComparisonChunk[],mode:"quotes"|"cells"="quotes",capacity:SourceWireCapacity=LEGACY_SOURCE_CAPACITY) {
  const {frame,fact}=directShapes(mode);
  type Shapes=ReturnType<typeof directShapes>;
  const local=sourcePropositionSchemaFor(chunks),input=propositionSourceInput(chunks);
  const unresolved=(mode==="cells"?cellQuote:contextQuote).extend({reason:z.string().min(1).max(400)})
    .meta({id:"PriorArtSourceUnresolved"});
  const additional=fact.omit({claimNo:true,basis:true}).extend({routeFrame:frame.nullable()})
    .meta({id:"PriorArtSourceAdditionalFact"});
  const additionalFacts=z.array(additional).min(1).max(capacity.facts).meta({id:"PriorArtSourceAdditionalFacts"});
  const loopAdditionalFacts=z.array(additional).max(capacity.facts).meta({id:"PriorArtSourceLoopAdditionalFacts"});
  const claimAnswer=z.union([additionalFacts,unresolved]).meta({id:"PriorArtSourceClaimAnswer"});
  type RawFact=z.infer<typeof fact>;
  type RawSource={sourceDigest:string} & Record<string,unknown>;
  // Required keys make omissions a provider schema violation, not merely a
  // prose instruction. Catalog IDs constrain identity only: every loop's
  // meaning and role quotations still come from the model. Its basis shares
  // the input locator coordinate space; no role is inferred or repaired.
  const loopBases=new Map<string,z.ZodType<{firstPart:number;lastPart:number}>>();
  const loopBasis=([firstPart,lastPart]:readonly [number,number])=>{
    const key=`${firstPart}_${lastPart}`;
    if(!loopBases.has(key))loopBases.set(key,z.object({firstPart:z.literal(firstPart),lastPart:z.literal(lastPart)}).strict()
      .meta({id:`PriorArtSourceLoopBasis_${key}`}));
    return loopBases.get(key)!;
  };
  const sourceSchemas=input.sources.map(source=>z.object({
    sourceDigest:z.literal(source.sourceDigest),
    // A claim has facts OR an unresolved explanation, never two independently
    // generated answers. Required loops already answer their own claims, so
    // only those claims may explicitly return no additional facts.
    ...Object.fromEntries(source.source.claims.map(c=>[`c${c.claimNo}`,
      source.recognizedLoopRoutes.some(r=>r.claimNo===c.claimNo)?loopAdditionalFacts:claimAnswer])),
    ...Object.fromEntries(source.recognizedLoopRoutes.map((r,id)=>[`loop${id}`,fact.extend({
      claimNo:z.literal(r.claimNo),routeFrame:z.literal(id),basis:loopBasis(r.basisParts),
    })])),
  }).strict());
  const schema=z.object({locatorVersion:z.literal(mode==="cells"?14:12),sources:z.array(
    z.union(sourceSchemas as [typeof sourceSchemas[number],typeof sourceSchemas[number],...typeof sourceSchemas])
  ).length(input.sources.length)}).strict() as z.ZodType<{locatorVersion:12|14;sources:RawSource[]}>;
  const model=comparisonModelSchema(schema,raw=>local.parse({sources:raw.sources.map((s,i)=>{
    const source=input.sources[i],expected=source.source.claims;
    if(s.sourceDigest!==source.sourceDigest)throw invalid();
    const order=new Map(expected.map((c,n)=>[c.claimNo,n]));
    let previous=-1,quotes=0;
    const allFacts=expected.flatMap(c=>{
      const answer=s[`c${c.claimNo}`] as z.infer<typeof claimAnswer>,text=c.segments.map(p=>p.text).join("");
      if(!Array.isArray(answer)){
        if(!answer.reason.trim())throw invalid();
        if("cells"in answer)resolveSourceCellRef(sourceCitationGrid(text),answer.cells);
        else resolveSourceContextQuote(text,answer);
      }
      return [
        ...source.recognizedLoopRoutes.flatMap((r,id)=>r.claimNo===c.claimNo?[s[`loop${id}`] as RawFact]:[]),
        ...(Array.isArray(answer)?answer.map(f=>({...f,claimNo:c.claimNo,
          basis:{firstPart:0,lastPart:c.segments.length-1}})):[]),
      ];
    });
    if(allFacts.length>capacity.facts)throw invalid();
    previous=-1;
    const facts=allFacts.map(f=>{
      const at=order.get(f.claimNo);
      if(at===undefined||at<previous)throw invalid();previous=at;
      const claim=expected[at],text=claim.segments.map(p=>p.text).join("");
      const grid=mode==="cells"?sourceCitationGrid(text):null;
      // One coordinate space for every role, including postposed subjects and
      // guards. This selects only a claim boundary, never its semantic facts.
      if(f.basis.firstPart!==0||f.basis.lastPart!==claim.segments.length-1)throw invalid();
      const basis:Span=[0,text.length];
      const seen=new Set<string>();
      const get=(q:z.infer<Shapes["evidence"]>):Span=>{
        if("quote"in q&&q.quote===null){
          const key=JSON.stringify(basis);
          if(!seen.has(key)){seen.add(key);if(++quotes>capacity.quotes)throw invalid();}
          return [...basis];
        }
        const anchor=text.slice(...basis);
        const span="cells"in q?(grid?resolveSourceCellRef(grid,q.cells):(()=>{throw invalid();})()):
          "part"in q?resolveSourcePartQuote(claim.segments.map(p=>p.text),q):
          resolveSourceContextQuote(anchor,q).map(n=>n+basis[0]) as Span;
        const key=JSON.stringify(span);
        if(!seen.has(key)){seen.add(key);if(++quotes>capacity.quotes)throw invalid();}
        return span;
      };
      const bindings:z.infer<typeof extractionSchema>["bindings"]=[];
      const readTerm=(items:z.infer<Shapes["term"]>):string=>{
        // Resolve EVERY role before coalescing equal strings. A repeated term
        // at a wrong location must never hide behind an earlier valid binding.
        const positions=items.map(get),value=positions.map(p=>text.slice(...p)).join("");
        if(value.length>80)throw invalid();
        if(!bindings.some(b=>b.term===value))bindings.push({term:value,spans:positions});
        return value;
      };
      const m=f.meaning,c={subject:m.subject===null?null:readTerm(m.subject),context:m.context,
        guard:{relation:m.guard.relation,conditions:m.guard.conditions.map(readTerm)},polarity:m.polarity};
      const decoded:Meaning=m.kind==="set"?{...c,kind:m.kind,selection:m.selection,extent:m.extent,members:m.members.map(readTerm)}:
        m.kind==="path"?{...c,kind:m.kind,origin:m.origin===null?null:readTerm(m.origin),
          destination:m.destination===null?null:readTerm(m.destination),via:m.via.map(readTerm),bypass:m.bypass.map(readTerm),
          extent:m.extent,relation:m.relation}:{...c,kind:m.kind,predicate:m.predicate,objects:m.objects.map(readTerm)};
      // This is only a reversible spelling of five nulls, never missing proof.
      const op=f.operators??{selection:null,extent:null,polarity:null,guard:null,context:null};
      const operators={selection:op.selection===null?null:get(op.selection),
        extent:op.extent===null?null:get(op.extent),polarity:op.polarity===null?null:get(op.polarity),
        guard:op.guard===null?null:get(op.guard),context:op.context===null?null:get(op.context)};
      // Check each guard role before coalesced bindings can hide a different
      // position. A broad whole-claim proof does not waive lexical boundaries.
      for(const condition of m.guard.conditions){
        const positions=condition.map(get);
        assertConditionBoundaries(text,positions);
        if(operators.guard&&positions.some(([a,b])=>a<operators.guard![0]||b>operators.guard![1]))throw invalid();
      }
      if(operators.guard)assertConditionBoundaries(text,[operators.guard]);
      let routeFrame:z.infer<typeof extractionSchema>["routeFrame"]=null;
      if(typeof f.routeFrame==="number"){
        const r=source.recognizedLoopRoutes[f.routeFrame],same=(t:string|null,p:Span)=>
          t!==null&&propositionKey(t)===propositionKey(text.slice(...p));
        if(!r||r.claimNo!==f.claimNo||decoded.kind!=="path"||decoded.extent!=="whole"||decoded.relation!=="route"||
          !same(decoded.subject,r.mode)||!same(decoded.origin,r.entry)||!same(decoded.destination,r.exit))throw invalid();
        if([r.mode,r.entry,r.exit,r.route,r.definition,r.control].some(([a,b])=>a<basis[0]||b>basis[1]))throw invalid();
        routeFrame={entry:[...r.entry],exit:[...r.exit],route:[...r.route],exclusions:[[...r.definition]],controls:[[...r.control]]};
      }else if(f.routeFrame){
        const r=f.routeFrame;
        routeFrame={entry:get(r.entry),exit:get(r.exit),route:get(r.route),
          exclusions:r.exclusions.map(get),controls:r.controls.map(get)};
      }
      return {claimNo:f.claimNo,basis:[basis],meaning:decoded,bindings,operators,routeFrame};
    });
    for(const claim of expected){
      const own=allFacts.filter(f=>f.claimNo===claim.claimNo);
      const loops=source.recognizedLoopRoutes.map((r,id)=>({...r,id})).filter(r=>r.claimNo===claim.claimNo);
      if(own.filter(f=>typeof f.routeFrame==="number").length!==loops.length||
        loops.some((r,n)=>own[n]?.routeFrame!==r.id))throw invalid();
    }
    return {sourceDigest:s.sourceDigest,facts};
  })}));
  // Dynamic claim keys must fit the documented Azure schema budget too.
  // Reject the complete plan before sending; never omit claims to fit it.
  if(propertyCount(model.jsonSchema)>100)throw new ComparisonError("plan_limit");
  return model;
}
export function compactDirectSourcePropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[]) {
  return sourceWireSchema(directSourceModel(chunks));
}
export function directSourcePropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[]) {
  const model=directSourceModel(chunks);
  return jsonSchema(model.jsonSchema,{validate:async value=>{
    try{
      if(Buffer.byteLength(JSON.stringify(value),"utf8")>32_000||!model.validate)throw invalid();
      return await model.validate(value);
    }catch{return {success:false,error:invalid()};}
  }});
}
