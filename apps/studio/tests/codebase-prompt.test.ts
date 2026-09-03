import { describe, expect, it } from "vitest";
import { CODEBASE_PROMPT, CODEBASE_PROMPT_ROUTE } from "../src/codebase-prompt";

describe("the codebase-to-design prompt", () => {
  it("describes the one repository reconstruction path", () => {
    expect(CODEBASE_PROMPT).toContain("create a system design from this codebase");
    expect(CODEBASE_PROMPT).toContain("studio_create_study");
    expect(CODEBASE_PROMPT).toContain("studio_get_catalog");
    expect(CODEBASE_PROMPT).toContain("studio_update_study");
    expect(CODEBASE_PROMPT).toContain("studio_import_architecture");
    expect(CODEBASE_PROMPT).toMatch(/branch, commit, dirty state/);
  });

  it("stays an as-is reconstruction rather than silently redesigning code", () => {
    expect(CODEBASE_PROMPT).toMatch(/observed component and connection/);
    expect(CODEBASE_PROMPT).toMatch(/deductions inferred/);
    expect(CODEBASE_PROMPT).toMatch(/unknown production behaviour assumed/);
    expect(CODEBASE_PROMPT).toMatch(/Do not redesign the system or edit code/);
    expect(CODEBASE_PROMPT_ROUTE).toEqual([
      "inspect the codebase",
      "define the system yardstick",
      "import the as-is design",
      "show evidence gaps",
    ]);
  });

  it("contains no bundled example domain", () => {
    expect(CODEBASE_PROMPT).not.toMatch(/pizza|inventory|ticket|seat/i);
  });
});
