import { KohoZipError } from "./errors";
import type { KohoZipEntryRole, KohoZipPathCandidate } from "./types";

const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const PRIMARY_SECTIONS = new Set(["P_A1", "P_A5", "P_P1", "P_P5", "P_B1"]);
const SCHEMA_EXTENSIONS = new Set([".xsd", ".dtd", ".xsl", ".xslt", ".js"]);
const IMAGE_EXTENSIONS = new Set([
  ".tif",
  ".tiff",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".pdf",
]);

export interface InspectedEntryPath {
  normalizedPath: string;
  isDirectory: boolean;
  role: KohoZipEntryRole;
  pathCandidate: KohoZipPathCandidate;
}

/**
 * Unicode-path extra fields can replace yauzl's decoded filename. Validate the
 * original filename bytes as well so an unsafe raw path cannot be masked by a
 * safe replacement. ZIP path control bytes are ASCII in both UTF-8 and CP437.
 */
export function assertSafeRawEntryPath(rawPath: Uint8Array): void {
  if (rawPath.byteLength === 0 || rawPath.includes(0)) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const isSeparator = (byte: number): boolean => byte === 0x2f || byte === 0x5c;
  if (
    isSeparator(rawPath[0]) ||
    (rawPath.byteLength >= 2 &&
      isAsciiLetter(rawPath[0]) &&
      rawPath[1] === 0x3a)
  ) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const isDirectory = isSeparator(rawPath[rawPath.byteLength - 1]);
  const comparisonEnd = isDirectory
    ? rawPath.byteLength - 1
    : rawPath.byteLength;
  if (comparisonEnd === 0) {
    throw new KohoZipError("unsafe_entry_path");
  }

  let segmentStart = 0;
  for (let cursor = 0; cursor <= comparisonEnd; cursor += 1) {
    if (cursor !== comparisonEnd && !isSeparator(rawPath[cursor])) continue;
    const segmentLength = cursor - segmentStart;
    const isDot = segmentLength === 1 && rawPath[segmentStart] === 0x2e;
    const isDotDot =
      segmentLength === 2 &&
      rawPath[segmentStart] === 0x2e &&
      rawPath[segmentStart + 1] === 0x2e;
    if (segmentLength === 0 || isDot || isDotDot) {
      throw new KohoZipError("unsafe_entry_path");
    }
    segmentStart = cursor + 1;
  }
}

export function inspectEntryPath(decodedPath: string): InspectedEntryPath {
  if (decodedPath.length === 0 || decodedPath.includes("\0")) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const slashPath = decodedPath.replace(/\\/g, "/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    DRIVE_PATH_PATTERN.test(slashPath)
  ) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const isDirectory = slashPath.endsWith("/");
  const comparisonPath = isDirectory ? slashPath.slice(0, -1) : slashPath;
  if (comparisonPath.length === 0) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const segments = comparisonPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const basename = segments[segments.length - 1];
  if (!isDirectory && basename.length === 0) {
    throw new KohoZipError("unsafe_entry_path");
  }

  const role = classifyRole(basename, isDirectory);
  const pathCandidate = classifyPathCandidate(segments, basename, role);
  return {
    normalizedPath: segments.join("/"),
    isDirectory,
    role,
    pathCandidate,
  };
}

function classifyRole(basename: string, isDirectory: boolean): KohoZipEntryRole {
  if (isDirectory) {
    return "directory";
  }

  const dotIndex = basename.lastIndexOf(".");
  const extension = dotIndex < 0 ? "" : basename.slice(dotIndex).toLowerCase();
  if (extension === ".xml") return "xml";
  if (extension === ".csv") return "csv";
  if (SCHEMA_EXTENSIONS.has(extension)) return "schema";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "other";
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function classifyPathCandidate(
  segments: readonly string[],
  basename: string,
  role: KohoZipEntryRole,
): KohoZipPathCandidate {
  if (
    role !== "xml" ||
    segments[0] !== "DOCUMENT" ||
    !PRIMARY_SECTIONS.has(segments[1] ?? "") ||
    segments.length < 6
  ) {
    return "none";
  }

  const documentNumber = segments[4];
  if (segments.length === 6 && basename === `${documentNumber}.xml`) {
    return "primary_xml";
  }
  return segments.length > 6 ? "nested_xml" : "none";
}
