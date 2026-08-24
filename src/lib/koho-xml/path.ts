export const KOHO_SECTIONS = [
  "P_A1",
  "P_A5",
  "P_P1",
  "P_P5",
  "P_B1",
] as const;

export type KohoSection = (typeof KOHO_SECTIONS)[number];

export type ZipEntryPathErrorCode =
  | "EMPTY_PATH"
  | "NUL_BYTE"
  | "UNC_PATH"
  | "DRIVE_PATH"
  | "ABSOLUTE_PATH"
  | "TRAILING_SLASH"
  | "EMPTY_SEGMENT"
  | "DOT_SEGMENT"
  | "PARENT_SEGMENT";

export interface ZipEntryPathError {
  code: ZipEntryPathErrorCode;
  message: string;
}

export interface NormalizedZipEntryPath {
  ok: true;
  sourcePath: string;
  normalizedPath: string;
  segments: readonly string[];
}

export interface InvalidZipEntryPath {
  ok: false;
  sourcePath: string;
  error: ZipEntryPathError;
}

export type NormalizeZipEntryPathResult =
  | NormalizedZipEntryPath
  | InvalidZipEntryPath;

export type KohoEntryPathKind = "primary-xml" | "deeper-xml" | "other";

export interface KohoEntryPathInfo extends NormalizedZipEntryPath {
  basename: string;
  section: KohoSection | null;
  bucket100: string | null;
  bucket10: string | null;
  documentNumber: string | null;
  documentRelativeSegments: readonly string[] | null;
  isXml: boolean;
  isPrimaryXml: boolean;
  isDeeperXml: boolean;
  pathKind: KohoEntryPathKind;
}

export type InspectKohoEntryPathResult =
  | KohoEntryPathInfo
  | InvalidZipEntryPath;

export type SchemaLocationErrorCode =
  | "INVALID_ENTRY_PATH"
  | "EMPTY_LOCATION"
  | "NUL_BYTE"
  | "UNC_PATH"
  | "BACKSLASH"
  | "DRIVE_PATH"
  | "ABSOLUTE_PATH"
  | "SCHEME"
  | "TRAILING_SLASH"
  | "EMPTY_SEGMENT"
  | "PACKAGE_ESCAPE";

export interface SchemaLocationError {
  code: SchemaLocationErrorCode;
  message: string;
  entryPathError?: ZipEntryPathError;
}

export interface ResolvedSchemaLocation {
  ok: true;
  entryPath: string;
  normalizedEntryPath: string;
  locationToken: string;
  expectedXsdBasename: string;
  resolvedPath: string;
  resolvedBasename: string;
  isXsdRootFile: boolean;
  matchesExpectedXsdPath: boolean;
}

export interface InvalidSchemaLocation {
  ok: false;
  entryPath: string;
  locationToken: string;
  expectedXsdBasename: string;
  error: SchemaLocationError;
}

export type ResolveSchemaLocationResult =
  | ResolvedSchemaLocation
  | InvalidSchemaLocation;

const KOHO_SECTION_SET: ReadonlySet<string> = new Set(KOHO_SECTIONS);
const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function invalidZipEntryPath(
  sourcePath: string,
  code: ZipEntryPathErrorCode,
  message: string,
): InvalidZipEntryPath {
  return {
    ok: false,
    sourcePath,
    error: { code, message },
  };
}

/**
 * ZIP entry名を比較用の`/`区切りpathへ正規化する。
 * filesystemへ展開するためのpath変換には使用しない。
 */
export function normalizeZipEntryPath(
  sourcePath: string,
): NormalizeZipEntryPathResult {
  if (sourcePath.length === 0) {
    return invalidZipEntryPath(sourcePath, "EMPTY_PATH", "entry path is empty");
  }

  if (sourcePath.includes("\0")) {
    return invalidZipEntryPath(
      sourcePath,
      "NUL_BYTE",
      "entry path contains a NUL byte",
    );
  }

  if (sourcePath.startsWith("\\\\") || sourcePath.startsWith("//")) {
    return invalidZipEntryPath(sourcePath, "UNC_PATH", "UNC path is not allowed");
  }

  if (DRIVE_PATH_PATTERN.test(sourcePath)) {
    return invalidZipEntryPath(
      sourcePath,
      "DRIVE_PATH",
      "drive-qualified path is not allowed",
    );
  }

  if (sourcePath.startsWith("/") || sourcePath.startsWith("\\")) {
    return invalidZipEntryPath(
      sourcePath,
      "ABSOLUTE_PATH",
      "absolute path is not allowed",
    );
  }

  if (sourcePath.endsWith("/") || sourcePath.endsWith("\\")) {
    return invalidZipEntryPath(
      sourcePath,
      "TRAILING_SLASH",
      "directory-style entry with a trailing slash is not allowed",
    );
  }

  const normalizedPath = sourcePath.replace(/\\/g, "/");
  const segments = normalizedPath.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    return invalidZipEntryPath(
      sourcePath,
      "EMPTY_SEGMENT",
      "entry path contains an empty segment",
    );
  }

  if (segments.includes(".")) {
    return invalidZipEntryPath(
      sourcePath,
      "DOT_SEGMENT",
      "entry path contains a dot segment",
    );
  }

  if (segments.includes("..")) {
    return invalidZipEntryPath(
      sourcePath,
      "PARENT_SEGMENT",
      "entry path contains a parent segment",
    );
  }

  return {
    ok: true,
    sourcePath,
    normalizedPath,
    segments,
  };
}

function isKohoSection(value: string | undefined): value is KohoSection {
  return value !== undefined && KOHO_SECTION_SET.has(value);
}

/**
 * 安全なentry pathを公報primary XML、deeper XML、その他へ分類する。
 * bucket名の書式は仕様上未確定なため、非空の安全なsegmentとしてのみ扱う。
 */
export function inspectKohoEntryPath(
  sourcePath: string,
): InspectKohoEntryPathResult {
  const normalized = normalizeZipEntryPath(sourcePath);
  if (!normalized.ok) {
    return normalized;
  }

  const { segments } = normalized;
  const basename = segments[segments.length - 1];
  const section =
    segments[0] === "DOCUMENT" && isKohoSection(segments[1])
      ? segments[1]
      : null;
  const hasDocumentPrefix = section !== null && segments.length >= 5;
  const bucket100 = hasDocumentPrefix ? segments[2] : null;
  const bucket10 = hasDocumentPrefix ? segments[3] : null;
  const documentNumber = hasDocumentPrefix ? segments[4] : null;
  const documentRelativeSegments = hasDocumentPrefix
    ? segments.slice(5)
    : null;
  const isXml = basename.endsWith(".xml");
  const isPrimaryXml =
    hasDocumentPrefix &&
    segments.length === 6 &&
    basename === `${documentNumber}.xml`;
  const isDeeperXml = hasDocumentPrefix && segments.length > 6 && isXml;
  const pathKind: KohoEntryPathKind = isPrimaryXml
    ? "primary-xml"
    : isDeeperXml
      ? "deeper-xml"
      : "other";

  return {
    ...normalized,
    basename,
    section,
    bucket100,
    bucket10,
    documentNumber,
    documentRelativeSegments,
    isXml,
    isPrimaryXml,
    isDeeperXml,
    pathKind,
  };
}

function invalidSchemaLocation(
  entryPath: string,
  locationToken: string,
  expectedXsdBasename: string,
  code: SchemaLocationErrorCode,
  message: string,
  entryPathError?: ZipEntryPathError,
): InvalidSchemaLocation {
  return {
    ok: false,
    entryPath,
    locationToken,
    expectedXsdBasename,
    error: {
      code,
      message,
      ...(entryPathError === undefined ? {} : { entryPathError }),
    },
  };
}

/** `resolvedPath`がZIP root直下の`XSD/<expected basename>`と完全一致するか返す。 */
export function isExpectedXsdPath(
  resolvedPath: string,
  expectedXsdBasename: string,
): boolean {
  if (
    expectedXsdBasename.length === 0 ||
    expectedXsdBasename === "." ||
    expectedXsdBasename === ".." ||
    expectedXsdBasename.includes("/") ||
    expectedXsdBasename.includes("\\") ||
    expectedXsdBasename.includes("\0")
  ) {
    return false;
  }

  return resolvedPath === `XSD/${expectedXsdBasename}`;
}

/**
 * `xsi:schemaLocation`のlocation tokenを、参照元entryのdirectory基準で解決する。
 * location tokenはfetchせず、ZIP内pathとしてだけ扱う。
 */
export function resolveSchemaLocationToken(
  entryPath: string,
  locationToken: string,
  expectedXsdBasename: string,
): ResolveSchemaLocationResult {
  const normalizedEntry = normalizeZipEntryPath(entryPath);
  if (!normalizedEntry.ok) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "INVALID_ENTRY_PATH",
      "schema location base entry path is invalid",
      normalizedEntry.error,
    );
  }

  if (locationToken.length === 0) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "EMPTY_LOCATION",
      "schema location token is empty",
    );
  }

  if (locationToken.includes("\0")) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "NUL_BYTE",
      "schema location token contains a NUL byte",
    );
  }

  if (locationToken.startsWith("\\\\") || locationToken.startsWith("//")) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "UNC_PATH",
      "UNC schema location is not allowed",
    );
  }

  if (locationToken.includes("\\")) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "BACKSLASH",
      "schema location must use forward slashes",
    );
  }

  if (DRIVE_PATH_PATTERN.test(locationToken)) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "DRIVE_PATH",
      "drive-qualified schema location is not allowed",
    );
  }

  if (locationToken.startsWith("/")) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "ABSOLUTE_PATH",
      "absolute schema location is not allowed",
    );
  }

  if (URI_SCHEME_PATTERN.test(locationToken)) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "SCHEME",
      "schema location URI scheme is not allowed",
    );
  }

  if (locationToken.endsWith("/")) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "TRAILING_SLASH",
      "schema location must identify a file",
    );
  }

  const locationSegments = locationToken.split("/");
  if (locationSegments.some((segment) => segment.length === 0)) {
    return invalidSchemaLocation(
      entryPath,
      locationToken,
      expectedXsdBasename,
      "EMPTY_SEGMENT",
      "schema location contains an empty segment",
    );
  }

  const resolvedSegments = normalizedEntry.segments.slice(0, -1);
  for (const segment of locationSegments) {
    if (segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (resolvedSegments.length === 0) {
        return invalidSchemaLocation(
          entryPath,
          locationToken,
          expectedXsdBasename,
          "PACKAGE_ESCAPE",
          "schema location escapes the ZIP package root",
        );
      }
      resolvedSegments.pop();
      continue;
    }

    resolvedSegments.push(segment);
  }

  const resolvedPath = resolvedSegments.join("/");
  const resolvedBasename = resolvedSegments[resolvedSegments.length - 1] ?? "";
  const isXsdRootFile =
    resolvedSegments.length === 2 && resolvedSegments[0] === "XSD";

  return {
    ok: true,
    entryPath,
    normalizedEntryPath: normalizedEntry.normalizedPath,
    locationToken,
    expectedXsdBasename,
    resolvedPath,
    resolvedBasename,
    isXsdRootFile,
    matchesExpectedXsdPath: isExpectedXsdPath(
      resolvedPath,
      expectedXsdBasename,
    ),
  };
}
