import { z } from "zod";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { jsonSchema } from "ai";
import { comparisonModelSchema } from "./model-schema";
import { extractionSchema, propositionSourceInput, sourcePropositionSchemaFor } from "./proposition-extraction";
import { guardSchema, meaningSchema, propositionKey, type Meaning, type Span } from "./propositions";
import { resolvePropositionQuote } from "./proposition-quotes";
import { ComparisonError } from "./source";

const index=z.number().int().nonnegative();
const quote=z.object({
  quote:z.string().min(1).max(12_000),
  occurrence:index.describe("Exact-match starts, zero-based in the COMPLETE claim. Count embedded matches too; select the occurrence supporting this meaning."),
}).strict().meta({id:"PriorArtSourceQuote"});
const evidence=z.union([quote,
  z.object({quote:z.null(),occurrence:z.literal(0)}).strict()])
  .meta({id:"PriorArtSourceEvidence"});
const term=z.array(
  quote.extend({quote:z.string().min(1).max(80)}).meta({id:"PriorArtSourceTermQuote"})).min(1).max(4)
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
const invalid=()=>new Error("comparison_locator_invalid");
function propertyCount(value:unknown):number {
  if(!value||typeof value!=="object")return 0;
  if(Array.isArray(value))return value.reduce((n,v)=>n+propertyCount(v),0);
  const record=value as Record<string,unknown>;
  return (record.properties?Object.keys(record.properties).length:0)+
    Object.values(record).reduce<number>((n,v)=>n+propertyCount(v),0);
}

/** Source-only v11. Each semantic role carries its own exact quotation, avoiding
 * a model-generated locator table and a second address space of role indexes.
 * Flat facts keep quote objects within Azure's five object levels. */
export function directSourcePropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[]) {
  const local=sourcePropositionSchemaFor(chunks),input=propositionSourceInput(chunks);
  const unresolved=quote.extend({reason:z.string().min(1).max(400)})
    .meta({id:"PriorArtSourceUnresolved"});
  const additional=fact.omit({claimNo:true,basis:true}).extend({routeFrame:frame.nullable()})
    .meta({id:"PriorArtSourceAdditionalFact"});
  const additionalFacts=z.array(additional).min(1).max(48).meta({id:"PriorArtSourceAdditionalFacts"});
  const loopAdditionalFacts=z.array(additional).max(48).meta({id:"PriorArtSourceLoopAdditionalFacts"});
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
  const schema=z.object({locatorVersion:z.literal(11),sources:z.array(
    z.union(sourceSchemas as [typeof sourceSchemas[number],typeof sourceSchemas[number],...typeof sourceSchemas])
  ).length(input.sources.length)}).strict() as z.ZodType<{locatorVersion:11;sources:RawSource[]}>;
  const model=comparisonModelSchema(schema,raw=>local.parse({sources:raw.sources.map((s,i)=>{
    const source=input.sources[i],expected=source.source.claims;
    if(s.sourceDigest!==source.sourceDigest)throw invalid();
    const order=new Map(expected.map((c,n)=>[c.claimNo,n]));
    let previous=-1,quotes=0;
    const allFacts=expected.flatMap(c=>{
      const answer=s[`c${c.claimNo}`] as z.infer<typeof claimAnswer>,text=c.segments.map(p=>p.text).join("");
      if(!Array.isArray(answer)){
        if(!answer.reason.trim())throw invalid();
        resolvePropositionQuote(text,answer.quote,answer.occurrence);
      }
      return [
        ...source.recognizedLoopRoutes.flatMap((r,id)=>r.claimNo===c.claimNo?[s[`loop${id}`] as RawFact]:[]),
        ...(Array.isArray(answer)?answer.map(f=>({...f,claimNo:c.claimNo,
          basis:{firstPart:0,lastPart:c.segments.length-1}})):[]),
      ];
    });
    if(allFacts.length>48)throw invalid();
    previous=-1;
    const facts=allFacts.map(f=>{
      const at=order.get(f.claimNo);
      if(at===undefined||at<previous)throw invalid();previous=at;
      const claim=expected[at],text=claim.segments.map(p=>p.text).join("");
      // One coordinate space for every role, including postposed subjects and
      // guards. This selects only a claim boundary, never its semantic facts.
      if(f.basis.firstPart!==0||f.basis.lastPart!==claim.segments.length-1)throw invalid();
      const basis:Span=[0,text.length];
      const seen=new Set<string>();
      const get=(q:z.infer<typeof evidence>):Span=>{
        if(q.quote===null){
          const key=JSON.stringify(basis);
          if(!seen.has(key)){seen.add(key);if(++quotes>512)throw invalid();}
          return [...basis];
        }
        const anchor=text.slice(...basis);
        const span=resolvePropositionQuote(anchor,q.quote,q.occurrence).map(n=>n+basis[0]) as Span;
        const key=JSON.stringify(span);
        if(!seen.has(key)){seen.add(key);if(++quotes>512)throw invalid();}
        return span;
      };
      const bindings:z.infer<typeof extractionSchema>["bindings"]=[];
      const readTerm=(items:z.infer<typeof term>):string=>{
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
  return jsonSchema(model.jsonSchema,{validate:async value=>{
    try{
      if(Buffer.byteLength(JSON.stringify(value),"utf8")>32_000||!model.validate)throw invalid();
      return await model.validate(value);
    }catch{return {success:false,error:invalid()};}
  }});
}
