import { jsonSchema, type JSONSchema7 } from "ai";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { directSourceModel } from "./source-direct-quotes";
import { expandSourceWire, sourceWireSchema } from "./source-wire-compact";
import { propositionSourceInput, legacyPropositionSourceTransport } from "./proposition-extraction";
import { sourceCitationGrid, compactSourceGridRows, resolveSourceCellRef, sourceCellRef, type SourceCitationGrid } from "./source-citation-grid";
import { sourceReadingClaim, sourceFactEvidence, assertSourceClauseCoverage,assertEvidenceContains } from "./source-clause-coverage";
import type { Span } from "./propositions";
import {ComparisonError} from "./source";
import { LEGACY_SOURCE_CAPACITY, type SourceWireCapacity } from "./source-capacity";

const invalid = () => new Error("comparison_source_wire_invalid");
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const refSchema: JSONSchema7 = { type: "array", items: { type: "integer" },
  description: "Exactly [startRow,startColumn,endRow,endColumn], inclusive cells of this claim. Columns 0..9; valid ordered endpoints only." };
const proofSchema: JSONSchema7 = { ...refSchema, description: refSchema.description + " Empty [] means whole-claim operator/frame proof." };

export function assertSourceGridProviderSchema(schema:JSONSchema7):void {
  const count=(v:unknown):number=>!v||typeof v!=="object"?0:Array.isArray(v)?v.reduce((n,x)=>n+count(x),0):
    Object.keys((v as JSONSchema7).properties??{}).length+Object.values(v).reduce<number>((n,x)=>n+count(x),0);
  const depth=(v:unknown,n=0,refs:readonly string[]=[]):number=>{
    if(!isRecord(v))return n;
    if(typeof v.$ref==="string"){
      if(!v.$ref.startsWith("#/definitions/")||refs.includes(v.$ref))throw new ComparisonError("plan_limit");
      const child=schema.definitions?.[v.$ref.slice("#/definitions/".length)];
      if(!child)throw new ComparisonError("plan_limit");
      return depth(child,n,[...refs,v.$ref]);
    }
    const next=n+Number(v.type==="object");
    return Math.max(next,...[Object.values(isRecord(v.properties)?v.properties:{}),v.items,v.anyOf].flat(2)
      .filter(Boolean).map(child=>depth(child,next,refs)));
  };
  if(count(schema)>100||depth(schema)>5)throw new ComparisonError("plan_limit");
}

export function propositionSourceGridTransport(input: ReturnType<typeof propositionSourceInput>) {
  const transport = legacyPropositionSourceTransport(input);
  return { task:transport.task, citationGrid: { version: 1, columns: 10 }, sources: transport.sources.map(s => ({
    sourceDigest:s.sourceDigest,side:s.side,docId:s.docId,comparisonRoots:s.comparisonRoots,
    recognizedLoopRoutes: input.sources.find(original=>original.sourceDigest===s.sourceDigest)!.recognizedLoopRoutes.map((r,id)=>{
      const claim=input.sources.find(original=>original.sourceDigest===s.sourceDigest)!.source.claims.find(c=>c.claimNo===r.claimNo)!;
      const grid=sourceCitationGrid(claim.segments.map(p=>p.text).join(""));
      return {id,claimNo:r.claimNo,basisParts:r.basisParts,mode:sourceCellRef(grid,r.mode),
        entry:sourceCellRef(grid,r.entry),exit:sourceCellRef(grid,r.exit),route:sourceCellRef(grid,r.route),
        exclusion:sourceCellRef(grid,r.definition),control:sourceCellRef(grid,r.control)};
    }),
    // Source extraction reads every own claim. Branch expansion remains local;
    // target review still receives the complete reference logic independently.
    source: { publicationNumber:s.source.publicationNumber,
      claims: s.source.claims.map(({ parts,canonicalModeSets, ...c }) => ({ ...c,
      ...(canonicalModeSets.length?{canonicalModeSets}:{}),
      ...(()=>{const reading=sourceReadingClaim(c.claimNo,parts.map(p=>p.text).join(""));
        return {grid:compactSourceGridRows(reading.grid),clauseRefs:reading.clauses.map(span=>sourceCellRef(reading.grid,span))};})() })) } })) };
}

/** Source v14 changes only evidence coordinates. Domain validation still
 * receives the exact original terms/spans and all existing strict guards. */
export function sourceGridPropositionModelSchemaFor(chunks: readonly ManagedComparisonChunk[], capacity:SourceWireCapacity=LEGACY_SOURCE_CAPACITY) {
  const domain = directSourceModel(chunks,"cells",capacity), input = propositionSourceInput(chunks);
  const schema = structuredClone(sourceWireSchema(domain).jsonSchema) as JSONSchema7;
  if (!schema.definitions || !schema.properties?.v) throw invalid();
  schema.properties.v = { type: "integer", enum: [14] };
  schema.definitions.PriorArtSourceCellQuote = refSchema;
  schema.definitions.PriorArtSourceEvidence = proofSchema;
  schema.definitions.PriorArtSourceUnresolved = { type: "object", properties: {
    K: refSchema, N: { type: "string", description: "Concrete unrepresentable meaning, 1..400 characters." },
  }, required: ["K", "N"], additionalProperties: false };
  const addReadingFields=(node:unknown):void=>{
    if(!isRecord(node))return;
    if(isRecord(node.properties)&&Array.isArray(node.required)){
      const required=node.required;
      if(Object.hasOwn(node.properties,"m")&&Object.hasOwn(node.properties,"O")&&Object.hasOwn(node.properties,"F")){
        node.properties.W={type:"array",items:refSchema,description:"1..12 exact complete input clauses supporting this fact, covering every term occurrence. No automatic basis copy."};
        node.required=[...required,"W"];
      }
      if(Object.hasOwn(node.properties,"d")&&Object.keys(node.properties).some(k=>/^c[1-9]\d*$/.test(k))){
        node.properties.Y={type:"array",items:{type:"array",items:{type:"string"}},description:"Exactly one nonempty row per input clause, claims/input order. Addresses cN:factIndex or loopN, and/or ?concrete unrepresented remainder. No omitted rows."};
        node.required=[...required,"Y"];
      }
    }
    for(const child of Object.values(node))if(Array.isArray(child))child.forEach(addReadingFields);else addReadingFields(child);
  };
  addReadingFields(schema);
  assertSourceGridProviderSchema(schema);
  const sourceGrids = input.sources.map(s => new Map(s.source.claims.map(c =>
    [c.claimNo, sourceCitationGrid(c.segments.map(p => p.text).join(""))])));
  const quote = (grid: SourceCitationGrid, value: unknown, proof = false): unknown => {
    if (proof && Array.isArray(value) && !value.length) return ["q", null, "", "", "both"];
    resolveSourceCellRef(grid, value);
    return {K:value};
  };
  const term = (grid: SourceCitationGrid, value: unknown,evidence:readonly Span[]): unknown => {
    if (!Array.isArray(value) || !value.length || value.length > 4) throw invalid();
    return value.map(v => {assertEvidenceContains(evidence,resolveSourceCellRef(grid,v));return quote(grid,v);});
  };
  const fact = (grid: SourceCitationGrid, value: unknown,evidence:readonly Span[]): unknown => {
    if (!isRecord(value) || !isRecord(value.m)) throw invalid();
    const m = { ...value.m };
    for (const key of ["u", "i", "j"]) if (Object.hasOwn(m, key) && m[key] !== null) m[key] = term(grid, m[key],evidence);
    for (const key of ["G", "M", "V", "B", "J"]) if (Object.hasOwn(m, key)) {
      if (!Array.isArray(m[key])) throw invalid();
      m[key] = m[key].map(v => term(grid, v,evidence));
    }
    let operators = value.O;
    const proof=(v:unknown)=>{
      if(Array.isArray(v)&&v.length)assertEvidenceContains(evidence,resolveSourceCellRef(grid,v));
      return quote(grid,v,true);
    };
    if (operators !== null) {
      if (!Array.isArray(operators) || operators.length !== 5) throw invalid();
      operators = operators.map(v => v === null ? null : proof(v));
    }
    let frame = value.F;
    if (isRecord(frame)) {
      const fields = { ...frame };
      for (const k of ["E", "X", "T"]) fields[k] = proof(fields[k]);
      for (const k of ["C", "D"]) {
        const values=fields[k];
        if (!Array.isArray(values)) throw invalid();
        fields[k] = values.map(v => proof(v));
      }
      frame=fields;
    }
    const result={ ...value, m, O: operators, F: frame };
    delete (result as Record<string,unknown>).W;
    return result;
  };
  return jsonSchema(schema, { validate: async raw => {
    try {
      if (!isRecord(raw) || raw.v !== 14 || !Array.isArray(raw.s) ||
          raw.s.length !== sourceGrids.length || Buffer.byteLength(JSON.stringify(raw), "utf8") > capacity.wireBytes || !domain.validate) throw invalid();
      const value = { ...raw, v: 13, s: raw.s.map((source, i) => {
        if (!isRecord(source)) throw invalid();
        const claims=input.sources[i].source.claims.map(c=>sourceReadingClaim(c.claimNo,c.segments.map(p=>p.text).join("")));
        const evidence=new Map<string,{claimNo:number;evidence:Span[]}>();
        const collect=(address:string,no:number,answer:unknown)=>{
          const claim=claims.find(c=>c.claimNo===no);
          if(!claim||!isRecord(answer))throw invalid();
          evidence.set(address,{claimNo:no,evidence:sourceFactEvidence(claim,answer.W)});
        };
        for(const[key,answer]of Object.entries(source)){
          const c=/^c([1-9]\d*)$/.exec(key),l=/^loop(0|[1-9]\d*)$/.exec(key);
          if(c&&Array.isArray(answer))answer.forEach((f,at)=>collect(`${key}:${at}`,Number(c[1]),f));
          if(l){const no=input.sources[i].recognizedLoopRoutes[Number(l[1])]?.claimNo;if(no===undefined)throw invalid();collect(key,no,answer);}
        }
        assertSourceClauseCoverage(claims,evidence,source.Y);
        return Object.fromEntries(Object.entries(source).filter(([key])=>key!=="Y").map(([key, answer]) => {
          if (key === "d") return [key, answer];
          const claim = /^c([1-9]\d*)$/.exec(key);
          const loop = /^loop(0|[1-9]\d*)$/.exec(key);
          const no = claim ? Number(claim[1]) : loop ? input.sources[i].recognizedLoopRoutes[Number(loop[1])]?.claimNo : undefined;
          const grid = no === undefined ? undefined : sourceGrids[i].get(no);
          if (!grid) throw invalid();
          if (loop) return [key, fact(grid, answer,evidence.get(key)!.evidence)];
          if (Array.isArray(answer)) return [key, answer.map((f,at) => fact(grid, f,evidence.get(`${key}:${at}`)!.evidence))];
          if (!isRecord(answer) || Object.keys(answer).sort().join(",") !== "K,N") throw invalid();
          resolveSourceCellRef(grid,answer.K);
          return [key,answer];
        }));
      }) };
      const expanded=expandSourceWire(value) as Record<string,unknown>;
      expanded.locatorVersion=14;
      return await domain.validate(expanded);
    } catch { return { success: false, error: invalid() }; }
  } });
}
