import { describe, expect, it } from "vitest";
import { CODEBASE_PROMPT, CODEBASE_PROMPT_ROUTE } from "../src/codebase-prompt";

describe("the codebase-to-design prompt", () => {
  it("describes the one repository reconstruction path", () => {
    expect(CODEBASE_PROMPT).toContain("create a system design from this codebase");
    expect(CODEBASE_PROMPT).toContain("studio_create_study");
    expect(CODEBASE_PROMPT).toContain("studio_get_catalog");
    expect(CODEBASE_PROMPT).toContain("studio_update_study");
    expect(CODEBASE_PROMPT).toContain("studio_validate_draft");
    expect(CODEBASE_PROMPT).toContain("studio_import_architecture");
    expect(CODEBASE_PROMPT).toContain("studio_get_architecture");
    expect(CODEBASE_PROMPT).toMatch(/branch, commit, dirty state/);
  });

  it("tells the agent where the tools live and how to call them in order", () => {
    expect(CODEBASE_PROMPT).toMatch(/WebMCP site tools named studio_\*/);
    expect(CODEBASE_PROMPT).toMatch(/rather than looking for an MCP server/);
    const order = [
      "studio_create_study",
      "studio_get_catalog",
      "studio_update_study",
      "studio_create_candidate",
      "studio_apply_architecture_patch",
      "studio_import_architecture",
      "studio_get_architecture",
    ].map((tool) => CODEBASE_PROMPT.indexOf(tool));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(CODEBASE_PROMPT.split("\n\n")).toHaveLength(8);
  });

  it("draws the design on the canvas step by step and seals it, rather than importing blind", () => {
    expect(CODEBASE_PROMPT).toMatch(/step by step/);
    expect(CODEBASE_PROMPT).toMatch(/no design to open an empty canvas/);
    expect(CODEBASE_PROMPT).toMatch(/add-node/);
    expect(CODEBASE_PROMPT).toMatch(/add-edge/);
    expect(CODEBASE_PROMPT).toMatch(/fromCandidateId and expectedRevision/);
    expect(CODEBASE_PROMPT).toMatch(/immutable as-is baseline/);
  });

  it("spells out the structured payloads the agent has to author blind", () => {
    expect(CODEBASE_PROMPT).toContain("repository { name, rootHint, branch, revision, dirty, scope }");
    expect(CODEBASE_PROMPT).toMatch(/targetKind: node \| edge/);
    expect(CODEBASE_PROMPT).toMatch(/source: code \| config \| documentation \| runtime \| user/);
    expect(CODEBASE_PROMPT).toMatch(/lineStart, lineEnd, symbol, claim/);
  });

  it("stays an as-is reconstruction rather than silently redesigning code", () => {
    expect(CODEBASE_PROMPT).toMatch(/observed component and connection/);
    expect(CODEBASE_PROMPT).toMatch(/deductions inferred/);
    expect(CODEBASE_PROMPT).toMatch(/unknown production behaviour assumed/);
    expect(CODEBASE_PROMPT).toMatch(/Do not redesign the system or edit code/);
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
