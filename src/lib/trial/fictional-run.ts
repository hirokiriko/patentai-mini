import { TrialError, type TrialPolicy } from "./policy";
import type { ManagedRunSnapshot, ManagedSetting } from "../patent-watch/managed-types";
import type { PublicationPeriod } from "../patent-watch/managed-period";

/** Legacy signed policies stay compatible. New fictional policies bind the
 * exact case original and only permit approved source versions before AI. */
export function assertTrialFictionalSetting(policy: TrialPolicy, setting: ManagedSetting, period: PublicationPeriod) {
  const fixture = policy.fictionalDistribution;
  if (!fixture) return;
  const record = fixture.records.find(row => row.caseId === setting.caseId);
  if (!record || record.originalXmlSha256 !== setting.source.sha256 ||
      period.from !== fixture.period.from || period.to !== fixture.period.to) throw new TrialError("trial_fixture_unconfirmed");
}
export function assertTrialFictionalRun(policy: TrialPolicy, snapshot: ManagedRunSnapshot) {
  const fixture = policy.fictionalDistribution;
  if (!fixture) return;
  assertTrialFictionalSetting(policy, snapshot.setting, snapshot.period);
  // A second unchanged run legitimately has no new sources.
  if (snapshot.sourceKeys.some(key => !fixture.records.some(row => row.sourceKey === key)) ||
      snapshot.candidates.some(candidate => !fixture.records.some(row => row.sourceKey === candidate.sourceKey &&
        row.publicationDate === candidate.publicationDate && row.kind === candidate.source?.version)))
    throw new TrialError("trial_fixture_unconfirmed");
}
