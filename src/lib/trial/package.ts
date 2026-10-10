import { parseKohoPackage } from "../koho-package";
import { buildKohoManualImportLimits } from "../koho-import/manual-api";
import { buildKohoImportPlan } from "../koho-import/builder";
import { projectManagedPackage } from "../koho-import/managed-package";
import { TrialError } from "./policy";
import { trialHash } from "./ledger";

export const TRIAL_PACKAGE_BYTES=32*1024**2;
/** Only small, complete official packages. Never truncate documents into a receipt. */
export async function prepareTrialPackage(bytes:Buffer,sha256:string){
  if(!bytes.length||bytes.length>TRIAL_PACKAGE_BYTES||trialHash(bytes)!==sha256)throw new TrialError("trial_input_limit");
  const limits=buildKohoManualImportLimits(TRIAL_PACKAGE_BYTES);
  limits.zip={...limits.zip,maxEntries:5000,maxTotalUncompressedBytes:32*1024**2,maxEntryUncompressedBytes:16*1024**2,maxTotalReadUncompressedBytes:32*1024**2};
  limits.xml={...limits.xml,maxXmlBytes:1024**2,maxTextBytes:1024**2};
  limits.csv={...limits.csv,maxInputBytes:4*1024**2,maxRecords:5000,maxTotalCharacters:4*1024**2};
  const parsed=await parseKohoPackage({packageType:"JPA",source:{type:"buffer",bytes},limits});
  const plan=buildKohoImportPlan({packageResult:parsed,sourceSha256:sha256}),managed=projectManagedPackage(parsed,plan);
  const payload=JSON.stringify({plan,sources:managed.sources,receipt:managed.receipt}),payloadBytes=Buffer.byteLength(payload);
  if(payloadBytes>16*1024**2)throw new TrialError("trial_input_limit");
  return{plan,managed,payloadBytes,id:trialHash(`package:${sha256}`),intent:trialHash(payload)};
}
