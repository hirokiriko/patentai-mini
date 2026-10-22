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

/** New output contract, not a repair of v16 responses. Names replace numeric
 * meaning enums; strict context objects replace ambiguous string-array tuples.
 * The existing exact citation, domain, reference and route validators remain. */
export function sourceSemanticPropositionModelSchemaFor(chunks:readonly ManagedComparisonChunk[]){
  const old=sourceClausePropositionModelSchemaFor(chunks,16,SOURCE_CAPACITY),input=propositionSourceInput(chunks);
  const schema=structuredClone(old.jsonSchema) as JSONSchema7;
  schema.properties!.v={type:"integer",enum:[17]};
  schema.definitions!.PriorArtSourceQuoteContext={type:"object",properties:{quote:{type:"string"},before:{type:"string"},after:{type:"string"}},required:["quote","before","after"],additionalProperties:false};
  schema.definitions!.PriorArtSourceCellQuote={anyOf:[{type:"string",description:"Exact quote unique within W."},{$ref:"#/definitions/PriorArtSourceQuoteContext"}]};
  schema.definitions!.PriorArtSourceEvidence={anyOf:[{type:"array",items:{type:"integer"},description:"Nonempty consecutive clause IDs, all inside W."},quoteRef]};
  schema.definitions!.PriorArtSourceOperators={type:"object",properties:Object.fromEntries(operatorKeys.map(k=>[k,{anyOf:[evidenceRef,{type:"null"}]}])),required:[...operatorKeys],additionalProperties:false};
  const change=(node:unknown):void=>{
    if(!record(node))return;
    if(record(node.properties)){
      for(const [key,full] of Object.entries(enumKeys)){
        const field=node.properties[key];
        if(record(field)&&Array.isArray(field.enum)){
          const allowed=field.enum.map(n=>SOURCE_MEANING_ENUMS[full][n as number]);
          if(allowed.some(x=>x===undefined))throw invalid();node.properties[key]={...field,type:"string",enum:allowed};
        }
      }
      if(Object.hasOwn(node.properties,"P")){
        node.properties.a={...quoteRef,description:"Exact action words for this predicate in this claim, not a whole-clause default. Includes maintained state when maintains proves it."};
        node.required=[...(node.required as string[]),"a"];
      }
    }
    Object.values(node).forEach(child=>Array.isArray(child)?child.forEach(change):change(child));
  };
  change(schema);assertSourceGridProviderSchema(schema);
  return jsonSchema(schema,{validate:async raw=>{
    try{
      if(!exact(raw,["v","s"])||raw.v!==17||!Array.isArray(raw.s)||raw.s.length!==input.sources.length||
        Buffer.byteLength(JSON.stringify(raw),"utf8")>SOURCE_CAPACITY.wireBytes||!old.validate)throw invalid();
      const quote=(v:unknown):string|string[]=>{
        if(typeof v==="string"&&v.length)return v;
        if(!exact(v,["quote","before","after"])||typeof v.quote!=="string"||!v.quote||typeof v.before!=="string"||typeof v.after!=="string")throw invalid();
        return [v.quote,v.before,v.after];
      };
      const proof=(v:unknown):unknown=>{
        if(v===null)return null;
        if(Array.isArray(v)){if(!v.length||v.some(n=>!Number.isSafeInteger(n)))throw invalid();return [...v];}
        return quote(v);
      };
      const converted={v:16,s:raw.s.map((source,i)=>{
        if(!record(source)||source.d!==input.sources[i].sourceDigest)throw invalid();
        const claims=input.sources[i].source.claims.map(c=>sourceReadingClaim(c.claimNo,c.segments.map(p=>p.text).join("")));
        const checked=new Map(claims.map(c=>[c.claimNo,[] as CheckedSourceFact[]]));
        const fact=(c:SourceReadingClaim,f:unknown)=>{
          if(!record(f)||!record(f.m)||!Array.isArray(f.W)||!f.W.length||f.W.length>12||
            f.W.some(n=>!Number.isSafeInteger(n)||n<0||!c.clauses[n])||new Set(f.W).size!==f.W.length||
            !exact(f.O,operatorKeys))throw invalid();
          const ids=f.W as number[],m={...f.m},termSpans=new Map<string,Span[][]>();
          const term=(v:unknown):{wire:unknown[];spans:Span[]}=>{
            if(!Array.isArray(v)||!v.length||v.length>4)throw invalid();
            const wire=v.map(quote);return {wire,spans:wire.map(q=>resolveSourceEvidenceQuote(c,q,ids))};
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
            const p=proof(v);
            if(Array.isArray(p)&&typeof p[0]==="number"){
              const ns=p as number[];if(ns.some((n,i)=>!ids.includes(n)||i>0&&n!==ns[i-1]+1))throw invalid();
              return [c.clauses[ns[0]][0],c.clauses[ns.at(-1)!][1]];
            }
            return resolveSourceEvidenceQuote(c,p,ids);
          };
          let action:Span|null=null;
          if(f.m.k==="relation"){action=resolveSourceEvidenceQuote(c,quote(m.a),ids);delete m.a;}
          else if(Object.hasOwn(m,"a"))throw invalid();
          const operators=f.O;
          const O=operatorKeys.map(k=>proof(operators[k]));
          let F=f.F;
          if(record(F)){
            if(!exact(F,["E","X","T","C","D"])||!Array.isArray(F.C)||!Array.isArray(F.D))throw invalid();
            F={E:proof(F.E),X:proof(F.X),T:proof(F.T),C:F.C.map(proof),D:F.D.map(proof)};
          }
          const identity=JSON.stringify({...m,G:[],a:action,u:termSpans.get("u"),J:termSpans.get("J")});
          checked.get(c.claimNo)!.push({kind:f.m.k as string,predicate:f.m.P as string|undefined,action,
            polarity:f.m.p as string,polarityProof:readProof(f.O.polarity),evidence:ids.map(id=>c.clauses[id]),objectSpans:termSpans.get("J")??[],guardSpans:termSpans.get("G")??[],guardProof:readProof(f.O.guard),identity});
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
        for(const c of claims)assertSourceSemanticReading(c,checked.get(c.claimNo)!);
        return answer;
      })};
      return await old.validate(converted);
    }catch{return {success:false,error:invalid()};}
  }});
}
