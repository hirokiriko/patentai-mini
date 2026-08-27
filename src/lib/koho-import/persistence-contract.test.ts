import { describe, expect, it } from "vitest";
import { assertKohoImportPlan } from "./persistence-contract";

describe("koho import persistence contract", () => {
  it("rejects a runtime value that is not an exact import plan", () => {
    expect(() => assertKohoImportPlan({})).toThrowError(
      expect.objectContaining({ code: "invalid_plan_shape" }),
    );
  });
});
