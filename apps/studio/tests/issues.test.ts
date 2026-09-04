import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pizzaStudy } from "@sds/models";
import { activeIssueBaseline, issueEvidenceRefKey, issueStatus } from "@sds/schema";
import {
  MutationRefused,
  recordIssueDecision,
  upsertIssue,
} from "../src/study/mutations";
import { syncAnalysisIssues } from "../src/study/issueSync";
import { readUiDensity, writeUiDensity } from "../src/uiDensity";

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

describe("the unified issue registry", () => {
  it("upserts repeated analysis deterministically instead of duplicating it", () => {
    const study = pizzaStudy();
    const first = upsertIssue(study, proposal, 10);
    const retry = upsertIssue(first.study, proposal, 20);

    expect(retry.study.issueRegistry).toHaveLength(1);
    expect(retry.issue.id).toBe(first.issue.id);
    expect(retry.issue.revision).toBe(0);
    expect(retry.issue.updatedAt).toBe(10);
  });

  it("requires an agent to acknowledge the issue revision before changing a match", () => {
    const first = upsertIssue(pizzaStudy(), proposal, 10);
    expect(() => upsertIssue(first.study, { ...proposal, severity: "critical" }, 20)).toThrow(MutationRefused);
    const updated = upsertIssue(first.study, { ...proposal, severity: "critical", expectedRevision: 0 }, 20);
    expect(updated.study.issueRegistry).toHaveLength(1);
    expect(updated.issue).toMatchObject({ severity: "critical", revision: 1 });
  });

  it("does not let an agent impersonate a check or decide its own finding", () => {
    const study = pizzaStudy();
    expect(() => upsertIssue(study, { ...proposal, source: "correctness-check" }, 10)).toThrow(/only propose agent-sourced/);
    const created = upsertIssue(study, proposal, 10);
    expect(() => recordIssueDecision(created.study, {
      issueId: created.issue.id,
      expectedRevision: created.issue.revision,
      outcome: "verified",
      authority: "agent",
    })).toThrow(/cannot verify/);
  });

  it("derives state from evidence and a revision-pinned trusted receipt", () => {
    const created = upsertIssue(pizzaStudy(), proposal, 10);
    const evidenceRef = issueEvidenceRefKey(created.issue.evidence[0]!);
    const decided = recordIssueDecision(created.study, {
      issueId: created.issue.id,
      expectedRevision: created.issue.revision,
      outcome: "verified",
      authority: "check",
      evaluationHash: "evaluation-1",
      evidenceRefs: [evidenceRef],
      now: 20,
    });
    expect(issueStatus(decided.issue)).toBe("verified");
    expect(issueStatus(decided.issue, { snapshotId: null, revision: "another-baseline" })).toBe("historical");
  });

  it("reserves risk acceptance for people", () => {
    const created = upsertIssue(pizzaStudy(), proposal, 10);
    expect(() => recordIssueDecision(created.study, {
      issueId: created.issue.id,
      expectedRevision: 0,
      outcome: "accepted-risk",
      authority: "check",
    })).toThrow(/only a human/);
    const accepted = recordIssueDecision(created.study, {
      issueId: created.issue.id,
      expectedRevision: 0,
      outcome: "accepted-risk",
      authority: "human",
      reason: "Known launch trade-off.",
      now: 30,
    });
    expect(issueStatus(accepted.issue)).toBe("accepted-risk");
  });

  it("adapts performance findings into the same registry and target model", () => {
    const study = pizzaStudy();
    const candidate = study.candidates[0]!;
    const node = candidate.design.nodes.find((item) => item.kind !== "client")!;
    const synced = syncAnalysisIssues(study, candidate.id, [{
      id: "pool-undersized",
      severity: "critical",
      title: "pool is undersized",
      evidence: "arrival exceeds available slots",
      remediation: "increase the pool",
      nodeId: node.id,
    }], "analysis-hash", 40);
    expect(synced.issueRegistry).toHaveLength(1);
    expect(synced.issueRegistry[0]).toMatchObject({
      source: "performance-analysis",
      severity: "critical",
      candidateId: candidate.id,
      targets: [{ kind: "node", nodeId: node.id }],
    });
    expect(activeIssueBaseline(synced).revision).toMatch(/^freehand:/);
  });
});

describe("UI density preference", () => {
  it("defaults new installations to Guided and persists an Expert choice locally", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readUiDensity(storage)).toBe("guided");
    writeUiDensity("expert", storage);
    expect(readUiDensity(storage)).toBe("expert");
  });

  it("keeps filtering, multi-selection, focus, and non-color state text in the registry UI", () => {
    const source = readFileSync(new URL("../src/panels/IssueRegistry.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/statusFilter/);
    expect(source).toMatch(/severityFilter/);
    expect(source).toMatch(/type="checkbox"/);
    expect(source).toMatch(/focus on canvas/);
    expect(source).toMatch(/STATUS_MARK/);
    expect(source).toMatch(/status\.replace/);
  });
});
