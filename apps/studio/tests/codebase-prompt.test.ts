import { describe, expect, it } from "vitest";
import { CODEBASE_PROMPT, CODEBASE_PROMPT_ROUTE } from "../src/codebase-prompt";

describe("the codebase-to-design prompt", () => {
  it("describes the one repository reconstruction path", () => {
    expect(CODEBASE_PROMPT).toContain("draw an evidence-backed as-is architecture");
    expect(CODEBASE_PROMPT).toContain("studio_* WebMCP site tools");
    expect(CODEBASE_PROMPT).toMatch(/branch, commit, dirty state/);
  });

  it("is concise and delegates payload details to the tools", () => {
    expect(CODEBASE_PROMPT.split(/\s+/).length).toBeLessThanOrEqual(300);
    expect(CODEBASE_PROMPT.split("\n\n")).toHaveLength(5);
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
    expect(CODEBASE_PROMPT).toMatch(/Plan topology and layout from layoutGuide/)
    expect(CODEBASE_PROMPT).toMatch(/use auto-layout/)
  })

  it("preserves runtime boundaries instead of promoting every code unit to a service", () => {
    expect(CODEBASE_PROMPT).toMatch(/processes or containers/)
    expect(CODEBASE_PROMPT).toMatch(/independent capacity or failure boundary/)
    expect(CODEBASE_PROMPT).toMatch(/not merely a package, handler, goroutine, or class/)
    expect(CODEBASE_PROMPT).toMatch(/label it '\(in-process\)'/)
    expect(CODEBASE_PROMPT).toMatch(/configured or documented-default provider/)
    expect(CODEBASE_PROMPT).toMatch(/mutually exclusive alternatives as gaps/)
  })

  it("requires an executable flow without presenting placeholders as measurements", () => {
    expect(CODEBASE_PROMPT).toMatch(/invariants for required system outcomes/)
    expect(CODEBASE_PROMPT).toMatch(/not implementation mechanisms or process-local guarantees/)
    expect(CODEBASE_PROMPT).toMatch(/highest-risk state-changing flow into a workflow/)
    expect(CODEBASE_PROMPT).toMatch(/Never invent production rates, replicas, latencies, or provider choices/)
    expect(CODEBASE_PROMPT).toMatch(/placeholders assumed/)
    expect(CODEBASE_PROMPT).toMatch(/do not run performance until calibrated/)
  })

  it("stays an as-is reconstruction rather than silently redesigning code", () => {
    expect(CODEBASE_PROMPT).toMatch(/facts observed/);
    expect(CODEBASE_PROMPT).toMatch(/deductions inferred/);
    expect(CODEBASE_PROMPT).toMatch(/unknown production behaviour assumed/);
    expect(CODEBASE_PROMPT).toMatch(/Stop before redesigning or editing code/);
    expect(CODEBASE_PROMPT_ROUTE).toEqual([
      "inspect the codebase",
      "identify runtime and capacity boundaries",
      "define the system yardstick",
      "trace one critical flow",
      "draw the as-is design live, then seal it",
      "show evidence gaps",
    ]);
  });

  it("contains no bundled example domain", () => {
    expect(CODEBASE_PROMPT).not.toMatch(/pizza|inventory|ticket|seat/i);
  });
});
