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
  "generates_heat", "absorbs_heat", "releases_heat", "maintains", "at_least", "at_most", "greater_than", "less_than"] as const;
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
export function expandSourceWitness(witness: CompactSourceWitness): SourceExtraction {
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

export type SourceDescriptor = { id: string; claimNo: number; basis: readonly Span[]; kind: Meaning["kind"]; subject: string | null };
export const compactSourceDescriptors = (facts: readonly SourceDescriptor[]) =>
  facts.map(f => [f.id, f.claimNo, f.basis, f.kind, f.subject] as const);
