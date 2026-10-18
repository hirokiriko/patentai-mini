import { z } from "zod";
import { managedClaimContext, type ManagedComparisonChunk } from "../patent-watch/managed-claims";
import type { PairResult } from "./comparison";
import { requestBytes, unionSource } from "./generation-batch";
import { LIMITS } from "./limits";
import { ComparisonError, digest } from "./source";
import { referenceLogicInput } from "./reference-logic";
import { sourceSegments } from "./generation";
import { reviewReferenceMentions, validateReferenceRelations, REFERENCE_ALL_WORDS, REFERENCE_ANY_WORDS } from "./reference-mentions";
import { REVIEW_TRANSPORT_SYSTEM, reviewTransportInput, reviewTransportSchemaFor } from "./review-transport";
import { sourceAnalysisInput, type SourceAnalysis } from "./source-analysis";
import { generationBatches } from "./generation-batch";
import { SYSTEM } from "./comparison";

export type ReviewDraft = PairResult & { baseObservation: string; candidateObservation: string };
export const REVIEW_FIELDS = ["baseObservation", "candidateObservation", "common", "differences", "unconfirmed"] as const;
const targetId = (p: PairResult, field: typeof REVIEW_FIELDS[number]) => `${p.docId}:${p.baseClaimNo}:${p.candidateClaimNo}:${field}`;
/** Keep every character, including punctuation and trailing whitespace. A unit
 * remains in the context of the entire field; it is not a replacement summary. */
export function reviewTargetUnits(text: string) {
  const starts = [0];
  for (let at = 0; at < text.length - 1; at++) {
    if (text[at] === "。" && text[at + 1] !== "。" && text.slice(at + 1).trim()) starts.push(at + 1);
  }
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? text.length, text: text.slice(start, starts[i + 1]) }));
}
/** Position hints, not independent propositions. A contrast may group adjacent
 * intervals to keep a condition and its conclusion together. Nothing is cut
 * from the full field or its sentence context. Sentence edges are already in
 * unitStarts and are not serialized twice. */
export function reviewContrastCuts(text: string): number[] {
  const units = reviewTargetUnits(text), mentions = reviewReferenceMentions(text), cuts = new Set<number>();
  const splitsSurrogate = (at: number) => /[\uD800-\uDBFF]/.test(text[at - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[at] ?? "");
  for (const unit of units) {
    const bounds = new Set([unit.start, unit.end]);
    for (let at = unit.start; at < unit.end - 1; at++) if (text[at] === "、") bounds.add(at + 1);
    for (const mention of mentions.filter(m => m.start >= unit.start && m.end <= unit.end)) { bounds.add(mention.start); bounds.add(mention.end); }
    const ordered = [...bounds].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      let start = ordered[i - 1];
      while (ordered[i] - start > 60) { let next = start + 60; if (splitsSurrogate(next)) next--; bounds.add(next); start = next; }
    }
    for (const at of bounds) if (at > unit.start && at < unit.end) cuts.add(at);
  }
  return [...cuts].sort((a, b) => a - b);
}
export function reviewTargetIdentity(id: string) {
  const [docId, baseClaimNo, candidateClaimNo, field] = id.split(":");
  return { docId: Number(docId), baseClaimNo: Number(baseClaimNo), candidateClaimNo: Number(candidateClaimNo), field };
}
export function reviewInput(plan: readonly ManagedComparisonChunk[], drafts: readonly ReviewDraft[], sourceAnalysis: SourceAnalysis = []) {
  const documents = [...new Set(plan.map(c => c.candidateId))].map(docId => ({ docId, source: unionSource(plan.filter(c => c.candidateId === docId).map(c => c.candidate)) }));
  const base = unionSource(plan.map(c => c.base));
  const pairs = drafts.map(draft => {
    const source = documents.find(d => d.docId === draft.docId)!.source;
    return { docId: draft.docId, baseClaimNo: draft.baseClaimNo, candidateClaimNo: draft.candidateClaimNo,
      baseContextClaimNos: managedClaimContext(base, [draft.baseClaimNo]).claims.map(c => c.claimNo),
      candidateContextClaimNos: managedClaimContext(source, [draft.candidateClaimNo]).claims.map(c => c.claimNo),
      // The complete source below contains the quote already. Keep its exact
      // coordinates rather than serializing a second copy of the same text.
      baseEvidence: { claimNo: draft.baseEvidence.claimNo, start: draft.baseEvidence.start, end: draft.baseEvidence.end },
      candidateEvidence: { claimNo: draft.candidateEvidence.claimNo, start: draft.candidateEvidence.start, end: draft.candidateEvidence.end } };
  });
  const scopes = [...new Map(pairs.flatMap(p => [
    { id: `base:${p.baseClaimNo}`, side: "base" as const, docId: null, selectedClaimNo: p.baseClaimNo, contextClaimNos: p.baseContextClaimNos },
    { id: `candidate:${p.docId}:${p.candidateClaimNo}`, side: "candidate" as const, docId: p.docId, selectedClaimNo: p.candidateClaimNo, contextClaimNos: p.candidateContextClaimNos },
  ]).map(scope => [scope.id, scope])).values()];
  const logic = (source: typeof base, selected: number[]) => referenceLogicInput(source, [...new Set(selected)]);
  // Review-only ordinals keep long original catalogs compact. The source,
  // claim and cumulative UTF-16 offsets still determine each original segment;
  // generation IDs and saved quote coordinates are unchanged.
  let evidenceOrdinal = 0;
  const catalog = (source: typeof base, prefix: string) => {
    const partitioned = sourceSegments(source, prefix);
    return { ...partitioned, claims: partitioned.claims.map(({ segments, ...claim }) => ({ ...claim,
      segments: segments.map(segment => [evidenceOrdinal++, segment.text] as const) })) };
  };
  // Raw logical-review inspection also accepts ungenerated diagnostic plans.
  // Only supplied analyses require binding to actual generation batches.
  const identities = sourceAnalysis.length ? generationBatches(plan, SYSTEM).flatMap(batch => sourceAnalysisInput(batch).sources) : [];
  const analyses = sourceAnalysis.map(note => {
    const original = identities.find(s => s.sourceDigest === note.sourceDigest);
    if (!original) throw new ComparisonError("ai_incomplete");
    return { ...note, side: original.side, docId: original.docId, selected: original.selected,
      contextClaimNos: original.source.claims.map(c => c.claimNo) };
  });
  const content = { sourceAnalysis: analyses, base: { ...catalog(base, "b"), referenceLogic: logic(base, pairs.map(p => p.baseClaimNo)) },
    documents: documents.map(d => ({ ...d, source: { ...catalog(d.source, `c${d.docId}`),
      referenceLogic: logic(d.source, pairs.filter(p => p.docId === d.docId).map(p => p.candidateClaimNo)) } })), scopes, pairs,
    // IDs already bind the pair and field. Do not repeat that metadata for
    // every sentence; preserve the full text and its lossless unit boundaries.
    targets: drafts.flatMap(d => REVIEW_FIELDS.map(field => {
      const mentions = reviewReferenceMentions(d[field]), contrastCuts = reviewContrastCuts(d[field]);
      return { id: targetId(d, field), text: d[field], unitStarts: reviewTargetUnits(d[field]).map(unit => unit.start),
        ...(contrastCuts.length ? { contrastCuts } : {}),
        ...(mentions.length ? { mentions: mentions.map(m => [m.start, m.end] as const) } : {}) };
    })) };
  return { task: "review" as const, draftDigest: digest(content), ...content };
}
/** Local derivation only: ordinals never change the original source position. */
export function reviewEvidenceCatalog(input: ReturnType<typeof reviewInput>) {
  const catalog = new Map<number, { side: "base" | "candidate"; docId: number | null; claimNo: number; start: number; end: number; key: string; text: string }>();
  for (const { side, docId, source } of [{ side: "base" as const, docId: null, source: input.base },
    ...input.documents.map(d => ({ side: "candidate" as const, docId: d.docId, source: d.source }))]) {
    for (const claim of source.claims) {
      let start = 0;
      for (const [id, text] of claim.segments) {
        if (!Number.isSafeInteger(id) || id !== catalog.size) throw new ComparisonError("ai_incomplete");
        const end = start + text.length;
        catalog.set(id, { side, docId, claimNo: claim.claimNo, start, end, key: `${side === "base" ? "b" : `c${docId}`}:${claim.claimNo}:${start}`, text }); start = end;
      }
    }
  }
  return catalog;
}
export const REVIEW_SYSTEM = REVIEW_TRANSPORT_SYSTEM;
const reading = z.string().min(1).regex(/^[^\x00-\x1f\x7f-\x9f]*$/);
type RejectedTargetAnchor = { unitStart: number; quote: string };
const verdict = z.enum(["consistent", "inconsistent", "uncertain"]);
const referenceCheckSchema = z.object({ start: z.number().int().nonnegative(), relation: z.enum(["unspecified", "all", "any", "unresolved"]),
  operatorBasis: z.object({ start: z.number().int().nonnegative(), quote: z.enum([...REFERENCE_ALL_WORDS, ...REFERENCE_ANY_WORDS]) }).strict().nullable() }).strict();
const contrastSchema = z.object({ end: z.number().int().nonnegative(),
  kind: z.enum(["technical", "reference_scope", "reference_combination"]), referenceStart: z.number().int().nonnegative().nullable(),
  evidenceIds: z.array(z.number().int().nonnegative()), sourceComparison: reading, verdict,
  rejectedTargetSpan: z.array(z.number().int().nonnegative()).length(2).nullable() }).strict();
const unitCheckSchema = z.object({ start: z.number().int().nonnegative(),
  referenceChecks: z.array(referenceCheckSchema).max(200), contrasts: z.array(contrastSchema).min(1).max(200) }).strict();
const checkSchema = z.object({ id: z.string().min(1).max(100), unitChecks: z.array(unitCheckSchema).min(1).max(200) }).strict();
export const reviewSchema = z.object({ draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(checkSchema).min(1).max(LIMITS.reviewPairs * REVIEW_FIELDS.length) }).strict();
export function reviewSchemaFor(input: ReturnType<typeof reviewInput>) {
  const evidenceCount = [input.base, ...input.documents.map(d => d.source)].reduce((sum, source) =>
    sum + source.claims.reduce((count, claim) => count + claim.segments.length, 0), 0);
  return reviewSchema.extend({ draftDigest: z.literal(input.draftDigest),
    checks: z.array(checkSchema.extend({ id: z.enum(input.targets.map(t => t.id)),
      unitChecks: z.array(unitCheckSchema.extend({ contrasts: z.array(contrastSchema.extend({ evidenceIds: contrastSchema.shape.evidenceIds.max(evidenceCount) })).min(1).max(200) })).min(1).max(200)
    })).length(input.targets.length) });
}
export function assertReviewSize(input: ReturnType<typeof reviewInput>): void {
  if (requestBytes(REVIEW_SYSTEM, JSON.stringify(reviewTransportInput(input)), reviewTransportSchemaFor(input)) > LIMITS.inputBytes) throw new ComparisonError("plan_limit");
}
export function assertReviewPlan(plan: readonly ManagedComparisonChunk[]): void {
  // An accepted lone surrogate takes seven bytes per UTF-16 unit after nested
  // JSON escaping, more than backslash/quote or ordinary Unicode. No clipping.
  const text = (n: number) => "\ud800".repeat(n);
  const evidence = { claimNo: Number.MAX_SAFE_INTEGER, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER, quote: text(120) };
  const drafts = plan.flatMap(c => c.pairs.map(p => ({ ...p, docId: c.candidateId, baseObservation: text(120), candidateObservation: text(120),
    common: text(200), differences: text(200), unconfirmed: text(120), baseEvidence: evidence, candidateEvidence: evidence })));
  if (!drafts.length || drafts.length > LIMITS.reviewPairs) throw new ComparisonError("plan_limit");
  const analyses = generationBatches(plan, SYSTEM).flatMap(batch => sourceAnalysisInput(batch).sources.map(s => ({ sourceDigest: s.sourceDigest, reading: text(90) })));
  const input = reviewInput(plan, drafts, analyses);
  // Wire sentences preserve every character and expose exact reference slots.
  // Reserve field framing plus sentence/reference metadata against the maximal
  // nested-JSON surrogate envelope; dense punctuation, references and Unicode
  // are also measured with the full wire/schema and actual SDK serialization.
  // In the marker form, each extra unit boundary costs three nested-JSON bytes,
  // below the four bytes saved by its original Japanese full stop against the
  // seven-byte lone-surrogate maximum. Reference TAB markers similarly cost
  // six bytes, below the saving from even the shortest reference phrase.
  // Reserve the increasing unit-index/reference-count digits separately.
  const metadataAllowance = input.targets.length * 16;
  if (requestBytes(REVIEW_SYSTEM, JSON.stringify(reviewTransportInput(input)), reviewTransportSchemaFor(input)) + metadataAllowance > LIMITS.inputBytes) throw new ComparisonError("plan_limit");
}
/** Resolve the new wire anchor without repairing or reinterpreting old replies.
 * Matching is exact, unique inside the specified unit, and Unicode-preserving. */
export function resolveReviewAnchor(text: string, anchor: RejectedTargetAnchor) {
  const unit = reviewTargetUnits(text).find(unit => unit.start === anchor.unitStart);
  if (!unit || !anchor.quote.trim()) throw new ComparisonError("ai_incomplete");
  const at = unit.text.indexOf(anchor.quote);
  if (at < 0 || unit.text.indexOf(anchor.quote, at + 1) !== -1) throw new ComparisonError("ai_incomplete");
  const start = unit.start + at, end = start + anchor.quote.length;
  const splitsSurrogate = (position: number) => position > 0 && position < text.length &&
    /[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position]);
  if (splitsSurrogate(start) || splitsSurrogate(end)) throw new ComparisonError("ai_incomplete");
  return { start, end, quote: anchor.quote };
}
export function resolveReviewSpan(text: string, unitStart: number, span: readonly number[], group: { start: number; end: number }) {
  const unit = reviewTargetUnits(text).find(u => u.start === unitStart);
  const cuts = new Set([...(unit ? [unit.start, unit.end] : []), ...reviewContrastCuts(text)]);
  const [start, end] = span;
  // Review rejection identifies the whole bounded draft unit. This is separate
  // from source-evidence quotes, whose120-character contract is unchanged.
  if (span.length !== 2 || !unit || start < group.start || end > group.end || end <= start || end - start > 200 || !cuts.has(start) || !cuts.has(end)) throw new ComparisonError("ai_incomplete");
  const resolved = resolveReviewAnchor(text, { unitStart, quote: text.slice(start, end) });
  if (resolved.start !== start || resolved.end !== end) throw new ComparisonError("ai_incomplete");
  return resolved;
}
/** Protocol coverage and literal anchors only. This never authorizes saving or
 * establishes the truth of a verdict, and permits negative probe assessments. */
export function inspectReviewCoverage(input: ReturnType<typeof reviewInput>, value: unknown) {
  try {
    const parsed = reviewSchemaFor(input).parse(value);
    const catalog = reviewEvidenceCatalog(input);
    const remaining = new Map(input.targets.map(t => [t.id, t]));
    const checks = parsed.checks.map(check => {
      const target = remaining.get(check.id);
      if (!target) throw Error();
      const identity = reviewTargetIdentity(target.id);
      const pair = input.pairs.find(p => p.docId === identity.docId && p.baseClaimNo === identity.baseClaimNo && p.candidateClaimNo === identity.candidateClaimNo);
      if (!pair) throw Error();
      const evidence = new Map<number, { side: "base" | "candidate"; claimNo: number }>();
      for (const side of ["base", "candidate"] as const) {
        if (identity.field === (side === "base" ? "candidateObservation" : "baseObservation")) continue;
        const source = side === "base" ? input.base : input.documents.find(d => d.docId === pair.docId)!.source;
        for (const claim of source.claims.filter(c => pair[`${side}ContextClaimNos`].includes(c.claimNo))) {
          for (const [id, text] of claim.segments) if (text.trim()) evidence.set(id, { side, claimNo: claim.claimNo });
        }
      }
      const units = reviewTargetUnits(target.text), missingUnits = new Map(units.map(unit => [unit.start, unit]));
      if (JSON.stringify(target.unitStarts) !== JSON.stringify(units.map(unit => unit.start))) throw Error();
      if (JSON.stringify(target.mentions ?? []) !== JSON.stringify(reviewReferenceMentions(target.text).map(m => [m.start, m.end]))) throw Error();
      if (JSON.stringify(target.contrastCuts ?? []) !== JSON.stringify(reviewContrastCuts(target.text))) throw Error();
      const baseClaimNos = new Set<number>(), candidateClaimNos = new Set<number>();
      const combine = (values: readonly { verdict: z.infer<typeof verdict> }[]) => values.some(v => v.verdict === "inconsistent") ? "inconsistent" as const
        : values.some(v => v.verdict === "uncertain") ? "uncertain" as const : "consistent" as const;
      const unitChecks = check.unitChecks.map(unit => {
        const original = missingUnits.get(unit.start); if (!original) throw Error(); missingUnits.delete(unit.start);
        const cuts = new Set([original.start, original.end, ...(target.contrastCuts ?? [])]);
        validateReferenceRelations(target.text, original, unit.referenceChecks, unit.contrasts.some(c => c.verdict === "uncertain"));
        let cursor = original.start;
        const contrasts = unit.contrasts.map(contrast => {
          const start = cursor, end = contrast.end;
          if (!cuts.has(end) || end <= start || end > original.end || !contrast.sourceComparison.trim() || new Set(contrast.evidenceIds).size !== contrast.evidenceIds.length) throw Error();
          cursor = end;
          if (contrast.kind === "technical") { if (contrast.referenceStart !== null) throw Error(); }
          else {
            const mention = reviewReferenceMentions(target.text).find(m => m.start === contrast.referenceStart && m.start >= start && m.end <= end);
            const relation = unit.referenceChecks.find(r => r.start === mention?.start);
            if (!mention || !relation) throw Error();
            if (contrast.kind === "reference_combination" && (relation.relation === "unspecified" || (relation.relation === "unresolved" && contrast.verdict !== "uncertain"))) throw Error();
          }
          for (const id of contrast.evidenceIds) {
            const source = evidence.get(id); if (!source) throw Error();
            (source.side === "base" ? baseClaimNos : candidateClaimNos).add(source.claimNo);
          }
          if (contrast.verdict !== "uncertain" && !contrast.evidenceIds.length) throw Error();
          let rejectedTargetAnchor: string | null = null;
          if (contrast.verdict === "inconsistent") {
            if (contrast.rejectedTargetSpan === null) throw Error();
            rejectedTargetAnchor = resolveReviewSpan(target.text, unit.start, contrast.rejectedTargetSpan, { start, end }).quote;
          } else if (contrast.rejectedTargetSpan !== null) throw Error();
          return { ...contrast, start, evidenceKeys: contrast.evidenceIds.map(id => catalog.get(id)!.key), rejectedTargetAnchor };
        });
        if (cursor !== original.end) throw Error();
        return { ...unit, contrasts, evidenceIds: [...new Set(contrasts.flatMap(c => c.evidenceIds))],
          sourceComparison: contrasts.map(c => c.sourceComparison).join(" "), verdict: combine(contrasts),
          rejectedTargetAnchor: contrasts.find(c => c.verdict === "inconsistent")?.rejectedTargetAnchor ?? null };
      }).sort((a, b) => a.start - b.start);
      if (missingUnits.size) throw Error();
      const combined = combine(unitChecks);
      // A contrast may describe each side in separate sentences. Require both
      // sides across the field, without demanding irrelevant proof per unit.
      if (!unitChecks.some(unit => unit.contrasts.some(c => c.verdict === "uncertain"))) {
        if (identity.field !== "candidateObservation" && !baseClaimNos.size) throw Error();
        if (identity.field !== "baseObservation" && !candidateClaimNos.size) throw Error();
      }
      const firstNegative = unitChecks.find(unit => unit.verdict === "inconsistent");
      remaining.delete(check.id);
      return { ...check, unitChecks, verdict: combined,
        baseClaimNos: [...baseClaimNos].sort((a, b) => a - b), candidateClaimNos: [...candidateClaimNos].sort((a, b) => a - b),
        rejectedTargetAnchor: firstNegative ? { unitStart: firstNegative.start, quote: firstNegative.rejectedTargetAnchor! } : null };
    });
    if (remaining.size) throw Error();
    return { draftDigest: parsed.draftDigest, checks };
  } catch { throw new ComparisonError("ai_incomplete"); }
}
/** Complete source review remains mandatory. Valid negative/uncertain verdicts
 * are still rejected; a literal span is not a semantic quality certificate. */
export function validateReview(input: ReturnType<typeof reviewInput>, value: unknown): void {
  if (inspectReviewCoverage(input, value).checks.some(check => check.verdict !== "consistent")) throw new ComparisonError("ai_incomplete");
}
