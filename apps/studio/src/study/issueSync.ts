import {
  activeIssueBaseline,
  contentHash,
  groundingReport,
  issueEvidenceRefKey,
  issueMatchesBaseline,
  issueStatus,
  walkOperations,
  type CandidateEvaluation,
  type EvidenceTarget,
  type Issue,
  type IssueEvidenceRef,
  type Study,
} from "@sds/schema";
import { recordIssueDecision, upsertIssue } from "./mutations";

const finishResolved = (
  study: Study,
  issue: Issue,
  evidence: IssueEvidenceRef,
  evaluationHash: string,
  now: number
): Study => {
  if (issueStatus(issue, activeIssueBaseline(study)) !== "open") return study;
  const updated = upsertIssue(study, {
    title: issue.title,
    description: issue.description,
    source: issue.source,
    severity: issue.severity,
    category: issue.category,
    candidateId: issue.candidateId,
    targets: issue.targets,
    evidence: [...issue.evidence, evidence],
    verification: issue.verification,
    by: "check",
  }, now);
  const key = issueEvidenceRefKey(evidence);
  return recordIssueDecision(updated.study, {
    issueId: updated.issue.id,
    expectedRevision: updated.issue.revision,
    outcome: "verified",
    authority: "check",
    candidateId: updated.issue.candidateId,
    evaluationHash,
    evidenceRefs: [key],
    reason: "A trusted application check satisfied the issue's verification contract.",
    now,
  }).study;
};

/** Persist grounding gaps and close only those a later computed report actually removes. */
export function syncGroundingIssues(study: Study, candidateId: string, now = Date.now()): Study {
  const candidate = study.candidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.role !== "baseline") return study;
  const report = groundingReport(study, candidate);
  const reportHash = contentHash(report);
  let next = study;
  const currentGapCodes = new Set<string>(report.gaps.map((gap) => gap.code));
  for (const gap of report.gaps) {
    const evidence: IssueEvidenceRef = {
      kind: "grounding-report",
      candidateId,
      reportHash,
      gapCode: gap.code,
    };
    next = upsertIssue(next, {
      title: `Grounding gap: ${gap.message}`,
      description: gap.message,
      source: "grounding-gap",
      severity: gap.code === "model-invalid" || gap.code === "snapshot-missing" ? "critical" : "warning",
      category: "grounding",
      candidateId,
      targets: gap.target ? [gap.target] : [],
      evidence: [evidence],
      verification: {
        kind: "grounding",
        summary: `The computed grounding report must no longer contain ${gap.code}.`,
        requiredSignals: ["fresh grounding receipt", "current repository snapshot"],
      },
      by: "check",
    }, now).study;
  }

  const resolved = next.issueRegistry.filter((issue) =>
    issue.source === "grounding-gap" &&
    issue.candidateId === candidateId &&
    issueMatchesBaseline(issue, activeIssueBaseline(next)) &&
    issue.evidence.some((reference) => reference.kind === "grounding-report" && !currentGapCodes.has(reference.gapCode))
  );
  for (const issue of resolved) {
    const original = issue.evidence.find((reference) => reference.kind === "grounding-report");
    if (!original || original.kind !== "grounding-report") continue;
    next = finishResolved(next, issue, {
      kind: "grounding-report",
      candidateId,
      reportHash,
      gapCode: original.gapCode,
    }, reportHash, now);
  }
  return next;
}

function operationTarget(study: Study, candidateId: string, operationId: string | undefined): EvidenceTarget[] {
  if (!operationId) return [];
  const candidate = study.candidates.find((item) => item.id === candidateId);
  for (const handler of candidate?.design.workflow?.handlers ?? []) {
    let found = false;
    walkOperations(handler.steps, (operation) => { if (operation.id === operationId) found = true; });
    if (found) return [{ kind: "operation", handlerId: handler.id, operationId }];
  }
  return [];
}

/** Fold correctness and production-check results into the same persistent registry. */
export function syncEvaluationIssues(study: Study, evaluation: CandidateEvaluation, now = Date.now()): Study {
  let next = study;
  const reference: IssueEvidenceRef = {
    kind: "evaluation",
    evaluationId: evaluation.evaluationId,
    candidateHash: evaluation.candidateHash,
  };
  const evaluationHash = contentHash(evaluation);
  const correctness = evaluation.correctness;
  if (correctness?.status === "VIOLATED" && correctness.counterexample) {
    const last = correctness.counterexample.steps.at(-1);
    next = upsertIssue(next, {
      title: `Rule violated: ${correctness.counterexample.invariantLabel}`,
      description: correctness.counterexample.message,
      source: "correctness-check",
      severity: "critical",
      category: "correctness",
      candidateId: evaluation.candidateId,
      targets: operationTarget(next, evaluation.candidateId, last?.opId),
      evidence: [reference],
      verification: {
        kind: "correctness",
        summary: `Re-run the bounded check and exhaust it without violating ${correctness.counterexample.invariantLabel}.`,
        requiredSignals: ["NO_VIOLATION_WITHIN_BOUNDS", "matching candidate and source snapshot"],
      },
      by: "check",
    }, now).study;
  } else if (correctness?.status === "NO_VIOLATION_WITHIN_BOUNDS" && correctness.stats.exhausted) {
    const open = next.issueRegistry.filter((issue) =>
      issue.source === "correctness-check" &&
      issue.candidateId === evaluation.candidateId &&
      issueMatchesBaseline(issue, activeIssueBaseline(next))
    );
    for (const issue of open) next = finishResolved(next, issue, reference, evaluationHash, now);
  } else if (correctness && correctness.status !== "NO_VIOLATION_WITHIN_BOUNDS") {
    next = upsertIssue(next, {
      title: `Correctness check inconclusive: ${correctness.status}`,
      description: correctness.claim || correctness.modelErrors.join(" "),
      source: "correctness-check",
      severity: "warning",
      category: "correctness",
      candidateId: evaluation.candidateId,
      evidence: [reference],
      verification: {
        kind: "correctness",
        summary: "Produce an exhausted, valid bounded correctness result.",
        requiredSignals: ["NO_VIOLATION_WITHIN_BOUNDS", "exhausted=true"],
      },
      by: "check",
    }, now).study;
  }

  if (evaluation.performance?.unstable) {
    next = upsertIssue(next, {
      title: "Simulation has no steady state",
      description: "The measured run was non-stationary at the configured workload.",
      source: "performance-analysis",
      severity: "critical",
      category: "scalability",
      candidateId: evaluation.candidateId,
      evidence: [reference],
      verification: {
        kind: "performance",
        summary: "A matching replicated evaluation must remain stable without a critical regression.",
        requiredSignals: ["performance.unstable=false"],
      },
      by: "check",
    }, now).study;
  }
  for (const scenario of evaluation.scenarios.filter((item) => item.status === "critical" || item.status === "warning")) {
    const targets: EvidenceTarget[] = scenario.targetNodeId
      ? [{ kind: "node", nodeId: scenario.targetNodeId }]
      : scenario.targetEdgeId
        ? [{ kind: "edge", edgeId: scenario.targetEdgeId }]
        : [];
    next = upsertIssue(next, {
      title: `Scenario ${scenario.status}: ${scenario.label}`,
      description: scenario.summary,
      source: "performance-analysis",
      severity: scenario.status === "critical" ? "critical" : "warning",
      category: "reliability",
      candidateId: evaluation.candidateId,
      targets,
      evidence: [reference],
      verification: {
        kind: "performance",
        summary: `Re-run ${scenario.label} without a warning or critical result.`,
        requiredSignals: ["matching production scenario is healthy"],
      },
      by: "check",
    }, now).study;
  }
  return next;
}

export interface AnalysisFindingInput {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  evidence: string;
  remediation: string;
  nodeId?: string;
  edgeId?: string;
}

/** Adapter for the load analyzer: prose stays descriptive; the stable analysis hash is evidence. */
export function syncAnalysisIssues(
  study: Study,
  candidateId: string,
  findings: readonly AnalysisFindingInput[],
  analysisHash: string,
  now = Date.now()
): Study {
  let next = study;
  for (const finding of findings) {
    const targets: EvidenceTarget[] = finding.nodeId
      ? [{ kind: "node", nodeId: finding.nodeId }]
      : finding.edgeId
        ? [{ kind: "edge", edgeId: finding.edgeId }]
        : [];
    next = upsertIssue(next, {
      title: finding.title,
      description: `${finding.evidence}\n\nSuggested remediation: ${finding.remediation}`.slice(0, 4000),
      source: "performance-analysis",
      severity: finding.severity,
      category: finding.id.includes("retry") || finding.id.includes("health") ? "reliability" : "performance",
      candidateId,
      targets,
      evidence: [{ kind: "analysis", analysisHash, findingId: finding.id }],
      verification: {
        kind: "performance",
        summary: "Re-run the analyzer after the design change and confirm this finding no longer appears.",
        requiredSignals: [`finding ${finding.id} absent`, "no critical regression"],
      },
      by: "check",
    }, now).study;
  }
  return next;
}
