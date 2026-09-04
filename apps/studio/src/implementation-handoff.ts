import {
  activeRepositorySnapshot,
  activeIssueBaselineRevision,
  candidateIssueReadiness,
  candidateIssueVerificationStatus,
  contentHash,
  evidenceTargetKey,
  groundingReport,
  issueStatus,
  type ArchitectureEvidence,
  type Candidate,
  type CandidateEvaluation,
  type DesignApproval,
  type RepositorySnapshot,
  type SdsEdge,
  type SdsNode,
  type Study,
} from "@sds/schema";
import { assemblePortfolio, cachedEvaluation } from "@sds/study";
import { baselineAncestor } from "./study/mutations";
import { compareDesignTopology, type DesignDelta } from "./topology";

export type ImplementationHandoffBlocker =
  | "repository-unlinked"
  | "approval-required"
  | "approval-stale"
  | "experiment-required"
  | "baseline-required"
  | "baseline-stale"
  | "source-not-grounded"
  | "evaluation-required"
  | "approval-ineligible"
  | "issues-unverified"
  | "no-code-delta";

export interface BlockedImplementationHandoff {
  status: "blocked";
  code: ImplementationHandoffBlocker;
  message: string;
}

interface ArchitectureRevisionRef {
  candidateId: string;
  label: string;
  revision: number;
  designHash: string;
}

export interface ImplementationNodeChange {
  kind: "node";
  id: string;
  label: string;
  status: "added" | "removed" | "changed" | "moved";
  changedFields: string[];
  moved: boolean;
  implementationRelevant: boolean;
  before: SdsNode | null;
  after: SdsNode | null;
}

export interface ImplementationEdgeChange {
  kind: "edge";
  id: string;
  status: "added" | "removed" | "changed";
  changedFields: string[];
  implementationRelevant: true;
  before: SdsEdge | null;
  after: SdsEdge | null;
}

export interface ImplementationSourceHint extends ArchitectureEvidence {
  /** Which side of the approved comparison contained this evidence record. */
  from: Array<"baseline" | "approved">;
}

type HandoffCorrectness = Pick<
  NonNullable<CandidateEvaluation["correctness"]>,
  "status" | "claim" | "bounds" | "faults" | "invariantsChecked" | "modelErrors" | "assumptions"
> & { violatedInvariant: string | null };

export interface HandoffEvaluation {
  evaluationId: string;
  candidateRevision: number;
  candidateHash: string;
  engineVersion: string;
  seeds: number[];
  boundsHash: string;
  correctness: HandoffCorrectness | null;
  performance: CandidateEvaluation["performance"];
  business: CandidateEvaluation["business"];
  resources: CandidateEvaluation["resources"];
  scenarios: CandidateEvaluation["scenarios"];
  assumptions: string[];
  warnings: string[];
}

export interface ReadyImplementationHandoff {
  status: "ready";
  approval: DesignApproval;
  repository: RepositorySnapshot;
  baseline: ArchitectureRevisionRef;
  approvedDesign: ArchitectureRevisionRef & {
    intent: string;
    notes: string;
  };
  delta: {
    comparable: boolean;
    summary: DesignDelta["summary"] & {
      workflowChanged: boolean;
      implementationChanges: number;
      layoutOnlyChanges: number;
    };
    nodes: ImplementationNodeChange[];
    edges: ImplementationEdgeChange[];
    workflow: {
      changed: boolean;
      before: Candidate["design"]["workflow"];
      after: Candidate["design"]["workflow"];
    };
  };
  sourceHints: ImplementationSourceHint[];
  sourcePaths: string[];
  unmappedTargets: string[];
  acceptance: {
    problem: string;
    productContract: Study["contract"];
    workload: Study["workload"];
    targets: Study["targets"];
    invariants: Study["correctness"]["invariants"];
    currentEvaluation: HandoffEvaluation;
  };
  unresolvedFindings: Array<{
    id: string;
    label: string;
    status: "warning" | "critical" | "inconclusive";
    summary: string;
    recommendation: string;
    targetNodeId: string | null;
    targetEdgeId: string | null;
  }>;
  issueChanges: Array<{
    issueId: string;
    title: string;
    hypothesis: string;
    tradeoffs: string[];
    verificationPlan: string;
    verificationResult: "pending" | "passed" | "failed" | "inconclusive" | "manual" | "accepted-risk";
    architectureImpact: {
      summary: string;
      targets: string[];
      changedTargets: string[];
    };
  }>;
  warnings: string[];
  instructions: string[];
  implementationPrompt: string;
}

export type ImplementationHandoff =
  | BlockedImplementationHandoff
  | ReadyImplementationHandoff;

/**
 * Derive the exact code-facing consequence of the current human decision.
 *
 * The function writes nothing. Approval remains the UI's authority boundary; this merely turns a
 * pinned receipt into a payload that an agent can inspect and a person can audit.
 */
export function buildImplementationHandoff(study: Study): ImplementationHandoff {
  const repository = activeRepositorySnapshot(study);
  if (!repository) {
    return blocked(
      "repository-unlinked",
      "Link a repository and import an evidence-backed as-is architecture before creating a code handoff."
    );
  }
  if (!study.approval) {
    return blocked(
      "approval-required",
      study.promotedCandidateId
        ? "This choice predates revision-pinned approvals. Review and approve the experiment again."
        : "Approve an eligible experiment in the comparison gates. Agents can propose and test designs, but only a person can approve one."
    );
  }

  const approval = study.approval;
  const approved = study.candidates.find((candidate) => candidate.id === approval.candidateId);
  if (
    !approved ||
    study.promotedCandidateId !== approved.id ||
    approved.revision !== approval.candidateRevision
  ) {
    return blocked(
      "approval-stale",
      "The approved experiment no longer matches its receipt. Review the current revision and approve it again."
    );
  }
  if (approved.role !== "experiment") {
    return blocked(
      "experiment-required",
      "The as-is baseline describes existing code; approve an experiment with an authored change to create a handoff."
    );
  }
  if (approval.baselineCandidateId === null || approval.baselineRevision === null) {
    return blocked(
      "baseline-required",
      "The approved experiment has no as-is baseline in its ancestry. Create it from the imported baseline and approve that experiment."
    );
  }

  const baseline = study.candidates.find(
    (candidate) => candidate.id === approval.baselineCandidateId
  );
  const currentAncestor = baselineAncestor(study, approved.id);
  if (
    !baseline ||
    baseline.role !== "baseline" ||
    baseline.revision !== approval.baselineRevision ||
    currentAncestor?.id !== baseline.id
  ) {
    return blocked(
      "baseline-stale",
      "The as-is side of the approved comparison no longer matches its receipt. Re-scan or review the baseline, then approve again."
    );
  }
  const grounding = groundingReport(study, baseline);
  if (!grounding.eligibleForApproval) {
    return blocked(
      "source-not-grounded",
      `The as-is baseline is ${grounding.status}: ${grounding.gaps[0]?.message ?? "grounding is incomplete"}`
    );
  }
  const issueReadiness = candidateIssueReadiness(study, approved);
  if (!issueReadiness.ready) {
    return blocked(
      "issues-unverified",
      issueReadiness.criticalRegressionIssueIds.length > 0
        ? `Critical regression issues remain open: ${issueReadiness.criticalRegressionIssueIds.join(", ")}.`
        : `Required issues need current verification or accepted risk: ${issueReadiness.pendingIssueIds.join(", ")}.`
    );
  }

  const topology = compareDesignTopology(baseline.design, approved.design);
  const baselineNodes = new Map(baseline.design.nodes.map((node) => [node.id, node]));
  const approvedNodes = new Map(approved.design.nodes.map((node) => [node.id, node]));
  const baselineEdges = new Map(baseline.design.edges.map((edge) => [edge.id, edge]));
  const approvedEdges = new Map(approved.design.edges.map((edge) => [edge.id, edge]));
  const nodes: ImplementationNodeChange[] = topology.nodes.map((change) => ({
    ...change,
    implementationRelevant: change.status !== "moved",
    before: baselineNodes.get(change.id) ?? null,
    after: approvedNodes.get(change.id) ?? null,
  }));
  const edges: ImplementationEdgeChange[] = topology.edges.map((change) => ({
    ...change,
    implementationRelevant: true,
    before: baselineEdges.get(change.id) ?? null,
    after: approvedEdges.get(change.id) ?? null,
  }));
  const workflowChanged = contentHash(baseline.design.workflow) !== contentHash(approved.design.workflow);
  const implementationChanges =
    nodes.filter((change) => change.implementationRelevant).length +
    edges.length +
    (workflowChanged ? 1 : 0);
  if (implementationChanges === 0) {
    return blocked(
      "no-code-delta",
      "The approved experiment only changes canvas layout or presentation. There is no architecture or behavior delta to implement in code."
    );
  }

  const evaluation = cachedEvaluation(study, approved);
  if (!evaluation) {
    return blocked(
      "evaluation-required",
      "No current evaluation matches the approved revision and project yardstick. Run the correctness and performance checks, then approve again."
    );
  }
  const decision = assemblePortfolio(study).decisions.find(
    (item) => item.candidateId === approved.id
  );
  if (!decision?.eligible) {
    const failedGate = decision?.gates.find((gate) => !gate.passed);
    return blocked(
      "approval-ineligible",
      failedGate
        ? `The approved revision no longer passes ${failedGate.gate.replace(/-/g, " ")}: ${failedGate.reason}`
        : "The approved revision is not eligible for implementation under the current project yardstick."
    );
  }

  const changedTargets = new Set<string>();
  for (const node of nodes) {
    if (node.implementationRelevant) changedTargets.add(`node:${node.id}`);
  }
  for (const edge of edges) changedTargets.add(`edge:${edge.id}`);
  const sourceHints = mergeSourceHints(baseline, approved, changedTargets);
  const sourcePaths = [...new Set(sourceHints.map((hint) => hint.path).filter(Boolean))].sort();
  const mappedTargets = new Set(
    sourceHints.filter((hint) => hint.path.length > 0).map((hint) => `${hint.targetKind}:${hint.targetId}`)
  );
  const unmappedTargets = [...changedTargets].filter((target) => !mappedTargets.has(target));
  if (workflowChanged) unmappedTargets.push("workflow");

  const currentEvaluation = compactHandoffEvaluation(evaluation);
  const unresolvedFindings = evaluation.scenarios
    .filter(
      (
        scenario
      ): scenario is typeof scenario & {
        status: "warning" | "critical" | "inconclusive";
      } => scenario.status !== "healthy"
    )
    .map((scenario) => ({
      id: scenario.id,
      label: scenario.label,
      status: scenario.status,
      summary: scenario.summary,
      recommendation: scenario.recommendation,
      targetNodeId: scenario.targetNodeId,
      targetEdgeId: scenario.targetEdgeId,
    }));

  const warnings = buildWarnings({
    repository,
    topology,
    unmappedTargets,
    unresolvedFindings,
  });
  const baselineRevision = activeIssueBaselineRevision(study);
  const issueChanges = approved.issuePlans.flatMap((plan) => {
    const issue = study.issueRegistry.find((item) => item.id === plan.issueId);
    if (!issue) return [];
    const disposition = issueStatus(issue, baselineRevision);
    const verificationResult = disposition === "accepted-risk"
      ? "accepted-risk" as const
      : candidateIssueVerificationStatus(study, approved, plan);
    const targets = plan.expectedArchitectureImpact.targets.map(evidenceTargetKey);
    return [{
      issueId: issue.id,
      title: issue.title,
      hypothesis: plan.hypothesis,
      tradeoffs: plan.tradeoffs,
      verificationPlan: plan.verificationPlan,
      verificationResult,
      architectureImpact: {
        summary: plan.expectedArchitectureImpact.summary,
        targets,
        changedTargets: targets.filter((target) => changedTargets.has(target)),
      },
    }];
  });
  const handoff: Omit<ReadyImplementationHandoff, "implementationPrompt"> = {
    status: "ready",
    approval,
    repository,
    baseline: revisionRef(baseline),
    approvedDesign: {
      ...revisionRef(approved),
      intent: approved.intent,
      notes: approved.notes,
    },
    delta: {
      comparable: topology.comparable,
      summary: {
        ...topology.summary,
        workflowChanged,
        implementationChanges,
        layoutOnlyChanges: nodes.filter((change) => !change.implementationRelevant).length,
      },
      nodes,
      edges,
      workflow: {
        changed: workflowChanged,
        before: workflowChanged ? baseline.design.workflow : null,
        after: workflowChanged ? approved.design.workflow : null,
      },
    },
    sourceHints,
    sourcePaths,
    unmappedTargets,
    acceptance: {
      problem: study.problem,
      productContract: study.contract,
      workload: study.workload,
      targets: study.targets,
      invariants: study.correctness.invariants,
      currentEvaluation,
    },
    unresolvedFindings,
    issueChanges,
    warnings,
    instructions: [
      "Verify the workspace still matches the recorded repository revision and dirty-state before editing.",
      "Treat source paths as search starting points, not proof that the source is unchanged; re-read the current code.",
      "Implement only the approved architecture and behavior delta, preserving the project contract and acceptance criteria.",
      "Add or update tests for the affected correctness invariants, SLO behavior, and production scenarios.",
      "Run the relevant checks and report changed files, evidence, remaining assumptions, and the resulting commit revision.",
      "Do not deploy. Re-scan the repository after verification before claiming the architecture is synchronized.",
    ],
  };

  return { ...handoff, implementationPrompt: buildImplementationPrompt(handoff) };
}

export function buildImplementationPrompt(
  handoff: Omit<ReadyImplementationHandoff, "implementationPrompt">
): string {
  const repositoryRevision = handoff.repository.revision || "not recorded";
  return [
    "Implement the human-approved architecture change currently open in System Design Studio.",
    "Use the page's `studio_get_implementation_handoff` site tool as the authoritative approval receipt and exact design delta.",
    `Approval: ${handoff.approvedDesign.candidateId}@r${handoff.approvedDesign.revision} from ${handoff.baseline.candidateId}@r${handoff.baseline.revision}.`,
    `Repository snapshot: ${repositoryRevision}; dirty state: ${String(handoff.repository.dirty)}.`,
    ...handoff.issueChanges.map((item) =>
      `Issue ${item.issueId} (${item.title}) → ${item.architectureImpact.summary} → ${item.verificationResult}. Verification: ${item.verificationPlan}`
    ),
    "Before editing, verify the workspace still matches that source state and re-read every relevant file; source paths in the handoff are hints, not authority.",
    "Implement only the approved component, link, and workflow changes. Preserve the listed product contract, invariants, SLOs, and business goals.",
    "Address or explicitly report every unresolved production finding. Add or update tests, then run the relevant checks.",
    "Report changed files, verification evidence, remaining assumptions, and the resulting commit revision. Do not deploy.",
    "After the code is verified, re-scan it before claiming the visual architecture is synchronized.",
  ].join("\n\n");
}

function blocked(
  code: ImplementationHandoffBlocker,
  message: string
): BlockedImplementationHandoff {
  return { status: "blocked", code, message };
}

function revisionRef(candidate: Candidate): ArchitectureRevisionRef {
  return {
    candidateId: candidate.id,
    label: candidate.label,
    revision: candidate.revision,
    designHash: contentHash(candidate.design),
  };
}

function mergeSourceHints(
  baseline: Candidate,
  approved: Candidate,
  changedTargets: Set<string>
): ImplementationSourceHint[] {
  const merged = new Map<string, ImplementationSourceHint>();
  const add = (evidence: ArchitectureEvidence, side: "baseline" | "approved") => {
    if (!changedTargets.has(`${evidence.targetKind}:${evidence.targetId}`)) return;
    const key = [
      evidence.targetKind,
      evidence.targetId,
      evidence.confidence,
      evidence.source,
      evidence.path,
      evidence.lineStart,
      evidence.lineEnd,
      evidence.symbol,
      evidence.claim,
    ].join("\u0000");
    const existing = merged.get(key);
    if (existing) {
      if (!existing.from.includes(side)) existing.from.push(side);
      return;
    }
    merged.set(key, { ...evidence, from: [side] });
  };

  for (const evidence of baseline.evidence) add(evidence, "baseline");
  for (const evidence of approved.evidence) add(evidence, "approved");
  return [...merged.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.targetKind.localeCompare(right.targetKind) ||
      left.targetId.localeCompare(right.targetId)
  );
}

function compactHandoffEvaluation(evaluation: CandidateEvaluation): HandoffEvaluation {
  const correctness = evaluation.correctness
    ? {
        status: evaluation.correctness.status,
        claim: evaluation.correctness.claim,
        bounds: evaluation.correctness.bounds,
        faults: evaluation.correctness.faults,
        invariantsChecked: evaluation.correctness.invariantsChecked,
        modelErrors: evaluation.correctness.modelErrors,
        assumptions: evaluation.correctness.assumptions,
        violatedInvariant: evaluation.correctness.counterexample?.invariantId ?? null,
      }
    : null;
  return {
    evaluationId: evaluation.evaluationId,
    candidateRevision: evaluation.candidateRevision,
    candidateHash: evaluation.candidateHash,
    engineVersion: evaluation.engineVersion,
    seeds: evaluation.seeds,
    boundsHash: evaluation.boundsHash,
    correctness,
    performance: evaluation.performance,
    business: evaluation.business,
    resources: evaluation.resources,
    scenarios: evaluation.scenarios,
    assumptions: evaluation.assumptions,
    warnings: evaluation.warnings,
  };
}

function buildWarnings(input: {
  repository: RepositorySnapshot;
  topology: DesignDelta;
  unmappedTargets: string[];
  unresolvedFindings: ReadyImplementationHandoff["unresolvedFindings"];
}): string[] {
  const warnings: string[] = [];
  if (!input.repository.revision) {
    warnings.push("The repository snapshot has no immutable revision. Verify the current source before editing.");
  }
  if (input.repository.dirty === true) {
    warnings.push("The as-is model includes uncommitted source changes.");
  } else if (input.repository.dirty === null) {
    warnings.push("Whether the imported source had uncommitted changes is unknown.");
  }
  if (!input.topology.comparable) {
    warnings.push("The designs share no stable component IDs; additions and removals are exact, but continuity is not.");
  }
  if (input.unmappedTargets.length > 0) {
    warnings.push(
      `${input.unmappedTargets.length} changed target${input.unmappedTargets.length === 1 ? " has" : "s have"} no direct source-path evidence.`
    );
  }
  const critical = input.unresolvedFindings.filter((finding) => finding.status === "critical").length;
  const inconclusive = input.unresolvedFindings.filter(
    (finding) => finding.status === "inconclusive"
  ).length;
  if (critical > 0) warnings.push(`${critical} production scenario${critical === 1 ? " remains" : "s remain"} critical.`);
  if (inconclusive > 0) {
    warnings.push(`${inconclusive} production scenario${inconclusive === 1 ? " is" : "s are"} inconclusive.`);
  }
  return warnings;
}
