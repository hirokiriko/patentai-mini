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
import { compactSourceGridRows, sourceCellRef, SOURCE_GRID_GUIDE } from "./source-citation-grid";
import { decodeClaimCoordinateQuotes } from "./source-claim-coordinates";
import { sourceClaimObligations } from "./source-claim-obligations";

const invalid = () => new ComparisonError("ai_incomplete");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export type SourceClaimTask = Readonly<{ id: string; sourceIndex: number; sourceDigest: string; claimNo: number;
  system: string; prompt: string; schema: Schema<unknown> }>;
export type SourceClaimPlan = Readonly<{ tasks: readonly SourceClaimTask[] }>;
const plans = new WeakMap<SourceClaimPlan, { chunks: readonly ManagedComparisonChunk[];
  input: ReturnType<typeof propositionSourceInput>; schema: ReturnType<typeof sourceIdentifiedPropositionModelSchemaFor>;
  normalize: Map<string, (raw: Record<string, unknown>) => Record<string, unknown>> }>();

const CLAIM_SYSTEM = PROPOSITION_SOURCE_IDENTIFIED_SYSTEM.split("\n").map(line => {
  if (line.startsWith("Extract complete")) return line.replace("v22", "v24");
  if (line.startsWith("Each cN=")) return 'Each cN={Q,facts,t0,t1,...} with exactly the supplied obligation keys. Q entries are {id:"q17",K:[startRow,startColumn,endRow,endColumn]}, selecting inclusive ORIGINAL grid cells in THIS target claim. Do not regenerate quotation text or clause ranges. Every m/O/F quote reference is an exactly declared qID; never an array index. No duplicate IDs/spans or unused declarations. Terms remain 1..4 IDs and <=80 UTF16 original characters.';
  if (line.startsWith("Fictional clauses")) return 'Fictional target text "赤弁を閉じる。" has cells row0=赤|弁|を|閉|じ|る|。; Q=[{id:"q8",K:[0,0,0,1]},{id:"q3",K:[0,3,0,5]}]. A closes fact uses J=[["q8"]],a="q3". An obligation naming that closing occurrence points to its zero-based facts index, not to a quote ID.';
  return line;
}).join("\n") + `
This request extracts ONLY target.claimNo of target.sourceDigest. Return {v:24,sourceDigest,claimNo,answer}.
answer contains d, this cN and ONLY this claim's supplied loopN keys. Preserve original loop IDs.
Every quote ID matches q[0-9]{1,4}: lowercase q followed by one to four decimal digits ONLY (q0/q17/q9999 allowed; q0a and q10000 forbidden). Declare the exact ID in Q and reuse only that declared ID in m/O/F. IDs are labels, never array positions.
Each supplied obligation tN is a literal action occurrence, NOT a supplied proposition. Its REQUIRED integer value is the zero-based index of the fact in facts that actually expresses that occurrence. Emit the independent fact with its actor, full action/object and complete guard before assigning the index. A definition fact cannot discharge a different mode occurrence. Paths, O quotes and a task index alone never replace an action. One fact may serve multiple obligations only when it expresses every occurrence. Keep facts in R order; do not duplicate or reorder facts to match task order. Obligations are partial: retain all other meanings too.
For maintains, a and J must quote the same FULL maintained state including the maintaining verb, not a bare verb or a truncated first conjunct.
${SOURCE_GRID_GUIDE.replace("Empty [] is whole-claim proof ONLY in operators/frames, never a term.", "Empty coordinates are forbidden; O uses declared quote IDs or null.")}
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
  const normalize = new Map<string, (raw: Record<string, unknown>) => Record<string, unknown>>();
  for (const [sourceIndex, source] of input.sources.entries()) for (const claim of source.source.claims) {
    const claimNo = claim.claimNo, sourceDigest = source.sourceDigest;
    const c = sourceReadingClaim(claimNo, claim.segments.map(p => p.text).join(""));
    const obligations = sourceClaimObligations(c), obligationKeys = obligations.map((_, i) => `t${i}`);
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
      v: { type: "integer", enum: [24] }, sourceDigest: { type: "string", enum: [sourceDigest] },
      claimNo: { type: "integer", enum: [claimNo] },
      answer: { type: "object", properties: Object.fromEntries(keys.map(k => [k, own.properties![k]])), required: keys, additionalProperties: false },
    }, required: ["v", "sourceDigest", "claimNo", "answer"], additionalProperties: false, definitions: structuredClone(definitions) };
    // Fresh v24 coordinates and required occurrence references. Historical
    // v22/v23 answers are not accepted or repaired through this contract.
    const idDescription="Quote ID grammar is exactly q[0-9]{1,4}: lowercase q plus 1..4 decimal digits ONLY. q0/q17/q9999 allowed; q0a/q10000 forbidden. Use only an exactly declared claim-local ID, never an array position.";
    const ownDefinitions=schema.definitions!;
    const ref=ownDefinitions.PriorArtSourceCellQuote as JSONSchema7;
    ref.description=idDescription;
    ownDefinitions.PriorArtSourceDictionaryQuote = { type: "object", properties: {
      id: { type: "string", description: idDescription },
      K: { type: "array", items: { type: "integer" }, description: "Exactly four inclusive original grid coordinates [startRow,startColumn,endRow,endColumn]." },
    }, required: ["id", "K"], additionalProperties: false };
    const dictionaryClaim=ownDefinitions.PriorArtSourceDictionaryClaim as JSONSchema7;
    (dictionaryClaim.properties!.Q as JSONSchema7).description=`Original cell selections only. ${idDescription}`;
    for (const key of obligationKeys) dictionaryClaim.properties![key] = {
      type: "integer", description: `Index in facts expressing literal obligation ${key}; the actual action and meaning are checked.`,
    };
    dictionaryClaim.required = [...dictionaryClaim.required!, ...obligationKeys];
    // Remove definitions unreachable from this one-claim schema, preserving
    // the provider's existing 100-property and five-object-depth boundaries.
    const used = new Set<string>();
    const visit = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      const node = v as JSONSchema7;
      if (node.$ref) {
        const name = node.$ref.split("/").at(-1)!;
        if (!used.has(name)) { used.add(name); visit(ownDefinitions[name]); }
      }
      for (const [key, child] of Object.entries(node)) if (key !== "definitions") visit(child);
    };
    visit(schema); schema.definitions = Object.fromEntries([...used].map(key => [key, ownDefinitions[key]]));
    assertSourceGridProviderSchema(schema);
    const normalizeAnswer = (raw: Record<string, unknown>): Record<string, unknown> => {
      if (!record(raw.answer)) throw invalid();
      const own = raw.answer[`c${claimNo}`];
      if (!exact(own, ["Q", "facts", ...obligationKeys])) throw invalid();
      return { ...raw.answer, [`c${claimNo}`]: { Q: decodeClaimCoordinateQuotes(c, own.Q), facts: own.facts } };
    };
    const taskSchema = jsonSchema(schema, { validate: async raw => {
      try {
        if (!exact(raw, ["v", "sourceDigest", "claimNo", "answer"]) || raw.v !== 24 || raw.sourceDigest !== sourceDigest ||
          raw.claimNo !== claimNo || !exact(raw.answer, keys) || raw.answer.d !== sourceDigest ||
          Buffer.byteLength(JSON.stringify(raw), "utf8") > SOURCE_CAPACITY.wireBytes) throw invalid();
        const answer = normalizeAnswer(raw), declaredClaim = raw.answer[`c${claimNo}`] as Record<string, unknown>;
        const ownClaim = answer[`c${claimNo}`];
        if (!exact(ownClaim, ["Q", "facts"]) || !Array.isArray(ownClaim.facts)) throw invalid();
        const factCount = ownClaim.facts.length;
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
          const matchedObligations = sourceMatchedTasks(obligations, m, ids, action, route);
          for (const [i] of obligations.entries()) if (declaredClaim[`t${i}`] === at) {
            if (at >= ownClaim.facts.length || !matchedObligations.includes(i)) throw invalid();
            if (m.P === "maintains" && (!action || !objects.some(term => term.length === 1 &&
                term[0][0] === action[0] && term[0][1] === action[1]) ||
                !/[^、，。]+(?:を|に)[^、，。]*維持/u.test(c.grid.text.slice(...action)))) throw invalid();
          }
          checked.push({ kind: String(m.k), predicate: m.P as string | undefined, action, polarity: String(m.p),
            polarityProof: O.polarity === null ? null : q(O.polarity), evidence: ids.map(id => c.clauses[id]),
            objectSpans: objects, guardSpans: guard, guardProof: O.guard === null ? null : q(O.guard),
            identity: JSON.stringify({ ...m, G: [], a: action, J: objects, u: m.u === null ? null : terms([m.u]) }) });
        }
        if (obligationKeys.some(key => !Number.isSafeInteger(declaredClaim[key]) || Number(declaredClaim[key]) < 0 ||
            Number(declaredClaim[key]) >= factCount)) throw invalid();
        dictionary.assertAllUsed();
        if (covered.size !== c.clauses.length || completed.size !== tasks.length) throw invalid();
        assertSourceSemanticReading(c, checked, sourceFullActionCues(c));
        await validateIdentifiedSourceClaim(source,claimNo,answer);
        // A validated piece is still not a successful extraction or save. The
        // original complete decoder must validate the union below.
        return { success: true, value: structuredClone(raw) };
      } catch { return { success: false, error: invalid() }; }
    } });
    normalize.set(`${sourceDigest}:${claimNo}`, normalizeAnswer);
    tasks.push(Object.freeze({ id: `${sourceDigest}:${claimNo}`, sourceIndex, sourceDigest, claimNo, system: CLAIM_SYSTEM,
      prompt: JSON.stringify({ task: "extract_source_propositions", citationClauses: { version: 9 },
        target: { sourceDigest, claimNo, grid: compactSourceGridRows(c.grid),
          obligations: obligations.map((t, i) => ({ key: `t${i}`, clause: t.clause, K: sourceCellRef(c.grid, t.span), literal: c.grid.text.slice(...t.span) })) },
        sourceContext: { ...transport.sources[sourceIndex],
          referenceLogic: source.source.referenceLogic, scopes: source.scopes } }), schema: taskSchema }));
  }
  if (!tasks.length || tasks.length > LIMITS.sourceClaims) throw new ComparisonError("plan_limit");
  const plan = Object.freeze({ tasks: Object.freeze(tasks) });
  plans.set(plan, { chunks: boundChunks, input, schema: fullSchema, normalize });
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
    for (const [key, value] of Object.entries(bound.normalize.get(task.id)!(result.value))) {
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
