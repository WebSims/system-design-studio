import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pizzaStudy } from "@sds/models";
import {
  candidateIssueReadiness,
  candidateIssueVerificationStatus,
  StudySchema,
  type CandidateIssuePlan,
  type Issue,
  type Study,
} from "@sds/schema";
import { applyCandidateIssueEvaluation, evaluateCandidate } from "@sds/study";
import {
  MutationRefused,
  createCandidate,
  createCandidateAlternatives,
  promoteCandidate,
  recordCandidateIssueVerification,
  replaceCandidateDraft,
  upsertIssue,
} from "../src/study/mutations";

function addIssue(
  study: Study,
  options: { kind?: "correctness" | "performance" | "manual"; severity?: "critical" | "warning"; candidateId?: string } = {}
): { study: Study; issue: Issue } {
  return upsertIssue(study, {
    title: `Concurrent allocation can violate inventory (${options.candidateId ?? "shared"})`,
    description: "Two requests can observe the same remaining value.",
    source: "user",
    severity: options.severity ?? "warning",
    category: options.kind === "performance" ? "performance" : "correctness",
    candidateId: options.candidateId ?? null,
    targets: [],
    evidence: [{ kind: "user-observation", observationId: `obs-${options.candidateId ?? "shared"}` }],
    verification: {
      kind: options.kind ?? "correctness",
      summary: "Run the bounded concurrent request check.",
      requiredSignals: ["No invariant violation within exhausted bounds."],
    },
    by: "human",
  }, 100);
}

function planFor(issue: Issue): CandidateIssuePlan {
  return {
    issueId: issue.id,
    required: true,
    hypothesis: "An atomic write removes the read/write race.",
    tradeoffs: ["The datastore does more coordination."],
    verificationPlan: issue.verification.summary,
    expectedArchitectureImpact: { summary: "Replace the racy write path.", targets: issue.targets },
    verification: null,
  };
}

function fixCandidate(study: Study, issue: Issue, copyFrom = "c7-atomic-decrement-unique-claim") {
  return createCandidate(study, {
    label: "atomic inventory fix",
    copyFrom,
    origin: "human",
    candidateType: "repository-fix",
    issuePlans: [planFor(issue)],
  });
}

describe("issue-linked candidates", () => {
  it("requires a registered issue for repository fixes while retaining explicit explorations", () => {
    const study = pizzaStudy();
    expect(() => createCandidate(study, {
      label: "unfounded fix",
      copyFrom: study.candidates[0]!.id,
      origin: "agent",
      candidateType: "repository-fix",
      issuePlans: [],
    })).toThrowError(MutationRefused);

    const exploration = createCandidate(study, {
      label: "capacity exploration",
      copyFrom: study.candidates[0]!.id,
      origin: "agent",
      candidateType: "exploration",
    }).candidate;
    expect(exploration.candidateType).toBe("exploration");
    expect(exploration.issuePlans).toEqual([]);
  });

  it("creates several agent alternatives atomically without accepting verification authority", () => {
    const registered = addIssue(pizzaStudy());
    const proposal = planFor(registered.issue);
    const result = createCandidateAlternatives(registered.study, [
      { label: "transaction", copyFrom: "c6-serializable-transaction", origin: "agent", candidateType: "repository-fix", issuePlans: [proposal] },
      { label: "guarded decrement", copyFrom: "c7-atomic-decrement-unique-claim", origin: "agent", candidateType: "repository-fix", issuePlans: [proposal] },
    ]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.origin === "agent")).toBe(true);
    expect(result.candidates.map((candidate) => candidate.issuePlans[0]!.issueId)).toEqual([
      registered.issue.id,
      registered.issue.id,
    ]);

    expect(() => createCandidate(registered.study, {
      label: "self-certified",
      copyFrom: "c7-atomic-decrement-unique-claim",
      origin: "agent",
      candidateType: "repository-fix",
      issuePlans: [{
        ...proposal,
        verification: {
          status: "passed",
          authority: "check",
          candidateRevision: 0,
          issueRevision: registered.issue.revision,
          baselineSnapshotId: registered.issue.baselineSnapshotId,
          baselineRevision: registered.issue.baselineRevision,
          evaluationHash: "invented",
          notes: "",
          recordedAt: 1,
        },
      }],
    })).toThrowError(/cannot supply candidate verification/i);

    expect(() => createCandidate(registered.study, {
      label: "optionalized",
      copyFrom: "c7-atomic-decrement-unique-claim",
      origin: "agent",
      candidateType: "repository-fix",
      issuePlans: [{ ...proposal, required: false }],
    })).toThrowError(/cannot make a selected repository issue optional/i);
  });

  it("records deterministic check results and invalidates them after an architecture revision", () => {
    const registered = addIssue(pizzaStudy());
    const created = fixCandidate(registered.study, registered.issue);
    const evaluation = evaluateCandidate(created.study, created.candidate, {
      skipPerformance: true,
      clock: () => 200,
    });
    const evaluated = applyCandidateIssueEvaluation(created.study, evaluation, 200);
    const candidate = evaluated.candidates.find((item) => item.id === created.candidate.id)!;
    expect(candidateIssueVerificationStatus(evaluated, candidate, candidate.issuePlans[0]!)).toBe("passed");
    expect(candidate.issuePlans[0]!.verification).toMatchObject({
      authority: "check",
      candidateRevision: candidate.revision,
      issueRevision: registered.issue.revision,
      baselineRevision: registered.issue.baselineRevision,
    });
    expect(candidate.issuePlans[0]!.verification!.evaluationHash).not.toBe("");

    const edited = replaceCandidateDraft(evaluated, {
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      design: candidate.design,
      by: "human",
    });
    expect(candidateIssueVerificationStatus(edited.study, edited.candidate, edited.candidate.issuePlans[0]!)).toBe("pending");
  });

  it("keeps manual verification human-only and gates approval on current issue results", () => {
    const registered = addIssue(pizzaStudy(), { kind: "manual" });
    const created = fixCandidate(registered.study, registered.issue);
    expect(() => promoteCandidate(created.study, created.candidate.id)).toThrowError(/cannot be approved/i);
    expect(() => recordCandidateIssueVerification(created.study, {
      candidateId: created.candidate.id,
      issueId: registered.issue.id,
      expectedCandidateRevision: created.candidate.revision,
      expectedIssueRevision: registered.issue.revision,
      status: "manual",
      authority: "agent",
    })).toThrowError(/agents cannot verify/i);

    const checked = recordCandidateIssueVerification(created.study, {
      candidateId: created.candidate.id,
      issueId: registered.issue.id,
      expectedCandidateRevision: created.candidate.revision,
      expectedIssueRevision: registered.issue.revision,
      status: "manual",
      authority: "human",
      notes: "Reviewed the trace and implementation contract.",
      now: 300,
    });
    expect(candidateIssueReadiness(checked.study, checked.candidate).ready).toBe(true);
    expect(promoteCandidate(checked.study, checked.candidate.id, 400).promotedCandidateId).toBe(checked.candidate.id);
  });

  it("blocks approval when a candidate-specific critical regression remains open", () => {
    const base = pizzaStudy();
    const exploration = createCandidate(base, {
      label: "regressed option",
      copyFrom: base.candidates[0]!.id,
      origin: "human",
    });
    const registered = addIssue(exploration.study, {
      severity: "critical",
      candidateId: exploration.candidate.id,
    });
    expect(candidateIssueReadiness(registered.study, exploration.candidate).criticalRegressionIssueIds).toEqual([
      registered.issue.id,
    ]);
    expect(() => promoteCandidate(registered.study, exploration.candidate.id)).toThrowError(/critical regression/i);
  });

  it("requires re-verification after an external implementation is re-imported at a new revision", () => {
    const repositoryBacked = StudySchema.parse({
      ...pizzaStudy(),
      repositorySnapshots: [{
        id: "source-r1",
        name: "service",
        rootHint: "services/api",
        branch: "main",
        revision: "r1",
        dirty: false,
        scope: ["src"],
        excludedScope: [],
        changedPaths: [],
        workingTreeFingerprint: "",
        capturedAt: 1,
      }],
      activeRepositorySnapshotId: "source-r1",
    });
    const registered = addIssue(repositoryBacked, { kind: "manual" });
    const created = fixCandidate(registered.study, registered.issue);
    const checked = recordCandidateIssueVerification(created.study, {
      candidateId: created.candidate.id,
      issueId: registered.issue.id,
      expectedCandidateRevision: created.candidate.revision,
      expectedIssueRevision: registered.issue.revision,
      status: "manual",
      authority: "human",
      now: 2,
    });
    expect(candidateIssueReadiness(checked.study, checked.candidate).ready).toBe(true);

    const reimported = StudySchema.parse({
      ...checked.study,
      repositorySnapshots: [...checked.study.repositorySnapshots, {
        ...checked.study.repositorySnapshots[0]!,
        id: "source-r2",
        revision: "r2",
        capturedAt: 3,
      }],
      activeRepositorySnapshotId: "source-r2",
    });
    const candidate = reimported.candidates.find((item) => item.id === checked.candidate.id)!;
    expect(candidateIssueVerificationStatus(reimported, candidate, candidate.issuePlans[0]!)).toBe("pending");
    expect(candidateIssueReadiness(reimported, candidate).ready).toBe(false);
  });

  it("renders a keyboard-readable issue-by-candidate matrix with explicit result marks", () => {
    const source = readFileSync(new URL("../src/views/CompareView.tsx", import.meta.url), "utf8");
    expect(source).toContain("Issue by candidate verification comparison");
    expect(source).toContain("<th scope=\"row\">");
    expect(source).toContain("ISSUE_RESULT_MARK");
    expect(source).toContain("record manual pass");
  });
});
