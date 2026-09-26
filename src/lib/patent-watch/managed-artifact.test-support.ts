import { managedArtifactIntentSchema, type ManagedArtifactAdmission, type ManagedArtifactIntent } from "./managed-artifact-contract";
/** Business-boundary fixture. The real ETag ledger is covered by the SDK tests. */
export function artifactAdmissionFixture(location = "https://fictional.blob.core.windows.net/private") {
  const records = new Map<string, ManagedArtifactIntent>();
  const admit: ManagedArtifactAdmission = async (value, destination, deadline) => {
    deadline.throwIfAborted();
    const intent = managedArtifactIntentSchema.parse(value);
    if (destination !== location) throw Error("target_mismatch");
    const id = intent.kind === "delivery" ? intent.deliveryId : intent.kind === "backup" ? intent.backupId : intent.recoveryOperationId;
    if (records.has(id)) throw Error("conflict");
    records.set(id, structuredClone(intent));
  };
  return { admit, records };
}
