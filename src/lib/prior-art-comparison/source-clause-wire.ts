import { jsonSchema, type JSONSchema7 } from "ai";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { propositionSourceInput, legacyPropositionSourceTransport } from "./proposition-extraction";
import { assertEvidenceContains, sourceReadingClaim, type SourceReadingClaim } from "./source-clause-coverage";
import { resolveSourceContextQuote } from "./source-direct-quotes";
import { sourceCellRef } from "./source-citation-grid";
import { sourceGridPropositionModelSchemaFor, assertSourceGridProviderSchema } from "./source-grid-wire";
import type { Span } from "./propositions";

const invalid = () => new Error("comparison_source_clause_invalid");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const quoteSchema: JSONSchema7 = { anyOf: [
  { type: "string", description: "<clause id>:<exact unique substring>, e.g. 2:赤弁. Only that claim's specified clause is searched." },
  { type: "array", items: { type: "string" }, description: "Exactly [clause id,quote,before,after]. Exact adjacent context disambiguates within that clause; no coordinates." },
] };
const proofSchema: JSONSchema7 = { anyOf: [
  { type: "array", items: { type: "integer" }, description: "Consecutive ascending clause IDs. [] means whole-claim proof only, never a term." },
  { type:"string", description:"id:exact unique quote in that clause." },
  { type:"array", items:{type:"string"}, description:"[id,quote,before,after] or [startId,endId,quote,before,after]. Exact unique quote within the specified contiguous clause range." },
] };

export function propositionSourceClauseTransport(input: ReturnType<typeof propositionSourceInput>) {
  const old = legacyPropositionSourceTransport(input);
  return { task: old.task, citationClauses: { version: 1 }, sources: old.sources.map((s, i) => {
    const readings = new Map(s.source.claims.map(c => [c.claimNo, sourceReadingClaim(c.claimNo, c.parts.map(p => p.text).join(""))]));
    const cite = (c: SourceReadingClaim, span: Span) => ({ text: c.grid.text.slice(...span),
      clauses: c.clauses.flatMap(([a,b], id) => a < span[1] && b > span[0] ? [id] : []) });
    return { sourceDigest: s.sourceDigest, side: s.side, docId: s.docId, comparisonRoots: s.comparisonRoots,
      recognizedLoopRoutes: input.sources[i].recognizedLoopRoutes.map((r,id) => {
        const c = readings.get(r.claimNo)!;
        return { id, claimNo:r.claimNo, basisParts:r.basisParts, mode: cite(c,r.mode), entry: cite(c,r.entry),
          exit: cite(c,r.exit), route: cite(c,r.route).clauses, exclusion: cite(c,r.definition).clauses, control: cite(c,r.control).clauses };
      }), source: { publicationNumber: s.source.publicationNumber,
        claims: s.source.claims.map(({parts, canonicalModeSets, ...c}) => { void parts; return { ...c,
          ...(canonicalModeSets.length ? {canonicalModeSets} : {}),
          clauses: readings.get(c.claimNo)!.clauses.map(([a,b],id) => [id, readings.get(c.claimNo)!.grid.text.slice(a,b)] as [number,string]),
        }; }) } };
  }) };
}

/** Only the named clause is searched. Exact context may disambiguate repeated
 * words; absent/ambiguous quotes never search another clause or get repaired. */
export function resolveSourceClauseQuote(c: SourceReadingClaim, value: unknown): Span {
  let id: string, quote: string, before = "", after = "";
  if (typeof value === "string") {
    const m = /^(0|[1-9]\d*):([\s\S]+)$/.exec(value);
    if (!m) throw invalid();
    [,id,quote] = m;
  } else {
    if (!Array.isArray(value) || value.length !== 4 || value.some(v => typeof v !== "string")) throw invalid();
    [id,quote,before,after] = value;
  }
  if (!/^(0|[1-9]\d*)$/.test(id) || !Number.isSafeInteger(Number(id))) throw invalid();
  const span = c.clauses[Number(id)];
  if (!span) throw invalid();
  const [a,b] = resolveSourceContextQuote(c.grid.text.slice(...span), {quote,before,after,edge:"none"});
  return [span[0]+a,span[0]+b];
}
function clauseIds(c: SourceReadingClaim, value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.some(id => !Number.isSafeInteger(id) || id < 0 || !c.clauses[id]) ||
      new Set(value).size !== value.length) throw invalid();
  return value;
}

/** v16 selects an exact occurrence inside the fact's declared evidence. The
 * clause IDs already occur in W; asking the model to repeat them for every
 * term introduced contradictory locations. No other claim is searched. */
export function resolveSourceEvidenceQuote(c: SourceReadingClaim, value: unknown, ids: readonly number[]): Span {
  let quote: string, before = "", after = "";
  if (typeof value === "string") quote = value;
  else {
    if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== "string")) throw invalid();
    [quote,before,after] = value;
  }
  if (!quote.length) throw invalid();
  const evidence = clauseIds(c, [...ids]).map(id => c.clauses[id]);
  const context = before + quote + after, matches: Span[] = [];
  for (let at = c.grid.text.indexOf(context); at >= 0; at = c.grid.text.indexOf(context, at + 1)) {
    const span: Span = [at + before.length, at + before.length + quote.length];
    try { assertEvidenceContains(evidence,span); } catch { continue; }
    // Context identifies an occurrence; it is never additional fact evidence.
    // It may extend beyond W, but must remain exact and scalar-aligned.
    sourceCellRef(c.grid,[at,at + context.length]);
    const resolved = resolveSourceContextQuote(c.grid.text.slice(at,at + context.length), {quote,before,after,edge:"both"});
    matches.push([at + resolved[0],at + resolved[1]]);
  }
  if (matches.length !== 1) throw invalid();
  // Retain scalar-boundary validation before accepting the exact occurrence.
  sourceCellRef(c.grid,matches[0]);
  return matches[0];
}

/** v15 removes generated coordinates and the redundant positional Y table.
 * It does not create facts: every clause must be cited by an actual fact, and
 * the existing v14/domain validators still check all supplied roles/proofs. */
export function sourceClausePropositionModelSchemaFor(chunks: readonly ManagedComparisonChunk[], version: 15 | 16 = 16) {
  const old = sourceGridPropositionModelSchemaFor(chunks), input = propositionSourceInput(chunks);
  const schema = structuredClone(old.jsonSchema) as JSONSchema7;
  schema.properties!.v = {type:"integer",enum:[version]};
  const exactQuote: JSONSchema7 = { anyOf: [
    {type:"string",description:"Exact quote, unique within this fact's W. No clause-ID prefix."},
    {type:"array",items:{type:"string"},description:"Exactly [quote,before,after]; exact adjacent context identifies one occurrence in W."},
  ] };
  schema.definitions!.PriorArtSourceCellQuote = version === 15 ? quoteSchema : exactQuote;
  schema.definitions!.PriorArtSourceEvidence = version === 15 ? proofSchema : {anyOf:[
    {type:"array",items:{type:"integer"},description:"Nonempty consecutive ascending clause IDs containing the complete operator evidence. Must be within W."},
    ...exactQuote.anyOf!,
  ]};
  if (version === 16) schema.definitions!.PriorArtSourceOperators = {
    type:"array",items:{anyOf:[{$ref:"#/definitions/PriorArtSourceEvidence"},{type:"null"}]},
    description:"Exactly five proofs [selection,extent,polarity,guard,context]. Guard required for g=1/2; polarity required for p=1. Quote complete conditions.",
  };
  // Zod emits cN as a shared $ref, not an inline union.
  if (schema.definitions!.PriorArtSourceClaimAnswer)
    schema.definitions!.PriorArtSourceClaimAnswer = { $ref:"#/definitions/PriorArtSourceAdditionalFacts" };
  delete schema.definitions!.PriorArtSourceUnresolved;
  const change = (node: unknown): void => {
    if (!record(node)) return;
    if (record(node.properties) && Array.isArray(node.required)) {
      if (version === 16 && Object.hasOwn(node.properties,"O")) node.properties.O = {$ref:"#/definitions/PriorArtSourceOperators"};
      if (Object.hasOwn(node.properties,"W")) node.properties.W = {type:"array",items:{type:"integer"},description:"1..12 distinct complete clause IDs supporting this fact; include postposed actor, full conditions and dependency reference."};
      if (Object.hasOwn(node.properties,"Y")) { delete node.properties.Y; node.required = node.required.filter(k => k !== "Y"); }
      if (Object.hasOwn(node.properties,"k")) for (const [key, excluded] of Object.entries({x:2,g:3,p:2,e:4,S:4})) {
        const field=node.properties[key];
        if (record(field) && Array.isArray(field.enum)) field.enum=field.enum.filter(value=>value!==excluded);
      }
      for (const [key, child] of Object.entries(node.properties)) if (/^c[1-9]\d*$/.test(key) && record(child) && Array.isArray(child.anyOf)) {
        const facts = child.anyOf.find(v => record(v) && v.type === "array");
        if (!facts) throw invalid();
        node.properties[key] = facts;
      }
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(change); else change(child);
  };
  change(schema); assertSourceGridProviderSchema(schema);
  return jsonSchema(schema, { validate: async raw => {
    try {
      if (!record(raw) || raw.v !== version || !Array.isArray(raw.s) || raw.s.length !== input.sources.length ||
          Buffer.byteLength(JSON.stringify(raw),"utf8") > 32_000 || !old.validate) throw invalid();
      const converted = { ...raw, v:14, s:raw.s.map((s,i) => {
        if (!record(s) || Object.hasOwn(s,"Y")) throw invalid();
        const claims = input.sources[i].source.claims.map(c => sourceReadingClaim(c.claimNo,c.segments.map(p=>p.text).join("")));
        const coverage = new Map(claims.map(c => [c.claimNo,c.clauses.map(() => [] as string[])]));
        const fact = (c:SourceReadingClaim, f:unknown, address:string) => {
          if (!record(f) || !record(f.m)) throw invalid();
          if (f.m.x === 2 || f.m.g === 3 || f.m.p === 2 || f.m.e === 4 || f.m.S === 4) throw invalid();
          const ids = clauseIds(c,f.W);
          if (ids.length > 12) throw invalid();
          for (const id of ids) coverage.get(c.claimNo)![id].push(address);
          const term = (v:unknown) => {
            if (!Array.isArray(v) || !v.length || v.length > 4) throw invalid();
            return v.map(q => sourceCellRef(c.grid,version === 15 ? resolveSourceClauseQuote(c,q) : resolveSourceEvidenceQuote(c,q,ids)));
          };
          const proof = (v:unknown) => {
            if (Array.isArray(v) && !v.length) { if (version === 16) throw invalid(); return []; }
            if (typeof v === "string" || Array.isArray(v) && typeof v[0] === "string") {
              if (version === 16) return sourceCellRef(c.grid,resolveSourceEvidenceQuote(c,v,ids));
              if (Array.isArray(v) && v.length === 5 && v.every(x=>typeof x==="string")) {
                const [first,last,quote,before,after] = v;
                if (![first,last].every(id=>/^(0|[1-9]\d*)$/.test(id) && Number.isSafeInteger(Number(id))) || Number(first)>Number(last)) throw invalid();
                const a=c.clauses[Number(first)]?.[0],b=c.clauses[Number(last)]?.[1];
                if (a===undefined || b===undefined) throw invalid();
                const [start,end]=resolveSourceContextQuote(c.grid.text.slice(a,b),{quote,before,after,edge:"none"});
                return sourceCellRef(c.grid,[a+start,a+end]);
              }
              return sourceCellRef(c.grid,resolveSourceClauseQuote(c,v));
            }
            const selected = clauseIds(c,v);
            if (selected.some((id,n) => n > 0 && id !== selected[n-1]+1)) throw invalid();
            return sourceCellRef(c.grid,[c.clauses[selected[0]][0],c.clauses[selected.at(-1)!][1]]);
          };
          const m = {...f.m};
          for (const k of ["u","i","j"]) if (Object.hasOwn(m,k) && m[k] !== null) m[k] = term(m[k]);
          for (const k of ["G","M","V","B","J"]) if (Object.hasOwn(m,k)) {
            if (!Array.isArray(m[k])) throw invalid();
            m[k] = m[k].map(term);
          }
          let O = f.O, F = f.F;
          if (version === 16 && O === null) throw invalid();
          if (version === 16 && (!Array.isArray(O) ||
              ([1,2].includes(m.g as number) && O[3] === null) || (m.p === 1 && O[2] === null) ||
              (m.k === 0 && m.e === 1 && O[1] === null))) throw invalid();
          if (O !== null) { if (!Array.isArray(O) || O.length !== 5) throw invalid(); O = O.map(v=>v===null?null:proof(v)); }
          if (record(F)) {
            const fields = {...F};
            for (const k of ["E","X","T"]) fields[k] = proof(fields[k]);
            for (const k of ["C","D"]) { if (!Array.isArray(fields[k])) throw invalid(); fields[k] = fields[k].map(proof); }
            F = fields;
          }
          return {...f,m,O,F,W:ids.map(id=>sourceCellRef(c.grid,c.clauses[id]))};
        };
        const converted = Object.fromEntries(Object.entries(s).map(([key,value]) => {
          if (key === "d") return [key,value];
          const own = /^c([1-9]\d*)$/.exec(key), loop = /^loop(0|[1-9]\d*)$/.exec(key);
          const no = own ? Number(own[1]) : loop ? input.sources[i].recognizedLoopRoutes[Number(loop[1])]?.claimNo : undefined;
          const c = claims.find(c=>c.claimNo===no);
          if (!c) throw invalid();
          if (loop) return [key,fact(c,value,key)];
          // No {K,N}, empty placeholder or fallback fact can count as a reading.
          if (!Array.isArray(value)) throw invalid();
          return [key,value.map((f,n)=>fact(c,f,`${key}:${n}`))];
        }));
        const Y = claims.flatMap(c=>coverage.get(c.claimNo)!);
        if (Y.some(row=>!row.length)) throw invalid();
        return {...converted,Y};
      }) };
      return await old.validate(converted);
    } catch { return {success:false,error:invalid()}; }
  } });
}
