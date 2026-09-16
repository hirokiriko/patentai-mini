import { z } from "zod";
import { serializeKohoImportApplicantsJson } from "../koho-import/persistence-contract";
import { createPatentWatchSourceKey, isValidPatentWatchDate, sanitizePatentWatchPublicText } from "./domain";
import { PERIOD_READ_TIMEOUT_MS, periodCaseId } from "./period";

export const APPLICANTS_JSON_BYTES = 64 * 1024;
export const BIBLIOGRAPHY_PARTIAL = "一部または全部を表示できません。原文確認が必要です";
export type BibliographyField<T> = { state: "available"; value: T } | { state: "missing" | "unavailable" };
const id = z.number().int().positive().max(2_147_483_647);
const kind = z.enum(["A1", "P1", "B1", "B2"]);
const storedDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform(value => value.replaceAll("-", "")).refine(isValidPatentWatchDate);
const findingSchema = z.object({ findingId: id, firstRunId: id, publicationNumber: z.string().min(1).max(100),
  kind, packageType: z.enum(["JPA", "JPB"]), sourceKey: z.string().regex(/^[0-9a-f]{64}$/) });
const documentSchema = z.object({ documentId: id, publicationNumber: z.string().min(1).max(100), kind,
  packageType: z.enum(["JPA", "JPB"]), contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  parseStatus: z.enum(["success", "review_required"]), publicationDate: storedDate,
  inventionTitle: z.unknown(), applicationNumber: z.unknown(), registrationNumber: z.unknown(), registrationDate: z.unknown(), applicantsJson: z.unknown() });

export type FindingBibliography = {
  findingId: number; firstRunId: number;
  bibliography: null | {
    publicationNumber: string; kind: z.infer<typeof kind>; publicationDate: string; reviewRequired: boolean;
    inventionTitle: BibliographyField<string>; applicationNumber: BibliographyField<string>;
    registrationNumber: BibliographyField<string>; registrationDate: BibliographyField<string>;
    applicants: BibliographyField<string[][]>;
  };
};
export type BibliographyRepository = {
  readFindingBibliography(caseId: number, findingId: number): Promise<FindingBibliography | null>;
};
export type BibliographyResult = { kind: "ready"; finding: FindingBibliography } | { kind: "not_found" | "unavailable" };

function exactText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value) && sanitizePatentWatchPublicText(value) === value;
}
function textField(value: unknown, max = 500): BibliographyField<string> {
  if (value === null) return { state: "missing" };
  return exactText(value, max) ? { state: "available", value } : { state: "unavailable" };
}
function numberField(value: unknown): BibliographyField<string> {
  const field = textField(value, 100);
  // Stored application numbers are source strings (including era/office prefixes), never integers.
  if (field.state === "available" && (!/[0-9]/.test(field.value) || /[<>"'&]/.test(field.value))) return { state: "unavailable" };
  return field;
}
export function projectApplicants(text: unknown): BibliographyField<string[][]> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > APPLICANTS_JSON_BYTES) return { state: "unavailable" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length > 100) return { state: "unavailable" };
    // Reuse the exact persisted shape, including nested names and nullable metadata.
    serializeKohoImportApplicantsJson(parsed);
    if (!parsed.length) return { state: "missing" };
    const names: string[][] = [];
    for (const applicant of parsed) {
      if (!applicant.names.length || applicant.names.length > 100) return { state: "unavailable" };
      const values: string[] = [];
      for (const name of applicant.names) {
        if (!exactText(name.value, 500)) return { state: "unavailable" };
        values.push(name.value);
      }
      names.push(values);
    }
    return { state: "available", value: names };
  } catch { return { state: "unavailable" }; }
}

/** Server-only projection: the returned DTO contains no internal identity or raw JSON. */
export function projectFindingBibliography(input: { finding: unknown; document: unknown }): FindingBibliography {
  const finding = findingSchema.parse(input.finding);
  const result: FindingBibliography = { findingId: finding.findingId, firstRunId: finding.firstRunId, bibliography: null };
  const parsed = documentSchema.safeParse(input.document);
  if (!parsed.success) return result;
  const document = parsed.data;
  const registrationDate = storedDate.safeParse(document.registrationDate);
  if (document.publicationNumber !== finding.publicationNumber || document.kind !== finding.kind ||
      document.packageType !== finding.packageType ||
      ((document.kind === "A1" || document.kind === "P1") ? document.packageType !== "JPA" : document.packageType !== "JPB") ||
      createPatentWatchSourceKey(document.publicationNumber, document.contentSha256) !== finding.sourceKey ||
      numberField(document.publicationNumber).state !== "available") return result;
  return { ...result, bibliography: {
    publicationNumber: document.publicationNumber, kind: document.kind, publicationDate: document.publicationDate,
    reviewRequired: document.parseStatus === "review_required", inventionTitle: textField(document.inventionTitle),
    applicationNumber: numberField(document.applicationNumber), registrationNumber: numberField(document.registrationNumber),
    registrationDate: document.registrationDate === null ? { state: "missing" } : registrationDate.success
      ? { state: "available", value: registrationDate.data } : { state: "unavailable" },
    applicants: projectApplicants(document.applicantsJson),
  } };
}

export async function readFindingBibliography(repository: BibliographyRepository, caseId: number, findingId: number): Promise<BibliographyResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (periodCaseId(String(caseId)) === null || periodCaseId(String(findingId)) === null) return { kind: "not_found" };
    const finding = await Promise.race([
      repository.readFindingBibliography(caseId, findingId),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bibliography timeout")), PERIOD_READ_TIMEOUT_MS); }),
    ]);
    return finding ? { kind: "ready", finding } : { kind: "not_found" };
  } catch { return { kind: "unavailable" }; }
  finally { clearTimeout(timer); }
}
