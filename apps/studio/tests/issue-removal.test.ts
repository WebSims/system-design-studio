import { readFileSync } from "node:fs";
import { pizzaStudy } from "@sds/models";
import { describe, expect, it } from "vitest";
import { createCandidate, removeIssue, upsertIssue } from "../src/study/mutations";

const proposal = {
  title: "Database pool can saturate",
  description: "Measured demand is close to the configured pool ceiling.",
  source: "agent" as const,
  severity: "warning" as const,
  category: "performance" as const,
  candidateId: null,
  targets: [],
  evidence: [{ kind: "analysis" as const, analysisHash: "analysis-1", findingId: "pool" }],
  verification: {
    kind: "performance" as const,
    summary: "Re-run the load analysis without the pool finding.",
    requiredSignals: ["finding absent"],
  },
  by: "agent" as const,
};

describe("issue removal", () => {
  it("lets a person permanently remove an unreferenced manual issue", () => {
    const created = upsertIssue(pizzaStudy(), {
      ...proposal,
      source: "user",
      by: "human",
    }, 10);
    const removed = removeIssue(created.study, {
      issueId: created.issue.id,
      expectedRevision: created.issue.revision,
      authority: "human",
      now: 20,
    });

    expect(removed.issueRegistry).toEqual([]);
    expect(removed.updatedAt).toBe(20);
  });

  it("keeps permanent deletion human-only and preserves derived findings", () => {
    const manual = upsertIssue(pizzaStudy(), {
      ...proposal,
      source: "user",
      by: "human",
    }, 10);
    expect(() => removeIssue(manual.study, {
      issueId: manual.issue.id,
      expectedRevision: manual.issue.revision,
      authority: "agent",
    })).toThrow(/only a human/);

    const derived = upsertIssue(pizzaStudy(), proposal, 10);
    expect(() => removeIssue(derived.study, {
      issueId: derived.issue.id,
      expectedRevision: derived.issue.revision,
      authority: "human",
    })).toThrow(/Dismiss derived findings/);
  });

  it("refuses deletion from a stale issue revision", () => {
    const created = upsertIssue(pizzaStudy(), {
      ...proposal,
      source: "user",
      by: "human",
    }, 10);

    expect(() => removeIssue(created.study, {
      issueId: created.issue.id,
      expectedRevision: created.issue.revision + 1,
      authority: "human",
    })).toThrow(/revision/);
    expect(created.study.issueRegistry).toHaveLength(1);
  });

  it("does not delete an issue while a solution version depends on it", () => {
    const created = upsertIssue(pizzaStudy(), {
      ...proposal,
      source: "user",
      by: "human",
    }, 10);
    const base = created.study.candidates[0]!;
    const withSolution = createCandidate(created.study, {
      label: "pool fix",
      intent: "Increase capacity.",
      copyFrom: base.id,
      origin: "human",
      candidateType: "repository-fix",
      issuePlans: [{
        issueId: created.issue.id,
        required: true,
        hypothesis: "A larger pool removes saturation.",
        tradeoffs: ["More database connections."],
        verificationPlan: created.issue.verification.summary,
        expectedArchitectureImpact: { summary: "Increase database capacity.", targets: [] },
        verification: null,
      }],
    }).study;

    expect(() => removeIssue(withSolution, {
      issueId: created.issue.id,
      expectedRevision: created.issue.revision,
      authority: "human",
    })).toThrow(/used by "pool fix"/);
    expect(withSolution.issueRegistry).toHaveLength(1);
  });

  it("renders an explicit irreversible-delete confirmation", () => {
    const registry = readFileSync(new URL("../src/panels/IssueRegistry.tsx", import.meta.url), "utf8");
    expect(registry).toMatch(/Confirm permanent issue deletion/);
    expect(registry).toMatch(/This cannot be undone/);
  });
});
