import { z } from "zod";

/** Internal comparison algebra. These are extraction candidates, not AI
 * verdicts. A locator check proves only where words occur, never their meaning. */
export const spanSchema = z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).meta({id:"PriorArtSpan"});
export type Span = z.infer<typeof spanSchema>;
const term = z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f-\x9f]*$/).meta({id:"PriorArtTerm"});
const terms = z.array(term).max(12);
export const guardSchema = z.object({
  relation: z.enum(["unconditional", "when", "only_when", "unresolved"]),
  conditions: terms,
}).strict().meta({id:"PriorArtGuard"});
const common = {
  subject: term.nullable(),
  context: z.enum(["capability", "operation", "unresolved"]),
  guard: guardSchema,
  polarity: z.enum(["positive", "negative", "reserved"]),
};
export const meaningSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("set"),
    selection: z.enum(["required", "one", "nonempty", "all", "unspecified"]),
    extent: z.enum(["closed", "partial"]), members: terms.min(1),
  }).strict(),
  z.object({ ...common, kind: z.literal("path"),
    origin: term.nullable(), destination: term.nullable(), via: terms, bypass: terms,
    extent: z.enum(["segment", "whole", "unresolved"]), relation: z.enum(["route", "precedes"]),
  }).strict(),
  z.object({ ...common, kind: z.literal("relation"),
    predicate: z.enum(["has", "upstream", "downstream", "inside", "opens", "closes", "maintains", "at_least", "at_most", "greater_than", "less_than"]),
    objects: terms.min(1),
  }).strict(),
]);
export type Meaning = z.infer<typeof meaningSchema>;
export type Guard = z.infer<typeof guardSchema>;
export type SourceProposition = {
  id: string; scope: string; claimNo: number;
  basis: readonly Span[]; meaning: Meaning; authority: "literal" | "extracted";
  /** A whole route needs its boundaries, route clause and explicit exclusion /
   * active-control evidence. An extractor's 'whole' flag alone proves nothing. */
  routeFrame?: { entry: Span; exit: Span; route: Span; exclusions: Span[]; controls: Span[] };
};
export type TargetProposition = {
  id: string; targetId: string; span: Span; sourceIds: readonly string[];
  scope: string; claimNo: number; inheritedClaimNos?: readonly number[]; meaning: Meaning;
};
export type ComparisonRule = "same_conditions" | "required_optionalized" | "closed_set_changed" |
  "selection_changed" | "partial_membership" | "path_conflict" | "path_matches" |
  "order_matches" | "whole_route_exclusion" |
  "guard_lost" | "guard_mismatch" | "subject_mismatch" | "branch_mismatch" |
  "context_mismatch" | "polarity_mismatch" | "relation_matches" | "relation_changed" | "not_expressible";
export type PropositionComparison = {
  target: TargetProposition; sources: SourceProposition[];
  relation: "entailed" | "contradicted" | "unresolved"; rule: ComparisonRule;
  delta: { missing: string[]; added: string[]; counterexample: string[] };
};

/** Only orthographic normalization. No synonym dictionary or sample-specific
 * vocabulary: an extractor's proposed equivalence still needs source QA. */
export const propositionKey = (text: string) => text.normalize("NFKC").replace(/^(?:前記|当該|該)/u, "")
  .replace(/\s+/gu, "").replace(/の(?=運転モード|開閉弁)/gu, "");
const keys = (values: readonly string[]) => values.map(propositionKey);
const equalSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(keys(a)), y = new Set(keys(b)); return x.size === y.size && [...x].every(s => y.has(s));
};
const sameSubject = (a: string | null, b: string | null) => a === null ? b === null : b !== null && propositionKey(a) === propositionKey(b);

export function meaningKey(m: Meaning): string {
  // Sets and conjunctive conditions are unordered; route order remains material.
  const sorted = (xs: string[]) => [...new Set(xs.map(propositionKey))].sort();
  const common = {kind:m.kind,subject:m.subject === null ? null : propositionKey(m.subject),context:m.context,
    guard:{relation:m.guard.relation,conditions:sorted(m.guard.conditions)},polarity:m.polarity};
  return JSON.stringify(m.kind === "set" ? {...common,selection:m.selection,extent:m.extent,members:sorted(m.members)} : m.kind === "path"
    ? {...common,origin:m.origin === null ? null : propositionKey(m.origin),destination:m.destination === null ? null : propositionKey(m.destination),
      via:m.via.map(propositionKey),bypass:sorted(m.bypass),extent:m.extent,relation:m.relation}
    : {...common,predicate:m.predicate,objects:sorted(m.objects)});
}

/** Compute a relation only in the same source, reference branch and condition.
 * Insufficient extraction and non-matching guards are not contradictions. */
export function compareProposition(target: TargetProposition, available: readonly SourceProposition[]): PropositionComparison {
  const chosen = target.sourceIds.map(id => available.find(s => s.id === id && s.scope===target.scope && s.claimNo === target.claimNo)).filter((s): s is SourceProposition => !!s);
  // A model cannot hide a proven constraint by omitting its ID. Add applicable
  // literal groups on the exact branch, while retaining every chosen candidate.
  const literals = available.filter(s => s.authority === "literal" && s.scope === target.scope && (s.claimNo === target.claimNo || target.inheritedClaimNos?.includes(s.claimNo)) &&
    s.meaning.kind === target.meaning.kind && (target.meaning.subject === null || sameSubject(s.meaning.subject,target.meaning.subject)));
  const sources = [...new Map([...chosen,...literals].map(s=>[s.id,s])).values()];
  const result = (relation: PropositionComparison["relation"], rule: ComparisonRule,
    missing: string[] = [], added: string[] = [], counterexample: string[] = []): PropositionComparison =>
    ({ target, sources, relation, rule, delta: { missing, added, counterexample } });
  if (!chosen.length || chosen.length !== target.sourceIds.length || new Set(target.sourceIds).size !== target.sourceIds.length)
    return result("unresolved", "not_expressible");
  if (chosen.some(s => s.scope !== target.scope || s.claimNo !== target.claimNo)) return result("unresolved", "branch_mismatch");
  const t = target.meaning;
  // A proof inherited from a common ancestor cannot erase a more specific
  // constraint in one conditional descendant. We do not infer compatibility of
  // different projections; retain the entire closure and fail closed here.
  const conflictingBranches=available.filter(s => t.kind!=="path"&&s.scope === target.scope && s.authority === "literal" &&
      s.meaning.kind === t.kind && sameSubject(s.meaning.subject,t.subject) &&
      !sources.some(proof => meaningKey(proof.meaning) === meaningKey(s.meaning)));
  if (conflictingBranches.length){
    sources.push(...conflictingBranches);
    return result("unresolved", "branch_mismatch");
  }
  if (t.context === "unresolved" || sources.some(s => s.meaning.context !== t.context)) return result("unresolved", "context_mismatch");
  if (t.polarity !== "positive" || sources.some(s => s.meaning.polarity !== "positive")) return result("unresolved", "polarity_mismatch");
  if (t.guard.relation === "unresolved" || sources.some(s => s.meaning.guard.relation === "unresolved")) return result("unresolved", "guard_mismatch");
  if (sources.some(s => s.meaning.guard.relation !== t.guard.relation || !equalSet(s.meaning.guard.conditions, t.guard.conditions))) {
    // A conditional sufficient statement does not prove that its effect is
    // impossible outside the condition. Do not invent an iff implication.
    return result("unresolved", t.guard.relation === "unconditional" ? "guard_lost" : "guard_mismatch");
  }
  if (t.kind === "set") {
    const sets = sources.map(s => s.meaning).filter((s): s is Extract<Meaning,{kind:"set"}> => s.kind === "set");
    if (sets.length !== sources.length || sets.some(s => s.selection === "unspecified") || t.selection === "unspecified") return result("unresolved", "not_expressible");
    // A device-level closed alternative cannot turn a required capability of
    // another subject into one optional member. Preserve each original group.
    if (t.subject === null && t.extent === "closed" && ["one", "nonempty"].includes(t.selection)) {
      const required = sets.filter(s => s.selection === "required" || s.selection === "all").flatMap(s => s.members);
      for (const member of required) {
        const alternative = t.members.find(m => propositionKey(m) !== propositionKey(member));
        if (alternative && keys(t.members).includes(propositionKey(member)))
          return result("contradicted", "required_optionalized", [member], [], [alternative]);
      }
    }
    if (sets.some(s => !sameSubject(s.subject, t.subject))) return result("unresolved", "subject_mismatch");
    // Multiple constraints for a subject may be nested/refined, not a union.
    // Only an identical projection can be coalesced here.
    if (sets.some(s => s.selection !== sets[0].selection || s.extent !== sets[0].extent || !equalSet(s.members, sets[0].members))) return result("unresolved", "not_expressible");
    const s = sets[0], missing = s.members.filter(m => !keys(t.members).includes(propositionKey(m))),
      added = t.members.filter(m => !keys(s.members).includes(propositionKey(m)));
    if (t.extent === "partial") return !added.length && t.selection === "one" && ["one","nonempty"].includes(s.selection)
      ? result("entailed", "partial_membership") : result("unresolved", "not_expressible");
    if (s.extent !== "closed") return result("unresolved", "not_expressible");
    if (missing.length || added.length) return result("contradicted", "closed_set_changed", missing, added, missing.length ? [missing[0]] : [added[0]]);
    if (s.selection !== t.selection && !([s.selection,t.selection].every(v => v === "required" || v === "all"))) {
      if (s.members.length === 1) return result("entailed", "same_conditions");
      const counterexample = s.selection === "one" || t.selection === "one" && s.selection === "nonempty"
        ? s.members.slice(0,2) : [s.members[0]];
      return result("contradicted", "selection_changed", [], [], counterexample);
    }
    return result("entailed", "same_conditions");
  }
  if (sources.some(s => !sameSubject(s.meaning.subject, t.subject))) return result("unresolved", "subject_mismatch");
  if (t.kind === "path") {
    const candidates=chosen.filter(s=>s.meaning.kind==="path"&&(t.relation==="precedes"?s.meaning.extent==="whole":
      s.meaning.extent===t.extent&&sameSubject(s.meaning.origin,t.origin)&&sameSubject(s.meaning.destination,t.destination)));
    const unique=[...new Map(candidates.map(s=>[meaningKey(s.meaning),s])).values()];
    if(unique.length!==1||unique[0].meaning.kind!=="path")return result("unresolved", "not_expressible");
    const primary=unique[0],s=unique[0].meaning;
    if(s.extent==="whole"&&(!primary.routeFrame||!primary.routeFrame.exclusions.length||!primary.routeFrame.controls.length))
      return result("unresolved", "not_expressible");
    const constraints=available.filter(f=>f.scope===target.scope&&f.authority==="literal"&&f.meaning.kind==="path"&&sameSubject(f.meaning.subject,t.subject));
    for(const f of constraints){
      if(!sources.some(s=>s.id===f.id))sources.push(f);
      const c=f.meaning;if(c.kind!=="path")continue;
      if(c.context!==s.context||c.polarity!==s.polarity||c.guard.relation!==s.guard.relation||!equalSet(c.guard.conditions,s.guard.conditions))
        return result("unresolved", "branch_mismatch");
      if(meaningKey(c)===meaningKey(s))continue;
      const nodes=keys([...(s.origin?[s.origin]:[]),...s.via,...(s.destination?[s.destination]:[])]);
      const start=c.origin?nodes.indexOf(propositionKey(c.origin)):-1,end=c.destination?nodes.lastIndexOf(propositionKey(c.destination)):-1;
      if(start<0||end<=start)return result("unresolved", "not_expressible");
      const interval=nodes.slice(start+1,end);let cursor=-1;
      if(c.via.some(v=>{const next=interval.indexOf(propositionKey(v),cursor+1);cursor=next;return next<0;})||
        c.bypass.some(v=>nodes.slice(start,end+1).includes(propositionKey(v))))return result("unresolved", "not_expressible");
    }
    if (t.relation === "precedes") {
      // 'after X' does not mean 'immediately after X'. No invented origin.
      const frame = primary.routeFrame;
      if (s.relation !== "route" || s.extent !== "whole" || !frame || !frame.exclusions.length || !frame.controls.length ||
          !s.origin || !s.destination || t.via.length !== 1 || t.bypass.length || !t.destination || t.origin !== null)
        return result("unresolved", "not_expressible");
      const nodes = [s.origin,...s.via,s.destination], before = propositionKey(t.via[0]), after = propositionKey(t.destination);
      const end = keys(nodes).indexOf(after), start = keys(nodes).indexOf(before);
      if (end < 0) return result("unresolved", "not_expressible");
      if (start >= 0 && start < end) return result("entailed", "order_matches");
      // An explicit whole-route exclusion, not absence from a partial list.
      if (start < 0 && keys(s.bypass).includes(before)) return result("contradicted", "whole_route_exclusion", [], [], [t.via[0]]);
      return result("unresolved", "not_expressible");
    }
    if (s.extent === "unresolved" || t.extent === "unresolved" || !s.origin || !s.destination || !t.origin || !t.destination ||
        !sameSubject(s.origin,t.origin) || !sameSubject(s.destination,t.destination) || s.extent !== t.extent || s.relation !== t.relation)
      return result("unresolved", "not_expressible");
    const conflict = t.via.filter(v => keys(s.bypass).includes(propositionKey(v)))
      .concat(t.bypass.filter(v => keys(s.via).includes(propositionKey(v))));
    if (conflict.length) return result("contradicted", "path_conflict", [], [], conflict);
    // Order is material. A matching bag of route nodes is not a matching path.
    const ordered = (a: string[],b: string[]) => a.length === b.length && keys(a).every((v,i)=>v===keys(b)[i]);
    return ordered(s.via,t.via) && equalSet(s.bypass,t.bypass) ? result("entailed", "path_matches") : result("unresolved", "not_expressible");
  }
  if (sources.length !== 1 || sources[0].meaning.kind !== "relation") return result("unresolved", "not_expressible");
  const s = sources[0].meaning;
  if (s.predicate === t.predicate && equalSet(s.objects,t.objects)) return result("entailed", "relation_matches");
  const opposite = [["upstream","downstream"],["opens","closes"],["greater_than","at_most"],["less_than","at_least"]];
  // Providing both opening and closing capabilities is not contradictory.
  // Only a claim about the same operation state can exclude the other action.
  if(t.context==="capability"&&[s.predicate,t.predicate].every(p=>["opens","closes"].includes(p)))
    return result("unresolved", "not_expressible");
  return equalSet(s.objects,t.objects) && opposite.some(p=>p.includes(s.predicate)&&p.includes(t.predicate))
    ? result("contradicted", "relation_changed") : result("unresolved", "not_expressible");
}

/** No free-form reason is accepted from the model. The target, original
 * condition, calculated difference and both locators stay in one record. */
export function explainProposition(record: PropositionComparison): string {
  const { rule, delta, target, sources } = record;
  const subject = target.meaning.subject ?? "装置の要件";
  const sourceLocations = sources.map(s => `請求項${s.claimNo}[${s.basis.map(([a,b])=>`${a}:${b}`).join(",")}]`).join("・");
  const explanation: Record<ComparisonRule,string> = {
    same_conditions: "主体・条件・集合と選択関係が一致する",
    required_optionalized: `必須の${delta.missing.join("・")}を任意化している。${delta.counterexample.join("・")}だけの選択では必須条件を満たさない`,
    closed_set_changed: `閉じた集合が異なる（原文からの脱落:${delta.missing.join("・") || "なし"}、追加:${delta.added.join("・") || "なし"}）`,
    selection_changed: "構成要素は同じだが、必須・択一・組合せの関係が異なる",
    partial_membership: "一部として述べた要素は原文の集合に含まれる。集合全体の同一性は主張しない",
    path_conflict: `同じ主体・条件・起終点の経路で${delta.counterexample.join("・")}の経由と迂回が衝突する`,
    path_matches: "同じ主体・条件・起終点について経由順序と迂回が一致する",
    order_matches: "対象モードの全経路で、対象が述べたノードの前後関係が成立する。対象の起点は補っていない",
    whole_route_exclusion: `対象モードの全経路で${delta.counterexample.join("・")}は明示的に除外されており、その通過を要する対象の順序断定と衝突する`,
    guard_lost: "原文の条件が対象の無条件断定に残っていない。条件外の成否は導けない",
    guard_mismatch: "適用条件の同一性を確定できない",
    subject_mismatch: "条件の主体が一致せず、別主体へ移せない",
    branch_mismatch: "文献・指定範囲・参照枝の対応が一致しない",
    context_mismatch: "備える機能と同時の運転状態を同一視できない",
    polarity_mismatch: "否定・留保を肯定断定へ読み替えられない",
    relation_matches: "同じ主体と条件の関係が一致する",
    relation_changed: "同じ主体と条件について相反する関係を述べている",
    not_expressible: "抽出された表現では必要な関係を確定できない",
  };
  return `${subject}: ${explanation[rule]}。対象[${target.span.join(":")}]、原文${sourceLocations}。`;
}
