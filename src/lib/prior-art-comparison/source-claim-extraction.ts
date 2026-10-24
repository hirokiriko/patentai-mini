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
import { decodeClaimClauseQuotes } from "./source-claim-clause-quotes";
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
  if (line.startsWith("Extract complete")) return line.replace("v22", "v26");
  if (line.startsWith("Each cN=")) return 'Each cN={facts,t0,t1,...,Q}, with exactly the supplied obligation keys. Q entries are {id:"q17",quote,clause}. Copy quote ONLY from target.quoteSource; clause is the input clause ID containing its START. Exactly one literal match must start in that clause; if repeated there, quote enough original text to distinguish it. No before/after, character offsets or guessed ranges; no duplicate IDs/spans or unused declarations. Every m/O/F reference is a declared qID, never an array index. Terms: 1..4 IDs, <=80 UTF16 original characters; disjoint pieces use separate IDs, never a stitched quote.';
  if (line.startsWith("Fictional clauses")) return 'Fictional target.quoteSource="温度を検出して出力する青センサと、読取器を備える。" (clauses 0,1). facts=[{R:0,m:{u:["q8"],x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"executes",J:[["q3"]],a:"q3"},O:[null,null,null,null,null],F:null},{R:1,m:{u:null,x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"has",J:[["q8"],["q12"]],a:"q6"},O:[null,null,null,null,null],F:null}]. Q=[{id:"q8",quote:"青センサ",clause:0},{id:"q3",quote:"温度を検出して出力する",clause:0},{id:"q12",quote:"読取器",clause:1},{id:"q6",quote:"備える",clause:1}]. The function and possession are separate facts; the unprinted device actor stays null. Every component joined by と/及び before 備える needs possession, including components already used by function facts. Split long lists into has facts within the 12-clause evidence bound, omitting none.';
  return line;
}).join("\n") + `
Extract ONLY target.claimNo of target.sourceDigest. Return {v:26,sourceDigest,claimNo,answer}; answer has d, this cN and its supplied loopN keys with original IDs.
Quote IDs match q[0-9]{1,4}: q0/q17/q9999 allowed, q0a/q10000 forbidden.
Each required integer tN indexes, from zero, the fact expressing that literal action occurrence. Emit its actor, full action/object and complete guard. Definitions cannot discharge other mode occurrences; paths/O/task indices cannot replace actions. A fact may serve several obligations only if it expresses them all. Keep R order, without duplicates or task-order rearrangement. Obligations are partial: retain all other meanings.
For maintains, a and J quote the same FULL compound maintained state including the verb.
target.quoteSource is the unchanged continuous claim; sourceContext supplies clause IDs/context. Q quote must match exactly, including spaces, punctuation and printed 前記/該; never insert prefixes. Missing, ambiguous, normalized or invented text is rejected. A quote may cross <=12 consecutive clauses; its START must be in its explicit clause. Clause IDs select occurrences, never add meaning/coverage or guard/action. O uses declared IDs/null.
Q is an OCCURRENCE dictionary, not a component glossary. Build each fact's m first, then Q for its references; reuse a qID only for the identical original span, never for the same word at another position. Unused Q count must be ZERO. R must overlap an m quote; F/O/context do not count. u uses that action's actor/restatement occurrence; path i/j/V/B use that route's occurrences. Combined m/O/F evidence still fits <=12 clauses.
Fictional target.quoteSource="白管と黒管を備え、白管から黒管へ流す。" (clauses0,1). facts=[{"R":0,"m":{"u":null,"x":"capability","g":"unconditional","G":[],"p":"positive","k":"relation","P":"has","J":[["q0"],["q1"]],"a":"q2"},"O":[null,null,null,null,null],"F":null},{"R":1,"m":{"u":null,"x":"operation","g":"unconditional","G":[],"p":"positive","k":"path","i":["q3"],"j":["q4"],"V":[],"B":[],"e":"whole","r":"route"},"O":[null,null,null,null,null],"F":null}]. Q=[{"id":"q0","quote":"白管","clause":0},{"id":"q1","quote":"黒管","clause":0},{"id":"q2","quote":"備え","clause":0},{"id":"q3","quote":"白管","clause":1},{"id":"q4","quote":"黒管","clause":1}]. q0/q1 locate definitions; q3/q4 locate the route. Unprinted actor remains null.
For each requiredRouteClauses anchor, cite actual endpoint/via occurrences from that clause; another occurrence/loop elsewhere cannot cover it. One path/loop may cover several anchors only with its actual route quotes in each.
Other claims in sourceContext are reference context, extracted separately: never cite them or copy ancestor facts. Read all target definitions, conditions and reference tails. All v22 meaning/quotation/order/completeness rules remain; no previous answer is supplied or reusable.`;

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
    // Ordering trial: emit all meaning/reference IDs before their occurrence dictionary.
    const keys = ["d", ...loops.map(id => `loop${id}`), `c${claimNo}`];
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
      v: { type: "integer", enum: [26] }, sourceDigest: { type: "string", enum: [sourceDigest] },
      claimNo: { type: "integer", enum: [claimNo] },
      answer: { type: "object", properties: Object.fromEntries(keys.map(k => [k, own.properties![k]])), required: keys, additionalProperties: false },
    }, required: ["v", "sourceDigest", "claimNo", "answer"], additionalProperties: false, definitions: structuredClone(definitions) };
    // Fresh v26 exact quotations and required occurrence references. Historical
    // answers are not accepted or repaired through this contract.
    const idDescription="Claim-local q[0-9]{1,4} ONLY: q0/q17/q9999 valid, q0a/q10000 forbidden. Declared ID only, never array position.";
    const ownDefinitions=schema.definitions!;
    const ref=ownDefinitions.PriorArtSourceCellQuote as JSONSchema7;
    ref.description=idDescription;
    ownDefinitions.PriorArtSourceDictionaryQuote = { type: "object", properties: {
      id: { type: "string", description: idDescription },
      quote: { type: "string", description: "Single CONTIGUOUS original substring; never join disjoint pieces or invent connectors." },
      clause: { type: "integer", description: "Input clause containing the quote START; exactly one verbatim match may start there. No inferred or nearest clause." },
    }, required: ["id", "quote", "clause"], additionalProperties: false };
    const dictionaryClaim=ownDefinitions.PriorArtSourceDictionaryClaim as JSONSchema7;
    (dictionaryClaim.properties!.Q as JSONSchema7).description=`Exact original quotations with explicit clause IDs identifying one start occurrence in this claim. ${idDescription}`;
    for (const key of obligationKeys) dictionaryClaim.properties![key] = {
      type: "integer", description: `Index in facts expressing literal obligation ${key}; the actual action and meaning are checked.`,
    };
    dictionaryClaim.properties = Object.fromEntries(["facts", ...obligationKeys, "Q"].map(key => [key, dictionaryClaim.properties![key]]));
    dictionaryClaim.required = ["facts", ...obligationKeys, "Q"];
    (dictionaryClaim.properties!.Q as JSONSchema7).description += " Occurrence dictionary: identical span reuse only; same word elsewhere needs another ID. Zero unused entries.";
    const meaning = ownDefinitions.PriorArtSourceMeaning as JSONSchema7;
    for (const branch of meaning.anyOf as JSONSchema7[]) {
      const props = branch.properties!;
      (props.u as JSONSchema7).description = "Governing actor/restatement of THIS action; not a distant component definition.";
      for (const key of ["i", "j", "V", "B"]) if (props[key])
        (props[key] as JSONSchema7).description = "THIS route occurrence; never substitute its component definition.";
      if (props.j) (props.j as JSONSchema7).description += " Final printed endpoint, even in a later clause.";
      if (props.J) (props.J as JSONSchema7).description = "For executes, preserve full printed objects/function, not only its bare verb. Disjoint term pieces use separate qIDs, never a stitched Q quote.";
    }
    ((ownDefinitions.PriorArtSourceAdditionalFact as JSONSchema7).properties!.R as JSONSchema7).description =
      "Original clause overlapping an m quote; F/O/context never anchor R. Keep facts nondecreasing.";
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
      return { ...raw.answer, [`c${claimNo}`]: { Q: decodeClaimClauseQuotes(c, own.Q), facts: own.facts } };
    };
    const taskSchema = jsonSchema(schema, { validate: async raw => {
      try {
        if (!exact(raw, ["v", "sourceDigest", "claimNo", "answer"]) || raw.v !== 26 || raw.sourceDigest !== sourceDigest ||
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
      prompt: JSON.stringify({ task: "extract_source_propositions", citationClauses: { version: 13 },
        target: { sourceDigest, claimNo, quoteSource: c.grid.text,
          obligations: obligations.map((t, i) => ({ key: `t${i}`, clause: t.clause, literal: c.grid.text.slice(...t.span) })),
          requiredRouteClauses: sourceReadingTasks(c, true, true).filter(t => t.kind === "path").map(t => ({clause:t.clause,literal:c.grid.text.slice(...t.span)})) },
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
