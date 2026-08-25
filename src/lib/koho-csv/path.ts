import { createIssue } from "./issues";
import type {
  KohoCsvIssue,
  KohoCsvLogicalFile,
  KohoCsvPackageType,
} from "./types";

const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const LOGICAL_FILE_BY_BASENAME: Readonly<Record<string, KohoCsvLogicalFile>> = {
  "ABSTRACT.csv": "ABSTRACT",
  "DOCUMENT_LIST.csv": "DOCUMENT_LIST",
  "CONTENTS1.csv": "CONTENTS1",
  "CONTENTS2.csv": "CONTENTS2",
};

export interface SupportedKohoCsvPath {
  status: "success";
  sourceEntryPath: string;
  normalizedEntryPath: string;
  logicalFile: KohoCsvLogicalFile;
  issues: [];
}

export interface FailedKohoCsvPath {
  status: "failed";
  sourceEntryPath: string;
  normalizedEntryPath: string | null;
  logicalFile: KohoCsvLogicalFile | null;
  issues: [KohoCsvIssue];
}

export interface UnsupportedKohoCsvPath {
  status: "unsupported_type";
  sourceEntryPath: string;
  normalizedEntryPath: string;
  logicalFile: null;
  issues: [KohoCsvIssue];
}

export type InspectKohoCsvPathResult =
  | SupportedKohoCsvPath
  | FailedKohoCsvPath
  | UnsupportedKohoCsvPath;

interface NormalizedPath {
  normalizedEntryPath: string;
  segments: string[];
}

export function inspectKohoCsvPath(
  packageType: KohoCsvPackageType,
  sourceEntryPath: string,
): InspectKohoCsvPathResult {
  const normalized = normalizeEntryPath(sourceEntryPath);
  if (normalized === null) {
    return {
      status: "failed",
      sourceEntryPath,
      normalizedEntryPath: null,
      logicalFile: null,
      issues: [createIssue("unsafe_entry_path")],
    };
  }

  const { normalizedEntryPath, segments } = normalized;
  const basename = segments[segments.length - 1];
  const logicalFile = Object.hasOwn(LOGICAL_FILE_BY_BASENAME, basename)
    ? LOGICAL_FILE_BY_BASENAME[basename]
    : undefined;
  if (logicalFile === undefined) {
    return unsupported(
      sourceEntryPath,
      normalizedEntryPath,
      "unsupported_logical_file",
    );
  }

  if (logicalFile === "ABSTRACT" || logicalFile === "DOCUMENT_LIST") {
    if (segments.length === 1) {
      return supported(
        sourceEntryPath,
        normalizedEntryPath,
        logicalFile,
      );
    }
    return unsupported(
      sourceEntryPath,
      normalizedEntryPath,
      "unsupported_entry_placement",
    );
  }

  if (segments.length !== 3 || segments[0] !== "DOCUMENT") {
    return unsupported(
      sourceEntryPath,
      normalizedEntryPath,
      "unsupported_entry_placement",
    );
  }

  const section = segments[1];
  if (
    (packageType === "JPA" && section === "P_B1") ||
    (packageType === "JPB" && (section === "P_A1" || section === "P_P1"))
  ) {
    return {
      status: "failed",
      sourceEntryPath,
      normalizedEntryPath,
      logicalFile,
      issues: [createIssue("package_section_mismatch")],
    };
  }

  const isSupportedSection =
    packageType === "JPA"
      ? section === "P_A1" || section === "P_P1"
      : section === "P_B1";
  if (!isSupportedSection) {
    return unsupported(
      sourceEntryPath,
      normalizedEntryPath,
      "unsupported_entry_placement",
    );
  }

  return supported(sourceEntryPath, normalizedEntryPath, logicalFile);
}

function normalizeEntryPath(sourceEntryPath: string): NormalizedPath | null {
  if (sourceEntryPath.length === 0 || sourceEntryPath.includes("\0")) {
    return null;
  }
  if (
    sourceEntryPath.startsWith("\\\\") ||
    sourceEntryPath.startsWith("//") ||
    DRIVE_PATH_PATTERN.test(sourceEntryPath) ||
    sourceEntryPath.startsWith("/") ||
    sourceEntryPath.startsWith("\\") ||
    sourceEntryPath.endsWith("/") ||
    sourceEntryPath.endsWith("\\")
  ) {
    return null;
  }

  const normalizedEntryPath = sourceEntryPath.replace(/\\/g, "/");
  const segments = normalizedEntryPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return { normalizedEntryPath, segments };
}

function supported(
  sourceEntryPath: string,
  normalizedEntryPath: string,
  logicalFile: KohoCsvLogicalFile,
): SupportedKohoCsvPath {
  return {
    status: "success",
    sourceEntryPath,
    normalizedEntryPath,
    logicalFile,
    issues: [],
  };
}

function unsupported(
  sourceEntryPath: string,
  normalizedEntryPath: string,
  code: "unsupported_logical_file" | "unsupported_entry_placement",
): UnsupportedKohoCsvPath {
  return {
    status: "unsupported_type",
    sourceEntryPath,
    normalizedEntryPath,
    logicalFile: null,
    issues: [createIssue(code)],
  };
}
