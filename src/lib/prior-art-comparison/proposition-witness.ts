import type { SourceExtraction } from "./proposition-extraction";
import type { Meaning, Span } from "./propositions";

// The actual internal witness uses exact dictionaries, not repeated copies of
// the same quoted words and coordinates. No normalization or inference occurs.
const kinds = ["set", "path", "relation"] as const;
const contexts = ["capability", "operation", "unresolved"] as const;
const guards = ["unconditional", "when", "only_when", "unresolved"] as const;
const polarities = ["positive", "negative", "reserved"] as const;
const selections = ["required", "one", "nonempty", "all", "unspecified"] as const;
const extents = ["closed", "partial", "segment", "whole", "unresolved"] as const;
const relations = ["route", "precedes"] as const;
const predicates = ["has", "upstream", "downstream", "inside", "opens", "closes", "fully_closes",
  "generates_heat", "absorbs_heat", "releases_heat", "maintains", "at_least", "at_most", "greater_than", "less_than",
  "opens_one", "opens_together", "executes", "stops", "power_ends"] as const;
type EncodedMeaning = [number, number | null, number, number, number[], number, ...unknown[]];
type Frame = [number, number, number, number[], number[]];
type Fact = [number, number[], EncodedMeaning, [number, number[]][], (number | null)[], Frame | null];
export type CompactSourceWitness = {
  version: 1;
  sources: { digest: string; terms: string[]; positions: [number, number, number][]; facts: Fact[] }[];
};
function intern<T>(values: T[]) {
  const seen = new Map<string, number>();
  return (value: T) => {
    const key = JSON.stringify(value), prior = seen.get(key);
    if (prior !== undefined) return prior;
    const at = values.length; values.push(value); seen.set(key, at); return at;
  };
}
export function compactSourceWitness(raw: SourceExtraction): CompactSourceWitness {
  return { version: 1, sources: raw.sources.map(source => {
    const terms: string[] = [], positions: [number, number, number][] = [];
    const term = intern(terms), position = intern(positions);
    const facts: Fact[] = source.facts.map(f => {
      const span = (s: Span) => position([f.claimNo, ...s]);
      const m = f.meaning;
      const common: EncodedMeaning = [kinds.indexOf(m.kind), m.subject === null ? null : term(m.subject),
        contexts.indexOf(m.context), guards.indexOf(m.guard.relation), m.guard.conditions.map(term), polarities.indexOf(m.polarity)];
      const meaning: EncodedMeaning = m.kind === "set"
        ? [...common, selections.indexOf(m.selection), extents.indexOf(m.extent), m.members.map(term)]
        : m.kind === "path" ? [...common, m.origin === null ? null : term(m.origin),
          m.destination === null ? null : term(m.destination), m.via.map(term), m.bypass.map(term),
          extents.indexOf(m.extent), relations.indexOf(m.relation)]
        : [...common, predicates.indexOf(m.predicate), m.objects.map(term)];
      const r = f.routeFrame;
      return [f.claimNo, f.basis.map(span), meaning, f.bindings.map(b => [term(b.term), b.spans.map(span)]),
        [f.operators.selection, f.operators.extent, f.operators.polarity, f.operators.guard, f.operators.context].map(s => s === null ? null : span(s)),
        r ? [span(r.entry), span(r.exit), span(r.route), r.exclusions.map(span), r.controls.map(span)] : null];
    });
    return { digest: source.sourceDigest, terms, positions, facts };
  }) };
}

/** Reconstitute every field for inspection and round-trip checks. The public
 * extraction schema and all original domain checks remain the trust boundary. */
function expandSourceWitnessV1(witness: CompactSourceWitness): SourceExtraction {
  const invalid = () => new Error("comparison_witness_invalid");
  const at = <T>(values: readonly T[], index: unknown): T => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= values.length) throw invalid();
    return values[index as number];
  };
  if (witness.version !== 1) throw invalid();
  const raw: SourceExtraction = { sources: witness.sources.map(source => ({
    sourceDigest: source.digest, facts: source.facts.map(([claimNo, basis, m, bindings, operators, frame]) => {
      const term = (n: unknown) => at(source.terms, n);
      const terms = (ns: unknown) => {
        if (!Array.isArray(ns)) throw invalid();
        return ns.map(term);
      };
      const span = (n: number): Span => {
        const [claim, start, end] = at(source.positions, n);
        if (claim !== claimNo) throw invalid();
        return [start, end];
      };
      const common = { subject: m[1] === null ? null : term(m[1]), context: at(contexts, m[2]),
        guard: { relation: at(guards, m[3]), conditions: terms(m[4]) }, polarity: at(polarities, m[5]) };
      let meaning: Meaning;
      const kind = at(kinds, m[0]);
      if (kind === "set") {
        const extent = at(extents, m[7]);
        if (m.length !== 9 || !["closed", "partial"].includes(extent)) throw invalid();
        meaning = { ...common, kind, selection: at(selections, m[6]), extent: extent as "closed" | "partial", members: terms(m[8]) };
      } else if (kind === "path") {
        const extent = at(extents, m[10]);
        if (m.length !== 12 || !["segment", "whole", "unresolved"].includes(extent)) throw invalid();
        meaning = { ...common, kind, origin: m[6] === null ? null : term(m[6]), destination: m[7] === null ? null : term(m[7]),
          via: terms(m[8]), bypass: terms(m[9]), extent: extent as "segment" | "whole" | "unresolved", relation: at(relations, m[11]) };
      } else {
        if (m.length !== 8) throw invalid();
        meaning = { ...common, kind, predicate: at(predicates, m[6]), objects: terms(m[7]) };
      }
      if (operators.length !== 5) throw invalid();
      const [selection, extent, polarity, guard, context] = operators.map(n => n === null ? null : span(n));
      return { claimNo, basis: basis.map(span), meaning, bindings: bindings.map(([t, ss]) => ({ term: term(t), spans: ss.map(span) })),
        operators: { selection, extent, polarity, guard, context },
        routeFrame: frame ? { entry: span(frame[0]), exit: span(frame[1]), route: span(frame[2]),
          exclusions: frame[3].map(span), controls: frame[4].map(span) } : null };
    }),
  })) };
  // Noncanonical extra dictionaries or altered tuple lengths cannot hide data.
  if (JSON.stringify(compactSourceWitness(raw)) !== JSON.stringify(witness)) throw invalid();
  return raw;
}

type PositionRun=[number,...number[]];
type MeaningHead=[number,number|null,number,number,number[],number];
type RuntimeFact=[number,number|number[],[number,...unknown[]],[number,number[]][],(number|null)[]|null,Frame?];
export type RuntimeSourceWitness={version:2;sources:{digest:string;terms:string[];
  positions:PositionRun[];heads:MeaningHead[];facts:RuntimeFact[]}[]};
/** Lossless runtime v2. Repeated semantic prefixes are interned, never merged.
 * Position runs preserve original dictionary order and every claim binding. */
export function compactRuntimeSourceWitness(raw:SourceExtraction):RuntimeSourceWitness {
  const prior=compactSourceWitness(raw);
  return {version:2,sources:prior.sources.map(source=>{
    const positions:PositionRun[]=[],heads:MeaningHead[]=[],head=intern(heads);
    for(const[claim,start,end]of source.positions){
      let run=positions.at(-1);
      if(!run||run[0]!==claim){run=[claim];positions.push(run);}
      run.push(start,end-start);
    }
    const facts:RuntimeFact[]=source.facts.map(([claim,basis,m,bindings,operators,frame])=>{
      const result:RuntimeFact=[claim,basis.length===1?basis[0]:basis,
        [head(m.slice(0,6) as MeaningHead),...m.slice(6)],bindings,operators.every(p=>p===null)?null:operators];
      if(frame)result.push(frame);
      return result;
    });
    return {digest:source.digest,terms:source.terms,positions,heads,facts};
  })};
}
export function expandSourceWitness(witness:CompactSourceWitness|RuntimeSourceWitness):SourceExtraction {
  if(witness.version===1)return expandSourceWitnessV1(witness);
  const invalid=()=>new Error("comparison_witness_invalid");
  if(witness.version!==2)throw invalid();
  const prior:CompactSourceWitness={version:1,sources:witness.sources.map(source=>({
    digest:source.digest,terms:source.terms,
    positions:source.positions.flatMap(run=>{
      if(run.length<3||run.length%2!==1||run.some(n=>!Number.isSafeInteger(n)||n<0)||run[0]===0)throw invalid();
      const spans:[number,number,number][]=[];
      for(let i=1;i<run.length;i+=2){
        const start=run[i],length=run[i+1];
        if(length===0||!Number.isSafeInteger(start+length))throw invalid();
        spans.push([run[0],start,start+length]);
      }
      return spans;
    }),
    facts:source.facts.map(([claim,basis,m,bindings,op,frame])=>{
      const head=source.heads[m[0]];
      if(!Number.isSafeInteger(m[0])||m[0]<0||!head||head.length!==6)throw invalid();
      const operators=op??[null,null,null,null,null];
      return [claim,typeof basis==="number"?[basis]:basis,[...head,...m.slice(1)] as EncodedMeaning,
        bindings,operators,frame??null] as Fact;
    }),
  }))};
  const raw=expandSourceWitnessV1(prior);
  if(JSON.stringify(compactRuntimeSourceWitness(raw))!==JSON.stringify(witness))throw invalid();
  return raw;
}

export type SourceDescriptor = { id: string; claimNo: number; basis: readonly Span[]; kind: Meaning["kind"]; subject: string | null };
export const compactSourceDescriptors = (facts: readonly SourceDescriptor[]) =>
  facts.map(f => [f.id, f.claimNo, f.basis, f.kind, f.subject] as const);

/** Target input shares only exact descriptor strings and basis arrays. It does
 * not share meanings or allow an ID to borrow evidence from another claim. */
export function compactSourceDescriptorTable(facts:readonly SourceDescriptor[]) {
  const subjects:string[]=[],bases:(readonly Span[])[]=[];
  const subject=intern(subjects),basis=intern(bases);
  const rows=facts.map(f=>[f.id,f.claimNo,basis(f.basis),kinds.indexOf(f.kind),
    f.subject===null?null:subject(f.subject)] as const);
  return {version:2 as const,subjects,bases,rows};
}
export function expandSourceDescriptorTable(table:ReturnType<typeof compactSourceDescriptorTable>):SourceDescriptor[]{
  const at=<T>(values:readonly T[],n:number):T=>{
    if(!Number.isSafeInteger(n)||n<0||n>=values.length)throw new Error("comparison_descriptor_invalid");
    return values[n];
  };
  if(table.version!==2)throw new Error("comparison_descriptor_invalid");
  const facts=table.rows.map(([id,claimNo,basis,kind,subject])=>({id,claimNo,
    basis:at(table.bases,basis),kind:at(kinds,kind),subject:subject===null?null:at(table.subjects,subject)}));
  if(JSON.stringify(compactSourceDescriptorTable(facts))!==JSON.stringify(table))throw new Error("comparison_descriptor_invalid");
  return facts;
}
