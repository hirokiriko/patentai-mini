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
    const sasSecret = "FICTIONAL_SAS_SIGNATURE";
    const awsSecret = "FICTIONAL_AWS_SIGNATURE";
    const googleSecret = "FICTIONAL_GOOGLE_SIGNATURE";
    const encodedKeySecret = "FICTIONAL_ENCODED_KEY_SIGNATURE";
    const publicUrl = fixture(
      "https",
      "://",
      "example.invalid/public?view=1",
    );
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
      fixture(
        "https",
        "://",
        "fictional.blob.core.windows.net/container/blob?sv=2099-01-01&sig=",
        sasSecret,
      ),
      fixture(
        "https",
        "://",
        "example.invalid/object?X-Amz-Signature=",
        awsSecret,
      ),
      fixture(
        "https",
        "://",
        "example.invalid/object?X-Goog-Signature=",
        googleSecret,
      ),
      fixture(
        "https",
        "://",
        "example.invalid/object?%73ig=",
        encodedKeySecret,
      ),
      publicUrl,
    ].join(" | ");

    const sanitized = sanitizePatentWatchPublicText(unsafe);
    expect(sanitized).not.toContain(digest);
    expect(sanitized).not.toContain("fictional.xml");
    expect(sanitized).not.toContain("fictional-pass");
    expect(sanitized).not.toContain("FICTIONAL_TOKEN_123456789");
    expect(sanitized).not.toContain("FICTIONAL_SECRET");
    expect(sanitized).not.toContain("FICTIONAL_DOCUMENT_SECRET");
    expect(sanitized).not.toContain("FICTIONAL_ADMIN_TOKEN");
    expect(sanitized).not.toContain(sasSecret);
    expect(sanitized).not.toContain(awsSecret);
    expect(sanitized).not.toContain(googleSecret);
    expect(sanitized).not.toContain(encodedKeySecret);
    expect(sanitized).toContain(publicUrl);
    expect(sanitized.match(/\[非表示\]/gu)?.length).toBeGreaterThanOrEqual(19);
  });

  it.each([
    "https://example.invalid/object?%73%69%67=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?%73%69%67%3DFICTIONAL_URL_SECRET",
    "https://example.invalid/object?view=1%26sig%3DFICTIONAL_URL_SECRET",
    "https://example.invalid/object?%2573%2569%2567%253DFICTIONAL_URL_SECRET",
    "https://example.invalid/object?%EF%BD%93%EF%BD%89%EF%BD%87=FICTIONAL_URL_SECRET",
    "https://gateway.invalid/?redirect=https://example.invalid/object?sig=FICTIONAL_URL_SECRET",
    "https://gateway.invalid/?redirect=https%3A%2F%2Fexample.invalid%2Fobject%3Fsig%3DFICTIONAL_URL_SECRET",
    "//example.invalid/object?sig=FICTIONAL_URL_SECRET",
    "/object?sig=FICTIONAL_URL_SECRET",
    "download?sig=FICTIONAL_URL_SECRET",
    "?sig=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?key=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?subscription-key=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?x-amz-security-token=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?x-api-key=FICTIONAL_URL_SECRET",
    "https://example.invalid/object#access_token=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?sessionToken=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?auth_token=FICTIONAL_URL_SECRET",
    "https://example.invalid/object?csrf-token=FICTIONAL_URL_SECRET",
    "https://example.invalid/function?code=FICTIONAL_FUNCTION_CODE",
    "https://example.invalid/callback?auth=FICTIONAL_AUTH_VALUE",
    "(https://example.invalid/function?code=FICTIONAL_FUNCTION_CODE)",
    "https://example.invalid/function?code=FICTIONAL_FUNCTION_CODE,",
  ])("redacts an encoded or relative authenticated URL: %s", (unsafeUrl) => {
    expect(sanitizePatentWatchPublicText(unsafeUrl)).toBe("[非表示]");
  });

  it.each([
    "https://example.invalid/object?view=1",
    "https://example.invalid/object?signal=low",
    "https://example.invalid/object?signatureVersion=1",
    "https://example.invalid/object?monkey=value",
    "https://example.invalid/object?x-api-key-version=1",
    "https://example.invalid/object?code=200",
    "https://example.invalid/object?auth=public",
    "/docs/signature=guide",
    "https://example.invalid/object?view=%ZZ",
  ])("keeps a URL without a credential parameter: %s", (publicUrl) => {
    expect(sanitizePatentWatchPublicText(publicUrl)).toBe(publicUrl);
  });

  it.each([
    "Ocp-Apim-Subscription-Key: FICTIONAL_HEADER_SECRET",
    "x-api-key: FICTIONAL_HEADER_SECRET",
    "AccountKey: FICTIONAL_HEADER_SECRET",
    "SharedAccessKey: FICTIONAL_HEADER_SECRET",
    "Authorization: Basic RklDVElPTkFMX0NSRURFTlRJQUw=",
    "Proxy-Authorization: Digest FICTIONAL_HEADER_SECRET",
    "Cookie: session=FICTIONAL_HEADER_SECRET",
    "Set-Cookie: auth=FICTIONAL_HEADER_SECRET; HttpOnly",
    "X-Auth-Token: FICTIONAL_HEADER_SECRET",
    "TOKEN=FICTIONAL_HEADER_SECRET",
    '{"apiKey":"FICTIONAL_HEADER_SECRET"}',
    '{"token":"FICTIONAL_HEADER_SECRET"}',
    '{"sessionToken":"FICTIONAL_HEADER_SECRET"}',
    '{"authToken":"FICTIONAL_HEADER_SECRET"}',
    '{"csrfToken":"FICTIONAL_HEADER_SECRET"}',
    '{"credential":"FICTIONAL_HEADER_SECRET"}',
    'API_KEY: "FICTIONAL_HEADER_SECRET WITH SPACES"',
    "API_KEY：FICTIONAL_HEADER_SECRET",
    "API_\u200bKEY=FICTIONAL_HEADER_SECRET",
    '{"Authorization":"Basic FICTIONAL_HEADER_SECRET"}',
    '{"Proxy-Authorization":"Digest FICTIONAL_HEADER_SECRET"}',
    'Authorization = "Basic FICTIONAL_HEADER_SECRET"',
    '{\\"apiKey\\":\\"FICTIONAL_HEADER_SECRET\\"}',
    'payload={\\"token\\":\\"FICTIONAL_HEADER_SECRET\\"}',
    '{\\"sessionToken\\":\\"FICTIONAL_HEADER_SECRET\\"}',
    "`password`: `FICTIONAL_HEADER_SECRET WITH SPACES`",
  ])("redacts a credential header or assignment: %s", (unsafeHeader) => {
    expect(sanitizePatentWatchPublicText(unsafeHeader)).not.toContain(
      "FICTIONAL_HEADER_SECRET",
    );
  });

  it("redacts a complete credential header without crossing a line", () => {
    const sanitized = sanitizePatentWatchPublicText(
      "X-Auth-Token: FICTIONAL_FIRST_SECRET second=FICTIONAL_SECOND_SECRET\r\nPUBLIC_LINE",
    );

    expect(sanitized).toBe("[非表示]\r\nPUBLIC_LINE");
    expect(sanitizePatentWatchPublicText("Cookie:\nPUBLIC_LINE")).toContain(
      "PUBLIC_LINE",
    );
    expect(
      sanitizePatentWatchPublicText(
        "Cookie: session=FICTIONAL_FIRST|FICTIONAL_SECOND",
      ),
    ).toBe("[非表示]");
    expect(
      sanitizePatentWatchPublicText(
        "Authorization: Basic FICTIONAL_SECRET | https://example.invalid/public",
      ),
    ).toBe("[非表示] | https://example.invalid/public");
    expect(
      sanitizePatentWatchPublicText(
        `Cookie: token=${" ".repeat(20_000)}FICTIONAL_SECRET`,
      ),
    ).toBe("[非表示]");
    expect(
      sanitizePatentWatchPublicText(
        "Ｃｏｏｋｉｅ： session=FICTIONAL_FIRST|FICTIONAL_SECOND",
      ),
    ).toBe("[非表示]");
    expect(
      sanitizePatentWatchPublicText(
        "Coo\u200bkie: session=FICTIONAL_FIRST|FICTIONAL_SECOND",
      ),
    ).toBe("[非表示]");
  });

  it.each([
    "monkey: public",
    "Key: optical coupler",
    "key: sensor arrangement",
    "The encryption key = public key material.",
    "The report explains a lookup key=value pair.",
    "signature: optical arrangement",
    "Token: optical session identifier",
    "The token = public session token.",
    "signature=optical-arrangement",
    "sig=measurement-waveform",
    "Cookie policy: public",
    "X-Auth-Token-Version: 1",
    '{"credentialType":"public"}',
    "credential: optical coupler",
    "https://example.invalid/object?credential=public",
    '{"sessionTokenCount":3}',
    "sessionTokenization: optical",
    "The session token = optical session identifier.",
  ])("keeps a non-credential assignment: %s", (publicAssignment) => {
    expect(sanitizePatentWatchPublicText(publicAssignment)).toBe(
      publicAssignment,
    );
  });

  it("keeps safe full-width public text unchanged", () => {
    const publicText = "公開番号：ＪＰ２０２４－１２３４５６";

    expect(sanitizePatentWatchPublicText(publicText)).toBe(publicText);
  });

  it.each([
    "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=fictional;AccountKey=FICTIONAL_CONNECTION_SECRET;EndpointSuffix=core.windows.net",
    "connection_string=Endpoint=https://example.invalid;SharedAccessKey=FICTIONAL_CONNECTION_SECRET",
  ])("redacts an entire connection-string assignment: %s", (unsafeValue) => {
    const sanitized = sanitizePatentWatchPublicText(unsafeValue);

    expect(sanitized).toBe("[非表示]");
    expect(sanitized).not.toContain("FICTIONAL_CONNECTION_SECRET");
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
    "請求項1は新規と思われる。",
    "請求項1は新規と考えられる。",
    "請求項1は新規と考えられます。",
    "請求項1はD1に鑑み新規と思われる。",
    "請求項1は新規とはいえない。",
    "請求項1は有効である。",
    "請求項1は有効と判断されます。",
    "請求項1は有効とは認められない。",
    "請求項1は無効とは判断できない。",
    "本件特許は有効である。",
    "この発明は特許可能である。",
    "本願は拒絶すべきである。",
    "本願は登録すべきである。",
    "本願は拒絶の可能性が高い。",
    "本願は登録が見込まれる。",
    "本願は登録が見込まれる 。",
    "本願は登録が見込まれるため、人による確認が必要である。",
    "この発明は特許される。",
    "請求項1は先行技術から容易に想到できる。",
    "請求項1は容易想到である。",
    "本願発明は想到容易である。",
    "請求項1は自明である。",
    "請求項1は公知である。",
    "本願は特許要件を満たす。",
    "この発明は特許にならない",
    "本件には特許が付与される",
    "The claim is unpatentable.",
    "The claim is not patentable.",
    "The claim lacks novelty.",
    "The claim is novel.",
    "Claim 1: is novel.",
    "Claim 1 is clearly novel.",
    "Claim 1 appears to be novel.",
    "Claim 1 may be novel.",
    "Claim 1 is likely to be novel.",
    "Claim 1 is expected to be novel.",
    "Claim 1 may be considered novel.",
    "Claim 1 would appear to be novel.",
    "Claim 1 has been found to be novel.",
    "Claim 1, in view of D1, may be novel.",
    "The application is novel.",
    "Patent application 1 is novel.",
    "The claim is not novel.",
    "The claim is not new.",
    "The claim is new, but requires review.",
    "The claim is new; human review is required.",
    "The claim is new because the feature is absent.",
    "Claim 1 is anticipated by D1.",
    "Claim 1: is anticipated by D1.",
    "Claim 1 is fully anticipated by D1.",
    "Claim 1 is not clearly anticipated by D1.",
    "Claim 1 is expressly and inherently anticipated by D1.",
    "Claim 1 has clearly been anticipated by D1.",
    "Claim 1 could be anticipated by D1.",
    "Claim 1 is anticipated by Smith et al.",
    "Claim 1 is anticipated by Smith.",
    "Claim 1 is anticipated over Smith.",
    "Claim 1 is anticipated based on D1.",
    "Claim 1 is anticipated as disclosed in D1.",
    "Claim 1 is anticipated under 35 U.S.C. § 102.",
    "D1 anticipates claim 1.",
    "D1: anticipates claim 1.",
    "D1 anticipates all of the elements recited in independent claim 1.",
    "D1 anticipates every limitation expressly recited in independent claim 1.",
    "D1 anticipates patent application 1.",
    "D1 anticipates application 1.",
    "D1 anticipates the application as filed.",
    "D1 anticipates this application.",
    "JP2020-123456A anticipates claim 1.",
    "JP2020-123456A: anticipates claim 1.",
    "JPH10-123456A anticipates claim 1.",
    "JPH10123456A anticipates claim 1.",
    "JPS63-123456A anticipates claim 1.",
    "EP-A-123456 anticipates claim 1.",
    "US123456B2 anticipates claim 1.",
    "WO2020123456A1 anticipates claim 1.",
    "Smith anticipates claim 1.",
    "Claims 1 and 2 are novel.",
    "Claims 1-3 are novel.",
    "The claim is not novel in this corpus.",
    "The claim is novel to the corpus.",
    "Claims 1 and 2 are new in our corpus.",
    "Claims Nos. 1 and 2 are novel in this corpus.",
    "Claims #1 and #2 are novel in this corpus.",
    "Claims 1 & 2 are novel in this corpus.",
    "Claims numbered 1 and 2 are novel in this corpus.",
    "The invention is not new in the corpus.",
    "Ｃｌａｉｍ １ ｉｓ ｎｏｖｅｌ．",
    "The cl\u200baim is novel.",
    "The difference is obvious.",
    "Claim 1 is obvious.",
    "Claim 1 would have been obvious.",
    "D1 renders claim 1 obvious.",
    "It would have been obvious to combine D1 and D2.",
    "It is obvious that claim 1 lacks the element.",
    "The combination of D1 and D2 would have been obvious.",
    "Combining D1 and D2 would have been obvious.",
    "The difference is obvious to a person skilled in the art.",
    "Claim 1 is allowable.",
    "Claim 1 is deemed allowable.",
    "Claim 1 should be allowed.",
    "Allowance is likely.",
    "Allowance is likely because D1 lacks the feature.",
    "Allowance is likely; human review is required.",
    "The examiner will allow claim 1.",
    "The patent should issue.",
    "The patent should be issued.",
    "The patent will likely issue.",
    "The patent may never issue.",
    "Claim 1 should be allowed because D1 lacks the feature.",
    "The examiner will allow claim 1 because D1 lacks the feature.",
    "The patent should issue because the objection was withdrawn.",
    "Claim 1 is rejected.",
    "Claim 1 will likely be rejected.",
    "Claim 1 is likely to be rejected.",
    "Claim 1 appears to be invalid.",
    "Claim 1 is invalid because D1 anticipates it.",
    "The patent is valid.",
    "The patent is valid and enforceable.",
    "US123456B2 is invalid.",
    "Patent US123456B2 is valid.",
    "Invalidity of claim 1 is asserted.",
    "Invalidity of the patent is asserted.",
    "Claim 1 infringes the patent.",
    "Rejection of claim 1 is likely.",
    "The claim will be granted.",
    "The claim is invalid.",
    "この請求項は新規である",
    "この請求項は新規ではない",
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

  it("keeps novel when it describes an element rather than a legal conclusion", () => {
    const descriptiveText = "The source describes a novel optical coupler.";

    expect(
      sanitizePatentWatchAnalysis({
        matchedElements: [descriptiveText],
        unmatchedElements: [],
        explanation: descriptiveText,
      }),
    ).toEqual({
      matchedElements: [descriptiveText],
      unmatchedElements: [],
      explanation: descriptiveText,
    });
  });

  it.each([
    "The claim includes a novel optical coupler.",
    "The claim clearly includes a novel coupler.",
    "The claim may include a new sensor.",
    "The claim appears in a novel optical report.",
    'The claim text contains the phrase "may be novel".',
    'The word "novel" appears in the title.',
    "The patent is new to the corpus.",
    "The source is novel to the corpus.",
    "The source is not new in this corpus.",
    "The document is new in our corpus.",
    "The publication is not new to the corpus.",
    "The claim cites a source that is novel to the corpus.",
    "The coupler is novel-shaped.",
    "The report uses a new-style heading.",
    "The schedule anticipates a September import.",
    "US123456B2 anticipates a September import.",
    "Q3 forecast anticipates claims growth.",
    "ISO9001 planning anticipates claims processing.",
    "FY2024 forecast anticipates claims growth.",
    "The application is anticipated in September.",
    "Claim 1 is anticipated by September.",
    "The application is anticipated by the project team.",
    "Claim 1 is anticipated by D1team.",
    "The application is anticipated by R2D2.",
    "The application is anticipated by referenceable scheduling logic.",
    "The application is anticipated to be filed in September.",
    "D1 anticipates release: claim 1 remains pending.",
    "The publication anticipates future applications of the sensor.",
    "The publication anticipates the application launch in September.",
    "D1 anticipates the application processing schedule.",
    "The publication anticipates claims processing delays.",
    "The document anticipates invention disclosures next quarter.",
    "The source anticipates subject matter updates.",
    "D1 anticipates claims processing.",
    "D1 anticipates claim 1 processing next week.",
    "The publication anticipates claim 2 submission.",
    "Scheduler anticipates claim 1 filing.",
    "D1 anticipates application 1 processing.",
    "D1 renders application performance obvious.",
    "The source contains an obvious OCR error.",
    "The source contains an obvious formatting difference.",
    "The allowable temperature range is 10 to 20 degrees.",
    "The allowable error is 0.1 mm.",
    "The input is rejected by the parser.",
    "The checksum has invalidity markers.",
    "It is obvious that the application performance improved.",
    "It is obvious that the application launch succeeded.",
    "The session is new.",
    "The sensor is new and has not yet been initialized.",
    "The report is not new.",
    "The application is valid JSON.",
    "The application is rejected by the parser.",
    "The application is allowable input.",
    "Invalidity of application data is reported.",
    "Rejection of application input is logged.",
    "The application is new software.",
    "This application is novel software architecture.",
    "The application is new to the server.",
    "The application appears to be new in the deployment.",
    "The coating is new.",
    "The material is novel.",
    "サーバに端末を登録できる。",
    "センサIDがデータベースに登録される。",
    "設定登録部がセンサ設定を保存する。",
    "無効なトークンを破棄する。",
    "制御信号を無効化する。",
    "入力を拒絶するフィルタを備える。",
    "請求項は無効なトークンを除外する。",
    "発明は端末を登録できる。",
    "端末登録が見込まれる。",
    "この発明はセンサを特許データベースに登録する。",
    "新規であるセッションIDを生成する。",
    "接続は新規であるため初期化する。",
    "新規ではない既存レコードを更新する。",
    "The parser should be allowed to continue.",
    "The patent service should issue a session token.",
    "The allowance is stored as a billing field.",
    "The examiner will allow the parser to continue.",
    "Claim 1 should be allowed through the parser.",
    "The claim is allowed as schema input.",
    "The invention is issued a tracking identifier.",
    "本願は登録が見込まれる利用者を保持する。",
    "この発明は特許される文書を分類する。",
  ])("keeps descriptive use of novelty wording: %s", (descriptiveText) => {
    expect(
      sanitizePatentWatchAnalysis({
        matchedElements: [descriptiveText],
        unmatchedElements: [],
        explanation: descriptiveText,
      }),
    ).toEqual({
      matchedElements: [descriptiveText],
      unmatchedElements: [],
      explanation: descriptiveText,
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

  it("removes a complete claim despite case and punctuation changes", () => {
    const fullClaim =
      "A FICTIONAL OPTICAL SYSTEM, COMPRISING A SENSOR.";
    const serialized = serializePatentWatchAnalysis(
      {
        matchedElements: ["a fictional optical"],
        unmatchedElements: ["system; comprising", "a sensor"],
        explanation: "Candidate details.",
      },
      [fullClaim],
    );

    expect(JSON.parse(serialized)).toEqual({
      matchedElements: [],
      unmatchedElements: [],
      explanation: "重なり候補を整理した結果です。人による確認が必要です",
    });
  });
});
