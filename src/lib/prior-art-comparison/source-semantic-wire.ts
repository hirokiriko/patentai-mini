import { jsonSchema, type JSONSchema7 } from "ai";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { propositionSourceInput } from "./proposition-extraction";
import { propositionSourceClauseTransport, resolveSourceEvidenceQuote, sourceClausePropositionModelSchemaFor } from "./source-clause-wire";
import { assertSourceGridProviderSchema } from "./source-grid-wire";
import { sourceReadingClaim, type SourceReadingClaim } from "./source-clause-coverage";
import { SOURCE_MEANING_ENUMS } from "./source-wire-compact";
import { SOURCE_CAPACITY } from "./source-capacity";
import { assertSourceSemanticReading, sourceActionCues, sourceOrGroups, type CheckedSourceFact } from "./source-semantic-check";
import type { Span } from "./propositions";
import {assertSourceTaskBindings,resolveSourceTaskQuote,sourceConsecutiveIds,sourceReadingTasks} from "./source-reading-tasks";

const invalid=()=>new Error("comparison_source_semantic_wire_invalid");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const enumKeys:Record<string,string>={x:"context",g:"guardRelation",p:"polarity",k:"kind",S:"selection",e:"extent",r:"relation",P:"predicate"};
const operatorKeys=["selection","extent","polarity","guard","context"] as const;
const quoteRef={$ref:"#/definitions/PriorArtSourceCellQuote"};
const evidenceRef={$ref:"#/definitions/PriorArtSourceEvidence"};

export function propositionSourceSemanticTransport(input:ReturnType<typeof propositionSourceInput>){
  const old=propositionSourceClauseTransport(input);
  return {...old,citationClauses:{version:2},sources:old.sources.map(s=>({...s,source:{...s.source,
    claims:s.source.claims.map(c=>{
      const reading=sourceReadingClaim(c.claimNo,c.clauses.map(([,text])=>text).join(""));
      return {...c,readingActions:sourceActionCues(reading).map(cue=>[cue.clause,cue.predicate,cue.polarity,reading.grid.text.slice(...cue.span)]),
        conditionAlternatives:sourceOrGroups(reading).map(g=>g.branches.map(span=>reading.clauses.findIndex(([a,b])=>a<=span[0]&&b>=span[1])))};
    })}}))};
}

export function propositionSourceTaskTransport(input:ReturnType<typeof propositionSourceInput>){
  const old=propositionSourceSemanticTransport(input);
  return {...old,citationClauses:{version:3},sources:old.sources.map(s=>({...s,source:{...s.source,claims:s.source.claims.map(c=>{
    const {readingActions,...rest}=c;void readingActions;
    const reading=sourceReadingClaim(c.claimNo,c.clauses.map(([,text])=>text).join(""));
    return {...rest,readingTasks:sourceReadingTasks(reading).map(t=>[t.clause,t.kind,t.polarity])};
  })}}))};
}
export const sourceTaskPropositionModelSchemaFor=(chunks:readonly ManagedComparisonChunk[])=>sourceSemanticPropositionModelSchemaFor(chunks,18);

/** New output contract, not a repair of v16 responses. Names replace numeric
 * meaning enums; strict context objects replace ambiguous string-array tuples.
 * The existing exact citation, domain, reference and route validators remain. */
export function sourceSemanticPropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[],version:17|18=17){
  const resolveQuote=version===18?resolveSourceTaskQuote:resolveSourceEvidenceQuote;
  const old=sourceClausePropositionModelSchemaFor(chunks,16,SOURCE_CAPACITY,resolveQuote),input=propositionSourceInput(chunks);
  const schema=structuredClone(old.jsonSchema) as JSONSchema7;
  schema.properties!.v={type:"integer",enum:[version]};
  schema.definitions!.PriorArtSourceQuoteContext={type:"object",properties:{quote:{type:"string"},before:{type:"string"},after:{type:"string"}},required:["quote","before","after"],additionalProperties:false};
  schema.definitions!.PriorArtSourceCellQuote={anyOf:[{type:"string",description:"Exact quote unique within W."},{$ref:"#/definitions/PriorArtSourceQuoteContext"}]};
  schema.definitions!.PriorArtSourceEvidence={anyOf:[{type:"array",items:{type:"integer"},description:"Nonempty consecutive clause IDs, all inside W."},quoteRef]};
  if(version===18){
    schema.definitions!.PriorArtSourceQuoteContext={type:"object",properties:{first:{type:"integer"},last:{type:"integer"},quote:{type:"string"},before:{type:"string"},after:{type:"string"}},required:["first","last","quote","before","after"],additionalProperties:false};
    schema.definitions!.PriorArtSourceCellQuote={anyOf:[{type:"string",description:"clauseID:exact unique quote, e.g. 2:赤弁; clause must be in W."},{$ref:"#/definitions/PriorArtSourceQuoteContext"}]};
    schema.definitions!.PriorArtSourceRange={type:"object",properties:{first:{type:"integer"},last:{type:"integer"}},required:["first","last"],additionalProperties:false};
    schema.definitions!.PriorArtSourceEvidence={anyOf:[{$ref:"#/definitions/PriorArtSourceRange"},quoteRef]};
  }
  schema.definitions!.PriorArtSourceOperators={type:"object",properties:Object.fromEntries(operatorKeys.map(k=>[k,{anyOf:[evidenceRef,{type:"null"}]}])),required:[...operatorKeys],additionalProperties:false};
  const change=(node:unknown):void=>{
    if(!record(node))return;
    if(record(node.properties)){
      let properties=node.properties;
      if(version===18&&Object.hasOwn(properties,"W")){
        properties={T:{type:"array",items:{type:"integer"},description:"Covered readingTasks indices; [] for other meanings."},...properties};
        node.properties=properties;
        node.required=["T",...(node.required as string[])];
      }
      for(const [key,full] of Object.entries(enumKeys)){
        const field=properties[key];
        if(record(field)&&Array.isArray(field.enum)){
          const allowed=field.enum.map(n=>SOURCE_MEANING_ENUMS[full][n as number]);
          if(allowed.some(x=>x===undefined))throw invalid();properties[key]={...field,type:"string",enum:allowed};
        }
      }
      if(Object.hasOwn(properties,"P")){
        // Strict provider schemas require a $ref to stand alone. Inline this
        // small union so the action description does not become a ref sibling.
        properties.a={...(structuredClone(schema.definitions!.PriorArtSourceCellQuote) as JSONSchema7),description:version===18?"Exact action quote; maintains includes the maintained state and verb.":"Exact action words for this predicate in this claim, not a whole-clause default. Includes maintained state when maintains proves it."};
        node.required=[...(node.required as string[]),"a"];
      }
    }
    Object.values(node).forEach(child=>Array.isArray(child)?child.forEach(change):change(child));
  };
  change(schema);assertSourceGridProviderSchema(schema);
  return jsonSchema(schema,{validate:async raw=>{
    try{
      if(!exact(raw,["v","s"])||raw.v!==version||!Array.isArray(raw.s)||raw.s.length!==input.sources.length||
        Buffer.byteLength(JSON.stringify(raw),"utf8")>SOURCE_CAPACITY.wireBytes||!old.validate)throw invalid();
      const quote=(v:unknown):unknown=>{
        if(version===18){
          if(typeof v==="string"&&/^(0|[1-9]\d*):[\s\S]+$/u.test(v))return v;
          if(exact(v,["first","last","quote","before","after"]))return {...v};
          throw invalid();
        }
        if(typeof v==="string"&&v.length)return v;
        if(!exact(v,["quote","before","after"])||typeof v.quote!=="string"||!v.quote||typeof v.before!=="string"||typeof v.after!=="string")throw invalid();
        return [v.quote,v.before,v.after];
      };
      const proof=(v:unknown,c:SourceReadingClaim,ids:number[]):unknown=>{
        if(v===null)return null;
        if(version===18){
          if(exact(v,["first","last"]))return sourceConsecutiveIds(c,v.first,v.last,ids);
          return quote(v);
        }
        if(Array.isArray(v)){if(!v.length||v.some(n=>!Number.isSafeInteger(n)))throw invalid();return [...v];}
        return quote(v);
      };
      const converted={v:16,s:raw.s.map((source,i)=>{
        if(!record(source)||source.d!==input.sources[i].sourceDigest)throw invalid();
        const claims=input.sources[i].source.claims.map(c=>sourceReadingClaim(c.claimNo,c.segments.map(p=>p.text).join("")));
        const checked=new Map(claims.map(c=>[c.claimNo,[] as CheckedSourceFact[]]));
        const tasks=new Map(claims.map(c=>[c.claimNo,sourceReadingTasks(c)]));
        const completed=new Map(claims.map(c=>[c.claimNo,new Set<number>()]));
        const fact=(c:SourceReadingClaim,f:unknown)=>{
          if(!record(f)||!record(f.m)||!Array.isArray(f.W)||!f.W.length||f.W.length>12||
            f.W.some(n=>!Number.isSafeInteger(n)||n<0||!c.clauses[n])||new Set(f.W).size!==f.W.length||
            !exact(f.O,operatorKeys))throw invalid();
          const ids=f.W as number[],m={...f.m},termSpans=new Map<string,Span[][]>();
          const term=(v:unknown):{wire:unknown[];spans:Span[]}=>{
            if(!Array.isArray(v)||!v.length||v.length>4)throw invalid();
            const wire=v.map(quote);return {wire,spans:wire.map(q=>resolveQuote(c,q,ids))};
          };
          for(const [key,full] of Object.entries(enumKeys))if(Object.hasOwn(m,key)){
            if(typeof m[key]!=="string")throw invalid();
            const n=SOURCE_MEANING_ENUMS[full].indexOf(m[key] as string);if(n<0)throw invalid();m[key]=n;
          }
          for(const k of ["u","i","j"])if(Object.hasOwn(m,k)&&m[k]!==null){const t=term(m[k]);m[k]=t.wire;termSpans.set(k,[t.spans]);}
          for(const k of ["G","M","V","B","J"])if(Object.hasOwn(m,k)){
            if(!Array.isArray(m[k]))throw invalid();const ts=m[k].map(term);m[k]=ts.map(t=>t.wire);termSpans.set(k,ts.map(t=>t.spans));
          }
          const readProof=(v:unknown):Span|null=>{
            if(v===null)return null;
            const p=proof(v,c,ids);
            if(Array.isArray(p)&&typeof p[0]==="number"){
              const ns=p as number[];if(ns.some((n,i)=>!ids.includes(n)||i>0&&n!==ns[i-1]+1))throw invalid();
              return [c.clauses[ns[0]][0],c.clauses[ns.at(-1)!][1]];
            }
            return resolveQuote(c,p,ids);
          };
          let action:Span|null=null;
          if(f.m.k==="relation"){action=resolveQuote(c,quote(m.a),ids);delete m.a;}
          else if(Object.hasOwn(m,"a"))throw invalid();
          const operators=f.O;
          const O=operatorKeys.map(k=>proof(operators[k],c,ids));
          let F=f.F;
          if(record(F)){
            if(!exact(F,["E","X","T","C","D"])||!Array.isArray(F.C)||!Array.isArray(F.D))throw invalid();
            F={E:proof(F.E,c,ids),X:proof(F.X,c,ids),T:proof(F.T,c,ids),C:F.C.map(p=>proof(p,c,ids)),D:F.D.map(p=>proof(p,c,ids))};
          }
          const identity=JSON.stringify({...m,G:[],a:action,u:termSpans.get("u"),J:termSpans.get("J")});
          checked.get(c.claimNo)!.push({kind:f.m.k as string,predicate:f.m.P as string|undefined,action,
            polarity:f.m.p as string,polarityProof:readProof(f.O.polarity),evidence:ids.map(id=>c.clauses[id]),objectSpans:termSpans.get("J")??[],guardSpans:termSpans.get("G")??[],guardProof:readProof(f.O.guard),identity});
          if(version===18){
            const routePoints=["i","V","j"].flatMap(k=>(termSpans.get(k)??[]).flat());
            const selected=assertSourceTaskBindings(tasks.get(c.claimNo)!,f.T,f.m,ids,action,routePoints);
            selected.forEach(id=>completed.get(c.claimNo)!.add(id));
            const {T,...rest}=f;void T;return {...rest,m,O,F};
          }
          return {...f,m,O,F};
        };
        const answer=Object.fromEntries(Object.entries(source).map(([key,value])=>{
          if(key==="d")return[key,value];
          const own=/^c([1-9]\d*)$/.exec(key),loop=/^loop(0|[1-9]\d*)$/.exec(key);
          const no=own?Number(own[1]):loop?input.sources[i].recognizedLoopRoutes[Number(loop[1])]?.claimNo:undefined;
          const c=claims.find(c=>c.claimNo===no);if(!c)throw invalid();
          if(loop)return[key,fact(c,value)];
          if(!Array.isArray(value))throw invalid();return[key,value.map(v=>fact(c,v))];
        }));
        for(const c of claims){
          if(version===18&&completed.get(c.claimNo)!.size!==tasks.get(c.claimNo)!.length)throw invalid();
          assertSourceSemanticReading(c,checked.get(c.claimNo)!);
        }
        return answer;
      })};
      return await old.validate(converted);
    }catch{return {success:false,error:invalid()};}
  }});
}
