import { parseAbstractRecords } from "./parse-abstract";
import { parseContents1Records } from "./parse-contents1";
import { parseContents2Records } from "./parse-contents2";
import { parseDocumentListRecords } from "./parse-document-list";
import { parseCsvRecords } from "./csv-records";
import { decodeKohoCsv } from "./decode";
import { rollupFileStatus } from "./issues";
import { checkCsvByteLimit, validateLimits } from "./limits";
import { inspectKohoCsvPath } from "./path";
import type {
  KohoCsvEncodingMetadata,
  KohoCsvIssue,
  KohoCsvLogicalFile,
  KohoCsvParseInput,
  KohoCsvParseResult,
} from "./types";

function uninspectedEncoding(input: KohoCsvParseInput): KohoCsvEncodingMetadata {
  return {
    name: "utf-8",
    fatalDecode: true,
    bom: "not_inspected",
    byteLength: input.bytes.byteLength,
  };
}

function unclassifiedResult(
  input: KohoCsvParseInput,
  status: "failed" | "unsupported_type",
  normalizedEntryPath: string | null,
  issues: KohoCsvIssue[],
): KohoCsvParseResult {
  return {
    status,
    logicalFile: null,
    sourceEntryPath: input.entryPath,
    normalizedEntryPath,
    packageType: input.packageType,
    encoding: uninspectedEncoding(input),
    lineEndings: null,
    recordCount: 0,
    issues,
    records: [],
  };
}

function classifiedFailureResult(
  input: KohoCsvParseInput,
  logicalFile: KohoCsvLogicalFile,
  normalizedEntryPath: string,
  issues: KohoCsvIssue[],
  metadata?: {
    encoding: KohoCsvParseResult["encoding"];
    lineEndings: KohoCsvParseResult["lineEndings"];
  },
): KohoCsvParseResult {
  const base = {
    status: "failed" as const,
    sourceEntryPath: input.entryPath,
    normalizedEntryPath,
    packageType: input.packageType,
    encoding: metadata?.encoding ?? uninspectedEncoding(input),
    lineEndings: metadata?.lineEndings ?? null,
    recordCount: 0,
    issues,
  };
  switch (logicalFile) {
    case "ABSTRACT":
      return { ...base, logicalFile, records: [] };
    case "DOCUMENT_LIST":
      return { ...base, logicalFile, records: [] };
    case "CONTENTS1":
      return { ...base, logicalFile, records: [] };
    case "CONTENTS2":
      return { ...base, logicalFile, records: [] };
  }
}

export function parseKohoCsv(input: KohoCsvParseInput): KohoCsvParseResult {
  const limitIssues = validateLimits(input.limits);
  if (limitIssues.length > 0) {
    return unclassifiedResult(input, "failed", null, limitIssues);
  }

  const path = inspectKohoCsvPath(input.packageType, input.entryPath);
  if (path.status === "unsupported_type") {
    return unclassifiedResult(
      input,
      "unsupported_type",
      path.normalizedEntryPath,
      path.issues,
    );
  }
  if (path.status === "failed") {
    if (path.logicalFile === null || path.normalizedEntryPath === null) {
      return unclassifiedResult(input, "failed", null, path.issues);
    }
    return classifiedFailureResult(
      input,
      path.logicalFile,
      path.normalizedEntryPath,
      path.issues,
    );
  }

  const byteLimitIssues = checkCsvByteLimit(input.bytes, input.limits);
  if (byteLimitIssues.length > 0) {
    return classifiedFailureResult(
      input,
      path.logicalFile,
      path.normalizedEntryPath,
      byteLimitIssues,
    );
  }

  const decoded = decodeKohoCsv(input.bytes);
  if (!decoded.ok) {
    return classifiedFailureResult(
      input,
      path.logicalFile,
      path.normalizedEntryPath,
      decoded.issues,
      { encoding: decoded.encoding, lineEndings: null },
    );
  }

  const parsed = parseCsvRecords(decoded.text, input.limits);
  if (!parsed.ok) {
    return classifiedFailureResult(
      input,
      path.logicalFile,
      path.normalizedEntryPath,
      [...decoded.issues, ...parsed.issues],
      {
        encoding: decoded.encoding,
        lineEndings: decoded.lineEndings,
      },
    );
  }

  const common = {
    sourceEntryPath: input.entryPath,
    normalizedEntryPath: path.normalizedEntryPath,
    packageType: input.packageType,
    encoding: decoded.encoding,
    lineEndings: decoded.lineEndings,
  };

  switch (path.logicalFile) {
    case "ABSTRACT": {
      const file = parseAbstractRecords({
        packageType: input.packageType,
        records: parsed.records,
      });
      const issues = [...decoded.issues, ...file.issues];
      return {
        ...common,
        status: rollupFileStatus(issues, file.records),
        logicalFile: path.logicalFile,
        recordCount: file.records.length,
        issues,
        records: file.records,
      };
    }
    case "DOCUMENT_LIST": {
      const file = parseDocumentListRecords({
        packageType: input.packageType,
        records: parsed.records,
      });
      const issues = [...decoded.issues, ...file.issues];
      return {
        ...common,
        status: rollupFileStatus(issues, file.records),
        logicalFile: path.logicalFile,
        recordCount: file.records.length,
        issues,
        records: file.records,
      };
    }
    case "CONTENTS1": {
      const file = parseContents1Records({
        packageType: input.packageType,
        records: parsed.records,
        limits: input.limits,
      });
      const issues = [...decoded.issues, ...file.issues];
      return {
        ...common,
        status: rollupFileStatus(issues, file.records),
        logicalFile: path.logicalFile,
        recordCount: file.records.length,
        issues,
        records: file.records,
      };
    }
    case "CONTENTS2": {
      const file = parseContents2Records({
        packageType: input.packageType,
        records: parsed.records,
        limits: input.limits,
      });
      const issues = [...decoded.issues, ...file.issues];
      return {
        ...common,
        status: rollupFileStatus(issues, file.records),
        logicalFile: path.logicalFile,
        recordCount: file.records.length,
        issues,
        records: file.records,
      };
    }
  }
}
