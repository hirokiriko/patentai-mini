import { isAbsolute } from "node:path";

export const MANUAL_MAX_BYTES = 8 * 1024 ** 3;
export const MANUAL_DEADLINE_MS = 120 * 60_000;
export const MANUAL_INPUT_BYTES = 262_144;
export type ManualTarget = { host: "127.0.0.1" | "::1"; port: number; database: string; user: string };
export type ManualConnection = ManualTarget & { password: string };
export interface ManualConfiguration {
  mode: "preview" | "apply";
  files: { packageType: "JPA" | "JPB"; path: string }[];
  maxFileBytes: number;
  maxTotalBytes: number;
  allowReviewRequired: boolean;
  connection?: ManualConnection;
  expectedTarget?: ManualTarget;
}

export class ManualImportError extends Error {
  constructor() { super("manual_import_stopped"); }
}
export function requireManual(value: unknown): asserts value {
  if (!value) throw new ManualImportError();
}
function record(value: unknown): Record<string, unknown> {
  requireManual(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  requireManual(required.every(k => Object.hasOwn(value, k)) &&
    Object.keys(value).every(k => required.includes(k) || optional.includes(k)));
}
function text(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}
export function requireLocalPath(value: unknown): asserts value is string {
  requireManual(text(value, 32768) && isAbsolute(value) && !/^[\\/]{2}/.test(value));
}
function bytes(value: unknown) {
  requireManual(Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MANUAL_MAX_BYTES);
}
export function parseManualConfiguration(value: unknown): ManualConfiguration {
  const x = record(value);
  keys(x, ["files", "maxFileBytes", "maxTotalBytes"], ["mode", "allowReviewRequired", "connection", "expectedTarget"]);
  requireManual(x.mode === undefined || x.mode === "preview" || x.mode === "apply");
  requireManual(x.allowReviewRequired === undefined || typeof x.allowReviewRequired === "boolean");
  bytes(x.maxFileBytes); bytes(x.maxTotalBytes);
  requireManual(Array.isArray(x.files) && x.files.length >= 1 && x.files.length <= 64);
  const files = x.files.map(value => {
    const f = record(value); keys(f, ["packageType", "path"]);
    requireManual(f.packageType === "JPA" || f.packageType === "JPB");
    requireLocalPath(f.path);
    return { packageType: f.packageType as "JPA" | "JPB", path: f.path };
  });
  const mode = x.mode ?? "preview";
  const config: ManualConfiguration = { mode, files, maxFileBytes: x.maxFileBytes as number,
    maxTotalBytes: x.maxTotalBytes as number, allowReviewRequired: x.allowReviewRequired === true };
  if (mode === "preview") {
    // A preview never needs to load a driver or examine any database setting.
    requireManual(x.connection === undefined && x.expectedTarget === undefined);
  } else {
    const c = record(x.connection), t = record(x.expectedTarget);
    const fields = ["host", "port", "database", "user"];
    keys(c, [...fields, "password"]); keys(t, fields);
    requireManual(fields.every(k => c[k] === t[k]));
    requireManual((c.host === "127.0.0.1" || c.host === "::1") &&
      Number.isInteger(c.port) && (c.port as number) > 0 && (c.port as number) <= 65535 &&
      text(c.database, 63) && /^koho_manual_import_test_[a-zA-Z0-9]+$/.test(c.database) &&
      text(c.user, 63) && text(c.password, 8192));
    config.connection = c as ManualConnection; config.expectedTarget = t as ManualTarget;
  }
  return config;
}
