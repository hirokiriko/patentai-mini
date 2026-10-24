import { describe, expect, it } from "vitest";
import { providerFailureMetadata } from "./prior-art-provider-failure";

describe("bounded provider filter evidence", () => {
  it("distinguishes Responses prompt rejection while keeping usage unknown", async () => {
    const result = await providerFailureMetadata(Response.json({ error: {
      code: "content_filter", type: "invalid_request_error", param: "prompt",
      innererror: { code: "ContentFiltered" },
      content_filters: [{ blocked: true, source_type: "prompt",
        content_filter_results: { jailbreak: { detected: true, filtered: true },
          hate: { filtered: false, severity: "safe" } },
        content_filter_offsets: { start_offset: 0, end_offset: 12, check_offset: 0 } }],
    } }, { status: 400 }));
    expect(result).toMatchObject({ status: 400, param: "prompt", innerCode: "ContentFiltered",
      usagePresent: false, usageKnown: false, annotations: [{ blocked: true, source_type: "prompt",
        content_filter_results: { jailbreak: { detected: true, filtered: true }, hate: { filtered: false, severity: "safe" } },
        content_filter_offsets: { start_offset: 0, end_offset: 12, check_offset: 0 } }] });
  });

  it("preserves output-side attribution without assuming a prompt rejection", async () => {
    const result = await providerFailureMetadata(Response.json({ error: {
      code: "content_filter", content_filters: [{ blocked: true, source_type: "completion",
        content_filter_results: { violence: { filtered: true, severity: "high" } } }],
    }, usage: { input_tokens: 3, output_tokens: 1 } }, { status: 400 }));
    expect(result).toMatchObject({ usagePresent: true, usageKnown: false, param: null,
      annotations: [{ source_type: "completion", blocked: true }] });
  });

  it("never promotes free text, unknown categories, malformed flags or offsets into metadata", async () => {
    const result = await providerFailureMetadata(Response.json({ error: {
      message: "FICTIONAL_SECRET", innererror: { code: "FICTIONAL_SECRET" },
      content_filters: [{ blocked: "FICTIONAL_SECRET", source_type: "FICTIONAL_SECRET",
        content_filter_raw: ["FICTIONAL_SECRET"],
        content_filter_results: { FICTIONAL_SECRET: { filtered: true },
          jailbreak: { detected: "true", filtered: true, explanation: "FICTIONAL_SECRET" },
          hate: { severity: "FICTIONAL_SECRET" } },
        content_filter_offsets: { start_offset: -1, end_offset: 1.5, check_offset: Number.MAX_VALUE,
          FICTIONAL_SECRET: 1 } }],
    } }, { status: 400 }));
    expect(JSON.stringify(result)).not.toContain("FICTIONAL_SECRET");
    expect(result.annotations).toEqual([{ content_filter_results: { jailbreak: { filtered: true } } }]);
    expect(result.innerCode).toBeUndefined();
  });

  it("bounds the number of projected annotations and accepts known legacy filter fields", async () => {
    const result = await providerFailureMetadata(Response.json({ error: {
      content_filters: Array.from({ length: 9 }, () => ({ source_type: "prompt" })),
      innererror: { code: "ContentFiltered", content_filter_result: { self_harm: { filtered: false, severity: "safe" } } },
    } }, { status: 400 }));
    expect(result.annotations).toHaveLength(8);
    expect(result.contentFilterResults).toEqual({ self_harm: { filtered: false, severity: "safe" } });
  });
});
