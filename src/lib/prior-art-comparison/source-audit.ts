import { ComparisonError, digest } from "./source";
import type { SourceClaimTask } from "./source-claim-extraction";
import { LIMITS } from "./limits";
import { validateReviewFailureEvidence, type ReviewFailureEvidence } from "./review-failure-audit";

export const SOURCE_AUDIT_MAX_BYTES = 2_500_000;
export type SourceAuditTask = { -readonly [K in "id" | "sourceIndex" | "sourceDigest" | "claimNo"]: SourceClaimTask[K] };
export type SourceAudit = { version: 1 | 2; operationId: string; inputDigest: string; tasks: SourceAuditTask[];
  // Unmodified SDK objects, or exact members of a fully validated pair wrapper.
  // These are not provider HTTP envelopes or independent usage records.
  answers: { taskId: string; value: unknown }[];
  failure?: { taskId: string; text: string };
  previousAuditDigest?: string;
  reviewFailure?: ReviewFailureEvidence;
  auditDigest: string };
export type SourceAuditSink = (audit: SourceAudit) => Promise<void>;
const invalid = () => new ComparisonError("save_unconfirmed");
// Keep historical rosters readable; only the final third may have two segments.
const partition = (id:string) => {
  const m=/:part([1-3])of([23])(?::segment([12])of2)?$/.exec(id);
  return m&&Number(m[1])<=Number(m[2])&&(!m[3]||m[1]==="3"&&m[2]==="3")?
    {index:Number(m[1]),count:Number(m[2]),segment:m[3]?Number(m[3]):null,suffix:m[0]}:null;
};
export function sourceAudit(operationId: string, inputDigest: string, tasks: readonly SourceAuditTask[],
  answers: SourceAudit["answers"], failure?: SourceAudit["failure"]): SourceAudit {
  const value = { version: 1 as const, operationId, inputDigest, tasks: tasks.map(({id,sourceIndex,sourceDigest,claimNo}) => ({id,sourceIndex,sourceDigest,claimNo})),
    answers: structuredClone(answers), ...(failure ? { failure: { ...failure } } : {}) };
  return validateSourceAudit({ ...value, auditDigest: digest(value) }, operationId, inputDigest, value.tasks);
}
/** Append only to the exact committed source audit. Its original v1 digest
 * remains independently verifiable; old downloads keep their v1 contract. */
export function appendReviewFailureAudit(source: SourceAudit, reviewFailure: ReviewFailureEvidence): SourceAudit {
  const original = validateSourceAudit(source, source.operationId, source.inputDigest);
  if (original.version !== 1 || original.failure || original.answers.length !== original.tasks.length) throw invalid();
  const { auditDigest: previousAuditDigest, ...body } = original;
  const value = { ...body, version: 2 as const, previousAuditDigest, reviewFailure: validateReviewFailureEvidence(reviewFailure) };
  return validateSourceAudit({ ...value, auditDigest: digest(value) }, source.operationId, source.inputDigest, source.tasks);
}
export function validateSourceAudit(raw: unknown, operationId: string, inputDigest: string, tasks?: readonly SourceAuditTask[]): SourceAudit {
  try {
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > SOURCE_AUDIT_MAX_BYTES) throw invalid();
    const a = raw as SourceAudit;
    if (!a || typeof a !== "object" || Object.keys(a).sort().join() !== ["version","operationId","inputDigest","tasks","answers","auditDigest", ...(a.failure ? ["failure"] : []), ...(a.version === 2 ? ["previousAuditDigest","reviewFailure"] : [])].sort().join() ||
        ![1,2].includes(a.version) || a.operationId !== operationId || a.inputDigest !== inputDigest || !/^[a-f0-9]{64}$/.test(inputDigest) ||
        !Array.isArray(a.tasks) || !a.tasks.length || a.tasks.length > LIMITS.sourceRequests || !Array.isArray(a.answers) || a.answers.length > a.tasks.length) throw invalid();
    if (new Set(a.tasks.map(t => t.id)).size !== a.tasks.length || a.tasks.some(t => !t || Object.keys(t).sort().join() !== "claimNo,id,sourceDigest,sourceIndex" ||
        !/^[a-f0-9]{64}$/.test(t.sourceDigest) || typeof t.id !== "string" || !(t.id===`${t.sourceDigest}:${t.claimNo}`||partition(t.id)&&t.id===`${t.sourceDigest}:${t.claimNo}${partition(t.id)!.suffix}`) || !Number.isSafeInteger(t.sourceIndex) || t.sourceIndex < 0 || t.sourceIndex > 3 || !Number.isSafeInteger(t.claimNo) || t.claimNo < 1)) throw invalid();
    if(new Set(a.tasks.map(t=>`${t.sourceDigest}:${t.claimNo}`)).size>LIMITS.sourceClaims)throw invalid();
    const sources = new Map<number, string>();
    for (const [i,t] of a.tasks.entries()) {
      const previous = a.tasks[i-1];
      const base=`${t.sourceDigest}:${t.claimNo}`;
      const part=partition(t.id), prior=previous&&partition(previous.id);
      const segmented=a.tasks.some(v=>v.id===`${base}:part3of3:segment1of2`);
      const roster=part?(segmented?[`${base}:part1of3`,`${base}:part2of3`,`${base}:part3of3:segment1of2`,`${base}:part3of3:segment2of2`]:
        Array.from({length:part.count},(_,j)=>`${base}:part${j+1}of${part.count}`)):[];
      const position=roster.indexOf(t.id);
      if(part&&(position<0||roster.some((id,j)=>a.tasks[i-position+j]?.id!==id)))throw invalid();
      if ((!previous && t.sourceIndex !== 0) || (previous && (t.sourceIndex < previous.sourceIndex || t.sourceIndex > previous.sourceIndex + 1 ||
          (t.sourceIndex === previous.sourceIndex && (t.claimNo<previous.claimNo||t.claimNo===previous.claimNo&&!(part&&prior&&position>0&&roster[position-1]===previous.id))))) ||
          (sources.has(t.sourceIndex) && sources.get(t.sourceIndex) !== t.sourceDigest) ||
          [...sources].some(([index,hash]) => index !== t.sourceIndex && hash === t.sourceDigest)) throw invalid();
      sources.set(t.sourceIndex,t.sourceDigest);
    }
    if (tasks && digest(tasks) !== digest(a.tasks)) throw invalid();
    if (a.answers.some((answer, i) => !answer || Object.keys(answer).sort().join() !== "taskId,value" || answer.taskId !== a.tasks[i].id ||
        !answer.value || typeof answer.value !== "object" || Array.isArray(answer.value) || Buffer.byteLength(JSON.stringify(answer.value), "utf8") > 64_000)) throw invalid();
    if (a.failure && (Object.keys(a.failure).sort().join() !== "taskId,text" || a.failure.taskId !== a.tasks[a.answers.length]?.id ||
        typeof a.failure.text !== "string" || Buffer.byteLength(a.failure.text, "utf8") > 1_000_000)) throw invalid();
    if (a.version === 2) {
      if (a.failure || a.answers.length !== a.tasks.length) throw invalid();
      const { previousAuditDigest, reviewFailure, auditDigest: ignoredDigest, ...oldBody } = a;
      void ignoredDigest;
      if (previousAuditDigest !== digest({ ...oldBody, version: 1 })) throw invalid();
      const captured = validateReviewFailureEvidence(reviewFailure);
      for (const key of ["inputs","selection"] as const) {
        const item = captured[key];
        if (item.status === "captured") {
          const identity = item.value as { inputDigest?: unknown; operationId?: unknown } | null;
          if (!identity || identity.inputDigest !== inputDigest || key === "selection" && identity.operationId !== operationId) throw invalid();
        }
      }
    }
    const { auditDigest, ...body } = a;
    if (digest(body) !== auditDigest) throw invalid();
    return structuredClone(a);
  } catch { throw invalid(); }
}
