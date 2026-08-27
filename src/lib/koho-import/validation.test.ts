import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  kohoImportRepo,
  KohoImportRepositoryValidationError,
} from "../../repositories";
import {
  buildMinimalFictionalPackage,
  FICTIONAL_PACKAGE_LIMITS,
} from "../koho-package/__fixtures__/fictional-package";
import { parseKohoPackage, type KohoPackageType } from "../koho-package";
import { buildKohoImportPlan } from "./builder";
import {
  assertKohoImportDocumentPlan,
  assertKohoImportPlan,
  assertKohoImportRunContract,
  createKohoImportDocumentPlan,
  createKohoImportPlanSnapshot,
} from "./persistence-contract";
import {
  KohoImportPlanValidationError,
  type KohoImportDocumentPlan,
  type KohoImportPlan,
  type KohoImportPlanValidationErrorCode,
} from "./types";

const SOURCE_SHA256 = "1".repeat(64);
const ERROR_SENTINEL = "FICTIONAL-REJECTED-VALUE-MUST-NOT-LEAK";

const PLAN_FIELDS = [
  "packageType",
  "sourceSha256",
  "packageStatus",
  "documentCount",
  "amendmentCount",
  "nestedSt26Count",
  "countsJson",
  "issuesJson",
  "documents",
] as const satisfies readonly (keyof KohoImportPlan)[];

const DOCUMENT_FIELDS = [
  "normalizedEntryPath",
  "parseStatus",
  "kind",
  "publicationNumber",
  "applicationNumber",
  "publicationDate",
  "registrationNumber",
  "registrationDate",
  "inventionTitle",
  "abstractText",
  "claimsText",
  "applicantsJson",
  "ipcJson",
  "fiJson",
  "parseIssuesJson",
  "sourceMetadataJson",
  "contentSha256",
] as const satisfies readonly (keyof KohoImportDocumentPlan)[];

type DocumentJsonField =
  | "applicantsJson"
  | "ipcJson"
  | "fiJson"
  | "parseIssuesJson"
  | "sourceMetadataJson";

type JsonField = "countsJson" | "issuesJson" | DocumentJsonField;
type JsonRecord = Record<string, unknown>;

interface JsonContractCase {
  field: JsonField;
  code: KohoImportPlanValidationErrorCode;
}

interface SemanticMutationCase {
  name: string;
  code: KohoImportPlanValidationErrorCode;
  mutate: (plan: KohoImportPlan) => void;
}

let fictionalJpaPlan: KohoImportPlan;
let fictionalJpbPlan: KohoImportPlan;

async function buildFictionalPlan(
  packageType: KohoPackageType,
): Promise<KohoImportPlan> {
  const packageResult = await parseKohoPackage({
    packageType,
    source: {
      type: "buffer",
      bytes: buildMinimalFictionalPackage(packageType),
      sourceName: `fictional-${packageType.toLowerCase()}-package.zip`,
    },
    limits: FICTIONAL_PACKAGE_LIMITS,
  });
  return buildKohoImportPlan({ packageResult, sourceSha256: SOURCE_SHA256 });
}

function clonePlan(plan: KohoImportPlan = fictionalJpaPlan): KohoImportPlan {
  return structuredClone(plan);
}

function withoutContentSha256(
  document: KohoImportDocumentPlan,
): Omit<KohoImportDocumentPlan, "contentSha256"> {
  return {
    normalizedEntryPath: document.normalizedEntryPath,
    parseStatus: document.parseStatus,
    kind: document.kind,
    publicationNumber: document.publicationNumber,
    applicationNumber: document.applicationNumber,
    publicationDate: document.publicationDate,
    registrationNumber: document.registrationNumber,
    registrationDate: document.registrationDate,
    inventionTitle: document.inventionTitle,
    abstractText: document.abstractText,
    claimsText: document.claimsText,
    applicantsJson: document.applicantsJson,
    ipcJson: document.ipcJson,
    fiJson: document.fiJson,
    parseIssuesJson: document.parseIssuesJson,
    sourceMetadataJson: document.sourceMetadataJson,
  };
}

function digestDocument(document: KohoImportDocumentPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(withoutContentSha256(document)), "utf8")
    .digest("hex");
}

function refreshDocumentDigest(plan: KohoImportPlan): void {
  const document = plan.documents[0];
  document.contentSha256 = digestDocument(document);
}

function makeReviewPlan(): KohoImportPlan {
  const plan = clonePlan();
  plan.packageStatus = "review_required";
  plan.issuesJson = JSON.stringify([
    {
      source: "package",
      code: "contents_file_missing",
      status: "review_required",
      kind: null,
      section: "P_A1",
      count: 1,
    },
    {
      source: "xml",
      code: "optional_abstract_missing",
      status: "review_required",
      kind: "A1",
      section: null,
      count: 1,
    },
  ]);
  plan.documents[0].parseStatus = "review_required";
  plan.documents[0].parseIssuesJson = JSON.stringify([
    {
      code: "optional_abstract_missing",
      status: "review_required",
      field: "abstract",
    },
  ]);
  refreshDocumentDigest(plan);
  return plan;
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fictional test mutation expected a JSON object");
  }
  return value as JsonRecord;
}

function asRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("fictional test mutation expected a JSON object array");
  }
  return value as JsonRecord[];
}

function mutateFirstJsonRecord(
  text: string,
  mutate: (record: JsonRecord) => JsonRecord,
): string {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    const records = asRecordArray(parsed);
    if (records.length === 0) {
      throw new Error("fictional test mutation expected a non-empty JSON array");
    }
    records[0] = mutate(records[0]);
    return JSON.stringify(records);
  }
  return JSON.stringify(mutate(asRecord(parsed)));
}

function rewritePlanJson(
  plan: KohoImportPlan,
  field: "countsJson" | "issuesJson",
  mutate: (value: unknown) => void,
): void {
  const parsed = JSON.parse(plan[field]) as unknown;
  mutate(parsed);
  plan[field] = JSON.stringify(parsed);
}

function rewriteDocumentJson(
  plan: KohoImportPlan,
  field: DocumentJsonField,
  mutate: (value: unknown) => void,
): void {
  const document = plan.documents[0];
  const parsed = JSON.parse(document[field]) as unknown;
  mutate(parsed);
  document[field] = JSON.stringify(parsed);
  refreshDocumentDigest(plan);
}

function replaceJsonText(
  plan: KohoImportPlan,
  field: JsonField,
  replace: (text: string) => string,
): void {
  if (field === "countsJson" || field === "issuesJson") {
    plan[field] = replace(plan[field]);
    return;
  }
  const document = plan.documents[0];
  document[field] = replace(document[field]);
  refreshDocumentDigest(plan);
}

function expectValidationError(
  action: () => unknown,
  code: KohoImportPlanValidationErrorCode,
): KohoImportPlanValidationError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KohoImportPlanValidationError);
  expect(caught).toMatchObject({ code });
  return caught as KohoImportPlanValidationError;
}

function makeRunRow(plan: KohoImportPlan) {
  return {
    importId: 7,
    packageType: plan.packageType,
    sourceSha256: plan.sourceSha256,
    packageStatus: plan.packageStatus,
    documentCount: plan.documentCount,
    amendmentCount: plan.amendmentCount,
    nestedSt26Count: plan.nestedSt26Count,
    countsJson: plan.countsJson,
    issuesJson: plan.issuesJson,
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  };
}

function runContractFromRow(row: ReturnType<typeof makeRunRow>) {
  return {
    packageType: row.packageType,
    sourceSha256: row.sourceSha256,
    packageStatus: row.packageStatus,
    documentCount: row.documentCount,
    amendmentCount: row.amendmentCount,
    nestedSt26Count: row.nestedSt26Count,
    countsJson: row.countsJson,
    issuesJson: row.issuesJson,
  };
}

function makeDocumentRow(document: KohoImportDocumentPlan) {
  return {
    documentId: 11,
    importId: 7,
    ...document,
  };
}

function documentPlanFromRow(
  row: ReturnType<typeof makeDocumentRow>,
): KohoImportDocumentPlan {
  return {
    ...withoutContentSha256(row),
    contentSha256: row.contentSha256,
  };
}

beforeAll(async () => {
  [fictionalJpaPlan, fictionalJpbPlan] = await Promise.all([
    buildFictionalPlan("JPA"),
    buildFictionalPlan("JPB"),
  ]);
});

describe("koho import exact runtime shape", () => {
  it("accepts normal builder plans for fictional JPA and JPB packages", () => {
    expect(() => assertKohoImportPlan(clonePlan(fictionalJpaPlan))).not.toThrow();
    expect(() => assertKohoImportPlan(clonePlan(fictionalJpbPlan))).not.toThrow();
    expect(() => assertKohoImportPlan(makeReviewPlan())).not.toThrow();
  });

  it.each(PLAN_FIELDS)("rejects a missing plan field: %s", (field) => {
    const plan = clonePlan() as unknown as JsonRecord;
    delete plan[field];
    expectValidationError(() => assertKohoImportPlan(plan), "invalid_plan_shape");
  });

  it.each(DOCUMENT_FIELDS)("rejects a missing document field: %s", (field) => {
    const plan = clonePlan();
    delete (plan.documents[0] as unknown as JsonRecord)[field];
    expectValidationError(() => assertKohoImportPlan(plan), "invalid_document_shape");
  });

  it("rejects extra, inherited, symbol, accessor, and array-shaped plan values", () => {
    const extra = Object.assign(clonePlan(), { rawCsv: ERROR_SENTINEL });
    expectValidationError(() => assertKohoImportPlan(extra), "invalid_plan_shape");

    const inherited = Object.assign(
      Object.create({ rawXml: ERROR_SENTINEL }) as JsonRecord,
      clonePlan(),
    );
    expectValidationError(() => assertKohoImportPlan(inherited), "invalid_plan_shape");

    const symbol = clonePlan() as KohoImportPlan & Record<symbol, unknown>;
    symbol[Symbol("fictional-extra")] = ERROR_SENTINEL;
    expectValidationError(() => assertKohoImportPlan(symbol), "invalid_plan_shape");

    const accessor = clonePlan();
    Object.defineProperty(accessor, "packageType", {
      configurable: true,
      enumerable: true,
      get: () => "JPA",
    });
    expectValidationError(() => assertKohoImportPlan(accessor), "invalid_plan_shape");

    const array = Object.assign([], clonePlan());
    expectValidationError(() => assertKohoImportPlan(array), "invalid_plan_shape");
  });

  it.each(["rawXml", "description", "references", "rawCsv", "unknownField"])(
    "rejects a document field outside the persistence contract: %s",
    (field) => {
      const plan = clonePlan();
      (plan.documents[0] as unknown as JsonRecord)[field] = ERROR_SENTINEL;
      expectValidationError(() => assertKohoImportPlan(plan), "invalid_document_shape");
    },
  );

  it("rejects inherited and array-shaped document values", () => {
    const inheritedPlan = clonePlan();
    inheritedPlan.documents[0] = Object.assign(
      Object.create({ rawXml: ERROR_SENTINEL }) as JsonRecord,
      inheritedPlan.documents[0],
    ) as unknown as KohoImportDocumentPlan;
    expectValidationError(
      () => assertKohoImportPlan(inheritedPlan),
      "invalid_document_shape",
    );

    const arrayPlan = clonePlan();
    arrayPlan.documents[0] = Object.assign(
      [],
      arrayPlan.documents[0],
    ) as unknown as KohoImportDocumentPlan;
    expectValidationError(
      () => assertKohoImportPlan(arrayPlan),
      "invalid_document_shape",
    );
  });

  it("sanitizes a validation error thrown by an object trap", () => {
    const trapped = new Proxy(clonePlan(), {
      ownKeys() {
        const error = new KohoImportPlanValidationError("invalid_plan_shape");
        error.message = ERROR_SENTINEL;
        throw error;
      },
    });
    const error = expectValidationError(
      () => assertKohoImportPlan(trapped),
      "invalid_plan_shape",
    );
    expect(error.message).not.toContain(ERROR_SENTINEL);
  });
});

describe("koho import scalar persistence constraints", () => {
  it.each([
    {
      name: "unknown package type",
      code: "invalid_package_type",
      mutate: (plan: KohoImportPlan) => {
        (plan as unknown as JsonRecord).packageType = "JPC";
      },
    },
    {
      name: "unknown package status",
      code: "invalid_package_status",
      mutate: (plan: KohoImportPlan) => {
        (plan as unknown as JsonRecord).packageStatus = "unsupported_type";
      },
    },
    {
      name: "uppercase source digest",
      code: "invalid_source_sha256",
      mutate: (plan: KohoImportPlan) => {
        plan.sourceSha256 = "A".repeat(64);
      },
    },
    {
      name: "unknown document parse status",
      code: "invalid_document_status",
      mutate: (plan: KohoImportPlan) => {
        (plan.documents[0] as unknown as JsonRecord).parseStatus = "failed";
      },
    },
    {
      name: "unsupported persisted document kind",
      code: "invalid_document_kind",
      mutate: (plan: KohoImportPlan) => {
        (plan.documents[0] as unknown as JsonRecord).kind = "A5";
      },
    },
    {
      name: "unsafe normalized document path",
      code: "invalid_normalized_entry_path",
      mutate: (plan: KohoImportPlan) => {
        plan.documents[0].normalizedEntryPath = "../FICTIONAL.xml";
      },
    },
    {
      name: "non-nullable scalar object",
      code: "invalid_document_shape",
      mutate: (plan: KohoImportPlan) => {
        (plan.documents[0] as unknown as JsonRecord).registrationNumber = {};
      },
    },
    {
      name: "uppercase content digest",
      code: "invalid_content_sha256",
      mutate: (plan: KohoImportPlan) => {
        plan.documents[0].contentSha256 = "A".repeat(64);
      },
    },
    {
      name: "document array length mismatch",
      code: "invalid_document_count",
      mutate: (plan: KohoImportPlan) => {
        plan.documents = [];
      },
    },
  ] as const)("rejects $name", ({ code, mutate }) => {
    const plan = clonePlan();
    mutate(plan);
    expectValidationError(() => assertKohoImportPlan(plan), code);
  });

  it("rejects duplicate document paths at the persistence boundary", () => {
    const plan = clonePlan();
    plan.documents.push(structuredClone(plan.documents[0]));
    plan.documentCount = 2;
    rewritePlanJson(plan, "countsJson", (value) => {
      asRecord(value).confirmedFullPublications = 2;
    });
    expectValidationError(
      () => assertKohoImportPlan(plan),
      "duplicate_normalized_entry_path",
    );
  });
});

const JSON_CONTRACT_CASES: readonly JsonContractCase[] = [
  { field: "countsJson", code: "invalid_counts_json" },
  { field: "issuesJson", code: "invalid_issues_json" },
  { field: "applicantsJson", code: "invalid_applicants_json" },
  { field: "ipcJson", code: "invalid_ipc_json" },
  { field: "fiJson", code: "invalid_fi_json" },
  { field: "parseIssuesJson", code: "invalid_parse_issues_json" },
  { field: "sourceMetadataJson", code: "invalid_source_metadata_json" },
];

const CANONICAL_MUTATIONS = [
  {
    name: "extra key",
    apply: (text: string) =>
      mutateFirstJsonRecord(text, (record) => ({
        ...record,
        rawXml: ERROR_SENTINEL,
      })),
  },
  {
    name: "missing key",
    apply: (text: string) =>
      mutateFirstJsonRecord(text, (record) =>
        Object.fromEntries(Object.entries(record).slice(1)),
      ),
  },
  {
    name: "wrong field type",
    apply: (text: string) =>
      mutateFirstJsonRecord(text, (record) => {
        const entries = Object.entries(record);
        entries[0] = [entries[0][0], []];
        return Object.fromEntries(entries);
      }),
  },
  {
    name: "reordered keys",
    apply: (text: string) =>
      mutateFirstJsonRecord(text, (record) =>
        Object.fromEntries(Object.entries(record).reverse()),
      ),
  },
  { name: "trailing whitespace", apply: (text: string) => `${text} ` },
] as const;

describe("koho import canonical JSON text", () => {
  it.each(
    JSON_CONTRACT_CASES.flatMap((contractCase) =>
      CANONICAL_MUTATIONS.map((mutation) => ({ ...contractCase, mutation })),
    ),
  )("rejects $mutation.name in $field", ({ field, code, mutation }) => {
    const plan = makeReviewPlan();
    replaceJsonText(plan, field, mutation.apply);
    expectValidationError(() => assertKohoImportPlan(plan), code);
  });

  it("rejects nested counts, role, section, and applicant-name shape drift", () => {
    const nestedCounts = makeReviewPlan();
    rewritePlanJson(nestedCounts, "countsJson", (value) => {
      const counts = asRecord(value);
      const bySection = asRecord(counts.bySection);
      asRecord(bySection.P_A1).rawCsv = ERROR_SENTINEL;
    });
    expectValidationError(
      () => assertKohoImportPlan(nestedCounts),
      "invalid_counts_json",
    );

    const unknownRole = makeReviewPlan();
    rewritePlanJson(unknownRole, "countsJson", (value) => {
      asRecord(asRecord(value).roleCounts).unknown = 0;
    });
    expectValidationError(
      () => assertKohoImportPlan(unknownRole),
      "invalid_counts_json",
    );

    const unknownSection = makeReviewPlan();
    rewritePlanJson(unknownSection, "countsJson", (value) => {
      asRecord(asRecord(value).bySection).P_UNKNOWN = asRecord(
        asRecord(asRecord(value).bySection).P_A1,
      );
    });
    expectValidationError(
      () => assertKohoImportPlan(unknownSection),
      "invalid_counts_json",
    );

    const applicantName = makeReviewPlan();
    rewriteDocumentJson(applicantName, "applicantsJson", (value) => {
      const applicants = asRecordArray(value);
      const names = asRecordArray(applicants[0].names);
      names[0].reference = ERROR_SENTINEL;
    });
    expectValidationError(
      () => assertKohoImportPlan(applicantName),
      "invalid_applicants_json",
    );
  });
});

const SEMANTIC_MUTATIONS: readonly SemanticMutationCase[] = [
  {
    name: "negative counts value",
    code: "invalid_counts_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "countsJson", (value) => {
        asRecord(value).primaryXmlCandidates = -1;
      }),
  },
  {
    name: "fractional nested counts value",
    code: "invalid_counts_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "countsJson", (value) => {
        const section = asRecord(asRecord(asRecord(value).bySection).P_A1);
        section.finalXmlResults = 0.5;
      }),
  },
  {
    name: "unsafe role count",
    code: "invalid_counts_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "countsJson", (value) => {
        asRecord(asRecord(value).roleCounts).xml = Number.MAX_SAFE_INTEGER + 1;
      }),
  },
  {
    name: "counts document total mismatch",
    code: "invalid_counts_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "countsJson", (value) => {
        asRecord(value).confirmedFullPublications = 0;
      }),
  },
  {
    name: "counts amendment total mismatch",
    code: "invalid_counts_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "countsJson", (value) => {
        asRecord(value).confirmedAmendments = 1;
      }),
  },
  {
    name: "counts nested ST.26 total mismatch",
    code: "invalid_counts_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "countsJson", (value) => {
        asRecord(value).nestedXmlCandidates = 1;
      }),
  },
  {
    name: "unknown issue source",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[0].source = "other";
      }),
  },
  {
    name: "unknown issue status",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[0].status = "success";
      }),
  },
  {
    name: "unknown issue kind",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[1].kind = "Z9";
      }),
  },
  {
    name: "unknown issue section",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[0].section = "P_UNKNOWN";
      }),
  },
  {
    name: "non-positive issue aggregate count",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[0].count = 0;
      }),
  },
  {
    name: "package issue with a kind",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[0].kind = "A1";
      }),
  },
  {
    name: "XML issue with a section",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value)[1].section = "P_A1";
      }),
  },
  {
    name: "issue aggregate order violation",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        asRecordArray(value).reverse();
      }),
  },
  {
    name: "duplicate issue aggregate",
    code: "invalid_issues_json",
    mutate: (plan) =>
      rewritePlanJson(plan, "issuesJson", (value) => {
        const issues = asRecordArray(value);
        issues.splice(1, 0, { ...issues[0] });
      }),
  },
  {
    name: "unsafe applicant ordinal",
    code: "invalid_applicants_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "applicantsJson", (value) => {
        asRecordArray(value)[0].ordinal = Number.MAX_SAFE_INTEGER + 1;
      }),
  },
  {
    name: "non-boolean original-language indicator",
    code: "invalid_applicants_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "applicantsJson", (value) => {
        const names = asRecordArray(asRecordArray(value)[0].names);
        names[0].originalLanguageIndicator = "true";
      }),
  },
  {
    name: "unknown IPC role",
    code: "invalid_ipc_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "ipcJson", (value) => {
        asRecordArray(value)[0].role = "unknown";
      }),
  },
  {
    name: "fractional FI ordinal",
    code: "invalid_fi_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "fiJson", (value) => {
        asRecordArray(value)[0].ordinal = 0.5;
      }),
  },
  {
    name: "unknown parse issue code",
    code: "invalid_parse_issues_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "parseIssuesJson", (value) => {
        asRecordArray(value)[0].code = "fictional_unknown_issue";
      }),
  },
  {
    name: "unknown parse issue status",
    code: "invalid_parse_issues_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "parseIssuesJson", (value) => {
        asRecordArray(value)[0].status = "success";
      }),
  },
  {
    name: "parse issue raw message",
    code: "invalid_parse_issues_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "parseIssuesJson", (value) => {
        asRecordArray(value)[0].message = ERROR_SENTINEL;
      }),
  },
  {
    name: "unknown XSD validation state",
    code: "invalid_source_metadata_json",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "sourceMetadataJson", (value) => {
        asRecord(value).xsdValidation = "performed";
      }),
  },
  {
    name: "source metadata path mismatch",
    code: "inconsistent_source_metadata",
    mutate: (plan) =>
      rewriteDocumentJson(plan, "sourceMetadataJson", (value) => {
        asRecord(value).normalizedEntryPath =
          "DOCUMENT/P_A1/999900/999990/2099000001/DIFFERENT.xml";
      }),
  },
];

describe("koho import JSON semantic constraints", () => {
  it.each(SEMANTIC_MUTATIONS)("rejects $name", ({ code, mutate }) => {
    const plan = makeReviewPlan();
    mutate(plan);
    expectValidationError(() => assertKohoImportPlan(plan), code);
  });
});

describe("koho import canonical document digest", () => {
  it("creates the unchanged builder document from the shared payload helper", () => {
    for (const plan of [fictionalJpaPlan, fictionalJpbPlan]) {
      const document = clonePlan(plan).documents[0];
      expect(createKohoImportDocumentPlan(withoutContentSha256(document))).toEqual(
        document,
      );
    }
  });

  it("rejects a changed persistence field when the digest is retained", () => {
    const plan = clonePlan();
    plan.documents[0].inventionTitle = ERROR_SENTINEL;
    expectValidationError(
      () => assertKohoImportPlan(plan),
      "content_sha256_mismatch",
    );
  });

  it("rejects a changed but well-formed digest", () => {
    const plan = clonePlan();
    plan.documents[0].contentSha256 = "f".repeat(64);
    expectValidationError(
      () => assertKohoImportPlan(plan),
      "content_sha256_mismatch",
    );
  });

  it("does not expose a rejected value or payload in the digest error", () => {
    const plan = clonePlan();
    plan.documents[0].publicationNumber = ERROR_SENTINEL;
    const error = expectValidationError(
      () => assertKohoImportPlan(plan),
      "content_sha256_mismatch",
    );
    expect(error.message).not.toContain(ERROR_SENTINEL);
    expect(error.message).not.toContain(plan.documents[0].normalizedEntryPath);
    expect(error.message).not.toContain(plan.documents[0].applicantsJson);
  });

  it("maps a stale digest to the typed repository error before DB access", async () => {
    const plan = clonePlan();
    plan.documents[0].claimsText = ERROR_SENTINEL;

    let caught: unknown;
    try {
      await kohoImportRepo.savePlan(plan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KohoImportRepositoryValidationError);
    expect(caught).toMatchObject({ code: "content_sha256_mismatch" });
    expect((caught as Error).message).not.toContain("DATABASE_URL");
    expect((caught as Error).message).not.toContain(ERROR_SENTINEL);
  });

  it("returns a deep snapshot that cannot be changed after validation", () => {
    const plan = clonePlan();
    const snapshot = createKohoImportPlanSnapshot(plan);

    plan.packageStatus = "failed";
    plan.documents[0].claimsText = ERROR_SENTINEL;
    plan.documents[0].contentSha256 = "f".repeat(64);

    expect(snapshot.packageStatus).toBe("success");
    expect(snapshot.documents[0].claimsText).not.toBe(ERROR_SENTINEL);
    expect(() => assertKohoImportPlan(snapshot)).not.toThrow();
  });
});

describe("koho import DB row-equivalent contract inputs", () => {
  it("accepts fictional run and projected document rows", () => {
    const plan = makeReviewPlan();
    const runRow = makeRunRow(plan);
    const documentRow = makeDocumentRow(plan.documents[0]);

    expect(() => assertKohoImportRunContract(runContractFromRow(runRow))).not.toThrow();
    expect(() =>
      assertKohoImportDocumentPlan(documentPlanFromRow(documentRow)),
    ).not.toThrow();
  });

  it("rejects a noncanonical run row and a stale document-row digest", () => {
    const plan = makeReviewPlan();
    const runRow = makeRunRow(plan);
    runRow.countsJson = `${runRow.countsJson} `;
    expectValidationError(
      () => assertKohoImportRunContract(runContractFromRow(runRow)),
      "invalid_counts_json",
    );

    const documentRow = makeDocumentRow(plan.documents[0]);
    documentRow.claimsText = ERROR_SENTINEL;
    expectValidationError(
      () => assertKohoImportDocumentPlan(documentPlanFromRow(documentRow)),
      "content_sha256_mismatch",
    );
  });

  it("rejects a document that does not match its parent run package type", () => {
    const jpaDocument = clonePlan(fictionalJpaPlan).documents[0];
    const jpbDocument = clonePlan(fictionalJpbPlan).documents[0];

    expectValidationError(
      () => assertKohoImportDocumentPlan(jpaDocument, "JPB"),
      "invalid_normalized_entry_path",
    );
    expectValidationError(
      () => assertKohoImportDocumentPlan(jpbDocument, "JPA"),
      "invalid_normalized_entry_path",
    );
  });
});
