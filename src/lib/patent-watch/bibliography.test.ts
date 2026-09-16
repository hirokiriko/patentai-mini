import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLICANTS_JSON_BYTES, projectApplicants, projectFindingBibliography, readFindingBibliography } from "./bibliography";
import { applicantJson, bibliographyFixture } from "./bibliography-fixtures.test-support";
import { PERIOD_READ_TIMEOUT_MS } from "./period";

afterEach(() => vi.useRealTimers());
describe("finding bibliography projection", () => {
  it.each(["A1", "P1", "B1", "B2"] as const)("preserves %s publication, application and all fictional applicant names", kind => {
    const view = projectFindingBibliography(bibliographyFixture(kind));
    expect(view.bibliography).toMatchObject({ kind, publicationDate: "20990311", applicationNumber: { state: "available", value: "2098000001" },
      applicants: { state: "available", value: [["完全架空の出願人株式会社"], ["架空 太郎"]] } });
    expect(view.bibliography?.registrationDate).toEqual(kind.startsWith("B") ? { state: "available", value: "20990301" } : { state: "missing" });
    expect(JSON.stringify(view)).not.toMatch(/sourceKey|contentSha256|documentId|importId|entry|sourceValue|ordinal|sequenceNumber/);
  });
  it.each([null, {}, { kind: "B1" }, { publicationNumber: "2099000002" }, { contentSha256: "b".repeat(64) }, { parseStatus: "failed" }, { publicationDate: "2099-02-29" }, { packageType: "JPB" }])("withholds mismatching/missing/invalid source %j", patch => {
    const fixture = bibliographyFixture();
    expect(projectFindingBibliography({ ...fixture, document: patch === null ? null : patch && Object.keys(patch).length ? { ...fixture.document, ...patch } : {} }).bibliography).toBeNull();
  });
  it("distinguishes missing, invalid and review-required fields", () => {
    const fixture = bibliographyFixture();
    const view = projectFindingBibliography({ ...fixture, document: { ...fixture.document, parseStatus: "review_required", applicationNumber: null, registrationDate: "2099-04-31", applicantsJson: "broken" } });
    expect(view.bibliography).toMatchObject({ reviewRequired: true, applicationNumber: { state: "missing" }, registrationDate: { state: "unavailable" }, applicants: { state: "unavailable" } });
    expect(projectApplicants("[]")).toEqual({ state: "missing" });
    expect(projectApplicants(null)).toEqual({ state: "unavailable" });
  });
  it.each(["password=FICTIONAL_PRIVATE_SENTINEL", "a".repeat(64), "Bearer FICTIONAL_PRIVATE_SENTINEL", "C:/fictional/private/file", "", "a".repeat(501), "bad\u0000name"])("withholds an incomplete or redacted name without truncation", name => {
    expect(projectApplicants(applicantJson([name]))).toEqual({ state: "unavailable" });
  });
  it("preserves multiple language names in source order without extra metadata", () => {
    const parsed = JSON.parse(applicantJson(["完全架空"]));
    parsed[0].names.push({ value: "FICTIONAL NAME", sourceValue: "FICTIONAL RAW ONLY", originalLanguageIndicator: true });
    expect(projectApplicants(JSON.stringify(parsed))).toEqual({ state: "available", value: [["完全架空", "FICTIONAL NAME"]] });
  });
  it.each(["{}", "null", '[{"name":"fictional"}]', JSON.stringify([{ ordinal: 0, sequenceNumber: null, names: [] }]), JSON.stringify([{ ordinal: 0, sequenceNumber: null, names: [{ value: 1, sourceValue: "fictional", originalLanguageIndicator: null }] }])])("rejects malformed applicant contract %s", text => {
    expect(projectApplicants(text)).toEqual({ state: "unavailable" });
  });
  it("enforces character, applicant-count and UTF-8 byte boundaries", () => {
    expect(projectApplicants(applicantJson(["架".repeat(500)])).state).toBe("available");
    expect(projectApplicants(applicantJson(Array(100).fill("完全架空"))).state).toBe("available");
    expect(projectApplicants(applicantJson(Array(101).fill("完全架空"))).state).toBe("unavailable");
    const text = applicantJson(["完全架空"]), padded = text + " ".repeat(APPLICANTS_JSON_BYTES - Buffer.byteLength(text));
    expect(projectApplicants(padded).state).toBe("available");
    expect(projectApplicants(padded + " ").state).toBe("unavailable");
    expect(projectApplicants(padded + "架").state).toBe("unavailable");
  });
  it("rejects metadata shape extensions and sanitizes every public string", () => {
    const applicants = JSON.parse(applicantJson()); applicants[0].address = "FICTIONAL_PRIVATE_SENTINEL";
    expect(projectApplicants(JSON.stringify(applicants)).state).toBe("unavailable");
    const fixture = bibliographyFixture();
    const view = projectFindingBibliography({ ...fixture, document: { ...fixture.document, inventionTitle: "password=FICTIONAL_PRIVATE_SENTINEL", applicationNumber: "<script>1</script>", registrationNumber: "not-number" } });
    expect(view.bibliography).toMatchObject({ inventionTitle: { state: "unavailable" }, applicationNumber: { state: "unavailable" }, registrationNumber: { state: "unavailable" } });
    expect(JSON.stringify(view)).not.toContain("FICTIONAL_PRIVATE_SENTINEL");
  });
});
describe("bounded bibliography loader", () => {
  it("does not query invalid IDs and gives the same not-found result for absent/cross-case findings", async () => {
    const repository = { readFindingBibliography: vi.fn(async () => null) };
    for (const id of [0, -1, 2_147_483_648, 1.2, NaN]) expect(await readFindingBibliography(repository, 7, id)).toEqual({ kind: "not_found" });
    expect(repository.readFindingBibliography).not.toHaveBeenCalled();
    expect(await readFindingBibliography(repository, 7, 11)).toEqual({ kind: "not_found" });
    expect(repository.readFindingBibliography).toHaveBeenCalledWith(7, 11);
  });
  it("contains DB errors and connection timeouts without raw error disclosure", async () => {
    expect(await readFindingBibliography({ readFindingBibliography: async () => { throw Error("FICTIONAL_PRIVATE_SENTINEL"); } }, 7, 11)).toEqual({ kind: "unavailable" });
    vi.useFakeTimers();
    const pending = readFindingBibliography({ readFindingBibliography: () => new Promise(() => {}) }, 7, 11);
    await vi.advanceTimersByTimeAsync(PERIOD_READ_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "unavailable" });
  });
});
