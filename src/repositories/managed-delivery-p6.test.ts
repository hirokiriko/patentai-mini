import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISTRIBUTION_HEADERS } from "../lib/koho-distribution-table";
import { managedDigest } from "../lib/patent-watch/managed-claims";
import { MANAGED_DISTRIBUTION_URL } from "../lib/patent-watch/managed-distribution";
import { managedDeliveryCsv, validateManagedDelivery } from "../lib/patent-watch/managed-delivery";
import { managedPackageReceiptSchema } from "../lib/koho-import/managed-package-receipt";
import { ManagedDeliveryRepository } from "./managed-delivery";

const state = vi.hoisted(() => ({ setting: {} as unknown, run: {} as unknown }));
vi.mock("./managed-watch", () => ({
  ManagedWatchRepository: class { async setting() { return state.setting; } },
  readManagedStoredRun: () => state.run,
}));
afterEach(() => vi.restoreAllMocks());

/** Exercises the real receipt, distribution, delivery and CSV contracts over in-memory query results. */
async function prepare(originalDate: string | null, translatedDaily = 1) {
  const period = { from: "2026-07-26", to: "2026-08-25" };
  const baseDigest = "b".repeat(64), sourceSha256 = "a".repeat(64);
  const identity = { kind: "P6" as const, publicationNumber: "2099000007", applicationNumber: "FICTIONAL-APPLICATION-P6",
    detectedPublicationDate: "2026-08-12", originalPublicationNumber: "2099000007", originalPublicationDate: originalDate,
    contentDigest: "c".repeat(64), claimsEffect: "unresolved" as const, changes: [] };
  const receipt = managedPackageReceiptSchema.parse({ schema: 1, sourceSha256, publicationDate: "2026-08-12", issueNumber: "2026-148", cumulativeIssue: "01115",
    publishedCount: 0, translatedCount: 0, publishedAmendments: 0, translatedAmendments: 0, amendmentCount: 0, documentCount: 0,
    corrections: [{ eventKey: managedDigest(identity), ...identity }], translatedCorrections: 1 });
  const storedReceipt = { importId: 1, publicationDate: receipt.publicationDate, issueNumber: receipt.issueNumber, sourceSha256,
    receiptJson: JSON.stringify(receipt), receiptDigest: managedDigest(receipt) };
  const csvText = [DISTRIBUTION_HEADERS.JPA.join(","),
    ["20260724", "136", "01103", "", "", "", "", "00000", "00000", "可", ""].join(","),
    ["20260812", "148", "01115", "", "", "000007", "000007", "00000", String(translatedDaily).padStart(5, "0"), "可", ""].join(","),
    ["20260826", "158", "01125", "", "", "", "", "00000", "00000", "可", ""].join(",")].join("\r\n") + "\r\n";
  const distribution = { sourceUrl: MANAGED_DISTRIBUTION_URL, csvText,
    sha256: createHash("sha256").update(csvText).digest("hex"), acquiredAt: "2026-09-22T00:00:00.000Z" };
  state.setting = { settingId: 1, caseId: 7, baseDigest, contractSignedOn: "2026-07-24", monitoringStartsOn: period.from,
    contractEndsOn: null, base: { publicationNumber: "JP-FICTIONAL-BASE", version: "A1" }, selectedClaimNos: [1] };
  state.run = { runId: "FICTIONAL-RUN", caseId: 7, settingId: 1, status: "completed", snapshot: {
    setting: { baseDigest }, period, sourceKeys: [], candidates: [] } };
  const rows = [{ runId: "FICTIONAL-RUN", acceptedAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T00:00:01.000Z" }];
  const reads: unknown[][] = [[], [distribution], [], [{ bytes: "0" }], rows,
    [{ run: { importId: 1, packageType: "JPA", packageStatus: "success", sourceSha256, documentCount: 0, amendmentCount: 0 }, receipt: storedReceipt }],
    [{ bytes: String(Buffer.byteLength(storedReceipt.receiptJson)) }], [storedReceipt],
    ...(originalDate === null ? [[]] : []), [], []];
  const inserted: unknown[] = [];
  const tx = {
    execute: async () => undefined,
    select: () => {
      const result = reads.shift(); if (!result) throw Error("unexpected fictional query");
      const query = { from: () => query, where: () => query, orderBy: () => query, limit: () => query,
        innerJoin: () => query, leftJoin: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
      return query;
    },
    insert: () => ({ values: async (value: unknown) => { inserted.push(value); } }),
  };
  const database = { transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) };
  const report = await new ManagedDeliveryRepository(database as unknown as ConstructorParameters<typeof ManagedDeliveryRepository>[0])
    .prepare(7, period, { distributionTableSha256: distribution.sha256 }, "initial");
  expect(reads).toHaveLength(0);
  expect(inserted).toHaveLength(1);
  return report;
}

describe("P6 delivery coverage", () => {
  it.each([null, "2026-08-11"])("keeps an unresolved P6 event incomplete for original date %s", async originalDate => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("no network"));
    const report = await prepare(originalDate);
    expect(report.coverage).toMatchObject({ expectedPackages: 1, availablePackages: 1, importedDocuments: 0,
      completedRuns: 1, observedCorrections: 1, unresolvedCorrections: 1, complete: false });
    expect(() => validateManagedDelivery({ ...report, coverage: { ...report.coverage, complete: true } })).toThrow("incomplete");
    const csv: string[][] = parse(managedDeliveryCsv(report), { bom: true });
    expect(csv.length).toBeGreaterThan(1);
    expect(csv.every(row => row.length === 44)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
  it("retains an out-of-period P6 event without claiming that its text was resolved", async () => {
    const report = await prepare("2026-07-25");
    expect(report.coverage).toMatchObject({ observedCorrections: 1, unresolvedCorrections: 0, complete: true });
  });
  it("rejects a distribution total that omits the P6 correction", async () => {
    await expect(prepare(null, 0)).rejects.toThrow("incomplete");
  });
});
