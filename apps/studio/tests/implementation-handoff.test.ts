import { describe, expect, it } from "vitest";
import { pizzaStudy } from "@sds/models";
import {
  activeRepositorySnapshot,
  StudySchema,
  blankStudy,
  evaluationKey,
  walkOperations,
  type ArchitectureEvidence,
  type Design,
  type Study,
} from "@sds/schema";
import { evaluateCandidate } from "@sds/study";
import { reimportPrompt } from "../src/codebase-prompt";
import { buildImplementationHandoff } from "../src/implementation-handoff";
import {
  createCandidate,
  importRepositoryArchitecture,
  promoteCandidate,
  releaseApproval,
  replaceCandidateDraft,
} from "../src/study/mutations";
import { compareDesignTopology } from "../src/topology";

type RepositoryFixture = {
  study: Study;
  baselineId: string;
  experimentId: string;
  changedNodeId: string;
};

let cachedFixture: RepositoryFixture | null = null;
const SOURCE_HASH = "a".repeat(64);

function targetEvidence(
  design: Design,
  aspect: "architecture" | "performance",
  prefix: string
): ArchitectureEvidence[] {
  return [
    ...design.nodes.map((node, index) => ({
      id: `${prefix}-node-${index}`,
      targetKind: "node" as const,
      targetId: node.id,
      target: { kind: "node" as const, nodeId: node.id },
      aspect,
      confidence: "observed" as const,
      source: aspect === "performance" ? ("runtime" as const) : ("code" as const),
      path: aspect === "architecture" ? "src/checkout.ts" : "",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      contentHash: aspect === "architecture" ? SOURCE_HASH : "",
      claim:
        aspect === "performance"
          ? `runtime measurement supports ${node.label}'s performance inputs`
          : `source establishes the ${node.label} component`,
    })),
    ...design.edges.map((edge, index) => ({
      id: `${prefix}-edge-${index}`,
      targetKind: "edge" as const,
      targetId: edge.id,
      target: { kind: "edge" as const, edgeId: edge.id },
      aspect,
      confidence: "observed" as const,
      source: aspect === "performance" ? ("runtime" as const) : ("code" as const),
      path: aspect === "architecture" ? "src/checkout.ts" : "",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      contentHash: aspect === "architecture" ? SOURCE_HASH : "",
      claim:
        aspect === "performance"
          ? `runtime measurement supports ${edge.id}'s latency`
          : `source establishes the ${edge.from} to ${edge.to} dependency`,
    })),
  ];
}

function behaviorEvidence(design: Design): ArchitectureEvidence[] {
  const workflow = design.workflow;
  if (!workflow) return [];
  const evidence: ArchitectureEvidence[] = [
    ...workflow.collections.map((collection, index) => ({
      id: `behaviour-collection-${index}`,
      target: { kind: "collection" as const, collectionId: collection.id },
      targetKind: "collection" as const,
      targetId: collection.id,
      aspect: "behavior" as const,
      confidence: "observed" as const,
      source: "code" as const,
      path: "src/checkout.ts",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      contentHash: SOURCE_HASH,
      claim: `source establishes collection ${collection.id}`,
    })),
    ...workflow.handlers.map((handler, index) => ({
      id: `behaviour-handler-${index}`,
      target: { kind: "handler" as const, handlerId: handler.id },
      targetKind: "handler" as const,
      targetId: handler.id,
      aspect: "behavior" as const,
      confidence: "observed" as const,
      source: "code" as const,
      path: "src/checkout.ts",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      contentHash: SOURCE_HASH,
      claim: `source establishes handler ${handler.id}`,
    })),
  ];
  for (const handler of workflow.handlers) {
    walkOperations(handler.steps, (operation) => evidence.push({
      id: `behaviour-operation-${handler.id}-${operation.id}`,
      target: { kind: "operation", handlerId: handler.id, operationId: operation.id },
      targetKind: "operation",
      targetId: operation.id,
      aspect: "behavior",
      confidence: "observed",
      source: "code",
      path: "src/checkout.ts",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      contentHash: SOURCE_HASH,
      claim: `source establishes operation ${operation.id}`,
    }));
  }
  return evidence;
}

function repositoryStudy(): RepositoryFixture {
  if (cachedFixture) return structuredClone(cachedFixture);
  const template = pizzaStudy();
  const sourceDesign = structuredClone(
    template.candidates.find(
      (candidate) => candidate.id === "c7-atomic-decrement-unique-claim"
    )!.design
  );
  const changedNodeId = sourceDesign.nodes[0]!.id;
  const study = StudySchema.parse({
    ...blankStudy({ id: "checkout-study" }),
    name: "checkout-service",
    problem: template.problem,
    contract: template.contract,
    workload: template.workload,
    targets: template.targets,
    correctness: template.correctness,
  });
  const imported = importRepositoryArchitecture(study, {
    repository: {
      id: "repo-abc123",
      name: "checkout-service",
      rootHint: "services/checkout",
      branch: "main",
      revision: "abc123",
      dirty: false,
      scope: ["src"],
      excludedScope: [],
      changedPaths: [],
      workingTreeFingerprint: "",
      capturedAt: 100,
    },
    label: "As-is checkout",
    design: sourceDesign,
    evidence: [
      {
        id: "ev-entry",
        targetKind: "node",
        targetId: changedNodeId,
        target: { kind: "node", nodeId: changedNodeId },
        aspect: "architecture",
        confidence: "observed",
        source: "code",
        path: "src/checkout.ts",
        lineStart: 20,
        lineEnd: 38,
        symbol: "checkout",
        contentHash: SOURCE_HASH,
        claim: "The request enters this component.",
      },
      ...targetEvidence(sourceDesign, "architecture", "architecture"),
      ...behaviorEvidence(sourceDesign),
      ...targetEvidence(sourceDesign, "performance", "perf"),
    ],
    sourceInventory: [{
      id: "checkout-entrypoint",
      kind: "entrypoint",
      label: "checkout request",
      path: "src/checkout.ts",
      symbol: "checkout",
      contentHash: SOURCE_HASH,
      disposition: "modeled",
      target: { kind: "node", nodeId: changedNodeId },
      reason: "",
    }],
    origin: "human",
  });
  const created = createCandidate(imported.study, {
    label: "Approved checkout",
    copyFrom: imported.candidate.id,
    origin: "human",
  });
  const nextDesign = structuredClone(created.candidate.design);
  nextDesign.nodes[0] = {
    ...nextDesign.nodes[0]!,
    label: `${nextDesign.nodes[0]!.label} with admission control`,
  };
  const changed = replaceCandidateDraft(created.study, {
    candidateId: created.candidate.id,
    expectedRevision: created.candidate.revision,
    design: nextDesign,
    by: "human",
  });
  const evaluation = evaluateCandidate(changed.study, changed.candidate);
  const key = evaluationKey({
    candidateHash: evaluation.candidateHash,
    engineVersion: evaluation.engineVersion,
    seeds: evaluation.seeds,
    boundsHash: evaluation.boundsHash,
  });
  cachedFixture = {
    study: {
      ...changed.study,
      evaluations: { ...changed.study.evaluations, [key]: evaluation },
    },
    baselineId: imported.candidate.id,
    experimentId: changed.candidate.id,
    changedNodeId,
  };
  return structuredClone(cachedFixture);
}

describe("implementation handoff", () => {
  it("stays blocked until a repository-backed experiment is approved", () => {
    expect(buildImplementationHandoff(blankStudy({ id: "blank" }))).toMatchObject({
      status: "blocked",
      code: "repository-unlinked",
    });

    const fixture = repositoryStudy();
    expect(buildImplementationHandoff(fixture.study)).toMatchObject({
      status: "blocked",
      code: "approval-required",
    });
  });

  it("returns the exact revision-pinned delta, evidence, and acceptance contract", () => {
    const fixture = repositoryStudy();
    const approved = promoteCandidate(fixture.study, fixture.experimentId, 500);
    const result = buildImplementationHandoff(approved);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    expect(result.approval).toEqual({
      candidateId: fixture.experimentId,
      candidateRevision: 1,
      baselineCandidateId: fixture.baselineId,
      baselineRevision: 0,
      approvedAt: 500,
    });
    expect(result.repository.revision).toBe("abc123");
    expect(result.delta.summary.implementationChanges).toBe(1);
    expect(result.delta.nodes).toEqual([
      expect.objectContaining({
        id: fixture.changedNodeId,
        status: "changed",
        changedFields: ["label"],
        implementationRelevant: true,
      }),
    ]);
    expect(result.delta.nodes[0]!.before?.label).not.toBe(result.delta.nodes[0]!.after?.label);
    expect(result.sourcePaths).toEqual(["src/checkout.ts"]);
    expect(result.sourceHints[0]).toMatchObject({ from: ["baseline", "approved"] });
    expect(result.acceptance.problem).toBe(approved.problem);
    expect(result.acceptance.currentEvaluation.correctness?.status).toBe(
      "NO_VIOLATION_WITHIN_BOUNDS"
    );
    expect(result.implementationPrompt).toContain("studio_get_implementation_handoff");
    expect(result.implementationPrompt).toContain("Do not deploy");
  });

  it("refuses stale receipts and experiments with no code-facing delta", () => {
    const fixture = repositoryStudy();
    const approved = promoteCandidate(fixture.study, fixture.experimentId);
    const stale: Study = {
      ...approved,
      candidates: approved.candidates.map((candidate) =>
        candidate.id === fixture.experimentId
          ? { ...candidate, revision: candidate.revision + 1 }
          : candidate
      ),
    };
    expect(buildImplementationHandoff(stale)).toMatchObject({
      status: "blocked",
      code: "approval-stale",
    });

    const imported = importRepositoryArchitecture(blankStudy({ id: "unchanged" }), {
      repository: { ...activeRepositorySnapshot(approved)!, id: "repo-identical" },
      label: "As-is",
      design: pizzaStudy().candidates[0]!.design,
      evidence: [
        ...targetEvidence(pizzaStudy().candidates[0]!.design, "architecture", "identical-architecture"),
        ...behaviorEvidence(pizzaStudy().candidates[0]!.design),
      ],
      sourceInventory: [{
        id: "entrypoint",
        kind: "entrypoint",
        label: "request",
        path: "src/checkout.ts",
        symbol: "",
        contentHash: SOURCE_HASH,
        disposition: "modeled",
        target: { kind: "node", nodeId: pizzaStudy().candidates[0]!.design.nodes[0]!.id },
        reason: "",
      }],
      origin: "human",
    });
    const copy = createCandidate(imported.study, {
      label: "Identical experiment",
      copyFrom: imported.candidate.id,
      origin: "human",
    });
    expect(
      buildImplementationHandoff(promoteCandidate(copy.study, copy.candidate.id))
    ).toMatchObject({
      status: "blocked",
      code: "no-code-delta",
    });
  });

  it("does not turn an unevaluated approval receipt into implementation authority", () => {
    const fixture = repositoryStudy();
    const withoutResults: Study = { ...fixture.study, evaluations: {} };
    const approved = promoteCandidate(withoutResults, fixture.experimentId);
    expect(buildImplementationHandoff(approved)).toMatchObject({
      status: "blocked",
      code: "evaluation-required",
    });
  });

  /**
   * The step after the hand-off. An agent's import into an approved project is refused, so a
   * person releases the approval; the re-import then lands as a new baseline, and the diff
   * between it and the approved version is what says whether the change landed as signed off.
   */
  it("lets a person release the approval so the agent can re-import at the new commit, and the diff shows what landed", () => {
    const fixture = repositoryStudy();
    const approved = promoteCandidate(fixture.study, fixture.experimentId, 500);
    const approvedCandidate = approved.candidates.find((c) => c.id === fixture.experimentId)!;

    // Still approved: the agent is refused.
    expect(() =>
      importRepositoryArchitecture(approved, {
        repository: { ...activeRepositorySnapshot(approved)!, id: "repo-def456-refused", revision: "def456", capturedAt: 900 },
        label: "as built @def456",
        design: approvedCandidate.design,
        origin: "agent",
      })
    ).toThrow(/approved/);

    const released = releaseApproval(approved, 600);
    expect(released.promotedCandidateId).toBeNull();
    expect(released.approval).toBeNull();
    // Results are kept; only the decision is withdrawn.
    expect(Object.keys(released.evaluations)).toEqual(Object.keys(approved.evaluations));
    expect(buildImplementationHandoff(released)).toMatchObject({ status: "blocked", code: "approval-required" });

    // The agent built almost what was approved, but the measured shape of one link differs.
    const asBuiltDesign = structuredClone(approvedCandidate.design);
    const changedEdge = asBuiltDesign.edges.at(-1)!;
    changedEdge.latency = { kind: "deterministic", value: 0.75 };
    const reimported = importRepositoryArchitecture(released, {
      repository: { ...activeRepositorySnapshot(released)!, id: "repo-def456", revision: "def456", capturedAt: 900 },
      label: "as built @def456",
      design: asBuiltDesign,
      evidence: targetEvidence(asBuiltDesign, "architecture", "as-built"),
      sourceInventory: [{
        id: "checkout-entrypoint",
        kind: "entrypoint",
        label: "checkout request",
        path: "src/checkout.ts",
        symbol: "",
        contentHash: SOURCE_HASH,
        disposition: "modeled",
        target: { kind: "node", nodeId: asBuiltDesign.nodes[0]!.id },
        reason: "",
      }],
      origin: "agent",
    });
    expect(reimported.candidate.role).toBe("baseline");
    expect(reimported.study.activeCandidateId).toBe(reimported.candidate.id);
    expect(activeRepositorySnapshot(reimported.study)?.revision).toBe("def456");
    // Order is creation order, so the as-built import sits after the approved version.
    const ids = reimported.study.candidates.map((c) => c.id);
    expect(ids.indexOf(reimported.candidate.id)).toBeGreaterThan(ids.indexOf(fixture.experimentId));

    const delta = compareDesignTopology(approvedCandidate.design, reimported.candidate.design);
    expect(delta.comparable).toBe(true);
    expect(delta.summary.edgesChanged).toBe(1);
    expect(delta.edges.find((e) => e.status === "changed")?.id).toBe(changedEdge.id);
    expect(delta.summary.nodesAdded + delta.summary.nodesRemoved + delta.summary.nodesChanged).toBe(0);
  });

  it("the re-import request names the approved version and forbids code edits", () => {
    const prompt = reimportPrompt({ id: "c-approved", label: "Approved checkout" }, { studyId: "checkout-study" });
    expect(prompt).toContain("studio_import_architecture");
    expect(prompt).toContain('studio_compare_candidates between the new import and the approved version c-approved ("Approved checkout")');
    expect(prompt).toContain("studio_annotate");
    expect(prompt).toContain("Do not edit code");
    expect(prompt).toContain("Project (study) id: checkout-study");
  });
});
