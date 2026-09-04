import { describe, expect, it } from "vitest";
import { pizzaStudy } from "@sds/models";
import {
  ArchitectureEvidenceSchema,
  RepositorySnapshotSchema,
  STUDY_SCHEMA_VERSION,
  StudySchema,
  contentHash,
  groundingReport,
  migrateAndParseStudy,
  walkOperations,
  type ArchitectureEvidence,
  type Candidate,
  type EvidenceTarget,
  type SourceInventoryItem,
} from "@sds/schema";

const SOURCE_HASH = "a".repeat(64);

function evidenceFor(target: EvidenceTarget, aspect: "architecture" | "behavior", index: number): ArchitectureEvidence {
  const targetId =
    target.kind === "node"
      ? target.nodeId
      : target.kind === "edge"
        ? target.edgeId
        : target.kind === "collection"
          ? target.collectionId
          : target.kind === "handler"
            ? target.handlerId
            : target.operationId;
  return ArchitectureEvidenceSchema.parse({
    id: `evidence-${aspect}-${index}`,
    target,
    targetKind: target.kind,
    targetId,
    aspect,
    confidence: "observed",
    source: "code",
    path: "src/system.ts",
    lineStart: 1,
    lineEnd: 3,
    symbol: "system",
    contentHash: SOURCE_HASH,
    claim: `Source establishes ${target.kind} ${targetId}.`,
  });
}

function groundedStudy() {
  const template = pizzaStudy();
  const design = structuredClone(template.candidates.at(-1)!.design);
  const architectureTargets: EvidenceTarget[] = [
    ...design.nodes.map((node) => ({ kind: "node" as const, nodeId: node.id })),
    ...design.edges.map((edge) => ({ kind: "edge" as const, edgeId: edge.id })),
  ];
  const behaviorTargets: EvidenceTarget[] = [];
  for (const collection of design.workflow?.collections ?? []) {
    behaviorTargets.push({ kind: "collection", collectionId: collection.id });
  }
  for (const handler of design.workflow?.handlers ?? []) {
    behaviorTargets.push({ kind: "handler", handlerId: handler.id });
    walkOperations(handler.steps, (operation) => {
      behaviorTargets.push({ kind: "operation", handlerId: handler.id, operationId: operation.id });
    });
  }
  const evidence = [
    ...architectureTargets.map((target, index) => evidenceFor(target, "architecture", index)),
    ...behaviorTargets.map((target, index) => evidenceFor(target, "behavior", index)),
  ];
  const sourceInventory: SourceInventoryItem[] = [{
    id: "entrypoint",
    kind: "entrypoint",
    label: "public request",
    path: "src/system.ts",
    symbol: "system",
    contentHash: SOURCE_HASH,
    disposition: "modeled",
    target: architectureTargets[0]!,
    reason: "",
  }];
  const candidateBase: Candidate = {
    ...template.candidates.at(-1)!,
    role: "baseline",
    basedOnCandidateId: null,
    revision: 0,
    evidence,
    grounding: null,
    design,
  };
  const candidate: Candidate = {
    ...candidateBase,
    grounding: {
      repositorySnapshotId: "repo-1",
      policyVersion: 1,
      sourceInventory,
      receipt: {
        repositorySnapshotId: "repo-1",
        policyVersion: 1,
        candidateRevision: candidateBase.revision,
        designHash: contentHash(candidateBase.design),
        inventoryHash: contentHash(sourceInventory),
        evidenceHash: contentHash(evidence),
        sealedAt: 10,
      },
    },
  };
  const study = StudySchema.parse({
    ...template,
    candidates: [candidate],
    activeCandidateId: candidate.id,
    promotedCandidateId: null,
    approval: null,
    repositorySnapshots: [{
      id: "repo-1",
      name: "checkout",
      rootHint: "",
      branch: "main",
      revision: "abc123",
      dirty: false,
      scope: ["src"],
      excludedScope: ["docs"],
      changedPaths: [],
      workingTreeFingerprint: "",
      capturedAt: 10,
    }],
    activeRepositorySnapshotId: "repo-1",
  });
  return { study, candidate: study.candidates[0]! };
}

describe("repository grounding", () => {
  it("grounds a complete source inventory and every architecture and behavior target", () => {
    const { study, candidate } = groundedStudy();
    expect(groundingReport(study, candidate)).toMatchObject({
      status: "grounded",
      eligibleForApproval: true,
      architecture: { required: candidate.design.nodes.length + candidate.design.edges.length },
      inventory: { total: 1, unresolved: 0 },
      gaps: [],
    });
  });

  it("never treats documentation or assumed claims as qualifying evidence", () => {
    const { study, candidate } = groundedStudy();
    const documentation = structuredClone(candidate);
    documentation.evidence[0] = { ...documentation.evidence[0]!, source: "documentation" };
    documentation.grounding!.receipt.evidenceHash = contentHash(documentation.evidence);
    expect(groundingReport({ ...study, candidates: [documentation] }, documentation).status).toBe("provisional");

    const assumed = structuredClone(candidate);
    assumed.evidence[0] = { ...assumed.evidence[0]!, confidence: "assumed" };
    assumed.grounding!.receipt.evidenceHash = contentHash(assumed.evidence);
    expect(groundingReport({ ...study, candidates: [assumed] }, assumed).status).toBe("provisional");
  });

  it("detects a receipt made stale by any source-model change", () => {
    const { study, candidate } = groundedStudy();
    const changed = structuredClone(candidate);
    changed.design.name = "changed after sealing";
    expect(groundingReport({ ...study, candidates: [changed] }, changed).gaps).toContainEqual(
      expect.objectContaining({ code: "receipt-stale" })
    );
  });

  it("requires dirty snapshots to identify their base, changed paths and fingerprint", () => {
    expect(() => RepositorySnapshotSchema.parse({
      id: "dirty",
      name: "repo",
      dirty: true,
      capturedAt: 1,
    })).toThrow(/base revision|fingerprint|changed-path/);
  });

  it("stores references and hashes, not source excerpts or absolute paths", () => {
    const { candidate } = groundedStudy();
    const evidence = candidate.evidence[0]!;
    expect(() => ArchitectureEvidenceSchema.parse({ ...evidence, excerpt: "secret source" })).toThrow();
    expect(() => ArchitectureEvidenceSchema.parse({ ...evidence, path: "/tmp/source.ts" })).toThrow(/repository-relative/);
  });

  it("migrates v2 repository projects as readable legacy-unverified baselines", () => {
    const { study, candidate } = groundedStudy();
    const raw = JSON.parse(JSON.stringify(study)) as Record<string, unknown>;
    raw.version = 2;
    raw.repository = { ...study.repositorySnapshots[0] };
    delete (raw.repository as Record<string, unknown>).id;
    delete (raw.repository as Record<string, unknown>).excludedScope;
    delete (raw.repository as Record<string, unknown>).changedPaths;
    delete (raw.repository as Record<string, unknown>).workingTreeFingerprint;
    delete raw.repositorySnapshots;
    delete raw.activeRepositorySnapshotId;
    for (const item of raw.candidates as Array<Record<string, unknown>>) delete item.grounding;

    const migrated = migrateAndParseStudy(raw);
    expect(migrated.version).toBe(STUDY_SCHEMA_VERSION);
    expect(migrated.repositorySnapshots).toHaveLength(1);
    expect(migrated.candidates[0]!.grounding).toBeNull();
    expect(groundingReport(migrated, migrated.candidates[0]!)).toMatchObject({
      status: "legacy-unverified",
      eligibleForApproval: false,
    });
    expect(migrated.candidates[0]!.design).toEqual(candidate.design);
  });

  it("preserves dirty-state and pathless v2 evidence without pretending it is grounded", () => {
    const { study } = groundedStudy();
    const raw = JSON.parse(JSON.stringify(study)) as Record<string, unknown>;
    raw.version = 2;
    raw.repository = { ...study.repositorySnapshots[0], dirty: true };
    delete (raw.repository as Record<string, unknown>).id;
    delete (raw.repository as Record<string, unknown>).excludedScope;
    delete (raw.repository as Record<string, unknown>).changedPaths;
    delete (raw.repository as Record<string, unknown>).workingTreeFingerprint;
    delete raw.repositorySnapshots;
    delete raw.activeRepositorySnapshotId;
    const candidates = raw.candidates as Array<Record<string, unknown>>;
    delete candidates[0]!.grounding;
    const evidence = candidates[0]!.evidence as Array<Record<string, unknown>>;
    delete evidence[0]!.path;

    const migrated = migrateAndParseStudy(raw);
    expect(migrated.repositorySnapshots[0]).toMatchObject({
      dirty: true,
      changedPaths: ["legacy-unavailable"],
      workingTreeFingerprint: "legacy-unavailable",
    });
    expect(migrated.candidates[0]!.evidence[0]!.path).toBe("legacy-unavailable");
    expect(groundingReport(migrated, migrated.candidates[0]!).status).toBe("legacy-unverified");
  });
});
