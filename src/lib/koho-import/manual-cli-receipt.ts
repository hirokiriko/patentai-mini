import { randomUUID } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { requireManual, type ManualConfiguration } from "./manual-cli-config";
import { inspectManualDirectory } from "./manual-cli-source";
import { projectManualResult, type ManualFileResult } from "./manual-cli-summary";

export type ManualBinding = { ordinal: number; packageType: "JPA" | "JPB"; byteLength: number; sha256: string };
export type ManualCleanup = "complete" | "required";
export const MANUAL_RECEIPT_BYTES = 1024 * 1024;
export const MANUAL_RECEIPT_RECORD_BYTES = 16 * 1024;

/** Parent-only writer. A footer describes structure; stdout also reports sync/close acknowledgement. */
export class ManualReceipt {
  private handle?: FileHandle;
  private sequence = 0;
  private bytes = 0;
  private finishedFiles = 0;
  private verified = new Set<number>();
  private failed = false;
  private busy = false;
  private closed = false;
  private readonly operationId = randomUUID();

  constructor(private readonly config: ManualConfiguration, private readonly deadline: number,
    private readonly signal?: AbortSignal) {}

  invalidate() { this.failed = true; }
  private guard() {
    requireManual(!this.failed && !this.closed && performance.now() < this.deadline && !this.signal?.aborted);
  }
  private async perform(operation: () => Promise<void>) {
    let timer: NodeJS.Timeout | undefined;
    let rejectAbort: ((reason: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => { this.invalidate(); rejectAbort?.(new Error("manual_receipt_stopped")); };
    try {
      this.guard(); requireManual(!this.busy); this.busy = true;
      this.signal?.addEventListener("abort", abort, { once: true });
      await Promise.race([operation(), aborted, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { this.invalidate(); reject(new Error("manual_receipt_stopped")); },
          Math.max(1, this.deadline - performance.now()));
      })]);
      this.guard();
    } catch { this.invalidate(); throw new Error("manual_receipt_stopped"); }
    finally { clearTimeout(timer); this.signal?.removeEventListener("abort", abort); this.busy = false; }
  }
  private async write(type: string, fields: Record<string, unknown>) {
    this.guard(); requireManual(this.handle);
    const buffer = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: this.operationId,
      sequence: this.sequence + 1, type, observedAt: new Date().toISOString(), ...fields }) + "\n");
    requireManual(buffer.length <= MANUAL_RECEIPT_RECORD_BYTES && this.bytes + buffer.length <= MANUAL_RECEIPT_BYTES);
    let offset = 0;
    while (offset < buffer.length) {
      this.guard();
      const written = await this.handle.write(buffer, offset, buffer.length - offset, null);
      requireManual(written.bytesWritten > 0 && written.bytesWritten <= buffer.length - offset);
      offset += written.bytesWritten;
    }
    this.guard(); await this.handle.sync(); this.guard();
    this.sequence++; this.bytes += buffer.length;
  }
  async start() {
    await this.perform(async () => {
      requireManual(this.config.receipt);
      const path = this.config.receipt.path, parent = dirname(path);
      await inspectManualDirectory(parent); this.guard();
      if (process.platform !== "win32") {
        const stat = await lstat(parent);
        requireManual(typeof process.getuid === "function" && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
      }
      this.guard();
      const handle = await open(path, "wx", 0o600);
      // If open finishes after the caller timed out, retain the empty file and close only our handle.
      if (this.failed || performance.now() >= this.deadline || this.signal?.aborted) {
        await handle.close(); throw new Error("manual_receipt_stopped");
      }
      this.handle = handle;
      const stat = await handle.stat();
      requireManual(stat.isFile() && stat.nlink === 1);
      if (process.platform !== "win32") requireManual(stat.uid === process.getuid!() && (stat.mode & 0o077) === 0);
      await this.write("batch_started", { mode: this.config.mode, fileCount: this.config.files.length,
        files: this.config.files.map((file, index) => ({ ordinal: index + 1, packageType: file.packageType })) });
    });
  }
  async verify(binding: ManualBinding) {
    await this.perform(async () => {
      const ordinal = this.finishedFiles + 1;
      requireManual(binding.ordinal === ordinal && !this.verified.has(ordinal) &&
        binding.packageType === this.config.files[ordinal - 1]?.packageType &&
        Number.isSafeInteger(binding.byteLength) && binding.byteLength > 0 && binding.byteLength <= this.config.maxFileBytes &&
        typeof binding.sha256 === "string" && /^[a-f0-9]{64}$/.test(binding.sha256));
      await this.write("input_verified", { ordinal, packageType: binding.packageType,
        byteLength: binding.byteLength, sha256: binding.sha256 });
      this.verified.add(ordinal);
    });
  }
  async finishFile(value: ManualFileResult, cleanup: ManualCleanup) {
    await this.perform(async () => {
      const ordinal = this.finishedFiles + 1;
      const result = projectManualResult(value, ordinal, this.config.files[ordinal - 1]?.packageType);
      requireManual(cleanup === "complete" || cleanup === "required");
      const { summary, ...fields } = result;
      // Only project a summary when its input passed both final rehashes in this operation.
      const projected = summary && this.verified.has(ordinal) ? {
        ...summary, publicationDates: { scope: summary.publicationDates.scope,
          min: summary.publicationDates.min, max: summary.publicationDates.max },
      } : undefined;
      await this.write("file_finished", { ...fields, cleanup, ...(projected ? { summary: projected } : {}) });
      this.finishedFiles++;
    });
  }
  async finishBatch(status: string, cleanup: ManualCleanup, savedRecordCount: number) {
    await this.perform(async () => {
      requireManual(this.finishedFiles === this.config.files.length &&
        ["complete", "stopped", "reconciliation_required"].includes(status) &&
        (cleanup === "complete" || cleanup === "required") && Number.isSafeInteger(savedRecordCount) && savedRecordCount >= 0);
      await this.write("batch_finished", { status, cleanup, savedRecordCount });
    });
    await this.close();
    requireManual(!this.failed && !this.signal?.aborted);
  }
  async close() {
    let timer: NodeJS.Timeout | undefined;
    try {
      if (this.handle && !this.closed) {
        this.closed = true;
        await Promise.race([this.handle.close(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("manual_receipt_stopped")), 5_000);
        })]);
      }
    } catch { this.invalidate(); throw new Error("manual_receipt_stopped"); }
    finally { clearTimeout(timer); }
  }
}
