import { z } from "zod";
import { cloudTargetSchema } from "../koho-import/cloud-config";
import { managedExecutionApprovalSchema } from "./managed-budget-contract";
import { managedHash, managedId } from "./managed-types";
import { managedDate, validateManagedPeriod } from "./managed-period";

const date = z.string().refine(value => { try { managedDate(value); return true; } catch { return false; } });
const period = z.object({ from: date, to: date }).strict().refine(value => {
  try { validateManagedPeriod(value); return true; } catch { return false; }
});
export const managedArtifactIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delivery"), caseId: managedId, deliveryId: z.uuidv4(), period,
    distributionTableSha256: managedHash, reason: z.enum(["initial", "late_publication", "correction", "review_update"]),
    deliveredOn: date.nullable() }).strict(),
  z.object({ kind: z.literal("backup"), caseId: managedId, backupId: z.uuidv4() }).strict(),
  z.object({ kind: z.literal("recovery"), caseId: managedId, backupId: z.uuidv4(), recoveryOperationId: z.uuidv4(),
    sha256: managedHash, bytes: z.number().int().positive().max(256 * 1024 ** 2) }).strict(),
]);
export type ManagedArtifactIntent = z.infer<typeof managedArtifactIntentSchema>;
export const managedArtifactContextSchema = z.object({ approval: managedExecutionApprovalSchema,
  target: cloudTargetSchema, codeSha: z.string().regex(/^[a-f0-9]{40}$/),
  containerUrl: z.string().max(256) }).strict();
export type ManagedArtifactContext = z.infer<typeof managedArtifactContextSchema>;
export type ManagedArtifactAdmission = (intent: ManagedArtifactIntent, containerUrl: string, deadline: AbortSignal) => Promise<void>;
