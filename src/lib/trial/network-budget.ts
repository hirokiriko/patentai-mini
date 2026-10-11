import { AsyncLocalStorage } from "node:async_hooks";
import { trialBinding } from "./ledger";
import { readTrialPolicy, trialPolicyDigest, TrialError, type TrialPolicy } from "./policy";

// These are shared lifetime allocations, not new allowances per process, role,
// phase, policy revision or retry. They reuse the reviewed OWNER data/ARM slots.
export const TRIAL_STORAGE_REQUEST_LIMIT = 3_403;
export const TRIAL_STORAGE_RESERVED_BYTES = 32 * 1024 ** 3;
// 6,309 guardian + 600 wrapper + 91 shared runtime/OWNER = existing 7,000.
export const TRIAL_ARM_REQUEST_LIMIT = 91;
export const TRIAL_ARM_RESERVED_BYTES = TRIAL_ARM_REQUEST_LIMIT * 2 * 1024 ** 2;
export const TRIAL_NETWORK_DATABASE_BYTES = 8 * 1024 ** 2;
export const TRIAL_NETWORK_TABLE = "trial_network_budget";
export const TRIAL_NETWORK_DDL = `CREATE TABLE public.trial_network_budget (
  binding text NOT NULL CHECK (binding ~ '^[a-f0-9]{64}$'),
  service text NOT NULL CHECK (service IN ('blob','arm')),
  slot integer NOT NULL CHECK (slot BETWEEN 0 AND 3403),
  purpose text NOT NULL CHECK (purpose IN ('quota','originals','artifacts','budget','job')),
  method text NOT NULL CHECK (method IN ('QUOTA','GET','HEAD','PUT','POST')),
  request_bytes integer NOT NULL CHECK (request_bytes BETWEEN 0 AND 52428800),
  response_limit integer NOT NULL CHECK (response_limit BETWEEN 0 AND 52428800),
  requests integer NOT NULL DEFAULT 0 CHECK (requests BETWEEN 0 AND 3403),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes BETWEEN 0 AND 34359738368),
  observed_bytes integer CHECK (observed_bytes BETWEEN 0 AND response_limit),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  PRIMARY KEY (binding,service,slot),
  CHECK ((slot=0 AND purpose='quota' AND method='QUOTA' AND request_bytes=0 AND response_limit=0 AND observed_bytes IS NULL AND http_status IS NULL)
    OR (slot>0 AND purpose<>'quota' AND method<>'QUOTA' AND requests=0 AND reserved_bytes=0)),
  CHECK ((observed_bytes IS NULL) = (http_status IS NULL))
)`;
export interface TrialNetworkQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
// pg_get_constraintdef(..., false), PG16. An unfamiliar deparser output fails
// closed; a matching column list alone is not evidence of the fixed installer.
export const TRIAL_NETWORK_CONSTRAINTS = [
  "CHECK ((binding ~ '^[a-f0-9]{64}$'::text))",
  "CHECK ((service = ANY (ARRAY['blob'::text, 'arm'::text])))",
  "CHECK (((slot >= 0) AND (slot <= 3403)))",
  "CHECK ((purpose = ANY (ARRAY['quota'::text, 'originals'::text, 'artifacts'::text, 'budget'::text, 'job'::text])))",
  "CHECK ((method = ANY (ARRAY['QUOTA'::text, 'GET'::text, 'HEAD'::text, 'PUT'::text, 'POST'::text])))",
  "CHECK (((request_bytes >= 0) AND (request_bytes <= 52428800)))",
  "CHECK (((response_limit >= 0) AND (response_limit <= 52428800)))",
  "CHECK (((requests >= 0) AND (requests <= 3403)))",
  "CHECK (((reserved_bytes >= 0) AND (reserved_bytes <= '34359738368'::bigint)))",
  "CHECK (((observed_bytes >= 0) AND (observed_bytes <= response_limit)))",
  "CHECK (((http_status >= 100) AND (http_status <= 599)))",
  "PRIMARY KEY (binding, service, slot)",
  "CHECK ((((slot = 0) AND (purpose = 'quota'::text) AND (method = 'QUOTA'::text) AND (request_bytes = 0) AND (response_limit = 0) AND (observed_bytes IS NULL) AND (http_status IS NULL)) OR ((slot > 0) AND (purpose <> 'quota'::text) AND (method <> 'QUOTA'::text) AND (requests = 0) AND (reserved_bytes = 0))))",
  "CHECK (((observed_bytes IS NULL) = (http_status IS NULL)))",
].sort();
export async function verifyTrialNetworkTable(database: TrialNetworkQuery, owner: string) {
  const table=(await database.query("select pg_get_userbyid(relowner) as owner,relkind,relrowsecurity,relpersistence,relispartition,relhasrules from pg_class where oid=to_regclass('public.trial_network_budget')")).rows[0];
  if(!table||table.owner!==owner||table.relkind!=="r"||table.relrowsecurity||table.relpersistence!=="p"||table.relispartition||table.relhasrules)return false;
  const columns=(await database.query(`select a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attidentity,a.attgenerated,
    pg_get_expr(d.adbin,d.adrelid) as default_value from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.trial_network_budget'::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`)).rows;
  const expected=["binding:text","service:text","slot:integer","purpose:text","method:text","request_bytes:integer","response_limit:integer","requests:integer","reserved_bytes:bigint","observed_bytes:integer","http_status:integer"];
  if(columns.length!==expected.length||!columns.every((c,i)=>`${c.attname}:${c.type}`===expected[i]&&c.attnotnull===(i<9)&&c.attidentity===""&&c.attgenerated===""&&
    (i===7||i===8?c.default_value==="0":c.default_value===null)))return false;
  const constraints=(await database.query("select pg_get_constraintdef(oid,false) as definition,convalidated,condeferrable,condeferred from pg_constraint where conrelid='public.trial_network_budget'::regclass")).rows;
  if(constraints.some(c=>!c.convalidated||c.condeferrable||c.condeferred)||JSON.stringify(constraints.map(c=>c.definition).sort())!==JSON.stringify(TRIAL_NETWORK_CONSTRAINTS))return false;
  const other=(await database.query(`select exists(select 1 from pg_trigger where tgrelid='public.trial_network_budget'::regclass and not tgisinternal) or
    exists(select 1 from pg_inherits where inhrelid='public.trial_network_budget'::regclass or inhparent='public.trial_network_budget'::regclass) as bad`)).rows;
  return other.length===1&&other[0].bad===false;
}
export type TrialNetworkRequest = { service: "blob" | "arm"; purpose: "originals" | "artifacts" | "budget" | "job";
  method: "GET" | "HEAD" | "PUT" | "POST"; requestBytes: number; responseLimit: number };
export interface TrialNetworkReservation { observed(bytes: number, status: number): Promise<void> }
export interface TrialNetworkAllowance { reserve(request: TrialNetworkRequest): Promise<TrialNetworkReservation> }

/** One atomic autocommit reservation, followed by proof that its transaction
 * committed. Even a caller inside an outer SQL transaction cannot send early.
 * An uncertain SQL result never permits HTTP and is never retried/refunded.
 * Settlement records observations only; it cannot restore a request/byte slot. */
export class TrialNetworkBudget implements TrialNetworkAllowance {
  constructor(readonly policy: TrialPolicy, private readonly database: TrialNetworkQuery) {}
  async reserve(r: TrialNetworkRequest): Promise<TrialNetworkReservation> {
    try {
      if (!Number.isSafeInteger(r.requestBytes) || !Number.isSafeInteger(r.responseLimit) || r.requestBytes < 0 || r.responseLimit < 0 ||
          r.requestBytes > 50 * 1024 ** 2 || r.responseLimit > 50 * 1024 ** 2 ||
          (r.service === "blob" ? !["originals","artifacts","budget"].includes(r.purpose) || !["GET","HEAD","PUT"].includes(r.method) :
            r.service !== "arm" || r.purpose !== "job" || !["GET","POST"].includes(r.method)) ||
          Date.now() >= Date.parse(this.policy.retentionReviewAt) || trialPolicyDigest(readTrialPolicy()) !== trialPolicyDigest(this.policy)) throw new TrialError();
      const binding = trialBinding(this.policy), bytes = r.requestBytes + r.responseLimit;
      const requests = r.service === "blob" ? TRIAL_STORAGE_REQUEST_LIMIT : TRIAL_ARM_REQUEST_LIMIT;
      const limit = r.service === "blob" ? TRIAL_STORAGE_RESERVED_BYTES : TRIAL_ARM_RESERVED_BYTES;
      const roles = [this.policy.database.webUser, this.policy.database.workerUser, this.policy.database.migratorUser].filter(Boolean);
      const result = await this.database.query(`WITH allowance AS (
        UPDATE public.trial_network_budget SET requests=requests+1,reserved_bytes=reserved_bytes+$3
        WHERE binding=$1 AND service=$2 AND slot=0 AND requests<$4 AND reserved_bytes+$3<=$5
          AND current_database()=$6 AND session_user=ANY($7::text[])
          AND pg_total_relation_size('public.trial_network_budget')<=$8
        RETURNING requests
      ) INSERT INTO public.trial_network_budget(binding,service,slot,purpose,method,request_bytes,response_limit)
        SELECT $1,$2,requests,$9,$10,$11,$12 FROM allowance
        RETURNING slot,pg_current_xact_id()::text AS transaction_id`,
      [binding,r.service,bytes,requests,limit,this.policy.database.database,roles,TRIAL_NETWORK_DATABASE_BYTES,r.purpose,r.method,r.requestBytes,r.responseLimit]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || !Number.isSafeInteger(row.slot) || Number(row.slot) < 1 || Number(row.slot) > requests ||
          typeof row.transaction_id !== "string" || !/^\d+$/.test(row.transaction_id)) throw new TrialError();
      const proof = await this.database.query("SELECT pg_xact_status($1::xid8) AS status",[row.transaction_id]);
      if (proof.rows.length !== 1 || proof.rows[0].status !== "committed") throw new TrialError();
      let settled = false;
      return { observed: async (observed, status) => {
        if (settled || !Number.isSafeInteger(observed) || observed < 0 || observed > r.responseLimit ||
            !Number.isInteger(status) || status < 100 || status > 599) throw new TrialError("trial_network_observation_invalid");
        // Consume the local handle before SQL; a lost settlement acknowledgement
        // cannot be retried by the caller, nor alter the charged quota row.
        settled = true;
        try {
          const saved = await this.database.query(`UPDATE public.trial_network_budget SET observed_bytes=$4,http_status=$5
            WHERE binding=$1 AND service=$2 AND slot=$3 AND observed_bytes IS NULL AND http_status IS NULL RETURNING slot`,
          [binding,r.service,row.slot,observed,status]);
          if (saved.rows.length !== 1) throw new TrialError();
        } catch { throw new TrialError("trial_network_observation_unknown"); }
      } };
    } catch { throw new TrialError("trial_network_budget_unavailable"); }
  }
}

const context = new AsyncLocalStorage<TrialNetworkBudget>();
export function withTrialNetworkBudget<T>(budget: TrialNetworkBudget, action: () => Promise<T>) { return context.run(budget,action); }
export function configuredTrialNetworkBudget(p: TrialPolicy): TrialNetworkAllowance {
  const current = context.getStore();
  if (current) {
    if (trialPolicyDigest(current.policy) !== trialPolicyDigest(p)) throw new TrialError("trial_network_binding");
    return current;
  }
  if (process.env.TRIAL_RUNTIME_ROLE !== "web") throw new TrialError("trial_network_budget_required");
  // The existing Web pool supplies durable SQL; no second credential or service.
  return new TrialNetworkBudget(p,{ query: async (text,values) => (await import("../../db")).trialNetworkQuery(text,values) });
}
