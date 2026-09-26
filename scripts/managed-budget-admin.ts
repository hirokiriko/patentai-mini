import { z } from "zod";
import { managedBudgetEvidencePins, type ManagedBudgetEvidencePins } from "../src/lib/patent-watch/managed-budget-evidence";
import { managedBudgetForecast, ManagedBudgetError } from "../src/lib/patent-watch/managed-service-budget";
import { ManagedServiceBudgetStorage } from "../src/lib/patent-watch/managed-service-budget-storage";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const input = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z.object({ command: z.enum(["review-apply", "review-reconcile", "settlement-apply", "settlement-reconcile"]), evidenceDigest: digest }).strict(),
]);
type Store = Pick<ManagedServiceBudgetStorage, "snapshot" | "applyReviewedAdministration" | "settleReviewed">;

/** Separate Local administrator, never a business HTTP route or worker command.
 * Input only selects an already reviewed/signed immutable artifact. The private
 * signing key and raw accounting/provider records never enter this process. */
export async function operateManagedBudgetAdministration(value: unknown, store: Store, pins: ManagedBudgetEvidencePins) {
  try {
    const request = input.parse(value);
    if (request.command === "status") {
      const s = await store.snapshot(), month = new Date(Date.parse(s.lastTrustedAt) + 9 * 60 * 60_000).toISOString().slice(0, 7);
      return { status: "observed", recordedAt: s.lastTrustedAt, recordedMonth: month,
        forecastYen: s.plans.some(p => p.month === month) ? managedBudgetForecast(s, month) : null,
        operationCount: s.operations.length, unknownCount: s.operations.filter(o => o.unknown || o.actualYen === null).length,
        reviewRequiredCount: s.operations.filter(o => o.reviewRequired).length,
        administrationCount: s.administration.length, profileActive: s.activeProfileDigest !== null };
    }
    if (request.command === "review-apply" || request.command === "review-reconcile")
      return await store.applyReviewedAdministration(request.evidenceDigest, pins, request.command === "review-reconcile");
    return await store.settleReviewed(request.evidenceDigest, pins, request.command === "settlement-reconcile");
  } catch { throw new ManagedBudgetError(); }
}

async function readInput() {
  const timer = setTimeout(() => process.stdin.destroy(new ManagedBudgetError()), 30_000);
  try {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length; if (bytes > 2048) throw new ManagedBudgetError(); chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { clearTimeout(timer); }
}
if (require.main === module) {
  const watchdog = setTimeout(() => { process.stdout.write('{"status":"reconciliation_required"}\n'); process.exit(2); }, 8 * 60_000);
  void (async () => {
    try {
      if (process.argv.length !== 2) throw new ManagedBudgetError();
      const result = await operateManagedBudgetAdministration(await readInput(), ManagedServiceBudgetStorage.configured(), managedBudgetEvidencePins());
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch { process.stdout.write('{"status":"reconciliation_required"}\n'); process.exitCode = 2; }
    finally { clearTimeout(watchdog); }
  })();
}
