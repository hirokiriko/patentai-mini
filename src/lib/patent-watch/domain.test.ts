import { describe, expect, it } from "vitest";

import {
  PatentWatchDomainError,
  boundedPatentWatchPublicText,
  canonicalSourceIdentityJson,
  comparePatentWatchCursors,
  comparePatentWatchTimestamps,
  createPatentWatchSourceKey,
  parsePatentWatchCursor,
  sanitizePatentWatchAnalysis,
  sanitizePatentWatchPublicText,
  serializePatentWatchAnalysis,
  validatePatentWatchReviewInput,
  validatePatentWatchRunRequestBody,
  validatePatentWatchSettingInput,
} from "./domain";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected PatentWatchDomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(PatentWatchDomainError);
    expect((error as PatentWatchDomainError).code).toBe(code);
  }
}

describe("patent watch setting validation", () => {
  it("accepts only the exact setting body and a real Gregorian date", () => {
    expect(
      validatePatentWatchSettingInput({
        enabled: true,
        monitoringFromDate: "20960229",
      }),
    ).toEqual({ enabled: true, monitoringFromDate: "20960229" });
  });

  it.each([
    ["non-object", null],
    ["missing enabled", { monitoringFromDate: "20960101" }],
    ["missing date", { enabled: true }],
    ["extra key", { enabled: true, monitoringFromDate: "20960101", extra: 1 }],
    ["wrong enabled type", { enabled: "true", monitoringFromDate: "20960101" }],
    ["wrong date type", { enabled: true, monitoringFromDate: 20960101 }],
    ["separator", { enabled: true, monitoringFromDate: "2096-01-01" }],
    ["non-leap day", { enabled: true, monitoringFromDate: "20950229" }],
    ["invalid month", { enabled: true, monitoringFromDate: "20961301" }],
    ["invalid day", { enabled: true, monitoringFromDate: "20960431" }],
    ["year zero", { enabled: true, monitoringFromDate: "00000101" }],
  ])("rejects %s", (_name, body) => {
    expectCode(
      () => validatePatentWatchSettingInput(body),
      "invalid_watch_setting",
    );
  });

  it("accepts century leap years only when divisible by 400", () => {
    expect(
      validatePatentWatchSettingInput({
        enabled: false,
        monitoringFromDate: "20000229",
      }),
    ).toEqual({ enabled: false, monitoringFromDate: "20000229" });
    expectCode(
      () =>
        validatePatentWatchSettingInput({
          enabled: false,
          monitoringFromDate: "21000229",
        }),
      "invalid_watch_setting",
    );
  });
});

describe("patent watch cursor validation", () => {
  it("accepts all-null and all-non-null cursor fields", () => {
    expect(parsePatentWatchCursor(null, null)).toBeNull();
    expect(parsePatentWatchCursor("2096-03-01T00:00:00.000Z", 41)).toEqual({
      runUpdatedAt: "2096-03-01T00:00:00.000Z",
      importId: 41,
    });
  });

  it.each([
    ["partial timestamp", "2096-03-01T00:00:00.000Z", null],
    ["partial id", null, 41],
    ["invalid timestamp", "not-a-timestamp", 41],
    ["zero id", "2096-03-01T00:00:00.000Z", 0],
    ["fractional id", "2096-03-01T00:00:00.000Z", 1.5],
  ])("rejects %s", (_name, timestamp, importId) => {
    expectCode(
      () => parsePatentWatchCursor(timestamp, importId),
      "watch_unavailable",
    );
  });

  it("preserves Postgres microseconds before applying the import-id tie breaker", () => {
    expect(
      comparePatentWatchCursors(
        {
          runUpdatedAt: "2096-03-01 00:00:00.000100+00",
          importId: 999,
        },
        {
          runUpdatedAt: "2096-03-01 00:00:00.000900+00",
          importId: 1,
        },
      ),
    ).toBeLessThan(0);
    expect(
      comparePatentWatchTimestamps(
        "2096-03-01T09:00:00.123456+09:00",
        "2096-03-01T00:00:00.123456Z",
      ),
    ).toBe(0);
  });
});

describe("patent watch source identity", () => {
  const digest = "c".repeat(64);

  it("uses the exact canonical key order and lowercase SHA-256", () => {
    expect(canonicalSourceIdentityJson("JP2099-000001A", digest)).toBe(
      `{"publicationNumber":"JP2099-000001A","contentSha256":"${digest}"}`,
    );
    expect(createPatentWatchSourceKey("JP2099-000001A", digest)).toBe(
      "28136e4f108fa8b2781368eb2124ec7fd0281c777df6df3a93e5497bd4856696",
    );
  });

  it("does not depend on document, import, or package identifiers", () => {
    const first = createPatentWatchSourceKey("JP2099-000001A", digest);
    const reimported = createPatentWatchSourceKey(
      "JP2099-000001A",
      digest,
    );
    expect(reimported).toBe(first);
  });

  it("allows a changed digest for the same publication to become a new identity", () => {
    expect(
      createPatentWatchSourceKey("JP2099-000001A", "d".repeat(64)),
    ).not.toBe(createPatentWatchSourceKey("JP2099-000001A", digest));
  });

  it.each([
    ["empty publication", "", digest],
    ["uppercase digest", "JP2099-000001A", "C".repeat(64)],
    ["short digest", "JP2099-000001A", "c".repeat(63)],
  ])("rejects %s", (_name, publicationNumber, contentSha256) => {
    expectCode(
      () =>
        createPatentWatchSourceKey(publicationNumber, contentSha256),
      "watch_corpus_unavailable",
    );
  });
});

describe("patent watch review validation", () => {
  it.each(["reviewed", "unreviewed"] as const)(
    "accepts %s as an exact body",
    (reviewStatus) => {
      expect(validatePatentWatchReviewInput({ reviewStatus })).toEqual({
        reviewStatus,
      });
    },
  );

  it.each([
    {},
    { reviewStatus: "pending" },
    { reviewStatus: "reviewed", extra: true },
  ])("rejects invalid review body %#", (body) => {
    expectCode(
      () => validatePatentWatchReviewInput(body),
      "invalid_watch_review_status",
    );
  });
});

describe("patent watch run request validation", () => {
  it.each([null, undefined, "", new Uint8Array(), new ArrayBuffer(0)])(
    "accepts an absent or zero-byte body",
    (body) => {
      expect(() => validatePatentWatchRunRequestBody(body)).not.toThrow();
    },
  );

  it.each(["{}", " ", new Uint8Array([0x7b, 0x7d])])(
    "rejects a non-zero-byte body",
    (body) => {
      expectCode(
        () => validatePatentWatchRunRequestBody(body),
        "invalid_watch_run_request",
      );
    },
  );
});

describe("patent watch public analysis safety", () => {
  it("redacts hashes, local paths, and authenticated URLs", () => {
    const digest = "a".repeat(64);
    const fixture = (...parts: string[]) => parts.join("");
    const unsafe = [
      digest,
      fixture("C:", "\\", "private\\fictional.xml"),
      fixture("\\", "\\", "fictional-server\\private\\fixture.xml"),
      fixture("/", "var", "/lib/fictional.xml"),
      fixture("file", ":///", "tmp/fictional.xml"),
      fixture("/", "root", "/.env"),
      fixture("/", "app", "/data/secret.txt"),
      fixture("/", "workspace", "/private.xml"),
      fixture("/", "etc", "/passwd"),
      fixture(
        "https",
        "://",
        "fictional-user",
        ":",
        "fictional-pass",
        "@",
        "example.invalid/private",
      ),
      fixture(
        "postgresql",
        "://",
        "fictional-user",
        ":",
        "fictional-pass",
        "@",
        "example.invalid/db",
      ),
      fixture("Bearer", " ", "FICTIONAL_TOKEN_123456789"),
      fixture("AZURE_API_KEY", "=", "FICTIONAL_SECRET"),
      fixture(
        "AZURE_DOCUMENT_INTELLIGENCE_KEY",
        "=",
        "FICTIONAL_DOCUMENT_SECRET",
      ),
      fixture("KOHO_IMPORT_ADMIN_TOKEN", "=", "FICTIONAL_ADMIN_TOKEN"),
    ].join(" | ");

    const sanitized = sanitizePatentWatchPublicText(unsafe);
    expect(sanitized).not.toContain(digest);
    expect(sanitized).not.toContain("fictional.xml");
    expect(sanitized).not.toContain("fictional-pass");
    expect(sanitized).not.toContain("FICTIONAL_TOKEN_123456789");
    expect(sanitized).not.toContain("FICTIONAL_SECRET");
    expect(sanitized).not.toContain("FICTIONAL_DOCUMENT_SECRET");
    expect(sanitized).not.toContain("FICTIONAL_ADMIN_TOKEN");
    expect(sanitized.match(/\[非表示\]/gu)?.length).toBeGreaterThanOrEqual(15);
  });

  it("bounds public text by Unicode code point after sanitizing", () => {
    expect(boundedPatentWatchPublicText("架空😀監視", 3)).toBe("架空😀");
    expect(() => boundedPatentWatchPublicText("fixture", 0)).toThrow(
      expect.objectContaining({ code: "watch_internal_error" }),
    );
  });

  it("removes legal conclusions including inflected Japanese forms", () => {
    expect(
      sanitizePatentWatchAnalysis({
        matchedElements: ["同一のセンサ構成", "新規性なし"],
        unmatchedElements: ["侵害に当たる"],
        explanation: "この出願は拒絶されます。",
      }),
    ).toEqual({
      matchedElements: ["同一のセンサ構成"],
      unmatchedElements: [],
      explanation: "重なり候補を整理した結果です。人による確認が必要です",
    });
  });

  it.each([
    "この発明は特許を受けることができない",
    "この構成は権利化できない",
    "特許取得は困難",
    "本件特許は無効。",
    "侵害あり",
    "この発明は特許にならない",
    "本件には特許が付与される",
    "The claim is unpatentable.",
    "The claim is not patentable.",
    "The claim lacks novelty.",
    "The difference is obvious.",
    "The claim will be granted.",
    "The claim is invalid.",
  ])("removes an explicit legal conclusion: %s", (conclusion) => {
    expect(
      sanitizePatentWatchAnalysis({
        matchedElements: [conclusion],
        unmatchedElements: [],
        explanation: conclusion,
      }),
    ).toEqual({
      matchedElements: [],
      unmatchedElements: [],
      explanation: "重なり候補を整理した結果です。人による確認が必要です",
    });
  });

  it("does not serialize a complete draft or source claim echoed by AI", () => {
    const fullClaim =
      "センサと制御部と送信部を備える架空の監視装置。";
    const serialized = serializePatentWatchAnalysis(
      {
        matchedElements: [fullClaim, "センサと制御部"],
        unmatchedElements: [],
        explanation: `全文: ${fullClaim}`,
      },
      [fullClaim],
    );

    expect(serialized).not.toContain(fullClaim);
    expect(JSON.parse(serialized)).toEqual({
      matchedElements: ["センサと制御部"],
      unmatchedElements: [],
      explanation: "重なり候補を整理した結果です。人による確認が必要です",
    });
  });

  it("removes a complete claim split across multiple analysis fields", () => {
    const fullClaim = "架空センサと架空制御部を備える監視装置。";
    const serialized = serializePatentWatchAnalysis(
      {
        matchedElements: ["架空センサと", "架空制御部を備える"],
        unmatchedElements: ["監視装置。"],
        explanation: "人による確認が必要です",
      },
      [fullClaim],
    );

    expect(serialized).not.toContain("架空センサと");
    expect(serialized).not.toContain("架空制御部を備える");
    expect(serialized).not.toContain("監視装置。");
    expect(JSON.parse(serialized)).toEqual({
      matchedElements: [],
      unmatchedElements: [],
      explanation: "重なり候補を整理した結果です。人による確認が必要です",
    });
  });
});
