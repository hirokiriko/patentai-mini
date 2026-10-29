import { jsonSchema, type JSONSchema7, type Schema } from "ai";
import { type SourceClaimPlan, type SourceClaimTask } from "./source-claim-extraction";
import { ComparisonError } from "./source";
import { LIMITS } from "./limits";

export type SourceRequest = Readonly<{
  id: string; tasks: readonly SourceClaimTask[]; system: string; prompt: string;
  schema: Schema<unknown>; partitioned: boolean; outputTokenLimit?: number;
}>;
const invalid = () => new ComparisonError("ai_incomplete");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const WRAPPER_SYSTEM = "\nThis request contains exactly two independent target claims. Return {first:<complete v34 object for targets.first>,second:<complete v34 object for targets.second>}. Apply every single-claim instruction separately to each object, including its own claimNo, dictionary, scopes, clauses and obligations. Both targets share the unchanged full sourceContext only. Never transfer facts, scope IDs, references or obligations between the objects. Preserve every condition and original meaning in BOTH claims; one correct object cannot compensate for the other. The wrapper replaces only the single-object response envelope.";

// Keep identical definitions shared, including their dependencies. If a
// definition or one of its references differs, namespace that entire dependency
// chain. This retains each member's original schema without doubling common defs.
function wrapperSchema(tasks: readonly SourceClaimTask[]): JSONSchema7 {
  const schemas = tasks.map(t => t.schema.jsonSchema as JSONSchema7);
  const definitions = schemas.map(s => s.definitions ?? {});
  const names = new Set(definitions.flatMap(d => Object.keys(d)));
  const separate = new Set([...names].filter(n => JSON.stringify(definitions[0][n]) !== JSON.stringify(definitions[1][n])));
  const rewrite = (value: unknown, index: number): unknown => {
    if (Array.isArray(value)) return value.map(v => rewrite(v, index));
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
      key === "$ref" && typeof v === "string" && v.startsWith("#/definitions/") && separate.has(v.slice(14))
        ? `#/definitions/member${index}_${v.slice(14)}` : rewrite(v, index)]));
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) if (!separate.has(name) &&
      JSON.stringify(rewrite(definitions[0][name], 0)) !== JSON.stringify(rewrite(definitions[1][name], 1))) {
      separate.add(name); changed = true;
    }
  }
  const merged: NonNullable<JSONSchema7["definitions"]> = {};
  for (const [i, defs] of definitions.entries()) for (const [name, value] of Object.entries(defs)) {
    const key = separate.has(name) ? `member${i}_${name}` : name;
    const rewritten = rewrite(value, i) as JSONSchema7;
    if (Object.hasOwn(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(rewritten)) throw invalid();
    merged[key] = rewritten;
  }
  const members = schemas.map((s, i) => {
    const { definitions: _definitions, $schema: _schema, ...body } = s;
    void _definitions; void _schema;
    return rewrite(body, i) as JSONSchema7;
  });
  return { type: "object", properties: { first: members[0], second: members[1] },
    required: ["first", "second"], additionalProperties: false, definitions: merged };
}

/** A physical request plan fixed solely from the original source plan. Existing
 * singleton requests are byte-identical; never group by previous model answers. */
export function sourceRequestPlan(plan: SourceClaimPlan): readonly SourceRequest[] {
  const requests: SourceRequest[] = [];
  for (let i = 0; i < plan.tasks.length; i++) {
    const first = plan.tasks[i], second = plan.tasks[i + 1];
    if (!first.compactBatchEligible || !second?.compactBatchEligible || first.partitioned || second.partitioned ||
      first.sourceDigest !== second.sourceDigest || first.sourceIndex !== second.sourceIndex ||
      second.claimNo !== first.claimNo + 1 || first.system !== second.system) {
      requests.push(Object.freeze({ ...first, tasks: Object.freeze([first]) })); continue;
    }
    const left = JSON.parse(first.prompt), right = JSON.parse(second.prompt);
    if (left.task !== "extract_source_propositions" || right.task !== left.task ||
      JSON.stringify(left.sourceContext) !== JSON.stringify(right.sourceContext) ||
      JSON.stringify(left.citationClauses) !== JSON.stringify(right.citationClauses)) throw invalid();
    const tasks = Object.freeze([first, second]);
    const system = first.system + WRAPPER_SYSTEM;
    const prompt = JSON.stringify({ task: "extract_source_propositions_pair", citationClauses: left.citationClauses,
      targets: { first: left.target, second: right.target }, sourceContext: left.sourceContext });
    const schema = jsonSchema<unknown>(wrapperSchema(tasks), { validate: async raw => {
      try {
        if (!object(raw) || Object.keys(raw).sort().join() !== "first,second") throw invalid();
        for (const [index, key] of ["first", "second"].entries()) {
          const validate = tasks[index].schema.validate;
          if (!validate || !(await validate(raw[key])).success) throw invalid();
        }
        return { success: true, value: structuredClone(raw) };
      } catch { return { success: false, error: invalid() }; }
    } });
    if (Buffer.byteLength(JSON.stringify({ system, prompt, schema: schema.jsonSchema }), "utf8") + 8192 > LIMITS.inputBytes) throw new ComparisonError("plan_limit");
    requests.push(Object.freeze({ id: `${first.id}+${second.claimNo}`, tasks, system, prompt, schema,
      partitioned: false, outputTokenLimit: LIMITS.azureReasoningOutputTokens }));
    i++;
  }
  return Object.freeze(requests);
}

/** Validate the complete response before returning ANY member. The untouched
 * wrapper remains provider evidence; members are projections, never new calls. */
export async function sourceRequestPieces(request: SourceRequest, raw: unknown): Promise<{ taskId: string; value: unknown }[]> {
  const validate = request.schema.validate;
  if (!validate || !(await validate(raw)).success) throw invalid();
  if (request.tasks.length === 1) return [{ taskId: request.tasks[0].id, value: structuredClone(raw) }];
  if (request.tasks.length !== 2 || !object(raw)) throw invalid();
  return request.tasks.map((task, i) => ({ taskId: task.id, value: structuredClone(raw[i === 0 ? "first" : "second"]) }));
}
