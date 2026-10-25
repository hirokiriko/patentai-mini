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
import { projectClaimScopeLanes } from "./source-claim-scope-projection";
import { claimLiteralDictionary,mapClaimLiteralFact } from "./source-claim-literal-refs";
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
  if (line.startsWith("Extract complete")) return line.replace("v22", "v34");
  if (line.startsWith("Each cN=")) return 'Each cN={possessions:[],sets:[],f0:[],f1:[],...,T:[]}. possessions ONLY relation/has and sets ONLY set meanings, each row {R,s,m,O,F} nondecreasing R. fN ONLY other meanings as {s,m,O,F}, R=N. Merge by original R, then possessions,sets,fN at each R; never sort raw rows or infer omitted meaning. T contains ONLY fN:row addresses, never global counts or possession/set addresses. References are first-last:exact original quote, uniquely matched in that inclusive <=12-clause range; prefer a plain string; optional {reference,focus} selects a unique exact focus inside a uniquely matched outer reference. No occurrence counts/qIDs/offsets/normalization. Terms are 1..4 references <=80 UTF16 characters.';
  if (line.startsWith("O=[")) return 'scopes=[{id:"s0",g:"when" or "only_when",G:terms,proof:directReference}]. Each fact and loop has required s:scopeID or null for explicit unconditional. m has NO g/G; O=[selection,extent,polarity,context], exactly four references/null. Selected scope supplies only g/G/full O.guard; actor u/context x/polarity p stay in EACH m. A postposed printed mode label may be G/proof verbatim: controller actions select its scope, keeping the controller in u; do not invent a literal when phrase. The decoder never fills actor u from a scope or another fact. YOU must explicitly cite the continuing printed controller in EACH governed active executes, even across intermediate process clauses; an instrument introduced by で/にて is not a new subject. G separately cites every governing condition including full duration/mode, never punctuation or an action object alone. proof contains ALL G plus connectors; proof alone cannot supply omitted G. Reject duplicate/unknown/unused scopes. Semantic G/g instructions mean selected scope.G/g; never put them inside m. O[3] context is only an actual contiguous governing marker, or null; actor/action are separately cited in m.u/m.a, never stitch them into one quote. Negative still requires O[2]. F=null, supplied loop ID, or {E,X,T,C,D}; E/X/T are references/null, C/D arrays of references/null. loopN retains n/b/m/O/F/R plus required s with identical scope semantics. Never invent a when phrase.';
  if (line.startsWith("Fictional clauses")) return 'Fictional original="温度を検出して出力する青センサと、読取器を備える。", scopes=[]. possessions=[{R:1,s:null,m:{u:null,x:"capability",p:"positive",k:"relation",P:"has",J:[["0-0:青センサ"],["1-1:読取器"]],a:"1-1:備える"},O:[null,null,null,null],F:null}]. f0=[{s:null,m:{u:["0-0:青センサ"],x:"capability",p:"positive",k:"relation",P:"executes",J:[["0-0:温度を検出して出力する"]],a:"0-0:温度を検出して出力する"},O:[null,null,null,null],F:null}]. f1=[],sets=[]. Possession never substitutes its defining function, or vice versa. Split long possessions within <=12 clauses without omitting components.';
  if (line.startsWith("facts is flat")) return "f0,f1,... are original clause groups in that order; each group preserves its own fact order. T uses only explicit fN:row addresses, never flattened counts or possession/set/loop references.";
  return line;
}).join("\n") + `
Extract ONLY target.claimNo of target.sourceDigest. Return {v:34,sourceDigest,claimNo,d,scopes,...loopN,cN}; all fields are at root, with original IDs and no answer wrapper.
No output Q dictionary or qIDs: cite an exact original literal, optionally a unique outer reference plus exact inner focus.
T array index i identifies obligation ti; the f-number identifies an original clause, and row is local to that group. Example T[0]="f7:1" selects the second fact in f7 only when it expresses t0. Never use a flattened index. Emit its actor, full action/object and complete guard. Definitions cannot discharge other mode occurrences; paths/O/task indices cannot replace actions. A fact may serve several obligations only if it expresses them all. Keep R order, without duplicates or task-order rearrangement. Obligations are partial: retain all other meanings.
For EVERY executes, at least one J quote must contain the complete exact a quote at the SAME original occurrence. a is only validation evidence and is removed from the final meaning; operands alone lose the action. For switching, J must retain both operands AND the full switching action, e.g. [["0-0:青工程"],["1-1:赤工程を切り換えて実行する"]], not just the two names. Never rely on a alone to retain a verb.
For maintains, a and J quote the same FULL compound maintained state including the verb. Fictional "青工程と、赤工程を交替する": executes J=[["0-0:青工程"],["1-1:赤工程を交替する"]], retaining both operands.
Choose x for EACH assertion, not for the apparatus claim as a whole: capability is a defining property/function or overall apparatus ability; operation is each stated operating-mode action, route, control, startup/transition or duration-bound maintenance. A device claim does not turn its mode operations into capabilities. Retain their explicit scopes and operation context together.
Paths keep their printed mode in u; controller u belongs to its separate active relation facts. For numeric F, loop u must equal that recognizedLoopRoutes mode, never the controller. Finish EVERY mode through its final printed outlet/return even when not listed in requiredRouteClauses. A return path and switching action in the same clause are distinct meanings; neither substitutes the other. Fictional clauses [[0,"青源から白管を経て黒槽へ流す冬モードと、"],[1,"黒槽から青源へ戻す夏モードを切り換えて実行する読取装置。"]]: emit the summer path u=["1-1:夏モード"], i=["1-1:黒槽"], j=["1-1:青源"], AND a separate executes with u=["1-1:読取装置"] and both mode operands. Never omit the final 青源 because the clause also names a mode and switching action.
For a function followed by its printed subject, cite that postposed subject in u even without は/が. A named apparatus is not an unprinted implicit actor merely because it is the whole claimed device. Fictional "青工程と、赤工程を切り換えて実行する読取装置。": executes at f1 has u=["1-1:読取装置"], J=[["0-0:青工程"],["1-1:赤工程を切り換えて実行する"]], a="1-1:切り換えて実行する", x="capability", s=null. Both operands and the distinct printed actor are required; do not leave u=null or borrow an operand as actor.
sourceContext target claim clauses concatenate unchanged in ID order. Resolve references only inside their stated range; identical text at another occurrence is not interchangeable. Context or another group/loop never supplies missing meaning. R must overlap an m quote, not F/O/context. Each actor/restatement and route endpoint/via uses its actual occurrence. Each reference range is <=12 consecutive clauses; combined m/O/F evidence uses <=12 DISTINCT actually quoted clauses, not maxID-minID+1. Separate references do not include unquoted intervening clauses.
The fact group fN is NOT the quotation's first-last range. If a full J action starts in the preceding clause, include that clause in its reference. Fictional [[0,"青板を、"],[1,"布で拭く清掃器。"]]: f1 has J=[["0-1:青板を、布で拭く"]], a="1-1:拭く", u=["1-1:清掃器"]. "1-1:青板を、布で拭く" is invalid: its prefix is outside clause 1. Check EVERY complete quote against its own stated range, retaining the original punctuation.
For a coordinated component list governed by terminal 備える, has.J includes EVERY governed nominal head, including earlier heads whose defining functions were extracted separately. A function/route never substitutes that component's possession. Follow the printed coordination: nested objects inside a component's definition are not additional directly possessed components. Fictional heads at clauses 0,2,12: J=[["0-0:青センサ"],["2-2:読取器"],["12-12:制御器"]], a="12-12:備える", R=12 uses THREE distinct support clauses, although 0..12 spans thirteen. This is not one 0-12 reference. When the actual quoted support union exceeds twelve, split has into disjoint member subsets with the same printed possession verb and governing actor/context/polarity; preserve every member across the rows. Do not truncate to the terminal component.
Fictional original="制御器により、赤弁を閉じる冬モードと、赤弁を開く夏モード。". scopes=[{id:"s0",g:"when",G:[["1-1:冬モード"]],proof:"1-1:冬モード"},{id:"s1",g:"when",G:[["2-2:夏モード"]],proof:"2-2:夏モード"}]. f1=[{s:"s0",m:{u:["0-0:制御器"],x:"operation",p:"positive",k:"relation",P:"closes",J:[["1-1:赤弁"]],a:"1-1:閉じる"},O:[null,null,null,null],F:null}]; f2 uses s1, the same controller, P:opens,a:"2-2:開く",J:[["2-2:赤弁"]]. The obligations address f1:0/f2:0; O.context never concatenates controller and distant action.
Fictional clauses [[0,"制御器により、"],[1,"青板を研磨材で研磨する冬モードと、"],[2,"青板を布で拭く夏モード。"],[3,"赤管は白管に接続された。"]]: BOTH active executes at f1/f2 explicitly have u=["0-0:制御器"] and their own full action J/a. Their selected scopes cite 冬モード/夏モード; these mode labels do NOT replace the controller in executes.u. 研磨材/布 are instruments, not replacement actors. The separate path branch alone uses a printed route mode as u. The passive is_state at f3 instead has u=["3-3:赤管"]. These are model-supplied actor citations; software never infers or inserts them. A new printed subject ends the earlier subject scope.
For original "青管と青管。", {reference:"0-0:と青管。",focus:"青管"} selects only the second 青管. Both outer quote and inner focus must match uniquely and exactly. Outer locator text adds no semantic evidence. Prefer plain strings when already unique.
For each requiredRouteClauses anchor, cite actual endpoint/via occurrences from that clause; another occurrence/loop elsewhere cannot cover it. One path/loop may cover several anchors only with its actual route quotes in each.
Fictional scope for "起動時、所定期間、弁を開く。": G=[["0-0:起動時"],["1-1:所定期間"]], proof="0-1:起動時、所定期間、"; punctuation and 弁 are not G.
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
    const groupKeys=c.clauses.map((_,i)=>`f${i}`);
    const loops = source.recognizedLoopRoutes.flatMap((r, id) => r.claimNo === claimNo ? [id] : []);
    // Preserve batch-global loop identities; direct references have no forward dictionary.
    const keys = ["d", "scopes", ...loops.map(id => `loop${id}`), `c${claimNo}`];
    // Reuse the provider's complete fact/quote definitions without an extra
    // nested wrapper level. The sole claim key is required, never an array slot.
    const items = fullJson.properties!.s as JSONSchema7;
    const alternatives = (items.items as JSONSchema7).anyOf ?? [items.items as JSONSchema7];
    const resolve = (v: JSONSchema7): JSONSchema7 => v.$ref ? resolve(definitions[v.$ref.split("/").at(-1)!] as JSONSchema7) : v;
    const own = alternatives.map(v => resolve(v as JSONSchema7)).find(v => {
      const d = v.properties?.d as JSONSchema7 | undefined;
      return d?.const === sourceDigest || d?.enum?.includes(sourceDigest);
    });
    if (!own?.properties || keys.some(k => k !== "scopes" && !own.properties![k])) throw new ComparisonError("plan_limit");
    const schema: JSONSchema7 = { type: "object", properties: {
      v: { type: "integer", enum: [34] }, sourceDigest: { type: "string", enum: [sourceDigest] },
      claimNo: { type: "integer", enum: [claimNo] },
      ...Object.fromEntries(keys.map(k => [k, k === "scopes" ? {type:"array",items:{$ref:"#/definitions/PriorArtSourceScope"}} : structuredClone(own.properties![k])])),
    }, required: ["v", "sourceDigest", "claimNo", ...keys], additionalProperties: false, definitions: structuredClone(definitions) };
    // Fresh v34 exact quotations and required occurrence references. Historical
    // answers are not accepted or repaired through this contract.
    const ownDefinitions=schema.definitions!;
    const ref=ownDefinitions.PriorArtSourceCellQuote as JSONSchema7;
    ref.anyOf=[{type:"string"},{type:"object",properties:{reference:{type:"string"},focus:{type:"string"}},required:["reference","focus"],additionalProperties:false}];delete ref.type;
    ref.description="Exact original first-last:quote, independent of fN/R. Include EVERY clause containing the full quote, including preceding clauses for a cross-clause action; never use N-N merely because the fact is in fN. Preserve punctuation and check the entire quote inside that range. Optional {reference,focus}: unique outer quote and unique inner focus; return only the inner span. No occurrence counts, qIDs, normalization or inferred text.";
    ownDefinitions.PriorArtSourceScope={type:"object",properties:{id:{type:"string"},g:{type:"string",enum:["when","only_when"]},G:{type:"array",items:{$ref:"#/definitions/PriorArtSourceTerm"}},proof:{$ref:"#/definitions/PriorArtSourceCellQuote"}},required:["id","g","G","proof"],additionalProperties:false,description:"An explicitly extracted governing mode/condition environment. G is nonempty and proof contains ALL G plus connecting operators. Each fact selects s or explicit null (unconditional). Scope projection supplies no actor: each active action must explicitly cite its printed governing actor in m.u."};
    const operators=ownDefinitions.PriorArtSourceOperators as JSONSchema7;
    operators.minItems=4;operators.maxItems=4;
    operators.description="Exactly [selection,extent,polarity,context] direct references/null. Guard proof belongs ONLY to the explicitly selected scope, not O.";
    const dictionaryClaim=ownDefinitions.PriorArtSourceDictionaryClaim as JSONSchema7;
    const groupedFact=structuredClone(ownDefinitions.PriorArtSourceAdditionalFact) as JSONSchema7;
    delete groupedFact.properties!.R;groupedFact.required=groupedFact.required!.filter(key=>key!=="R");
    groupedFact.properties!.s={anyOf:[{type:"string"},{type:"null"}]};groupedFact.required!.push("s");
    ownDefinitions.PriorArtSourceLaneFact={...structuredClone(groupedFact),properties:{...structuredClone(groupedFact.properties),R:{type:"integer"}},required:[...groupedFact.required!,"R"]};
    groupedFact.description="Actor/context/polarity remain fact-local. Required s explicitly selects a declared governing scope; null explicitly means unconditional. No actor or mode may be inferred from another fact/loop. Never invent a when phrase.";
    ownDefinitions.PriorArtSourceGroupedFact=groupedFact;
    ownDefinitions.PriorArtSourceClauseGroup={type:"array",items:{$ref:"#/definitions/PriorArtSourceGroupedFact"},description:"All assertions anchored in this original clause, including component-defining functions and inherited mode/conditions regardless of literal T checks. Other groups/has/loop never replace distinct meaning. Empty only if no additional assertion remains."};
    dictionaryClaim.description="fN anchors facts to original clause N; its key supplies R. Concatenate f0,f1,..., retaining each group's fact order; never infer missing meaning/context.";
    dictionaryClaim.properties=Object.fromEntries([
      ...groupKeys.map(key=>[key,{$ref:"#/definitions/PriorArtSourceClauseGroup"}]),
      ["T",{type:"array",items:{type:"string"},minItems:obligations.length,maxItems:obligations.length,description:"T[i] addresses obligation ti as f<originalClause>:<zeroBasedLocalRow>; e.g T[0]=f7:1 selects the second f7 fact for t0. No flattened counts. Partial literal checklist, not an inventory of all required facts. No omitted or extra bindings."}],
    ]);
    dictionaryClaim.properties!.possessions={type:"array",items:{$ref:"#/definitions/PriorArtSourceLaneFact"},description:"Every component possession assertion: terminal 備える governs all its coordinated nominal heads, including earlier function-defined components, not only the terminal head. Cite each head separately; functions/routes do not replace has. Split only when actual distinct quoted support exceeds twelve; retain all members with the same printed possession verb. Only relation/has facts, explicit original R in nondecreasing order. Empty only if none printed."};
    dictionaryClaim.properties!.sets={type:"array",items:{$ref:"#/definitions/PriorArtSourceLaneFact"},description:"Every quantified member/alternative set assertion, including any/combinations/all. Only set facts with explicit selection and original R nondecreasing. Enumeration of operations never replaces selection."};
    dictionaryClaim.properties={possessions:dictionaryClaim.properties!.possessions,sets:dictionaryClaim.properties!.sets,...Object.fromEntries(groupKeys.map(k=>[k,dictionaryClaim.properties![k]])),T:dictionaryClaim.properties!.T};
    dictionaryClaim.required=["possessions","sets",...groupKeys,"T"];
    const meaning = ownDefinitions.PriorArtSourceMeaning as JSONSchema7;
    for (const branch of meaning.anyOf as JSONSchema7[]) {
      const props = branch.properties!;
      delete props.g;delete props.G;branch.required=branch.required!.filter(k=>k!=="g"&&k!=="G");
      (props.x as JSONSchema7).description = "Choose context for THIS assertion, not the whole claim: capability=defining component property/function or overall apparatus ability; operation=stated mode action/route/control or startup/transition/duration-bound maintenance. Apparatus claim wording does not convert its individual operations into capabilities. Keep operation together with its governing scope.";
      (props.u as JSONSchema7).description = "Explicitly cite THIS action's printed governing actor: the component or apparatus named AFTER its active defining function, or an earlier controller whose subject scope continues. A postposed apparatus head is explicit even without は/が; never use null just because it is the whole claimed device. For active executes, intervening process clauses, an instrument, or a mode label do not erase the continuing controller. When a controller governs executes in several modes, u cites that controller in EVERY mode; the selected scope carries the mode condition, never substitute that mode for the controller. Null only if no printed governing actor exists; passive is_state uses its own state subject. The decoder never fills an omitted actor. An unrelated component definition is not an actor.";
      if (props.i && props.j) (props.u as JSONSchema7).description = "Path subject u is the printed MODE for this route, not the controller actor of separate relation facts. For numeric F, quote exactly the fixed recognizedLoopRoutes mode; changing it to the controller fails frame identity. Cite actual endpoint/via occurrences and the final return endpoint. Null only when no mode/subject is printed.";
      for (const key of ["i", "j", "V", "B"]) if (props[key])
        (props[key] as JSONSchema7).description = "THIS route occurrence; never substitute its component definition.";
      if (props.j) (props.j as JSONSchema7).description += " Final printed endpoint, even in a later clause.";
      if (props.J) (props.J as JSONSchema7).description = "has: ALL nominal heads coordinated under this possession verb, including earlier function-defined components; separate exact head references, never just the terminal head. Heat releases/absorbs/generates: J is the actual heat COMPONENT, never refrigerant or action; u remains the printed actor/mode. executes: full printed action/objects including ALL coordinated operands (と/又は); separate exact references for disjoint operands, never rely on another fact/scope. is_state: ONE term/ONE span containing the entire a state/transition and its verb, not only its location. Disjoint pieces use separate direct references.";
    }
    ((ownDefinitions.PriorArtSourceAdditionalFact as JSONSchema7).properties!.R as JSONSchema7).description =
      "Original clause overlapping an m quote; F/O/context never anchor R. Keep facts nondecreasing.";
    for(const key of loops.map(id=>`loop${id}`)){const loop=schema.properties![key] as JSONSchema7;loop.properties!.s={anyOf:[{type:"string"},{type:"null"}]};loop.required!.push("s");}
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
      const rawAnswer=Object.fromEntries(keys.map(key=>[key,raw[key]]));
      const own = rawAnswer[`c${claimNo}`];
      if (!record(own)||!Array.isArray(own.T)||own.T.length!==obligations.length)throw invalid();
      const projected=projectClaimScopeLanes(rawAnswer,claimNo,c),dictionary=claimLiteralDictionary(c);
      const facts=projected.facts.map(row=>mapClaimLiteralFact(row,dictionary));
      const mappedLoops=Object.fromEntries(Object.entries(projected.loops).map(([key,row])=>[key,mapClaimLiteralFact(row,dictionary)]));
      return {...rawAnswer,...mappedLoops,[`c${claimNo}`]:{Q:dictionary.quotes(),facts},__bindings:projected.bindings};
    };
    const taskSchema = jsonSchema(schema, { validate: async raw => {
      try {
        if (!exact(raw, ["v", "sourceDigest", "claimNo", ...keys]) || raw.v !== 34 || raw.sourceDigest !== sourceDigest ||
          raw.claimNo !== claimNo || raw.d !== sourceDigest ||
          Buffer.byteLength(JSON.stringify(raw), "utf8") > SOURCE_CAPACITY.wireBytes) throw invalid();
        const answer = normalizeAnswer(raw);
        const declaredBindings=answer.__bindings as unknown[];delete answer.__bindings;delete answer.scopes;
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
          // The decoder removes a after quotation checks. Generic executes
          // therefore needs its action in J itself, at the same occurrence.
          if (m.k === "relation" && m.P === "executes" && (!action ||
              !objects.some(term => term.some(([start, end]) => start <= action[0] && end >= action[1])))) throw invalid();
          const route = m.k === "path" ? [...(m.i === null ? [] : terms([m.i]).flat()), ...terms(m.V).flat(), ...(m.j === null ? [] : terms([m.j]).flat())] : [];
          sourceMatchedTasks(tasks, m, ids, action, route).forEach(id => completed.add(id));
          const matchedObligations = sourceMatchedTasks(obligations, m, ids, action, route);
          for (const [i] of obligations.entries()) if (declaredBindings[i] === at) {
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
        if (obligationKeys.some((_,i) => !Number.isSafeInteger(declaredBindings[i]) || Number(declaredBindings[i]) < 0 ||
            Number(declaredBindings[i]) >= factCount)) throw invalid();
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
      prompt: JSON.stringify({ task: "extract_source_propositions", citationClauses: { version: 20 },
        target: { sourceDigest, claimNo,
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
    if (!result.success || !record(result.value)) throw invalid();
    for (const [key, value] of Object.entries(bound.normalize.get(task.id)!(result.value))) {
      if (key === "d"||key === "scopes"||key === "__bindings") continue;
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
