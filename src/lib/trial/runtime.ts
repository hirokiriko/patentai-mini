import { readFile } from "node:fs/promises";
import { TrialError,type TrialPolicy } from "./policy";
export async function verifyTrialBuild(p:TrialPolicy) {
  if((await readFile(".managed-build-sha","utf8")).trim()!==p.codeSha||!p.image)throw new TrialError("trial_build_mismatch");
}
