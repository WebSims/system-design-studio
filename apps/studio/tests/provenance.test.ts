import { describe, expect, it } from "vitest";
import { modelInputLabel } from "../src/canvas/provenance";

describe("canvas model input provenance", () => {
  it("makes assumed and unsupported repository inputs explicit", () => {
    expect(modelInputLabel(true, "assumed")).toBe("assumed inputs");
    expect(modelInputLabel(true, "inferred")).toBe("inferred inputs");
    expect(modelInputLabel(true, "uncovered")).toBe("unverified inputs");
  });

  it("does not imply that a freehand preview was measured", () => {
    expect(modelInputLabel(false, undefined)).toBe("model preview");
    expect(modelInputLabel(true, "observed")).toBe("model preview");
  });
});
