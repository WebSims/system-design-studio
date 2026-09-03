import { describe, expect, it } from "vitest";
import { isRetiredDevelopmentStudyId, loadStudy } from "../src/persist";

describe("retired development projects", () => {
  it("retires only the stable id used by the old bundled demo", () => {
    expect(isRetiredDevelopmentStudyId("limited-free-pizza")).toBe(true);
    expect(isRetiredDevelopmentStudyId("study-limited-free-pizza-review")).toBe(false);
    expect(isRetiredDevelopmentStudyId("my-pizza-service")).toBe(false);
    expect(isRetiredDevelopmentStudyId("study-user-project")).toBe(false);
  });

  it("refuses to reopen the retired demo before touching browser storage", async () => {
    await expect(loadStudy("limited-free-pizza")).resolves.toEqual({ status: "missing" });
  });
});
