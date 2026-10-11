import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { OperatorAccess } from "../src/lib/trial/operator-access";
import { TrialError, type TrialPolicy } from "../src/lib/trial/policy";

const exec = promisify(execFile);
const storage = "https://storage.azure.com/", arm = "https://management.azure.com/";
type OwnerTokenReader=(audience:string)=>Promise<{accessToken:string;tenant:string;expires_on:number}>;
let sessionReader:{head:string;owner:string;tenant:string;read:OwnerTokenReader;revoked:boolean}|undefined;
/** The staged child has no CLI fallback after its parent broker is installed. */
export function installTrialSessionOwnerTokenReader(policy:TrialPolicy,read:OwnerTokenReader){
  if(sessionReader)throw new TrialError("trial_owner_token_reader_already_installed");
  const state={head:policy.codeSha,owner:policy.auth.ownerId,tenant:policy.auth.tenantId,read,revoked:false};
  sessionReader=state;return()=>{state.revoked=true;};
}
export const trialAzureCliPythonSchema = z.string().min(1).max(2048).refine(value =>
  isAbsolute(value) && normalize(value) === value && !/[\x00-\x1f]/.test(value) &&
  (process.platform === "win32" ? basename(value).toLowerCase() === "python.exe" : ["python", "python3"].includes(basename(value))));

/** The private launcher binds this exact Python to its own normal OWNER CLI.
 * No PATH executable, shell, fallback, installation or alternate credential is
 * used. CLI token output lives only in memory and never reaches a receipt. */
export function trialOwnerCredential(policy: TrialPolicy, access: OperatorAccess, python: string, audience: typeof storage | typeof arm = storage) {
  const executable = trialAzureCliPythonSchema.parse(python);
  if (audience !== storage && audience !== arm) throw new TrialError();
  let cached: { token: string; expiresOnTimestamp: number } | undefined;
  return { async getToken() {
    try {
      access.check(30_000);
      if(sessionReader&&(sessionReader.revoked||sessionReader.head!==policy.codeSha||sessionReader.owner!==policy.auth.ownerId||sessionReader.tenant!==policy.auth.tenantId))throw new TrialError();
      if (cached && cached.expiresOnTimestamp > Date.now() + 60_000) return cached;
      let value;
      if(sessionReader){
        if(sessionReader.revoked||sessionReader.head!==policy.codeSha||sessionReader.owner!==policy.auth.ownerId||sessionReader.tenant!==policy.auth.tenantId)throw new TrialError();
        value=await sessionReader.read(audience);
      }else{
        const st = await lstat(executable);
        if (!st.isFile() || st.isSymbolicLink()) throw new TrialError();
        access.check(30_000);
        const result = await exec(executable, ["-I", "-m", "azure.cli", "account", "get-access-token", "--resource", audience,
          "--output", "json", "--only-show-errors"],
        { windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 65536, signal: access.signal });
        value=JSON.parse(result.stdout);
      }
      access.check();
      if(sessionReader&&(sessionReader.revoked||sessionReader.head!==policy.codeSha||sessionReader.owner!==policy.auth.ownerId||sessionReader.tenant!==policy.auth.tenantId))throw new TrialError();
      if (typeof value.accessToken !== "string" || value.accessToken.length > 32768 || value.accessToken.split(".").length !== 3 ||
        value.tenant?.toLowerCase() !== policy.auth.tenantId.toLowerCase()) throw new TrialError();
      const claims = JSON.parse(Buffer.from(value.accessToken.split(".")[1], "base64url").toString("utf8"));
      const until = Math.min(Number(value.expires_on), Number(claims.exp)) * 1000;
      const allowed = audience === storage ? [storage.slice(0, -1)] : [arm.slice(0, -1), "https://management.core.windows.net"];
      if (claims.oid?.toLowerCase() !== policy.auth.ownerId.toLowerCase() || claims.tid?.toLowerCase() !== policy.auth.tenantId.toLowerCase() ||
        typeof claims.aud !== "string" || !allowed.includes(claims.aud.replace(/\/$/, "")) ||
        !Number.isFinite(until) || until <= Date.now() + 60_000 ||
        (claims.nbf !== undefined && (!Number.isFinite(Number(claims.nbf)) || Number(claims.nbf) * 1000 > Date.now()))) throw new TrialError();
      cached = { token: value.accessToken, expiresOnTimestamp: until }; return cached;
    } catch { throw new TrialError("trial_owner_credential_unavailable"); }
  } };
}
