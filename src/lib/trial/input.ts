import { z } from "zod";
import { readTrialPolicy, TrialError, type TrialPolicy } from "./policy";

export const trialCaseInput = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export function trialSample(caseId: number, policy: TrialPolicy = readTrialPolicy()) {
  const sample = policy.samples.find(s => s.caseId === caseId);
  if (!sample) throw new TrialError("trial_sample_not_ready");
  return sample;
}
export function assertTrialPeriod(caseId: number, from: string, to: string): void {
  const sample = trialSample(caseId);
  if (from !== sample.from || to !== sample.through) throw new TrialError("trial_period_fixed");
}
