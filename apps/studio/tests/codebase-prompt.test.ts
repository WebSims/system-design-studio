import { describe, expect, it } from "vitest";
import { CODEBASE_PROMPT, CODEBASE_PROMPT_ROUTE } from "../src/codebase-prompt";

describe("the codebase-to-design prompt", () => {
  it("describes the one repository reconstruction path", () => {
    expect(CODEBASE_PROMPT).toContain("draw an evidence-backed as-is architecture");
    expect(CODEBASE_PROMPT).toContain("studio_* WebMCP site tools");
    expect(CODEBASE_PROMPT).toMatch(/branch, commit, dirty state/);
  });

  it("is concise and delegates payload details to the tools", () => {
    expect(CODEBASE_PROMPT.split(/\s+/).length).toBeLessThanOrEqual(150);
    expect(CODEBASE_PROMPT.split("\n\n")).toHaveLength(4);
    expect(CODEBASE_PROMPT).toMatch(/Follow the tool schemas and next-step guidance/);
    expect(CODEBASE_PROMPT).not.toMatch(/targetKind:|lineStart|fromCandidateId/);
  });

  it("draws the design live and seals it, rather than importing blind", () => {
    expect(CODEBASE_PROMPT).toMatch(/empty as-is candidate/);
    expect(CODEBASE_PROMPT).toMatch(/one component or link per patch/);
    expect(CODEBASE_PROMPT).toMatch(/carry forward each returned revision/);
    expect(CODEBASE_PROMPT).toMatch(/immutable as-is baseline/);
  });

  it("makes the agent plan and author the visual layout", () => {
    expect(CODEBASE_PROMPT).toMatch(/Plan the full topology and its x\/y layout/)
    expect(CODEBASE_PROMPT).toMatch(/dependency depth left-to-right/)
    expect(CODEBASE_PROMPT).toMatch(/parallel branches on separate rows/)
    expect(CODEBASE_PROMPT).toMatch(/no overlaps or avoidable edge crossings/)
  })

  it("stays an as-is reconstruction rather than silently redesigning code", () => {
    expect(CODEBASE_PROMPT).toMatch(/facts observed/);
    expect(CODEBASE_PROMPT).toMatch(/deductions inferred/);
    expect(CODEBASE_PROMPT).toMatch(/unknown production behaviour assumed/);
    expect(CODEBASE_PROMPT).toMatch(/Stop before redesigning or editing code/);
    expect(CODEBASE_PROMPT_ROUTE).toEqual([
      "inspect the codebase",
      "define the system yardstick",
      "draw the as-is design live, then seal it",
      "show evidence gaps",
    ]);
  });

  it("contains no bundled example domain", () => {
    expect(CODEBASE_PROMPT).not.toMatch(/pizza|inventory|ticket|seat/i);
  });
});
