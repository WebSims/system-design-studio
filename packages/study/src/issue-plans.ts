import {
  CandidateIssueVerificationSchema,
  CandidateSchema,
  StudySchema,
  activeIssueBaselineRevision,
  contentHash,
  issueStatus,
  syncCandidateToStudy,
  type Candidate,
  type CandidateEvaluation,
  type CandidateIssueVerificationStatus,
  type Issue,
  type Study,
} from "@sds/schema";

/** Map one trusted evaluation to the verification contract declared by an issue. */
function outcomeFor(
  study: Study,
  issue: Issue,
  evaluation: CandidateEvaluation
): CandidateIssueVerificationStatus | null {
  switch (issue.verification.kind) {
    case "manual":
      return null;
    case "grounding": {
      const status = issueStatus(issue, activeIssueBaselineRevision(study));
      return status === "verified" || status === "dismissed" ? "passed" : "inconclusive";
    }
    case "correctness":
      if (!evaluation.correctness) return "inconclusive";
      if (evaluation.correctness.status === "NO_VIOLATION_WITHIN_BOUNDS") return "passed";
      if (evaluation.correctness.status === "VIOLATED") return "failed";
      return "inconclusive";
    case "performance": {
      const performance = evaluation.performance;
      if (!performance) return "inconclusive";
      if (performance.unstable) return "failed";
      const slo = study.targets.slo;
      if (slo.p99LatencyMs !== null && performance.p99Ms.high > slo.p99LatencyMs) return "failed";
      if (slo.maxErrorRatePct !== null && performance.errorRatePct.high > slo.maxErrorRatePct) return "failed";
      return "passed";
    }
  }
}

/**
 * Persist per-issue check receipts without changing the architecture revision.
 * The receipt itself pins candidate, issue, source baseline and evaluation content; any later
 * edit makes the derived status pending. If an approved candidate's result changes, approval is
 * withdrawn because the human decision no longer describes the same verification record.
 */
export function applyCandidateIssueEvaluation(
  study: Study,
  evaluation: CandidateEvaluation,
  now = evaluation.createdAt || Date.now()
): Study {
  const candidate = study.candidates.find((item) => item.id === evaluation.candidateId);
  if (!candidate || candidate.issuePlans.length === 0) return study;
  if (
    candidate.revision !== evaluation.candidateRevision ||
    contentHash(syncCandidateToStudy(study, candidate).design) !== evaluation.candidateHash
  ) return study;
  const evaluationHash = contentHash(evaluation);
  const baselineRevision = activeIssueBaselineRevision(study);
  let changed = false;
  const issuePlans = candidate.issuePlans.map((plan) => {
    const issue = study.issueRegistry.find((item) => item.id === plan.issueId);
    if (!issue) return plan;
    const status = outcomeFor(study, issue, evaluation);
    if (status === null) return plan;
    const verification = CandidateIssueVerificationSchema.parse({
      status,
      authority: "check",
      candidateRevision: candidate.revision,
      issueRevision: issue.revision,
      baselineRevision,
      evaluationHash,
      notes: `Derived from ${issue.verification.kind} evaluation ${evaluation.evaluationId}.`,
      recordedAt: now,
    });
    const comparable = plan.verification ? { ...plan.verification, recordedAt: 0 } : null;
    if (contentHash(comparable) === contentHash({ ...verification, recordedAt: 0 })) return plan;
    changed = true;
    return { ...plan, verification };
  });
  if (!changed) return study;
  const revised: Candidate = CandidateSchema.parse({ ...candidate, issuePlans });
  const invalidatesApproval =
    study.promotedCandidateId === candidate.id || study.approval?.candidateId === candidate.id;
  return StudySchema.parse({
    ...study,
    ...(invalidatesApproval ? { promotedCandidateId: null, approval: null } : {}),
    candidates: study.candidates.map((item) => item.id === revised.id ? revised : item),
    updatedAt: now,
  });
}
