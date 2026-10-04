import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DISTRIBUTION_HEADERS } from "../koho-distribution-table";
import { fictionalP6Package } from "./p6-package.test-support";
import { collectUpdateCheck } from "./update-check";

it("reports the P6 component in offline update checking without claiming complete coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fictional-update-p6-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("no network"));
  try {
    const sourcePath = join(directory, "fictional-p6.zip"), tablePath = join(directory, "fictional-jpa.csv"), snapshots = join(directory, "snapshots");
    await mkdir(snapshots);
    await writeFile(sourcePath, fictionalP6Package());
    await writeFile(tablePath, [DISTRIBUTION_HEADERS.JPA.join(","),
      ["20260812", "148", "01115", "000001", "000001", "000007", "000007", "00001", "00001", "可", ""].join(",")].join("\r\n") + "\r\n");
    const result = await collectUpdateCheck({ period: { from: "2026-08-12", to: "2026-08-12" },
      distributionTables: [{ packageType: "JPA", path: tablePath }], packages: [{ packageType: "JPA", path: sourcePath }], receipts: [],
      maxFileBytes: 2_000_000, maxTotalBytes: 2_000_000, output: { path: join(directory, "unused.md"), privateDirectoryConfirmed: true } },
    snapshots, performance.now() + 30_000);
    expect(result.aggregate).toMatchObject({ status: "checked", coverageProven: false, counts: { targetRows: 1, processingErrors: 0 } });
    expect(result.markdown).toContain("訂正&#40;P6&#41;: 主XML候補 1; 確認済み 1");
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
