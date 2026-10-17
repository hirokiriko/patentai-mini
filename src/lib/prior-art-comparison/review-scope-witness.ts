import { z } from "zod";
import type { reviewInput } from "./semantic-review";
import { reviewReferenceMentions } from "./reference-mentions";
import { ComparisonError } from "./source";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** All ordinals are one-based within the unchanged target unit. There is no
 * caller-selected sourceClaimNo: scopeId fixes the selected source claim. */
export const reviewScopeWitnessSchema = z.object({
  scopeId: z.string().min(1).max(100),
  invalidMember: positive,
  mode: z.enum(["ancestor", "direct"]),
  subjectReference: positive.nullable(),
  directnessBasis: z.object({ word: z.literal("直接"), occurrence: positive }).strict().nullable(),
}).strict();

type Interval = { from: number; to: number };
const numberPattern = "[0-9０-９一二三四五六七八九十百千]+";
const digits: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const powers: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

function literalNumber(text: string): number {
  const normalized = text.normalize("NFKC");
  if (/^[0-9]+$/.test(normalized)) {
    const value = Number(normalized);
    if (!Number.isSafeInteger(value) || value <= 0) throw Error();
    return value;
  }
  let value = 0, pending = 0, previousPower = 10000, hasPower = false;
  for (const character of normalized) {
    if (digits[character]) {
      // Positional Kanji strings such as 一二 are deliberately not guessed.
      if (pending) throw Error();
      pending = digits[character];
    } else if (powers[character]) {
      const power = powers[character];
      if (power >= previousPower) throw Error();
      value += (pending || 1) * power;
      pending = 0; previousPower = power; hasPower = true;
    } else throw Error();
  }
  if (!hasPower && normalized.length !== 1) throw Error();
  value += pending;
  if (!Number.isSafeInteger(value) || value <= 0) throw Error();
  return value;
}

function literalMembers(text: string): { intervals: Interval[]; singleton: number | null } {
  const first = new RegExp(`^請求項[\\t ]*(${numberPattern})`, "u").exec(text);
  if (!first) throw Error();
  let remaining = text.slice(first[0].length), last = literalNumber(first[1]), atoms = 1, range = false;
  const intervals: Interval[] = [{ from: last, to: last }];
  const next = new RegExp(`^[\\t ]*(乃至|から|[-－〜～~／/・、])[\\t ]*(?:請求項[\\t ]*)?(${numberPattern})`, "u");
  while (remaining && remaining !== "まで") {
    const match = next.exec(remaining);
    if (!match) throw Error();
    const value = literalNumber(match[2]), isRange = /^(?:乃至|から|[-－〜～~])$/u.test(match[1]);
    if (isRange) {
      if (range || value < last) throw Error();
      intervals[intervals.length - 1] = { from: last, to: value };
    } else intervals.push({ from: value, to: value });
    last = value; range = isRange; atoms++; remaining = remaining.slice(match[0].length);
  }
  // A bare "6まで" supplies the literal endpoint6, not an invented lower1.
  return { intervals, singleton: atoms === 1 && remaining !== "まで" ? last : null };
}

function objectJoin(text: string): boolean {
  return /^[\t ]*(?:と|及び|および|又は|または|若しくは|もしくは|[、，,・／/])[\t ]*$/u.test(text);
}

/** Bind the witness to one narrow affirmative reference-relation phrase. A
 * citation of a phrase, a negative/hedged predicate, or technical use of
 * "directly" is not mechanically checkable evidence of an asserted edge. */
function relationPhrase(text: string, mentions: ReturnType<typeof reviewReferenceMentions>, target: number,
  subjectReference: number | null, selected: number, parsed: ReturnType<typeof literalMembers>[],
  field: string, side: "base" | "candidate") {
  if (/[「」『』“”‘’"']/u.test(text)) throw Error();
  let first = target, last = target;
  while (first > 0 && objectJoin(text.slice(mentions[first - 1].end, mentions[first].start))) first--;
  while (last + 1 < mentions.length && objectJoin(text.slice(mentions[last].end, mentions[last + 1].start))) last++;
  const marker = [...text.matchAll(/基準側|候補側|基準(?=の|は|が|では|請求項)|候補(?=の|は|が|では|請求項)/gu)]
    .filter(m => m.index < mentions[first].start).at(-1);
  const literalSide = marker ? (marker[0].startsWith("基準") ? "base" : "candidate") : null;
  if (literalSide !== null && literalSide !== side || literalSide === null && field !== "baseObservation" && field !== "candidateObservation") throw Error();
  const markerEnd = marker ? marker.index + marker[0].length : 0;
  let prefixStart = markerEnd, requireTopic = marker !== undefined;
  if (subjectReference === null) {
    if (first !== 0) throw Error();
  } else {
    const subject = mentions[subjectReference - 1];
    if (!subject || subjectReference !== first || parsed[subjectReference - 1].singleton !== selected ||
        !/^[\t ]*(?:の)?[\t ]*$/u.test(text.slice(markerEnd, subject.start))) throw Error();
    prefixStart = subject.end; requireTopic = true;
  }
  const prefix = text.slice(prefixStart, mentions[first].start);
  const topic = requireTopic ? /^[\t ]*(?:では|は|が)[\t ]*(?:[、，,][\t ]*)?(直接[\t ]*)?$/u
    : /^[\t ]*(直接[\t ]*)?$/u;
  const prefixMatch = topic.exec(prefix);
  if (!prefixMatch) throw Error();
  const tail = text.slice(mentions[last].end);
  const noun = /^(?:の[\p{Script=Han}\p{Script=Katakana}ー々A-Za-z0-9０-９・／/]+)?[\t ]*/u.exec(tail)![0];
  const predicate = /^(を|に)[\t ]*(直接(?:に)?[\t ]*)?(継承|引用|従属)(?:する|し)(?=[\t ]*(?:[、，,。．]|$))/u.exec(tail.slice(noun.length));
  if (!predicate || (predicate[3] === "従属" ? predicate[1] !== "に" : predicate[1] !== "を")) throw Error();
  const suffix = tail.slice(noun.length + predicate[0].length);
  if (/^[\t ]*[、，,][\t ]*(?:と(?:いう|の|は)|可能|場合|なら|仮定|記述|説明)/u.test(suffix)) throw Error();
  const directPositions = [
    ...(prefixMatch[1] ? [prefixStart + prefix.indexOf("直接")] : []),
    ...(predicate[2] ? [mentions[last].end + noun.length + predicate[0].indexOf("直接")] : []),
  ];
  return { verb: predicate[3], hasNoun: noun.trim().length > 0, directPositions };
}

/** Narrow necessary evidence of a scope finding, not sufficient proof of its
 * semantic truth. Only the supported affirmative phrase forms above qualify;
 * ambiguous subjects, quotation, negation, hedges and unsupported wording stop
 * the reply, and are never promoted to a consistent verdict. */
export function validateReviewScopeWitness(
  logical: ReturnType<typeof reviewInput>, targetId: string,
  unit: { start: number; end: number; text: string }, referenceOrdinal: number, value: unknown,
): void {
  try {
    const witness = reviewScopeWitnessSchema.parse(value);
    const target = logical.targets.find(t => t.id === targetId);
    const index = target?.unitStarts.indexOf(unit.start) ?? -1;
    if (!target || index < 0 || unit.end !== (target.unitStarts[index + 1] ?? target.text.length) ||
        unit.text !== target.text.slice(unit.start, unit.end)) throw Error();
    const [doc, base, candidate, field, extra] = targetId.split(":");
    const pair = logical.pairs.find(p => p.docId === Number(doc) && p.baseClaimNo === Number(base) && p.candidateClaimNo === Number(candidate));
    if (!pair || extra !== undefined || !["baseObservation", "candidateObservation", "common", "differences", "unconfirmed"].includes(field)) throw Error();
    const baseId = `base:${pair.baseClaimNo}`, candidateId = `candidate:${pair.docId}:${pair.candidateClaimNo}`;
    const side = witness.scopeId === baseId ? "base" : witness.scopeId === candidateId ? "candidate" : null;
    if (!side || field === "baseObservation" && side !== "base" || field === "candidateObservation" && side !== "candidate") throw Error();
    const selected = side === "base" ? pair.baseClaimNo : pair.candidateClaimNo;
    const scope = logical.scopes.find(s => s.id === witness.scopeId);
    if (!scope || scope.side !== side || scope.selectedClaimNo !== selected || scope.docId !== (side === "base" ? null : pair.docId)) throw Error();

    const mentions = reviewReferenceMentions(unit.text);
    if (!Number.isSafeInteger(referenceOrdinal) || referenceOrdinal < 1) throw Error();
    const mention = mentions[referenceOrdinal - 1];
    if (!mention) throw Error();
    const parsed = mentions.map(m => {
      // Do not silently accept a prefix of an unsupported/unsafe numeral.
      if (/^[0-9０-９一二三四五六七八九十百千万億兆〇零]/u.test(unit.text.slice(m.end)) ||
          /^[.．点][0-9０-９]/u.test(unit.text.slice(m.end))) throw Error();
      return literalMembers(unit.text.slice(m.start, m.end));
    });
    if (!parsed[referenceOrdinal - 1].intervals.some(r => witness.invalidMember >= r.from && witness.invalidMember <= r.to)) throw Error();

    const phrase = relationPhrase(unit.text, mentions, referenceOrdinal - 1, witness.subjectReference, selected, parsed, field, side);

    const source = side === "base" ? logical.base : logical.documents.find(d => d.docId === pair.docId)?.source;
    if (!source) throw Error();
    const byNo = new Map(source.claims.map(c => [c.claimNo, c]));
    const relations = new Map(source.referenceLogic.relations.map(r => [r.claimNo, r]));
    const closure = new Set<number>(), pending = [selected];
    while (pending.length) {
      const no = pending.pop()!;
      if (closure.has(no)) continue;
      const claim = byNo.get(no), relation = relations.get(no);
      if (!claim || relation?.relation === "unresolved" ||
          JSON.stringify([...claim.dependsOn].sort((a, b) => a - b)) !== JSON.stringify([...(relation?.directRefs ?? [])].sort((a, b) => a - b))) throw Error();
      closure.add(no); pending.push(...claim.dependsOn);
    }
    const guided = source.referenceLogic.scopes.find(s => s.claimNo === selected);
    const expected = new Set(guided ? [...guided.guaranteedClaimNos, ...guided.conditionalClaimNos] : []);
    if (closure.size !== expected.size || [...closure].some(n => !expected.has(n)) ||
        closure.size !== scope.contextClaimNos.length || scope.contextClaimNos.some(n => !closure.has(n))) throw Error();
    if (witness.mode === "ancestor") {
      if (witness.directnessBasis !== null || closure.has(witness.invalidMember)) throw Error();
    } else {
      if (!witness.directnessBasis || (relations.get(selected)?.directRefs ?? []).includes(witness.invalidMember)) throw Error();
      const occurrences = [...unit.text.matchAll(/直接/gu)];
      const basis = occurrences[witness.directnessBasis.occurrence - 1];
      if (!basis || phrase.verb !== "従属" || phrase.hasNoun || !phrase.directPositions.includes(basis.index) ||
          mentions.some(m => basis.index < m.end && basis.index + basis[0].length > m.start)) throw Error();
    }
  } catch { throw new ComparisonError("ai_incomplete"); }
}
