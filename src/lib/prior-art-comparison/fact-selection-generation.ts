import { z } from "zod";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import type { DecodedSources } from "./proposition-extraction";
import type { BatchAnswer } from "./generation-batch";
import { generationQuoteOptions, generationQuoteRanges, type GenerationQuoteOptions } from "./generation-quote-options";
import { renderMeaning } from "./proposition-result";
import { meaningKey, propositionKey, type SourceProposition } from "./propositions";
import { isNominalReservationText } from "./reservation-topic";
import { ComparisonError, digest } from "./source";
import { LIMITS } from "./limits";

const printableSubject = (fact: SourceProposition) => fact.meaning.subject !== null ||
  fact.meaning.kind === "relation" && ["is_state", "power_ends"].includes(fact.meaning.predicate);

const ids = z.array(z.string().min(1).max(160)).min(1).max(2);
export const factSelectionSchema = z.object({ results: z.array(z.object({
  docId: z.number().int().positive(), baseClaimNo: z.number().int().positive(), candidateClaimNo: z.number().int().positive(),
  baseFacts: ids, candidateFacts: ids,
  common: z.array(z.object({ baseFacts: ids, candidateFacts: ids }).strict()).min(1).max(2),
  differences: z.union([z.object({ baseFacts: ids, candidateFacts: ids }).strict(),
    z.object({ reservation: z.string().min(1).max(120) }).strict()]),
  unconfirmed: z.string().min(1).max(120),
}).strict()).min(1).max(LIMITS.reviewPairs) }).strict();

/** Compact selectable observation IDs; every original fact stays in closedFacts.
 * No shortened or fabricated quotation is offered to make a choice fit. */
export function factObservationChoices(chunks: readonly ManagedComparisonChunk[], sources: DecodedSources, quotes: GenerationQuoteOptions) {
  return sources.input.sources.flatMap(source => source.scopes.map(scope => ({ scope: scope.id,
    factIds: sources.facts.filter(f => {
      if (f.scope !== scope.id || !printableSubject(f)) return false;
      try {
        if (`基準側は、${renderMeaning(f.meaning)}。`.length > 120) return false;
        const side = source.side, chunk = chunks.find(c => side === "base" || c.candidateId === source.docId);
        if (!chunk) return false;
        const prefix = side === "base" ? `b${chunk.baseDigest}:0` : `c${chunk.candidateDigest}:${chunk.candidateId}`;
        const locator = sources.locators.find(l => l.id === f.id);
        if (!locator) return false;
        const spans = [...locator.quotes, ...(locator.action ? [locator.action] : [])];
        return generationQuoteRanges(chunk[side], prefix, quotes).some(r => r.claimNo === f.claimNo && spans.length > 0 &&
          spans.every(([start, end]) => start >= r.start && end <= r.end));
      } catch { return false; }
    }).map(f => f.id),
  })));
}

/** Relevance constraints use only original claim closure and action positions.
 * A characterizing-clause boundary ranks existing actions; it supplies no new
 * fact, guard or condition. Alternatives keep their original reference graph. */
export function factControlCoverage(sources: DecodedSources) {
  const active = new Set(["opens", "closes", "fully_closes", "opens_one", "opens_together", "executes", "stops", "maintains", "generates_heat", "absorbs_heat", "releases_heat", "power_ends"]);
  return sources.input.sources.flatMap(source => source.scopes.flatMap(scope => {
    const required = scope.nodes.find(n => n.claimNo === scope.selected)?.guaranteed ?? [];
    return required.flatMap(claimNo => {
      const claim = source.source.claims.find(c => c.claimNo === claimNo);
      if (!claim) return [];
      const text = claim.segments.map(s => s.text).join("");
      const boundaries = [...text.matchAll(/(?:において|であって)[、，]/gu)];
      const from = boundaries.length ? boundaries.at(-1)!.index! + boundaries.at(-1)![0].length : 0;
      const factIds = sources.facts.filter(f => f.scope === scope.id && f.claimNo === claimNo &&
        f.meaning.kind === "relation" && f.meaning.context === "operation" && active.has(f.meaning.predicate) &&
        sources.locators.some(l => l.id === f.id && l.action && l.action[0] >= from)).map(f => f.id);
      return factIds.length ? [{ scope: scope.id, claimNo, factIds }] : [];
    });
  }));
}

/** Model chooses facts, never rewritten subjects, conditions, or source quotes.
 * Source readings remain fallible and the independent review is unchanged. */
export function decodeFactSelection(chunks: readonly ManagedComparisonChunk[], sources: DecodedSources,
  quotes: GenerationQuoteOptions, value: unknown): BatchAnswer {
  try {
    if (digest(generationQuoteOptions(chunks, sources)) !== digest(quotes)) throw Error();
    const answer = factSelectionSchema.parse(value);
    const expected = new Set(chunks.flatMap(c => c.pairs.map(p => `${c.candidateId}:${p.baseClaimNo}:${p.candidateClaimNo}`)));
    const received = answer.results.map(r => `${r.docId}:${r.baseClaimNo}:${r.candidateClaimNo}`);
    if (received.length !== expected.size || new Set(received).size !== received.length || received.some(key => !expected.has(key))) throw Error();
    return { results: answer.results.map(result => {
      const chunk = chunks.find(c => c.candidateId === result.docId && c.pairs.some(p =>
        p.baseClaimNo === result.baseClaimNo && p.candidateClaimNo === result.candidateClaimNo));
      if (!chunk || !isNominalReservationText(result.unconfirmed)) throw Error();
      const scope = (side: "base" | "candidate") => side === "base" ? `base:${result.baseClaimNo}` : `candidate:${result.docId}:${result.candidateClaimNo}`;
      const select = (side: "base" | "candidate", selected: string[]) => {
        if (new Set(selected).size !== selected.length) throw Error();
        return selected.map(id => {
          const fact = sources.facts.find(f => f.id === id && f.scope === scope(side));
          // Never turn an absent source actor into the renderer's generic device.
          if (!fact || !printableSubject(fact)) throw Error();
          return fact;
        });
      };
      const sentence = (side: "base" | "candidate", facts: SourceProposition[]) => facts.map(f =>
        `${side === "base" ? "基準側" : "候補側"}は、${renderMeaning(f.meaning)}。`).join("");
      const bounded = (text: string, maximum: number) => { if (!text || text.length > maximum) throw Error(); return text; };
      const base = select("base", result.baseFacts), candidate = select("candidate", result.candidateFacts);
      // Representative source text belongs to the actual selected claim when
      // that claim has a complete selectable reading. Parents remain separate.
      const choices = factObservationChoices(chunks, sources, quotes);
      for (const [side, facts, no] of [["base", base, result.baseClaimNo], ["candidate", candidate, result.candidateClaimNo]] as const) {
        const own = choices.find(c => c.scope === scope(side))?.factIds ?? [];
        if (own.some(id => sources.facts.some(f => f.id === id && f.scope === scope(side) && f.claimNo === no)) && facts[0].claimNo !== no) throw Error();
      }
      const common = result.common.map(pair => {
        const b = select("base", pair.baseFacts), c = select("candidate", pair.candidateFacts);
        const keys = (facts: SourceProposition[]) => [...new Set(facts.map(f => meaningKey(f.meaning)))].sort();
        const sameMembers = b.length === 1 && c.length === 1 && b[0].meaning.kind === "set" && c[0].meaning.kind === "set" &&
          b[0].meaning.context === c[0].meaning.context && propositionKey(b[0].meaning.subject ?? "") === propositionKey(c[0].meaning.subject ?? "") &&
          JSON.stringify(b[0].meaning.members.map(propositionKey).sort()) === JSON.stringify(c[0].meaning.members.map(propositionKey).sort());
        if (JSON.stringify(keys(b)) !== JSON.stringify(keys(c)) && !sameMembers) throw Error();
        return sentence("base", b) + sentence("candidate", c);
      }).join("");
      let differences: string;
      if ("reservation" in result.differences) {
        if (!isNominalReservationText(result.differences.reservation)) throw Error();
        differences = result.differences.reservation;
      } else {
        const b = select("base", result.differences.baseFacts), c = select("candidate", result.differences.candidateFacts);
        const keys = (facts: SourceProposition[]) => [...new Set(facts.map(f => meaningKey(f.meaning)))].sort();
        if (JSON.stringify(keys(b)) === JSON.stringify(keys(c))) throw Error();
        differences = sentence("base", b) + sentence("candidate", c);
      }
      const selected = [...result.baseFacts, ...result.candidateFacts, ...result.common.flatMap(p => [...p.baseFacts, ...p.candidateFacts]),
        ...("reservation" in result.differences ? [] : [...result.differences.baseFacts, ...result.differences.candidateFacts])];
      for (const required of factControlCoverage(sources).filter(r => r.scope === scope("base") || r.scope === scope("candidate"))) {
        if (!required.factIds.some(id => selected.includes(id))) throw Error();
      }
      const evidence = (side: "base" | "candidate", facts: SourceProposition[]) => {
        const prefix = side === "base" ? `b${chunk.baseDigest}:0` : `c${chunk.candidateDigest}:${chunk.candidateId}`;
        // A representative quote must contain the complete first selected fact's
        // original locator (subject, guards, action), never an arbitrary segment.
        const fact = facts[0], locator = sources.locators.find(l => l.id === fact.id);
        if (!locator) throw Error();
        const spans = [...locator.quotes, ...(locator.action ? [locator.action] : [])];
        const ranges = generationQuoteRanges(chunk[side], prefix, quotes).filter(r => r.claimNo === fact.claimNo &&
          spans.length > 0 && spans.every(([start, end]) => start >= r.start && end <= r.end));
        ranges.sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start);
        if (!ranges.length) throw Error();
        return ranges[0].id;
      };
      return { docId: result.docId, baseClaimNo: result.baseClaimNo, candidateClaimNo: result.candidateClaimNo,
        baseObservation: bounded(sentence("base", base), 120), candidateObservation: bounded(sentence("candidate", candidate), 120),
        common: bounded(common, 200), differences: bounded(differences, 200), unconfirmed: result.unconfirmed,
        baseEvidenceId: evidence("base", base), candidateEvidenceId: evidence("candidate", candidate) };
    }) };
  } catch { throw new ComparisonError("ai_incomplete"); }
}

