import { describe, expect, it } from "vitest";
import { pizzaStudy } from "@sds/models";
import {
  activeIssueBaseline,
  currentBaselineCandidate,
  issueStatus,
  type RepositorySnapshot,
  type Study,
} from "@sds/schema";
import {
  MutationRefused,
  createCandidate,
  deleteCandidate,
  importRepositoryArchitecture,
  recordIssueDecision,
  upsertIssue,
} from "../src/study/mutations";
import { drawingCandidate } from "../src/study/steps";

const snapshot = (id: string, capturedAt: number): RepositorySnapshot => ({
  id,
  name: "example-service",
  rootHint: "services/example",
  branch: "main",
  // Deliberately identical: a corrected reconstruction of the same source commit is a new
  // immutable snapshot even when Git cannot distinguish the two imports.
  revision: "same-commit",
  dirty: false,
  scope: ["src"],
  excludedScope: [],
  changedPaths: [],
  workingTreeFingerprint: "",
  capturedAt,
});

const importBaseline = (study: Study, id: string, capturedAt: number) =>
  importRepositoryArchitecture(study, {
    repository: snapshot(id, capturedAt),
    label: `As-is ${id}`,
    design: study.candidates[0]!.design,
    evidence: [],
    sourceInventory: [],
    origin: "human",
  });

const issueInput = {
  title: "A durable checkpoint can outrun external work",
  description: "The stored cursor can advance before the external effect is complete.",
  source: "user" as const,
  severity: "critical" as const,
  category: "correctness" as const,
  candidateId: null,
  targets: [],
  evidence: [{ kind: "user-observation" as const, observationId: "checkpoint-order" }],
  verification: {
    kind: "manual" as const,
    summary: "Confirm the checkpoint and external effect cannot diverge.",
    requiredSignals: [],
  },
  by: "human" as const,
};

describe("repository baseline lifecycle", () => {
  it("keeps corrected same-commit imports distinct and makes only the active snapshot current", () => {
    const first = importBaseline(pizzaStudy(), "snapshot-1", 1);
    const firstIssue = upsertIssue(first.study, issueInput, 2);
    const second = importBaseline(firstIssue.study, "snapshot-2", 3);
    const secondIssue = upsertIssue(second.study, issueInput, 4);
    const baseline = activeIssueBaseline(secondIssue.study);

    expect(currentBaselineCandidate(secondIssue.study)?.id).toBe(second.candidate.id);
    expect(drawingCandidate(secondIssue.study)?.id).toBe(second.candidate.id);
    expect(first.candidate.role).toBe("baseline");
    expect(issueStatus(firstIssue.issue, baseline)).toBe("historical");
    expect(issueStatus(secondIssue.issue, baseline)).toBe("open");
    expect(secondIssue.issue.id).not.toBe(firstIssue.issue.id);
    expect(secondIssue.study.issueRegistry).toHaveLength(2);
  });

  it("refuses new decisions and solutions based on a prior snapshot", () => {
    const first = importBaseline(pizzaStudy(), "snapshot-1", 1);
    const firstIssue = upsertIssue(first.study, issueInput, 2);
    const second = importBaseline(firstIssue.study, "snapshot-2", 3);

    expect(() => createCandidate(second.study, {
      label: "stale solution",
      copyFrom: second.candidate.id,
      origin: "human",
      candidateType: "repository-fix",
      issuePlans: [{
        issueId: firstIssue.issue.id,
        required: true,
        hypothesis: "Change the ordering.",
        tradeoffs: [],
        verificationPlan: firstIssue.issue.verification.summary,
        expectedArchitectureImpact: { summary: "Change the worker path.", targets: [] },
        verification: null,
      }],
    })).toThrowError(MutationRefused);

    expect(() => recordIssueDecision(second.study, {
      issueId: firstIssue.issue.id,
      expectedRevision: firstIssue.issue.revision,
      outcome: "dismissed",
      authority: "human",
    })).toThrowError(/historical baseline/i);
  });

  it("pins findings from a retained version to that version's baseline ancestry", () => {
    const first = importBaseline(pizzaStudy(), "snapshot-1", 1);
    const second = importBaseline(first.study, "snapshot-2", 2);
    const priorFinding = upsertIssue(second.study, {
      ...issueInput,
      title: "A prior-version evaluation found a regression",
      candidateId: first.candidate.id,
      evidence: [{ kind: "user-observation", observationId: "prior-evaluation" }],
    }, 3);

    expect(priorFinding.issue.baselineSnapshotId).toBe("snapshot-1");
    expect(issueStatus(priorFinding.issue, activeIssueBaseline(priorFinding.study))).toBe("historical");
  });

  it("protects CURRENT while allowing an unreferenced PRIOR baseline to be removed", () => {
    const first = importBaseline(pizzaStudy(), "snapshot-1", 1);
    const second = importBaseline(first.study, "snapshot-2", 2);

    expect(() => deleteCandidate(second.study, second.candidate.id)).toThrowError(/CURRENT source baseline/);

    const withoutPrior = deleteCandidate(second.study, first.candidate.id);
    expect(withoutPrior.activeRepositorySnapshotId).toBe("snapshot-2");
    expect(currentBaselineCandidate(withoutPrior)?.id).toBe(second.candidate.id);
    expect(withoutPrior.candidates.some((candidate) => candidate.id === first.candidate.id)).toBe(false);
  });
});
