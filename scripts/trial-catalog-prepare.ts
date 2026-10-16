import {createPrivateKey,sign} from "node:crypto";
import {z} from "zod";
import {readTrialPolicy,trialPolicyBytes,TrialError} from "../src/lib/trial/policy";
import {catalogPlanSchema} from "../src/lib/trial/catalog-schema";
import {loadCatalogBuiltins} from "../src/lib/trial/catalog-builtins";
import {catalogDigest,CATALOG_QUERY_SET_SHA256,CATALOG_QUERY_BYTES,CATALOG_ROW_LIMIT,CATALOG_SNAPSHOT_BYTES} from "../src/lib/trial/catalog-queries";
import {operatorPolicyBinding,operatorTicketDigest} from "../src/lib/trial/operator-access";
import {trialSessionInput} from "./trial-session";
import {validateCatalogCommands} from "./trial-catalog-session";

const preparationSchema=z.object({payload:trialSessionInput,
  excludedDatabases:catalogPlanSchema.shape.excludedDatabases,
  // Passed only by the verified OWNER attempt producer. This pure function
  // cannot create approval, fetch credentials, persist a file or open a DB.
  authoritySha256:z.string().regex(/^[a-f0-9]{64}$/),
  temporaryOwnerSet:z.boolean(),
}).strict();

export function prepareTrialCatalogPayload(value:unknown){
  const input=preparationSchema.parse(value),payload=input.payload;
  const policy=readTrialPolicy(payload.environment),db=policy.database;
  if(!policy.localOperator||payload.access.policyDigest!==operatorPolicyBinding(policy)||
    policy.localOperator.ticketDigest!==operatorTicketDigest(payload.access))throw new TrialError("trial_catalog_prepare_binding");
  // Retire exactly the old four optional status requests. No business command
  // can be removed to make the connection count fit the twenty-attempt cap.
  if(payload.requests.length===14){
    for(const [i,c]of payload.bootstrap.manifest.cases.entries()){
      const tail=z.object({command:z.literal("status"),caseId:z.literal(c.id)}).strict();
      tail.parse(payload.requests[10+i]);
    }
    payload.requests=payload.requests.slice(0,10);
  }
  validateCatalogCommands(payload);
  const catalogPlan=catalogPlanSchema.parse({schema:1,server:db.host,adminUser:payload.bootstrap.manifest.adminUser,
    targetDatabase:db.database,roles:{owner:db.ownerRole,migrator:db.migratorUser,web:db.webUser,worker:db.workerUser},
    excludedDatabases:input.excludedDatabases,maximumAuditConnections:6,builtinManifestSha256:catalogDigest(loadCatalogBuiltins()),
    querySetSha256:CATALOG_QUERY_SET_SHA256,limits:{rowsPerQuery:CATALOG_ROW_LIMIT,bytesPerQuery:CATALOG_QUERY_BYTES,bytesPerSnapshot:CATALOG_SNAPSHOT_BYTES},
    ...(input.temporaryOwnerSet?{bootstrapOwnerSet:{schema:1,kind:"temporary-owner-set-v1",authoritySha256:input.authoritySha256}}:{})});
  policy.localOperator={...policy.localOperator,catalogPlanDigest:catalogDigest(catalogPlan)};
  const environment={...payload.environment,TRIAL_POLICY_JSON:JSON.stringify(policy),
    TRIAL_POLICY_SIGNATURE:sign(null,trialPolicyBytes(policy),createPrivateKey(payload.signingPrivateKey)).toString("base64")};
  readTrialPolicy(environment);
  return {...payload,environment,catalogPlan};
}
