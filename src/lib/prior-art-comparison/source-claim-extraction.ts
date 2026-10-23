import { jsonSchema, type JSONSchema7, type Schema } from "ai";
import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { propositionSourceInput, decodeSourcePropositions, type SourceExtraction } from "./proposition-extraction";
import { propositionSourceIdentifiedTransport, sourceIdentifiedPropositionModelSchemaFor, validateIdentifiedSourceClaim } from "./source-semantic-wire";
import { PROPOSITION_SOURCE_IDENTIFIED_SYSTEM } from "./source-task-prompt";
import { sourceReadingClaim } from "./source-clause-coverage";
import { sourceIdentifiedQuoteDictionary, sourceIdentifiedFact, sourceQuoteDictionary, sourceDictionaryFact,
  sourceDeclaredOrderedEvidence, resolveSourceOrderedQuote, sourceReadingTasks, sourceMatchedTasks } from "./source-reading-tasks";
import { assertSourceSemanticReading, sourceFullActionCues, type CheckedSourceFact } from "./source-semantic-check";
import { assertSourceGridProviderSchema } from "./source-grid-wire";
import { SOURCE_CAPACITY } from "./source-capacity";
import { LIMITS } from "./limits";
import { ComparisonError } from "./source";
import type { Span } from "./propositions";

const invalid = () => new ComparisonError("ai_incomplete");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export type SourceClaimTask = Readonly<{ id: string; sourceIndex: number; sourceDigest: string; claimNo: number;
  system: string; prompt: string; schema: Schema<unknown> }>;
export type SourceClaimPlan = Readonly<{ tasks: readonly SourceClaimTask[] }>;
const plans = new WeakMap<SourceClaimPlan, { chunks: readonly ManagedComparisonChunk[];
  input: ReturnType<typeof propositionSourceInput>; schema: ReturnType<typeof sourceIdentifiedPropositionModelSchemaFor> }>();

const CLAIM_SYSTEM = PROPOSITION_SOURCE_IDENTIFIED_SYSTEM.replace("v22", "v23") + `
This request extracts ONLY target.claimNo of target.sourceDigest. Return {v:23,sourceDigest,claimNo,answer}.
answer contains d, this cN and ONLY this claim's supplied loopN keys. Preserve original loop IDs.
Every quote ID matches q[0-9]{1,4}: lowercase q followed by one to four decimal digits ONLY (q0/q17/q9999 allowed; q0a and q10000 forbidden). Declare the exact ID in Q and reuse only that declared ID in m/O/F. IDs are labels, never array positions.
sourceContext contains unchanged originals and reference logic for reading context. Other claims are context only;
their own meanings are extracted in separate requests. Do not copy ancestor facts into this claim or cite another claim.
Read the entire target claim including all component definitions, conditions and reference tails. All v22 meaning,
quotation, ordering and completeness requirements remain. No previous answer is supplied or reusable.`;

/** Fixed before any send. Original digests, claim coordinates, references and
 * loop IDs are never recomputed from a partial source or comparison selection. */
export function sourceClaimExtractionPlan(chunks: readonly ManagedComparisonChunk[]): SourceClaimPlan {
  const boundChunks = structuredClone(chunks), input = propositionSourceInput(boundChunks);
  const transport = propositionSourceIdentifiedTransport(input);
  const fullSchema = sourceIdentifiedPropositionModelSchemaFor(boundChunks);
  const fullJson = fullSchema.jsonSchema as JSONSchema7;
  const definitions = fullJson.definitions!;
  const tasks: SourceClaimTask[] = [];
  for (const [sourceIndex, source] of input.sources.entries()) for (const claim of source.source.claims) {
    const claimNo = claim.claimNo, sourceDigest = source.sourceDigest;
    const loops = source.recognizedLoopRoutes.flatMap((r, id) => r.claimNo === claimNo ? [id] : []);
    const keys = ["d", `c${claimNo}`, ...loops.map(id => `loop${id}`)];
    // Reuse the provider's complete fact/quote definitions without an extra
    // nested wrapper level. The sole claim key is required, never an array slot.
    const items = fullJson.properties!.s as JSONSchema7;
    const alternatives = (items.items as JSONSchema7).anyOf ?? [items.items as JSONSchema7];
    const resolve = (v: JSONSchema7): JSONSchema7 => v.$ref ? resolve(definitions[v.$ref.split("/").at(-1)!] as JSONSchema7) : v;
    const own = alternatives.map(v => resolve(v as JSONSchema7)).find(v => {
      const d = v.properties?.d as JSONSchema7 | undefined;
      return d?.const === sourceDigest || d?.enum?.includes(sourceDigest);
    });
    if (!own?.properties || keys.some(k => !own.properties![k])) throw new ComparisonError("plan_limit");
    const schema: JSONSchema7 = { type: "object", properties: {
      v: { type: "integer", enum: [23] }, sourceDigest: { type: "string", enum: [sourceDigest] },
      claimNo: { type: "integer", enum: [claimNo] },
      answer: { type: "object", properties: Object.fromEntries(keys.map(k => [k, own.properties![k]])), required: keys, additionalProperties: false },
    }, required: ["v", "sourceDigest", "claimNo", "answer"], additionalProperties: false, definitions: structuredClone(definitions) };
    // Azure does not support string pattern constraints. State the existing
    // decoder grammar exactly in this v23 copy; do not alter historical v22.
    const idDescription="Quote ID grammar is exactly q[0-9]{1,4}: lowercase q plus 1..4 decimal digits ONLY. q0/q17/q9999 allowed; q0a/q10000 forbidden. Use only an exactly declared claim-local ID, never an array position.";
    const ownDefinitions=schema.definitions!;
    const ref=ownDefinitions.PriorArtSourceCellQuote as JSONSchema7;
    ref.description=idDescription;
    const context=ownDefinitions.PriorArtSourceQuoteContext as JSONSchema7;
    (context.properties!.id as JSONSchema7).description=idDescription;
    const declaration=ownDefinitions.PriorArtSourceDictionaryQuote as JSONSchema7;
    for(const branch of declaration.anyOf??[]){
      if(typeof branch!=="object")continue;
      if(branch.type==="string")branch.description=`Declare qID|first-last:exact text. ${idDescription}`;
      if(branch.type==="object"&&branch.properties?.id)(branch.properties.id as JSONSchema7).description=idDescription;
    }
    const dictionaryClaim=ownDefinitions.PriorArtSourceDictionaryClaim as JSONSchema7;
    (dictionaryClaim.properties!.Q as JSONSchema7).description=`Every declaration uses this exact grammar. ${idDescription}`;
    assertSourceGridProviderSchema(schema);
    const c = sourceReadingClaim(claimNo, claim.segments.map(p => p.text).join(""));
    const taskSchema = jsonSchema(schema, { validate: async raw => {
      try {
        if (!exact(raw, ["v", "sourceDigest", "claimNo", "answer"]) || raw.v !== 23 || raw.sourceDigest !== sourceDigest ||
          raw.claimNo !== claimNo || !exact(raw.answer, keys) || raw.answer.d !== sourceDigest ||
          Buffer.byteLength(JSON.stringify(raw), "utf8") > SOURCE_CAPACITY.wireBytes) throw invalid();
        const answer = raw.answer;
        const ownClaim = answer[`c${claimNo}`];
        if (!exact(ownClaim, ["Q", "facts"]) || !Array.isArray(ownClaim.facts)) throw invalid();
        const identified = sourceIdentifiedQuoteDictionary(c, ownClaim.Q), dictionary = sourceQuoteDictionary(c, identified.quotes);
        const checked: CheckedSourceFact[] = [], tasks = sourceReadingTasks(c, true, true), completed = new Set<number>();
        const covered = new Set<number>();
        let previous = -1;
        const rows = [...ownClaim.facts, ...loops.map(id => answer[`loop${id}`])];
        if (rows.length > SOURCE_CAPACITY.facts) throw invalid();
        for (const [at, row] of rows.entries()) {
          const decoded = sourceDictionaryFact(c, sourceIdentifiedFact(row, identified), dictionary);
          if (at < ownClaim.facts.length) { if (decoded.R < previous) throw invalid(); previous = decoded.R; }
          const f = decoded.fact, m = f.m, O = f.O;
          const frame = Number.isSafeInteger(f.F) ? source.recognizedLoopRoutes[Number(f.F)] : undefined;
          if (frame && frame.claimNo !== claimNo) throw invalid();
          const fixed: Span[] = frame ? [frame.mode, frame.entry, frame.exit, frame.route, frame.definition, frame.control] : [];
          const ids = sourceDeclaredOrderedEvidence(c, f, fixed); ids.forEach(id => covered.add(id));
          const q = (v: unknown) => resolveSourceOrderedQuote(c, v, ids);
          const terms = (v: unknown): Span[][] => {
            if (!Array.isArray(v) || v.some(t => !Array.isArray(t))) throw invalid();
            return v.map(t => t.map(q));
          };
          const action = m.k === "relation" ? q(m.a) : null;
          const guard = terms(m.G), objects = m.k === "relation" ? terms(m.J) : [];
          const route = m.k === "path" ? [...(m.i === null ? [] : terms([m.i]).flat()), ...terms(m.V).flat(), ...(m.j === null ? [] : terms([m.j]).flat())] : [];
          sourceMatchedTasks(tasks, m, ids, action, route).forEach(id => completed.add(id));
          checked.push({ kind: String(m.k), predicate: m.P as string | undefined, action, polarity: String(m.p),
            polarityProof: O.polarity === null ? null : q(O.polarity), evidence: ids.map(id => c.clauses[id]),
            objectSpans: objects, guardSpans: guard, guardProof: O.guard === null ? null : q(O.guard),
            identity: JSON.stringify({ ...m, G: [], a: action, J: objects, u: m.u === null ? null : terms([m.u]) }) });
        }
        dictionary.assertAllUsed();
        if (covered.size !== c.clauses.length || completed.size !== tasks.length) throw invalid();
        assertSourceSemanticReading(c, checked, sourceFullActionCues(c));
        await validateIdentifiedSourceClaim(source,claimNo,answer);
        // A validated piece is still not a successful extraction or save. The
        // original complete decoder must validate the union below.
        return { success: true, value: structuredClone(raw) };
      } catch { return { success: false, error: invalid() }; }
    } });
    tasks.push(Object.freeze({ id: `${sourceDigest}:${claimNo}`, sourceIndex, sourceDigest, claimNo, system: CLAIM_SYSTEM,
      prompt: JSON.stringify({ task: "extract_source_propositions", citationClauses: { version: 8 },
        target: { sourceDigest, claimNo }, sourceContext: { ...transport.sources[sourceIndex],
          referenceLogic: source.source.referenceLogic, scopes: source.scopes } }), schema: taskSchema }));
  }
  if (!tasks.length || tasks.length > LIMITS.sourceClaims) throw new ComparisonError("plan_limit");
  const plan = Object.freeze({ tasks: Object.freeze(tasks) });
  plans.set(plan, { chunks: boundChunks, input, schema: fullSchema });
  return plan;
}

/** Exactly one fresh response for each preplanned identity. No sorting facts,
 * citation repair, omissions, ancestor substitution or old-response fallback. */
export async function assembleSourceClaims(plan: SourceClaimPlan, answers: readonly { taskId: string; value: unknown }[]): Promise<SourceExtraction> {
  const bound = plans.get(plan);
  if (!bound || answers.length !== plan.tasks.length || new Set(answers.map(a => a.taskId)).size !== answers.length) throw invalid();
  const sources: Record<string, unknown>[] = bound.input.sources.map(s => ({ d: s.sourceDigest }));
  for (const task of plan.tasks) {
    const answer = answers.find(a => a.taskId === task.id);
    if (!answer || !task.schema.validate) throw invalid();
    const result = await task.schema.validate(answer.value);
    if (!result.success || !record(result.value) || !record(result.value.answer)) throw invalid();
    for (const [key, value] of Object.entries(result.value.answer)) {
      if (key === "d") continue;
      if (Object.hasOwn(sources[task.sourceIndex], key)) throw invalid();
      sources[task.sourceIndex][key] = value;
    }
  }
  const raw = { v: 22, s: sources };
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > SOURCE_CAPACITY.wireBytes || !bound.schema.validate) throw invalid();
  const result = await bound.schema.validate(raw);
  if (!result.success) throw invalid();
  decodeSourcePropositions(bound.chunks, result.value);
  return result.value as SourceExtraction;
}
