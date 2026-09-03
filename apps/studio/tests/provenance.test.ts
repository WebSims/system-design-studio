import { describe, expect, it } from "vitest";
import { pizzaStudy } from "@sds/models";
import { performanceCalibration, type ArchitectureEvidence, type Study } from "@sds/schema";
import {
  latencyLabel,
  modelInputLabel,
  performanceInputState,
} from "../src/canvas/provenance";

describe("canvas model input provenance", () => {
  it("makes assumed and unsupported repository inputs explicit", () => {
    expect(modelInputLabel(true, "assumed")).toBe("assumed inputs");
    expect(modelInputLabel(true, "inferred")).toBe("inferred inputs");
    expect(modelInputLabel(true, "uncovered")).toBe("unverified inputs");
  });

  it("does not imply that a freehand preview was measured", () => {
    expect(modelInputLabel(false, undefined)).toBe("model preview");
    expect(modelInputLabel(true, "observed")).toBe("model preview");
  });

  it("distinguishes an explicit estimate from a missing timing", () => {
    expect(
      performanceInputState({
        repositoryLinked: true,
        calibrated: false,
        hasPerformanceEvidence: true,
        usable: true,
      })
    ).toBe("estimated");
    expect(latencyLabel(30, "estimated")).toBe("≈30ms");

    expect(
      performanceInputState({
        repositoryLinked: true,
        calibrated: false,
        hasPerformanceEvidence: false,
        usable: true,
      })
    ).toBe("unknown");
    expect(latencyLabel(30, "unknown")).toBe("?ms");
    expect(latencyLabel(0, "calibrated")).toBe("?ms");
  });
});

describe("repository performance calibration", () => {
  it("does not mistake code citations or assumed benchmarks for measurements", () => {
    const base = pizzaStudy();
    const candidate = structuredClone(base.candidates[0]!);
    const study: Study = {
      ...base,
      repository: {
        name: "checkout",
        rootHint: "",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: [],
        capturedAt: 1,
      },
      candidates: [candidate],
      activeCandidateId: candidate.id,
    };
    const targets = candidate.design.nodes.length + candidate.design.edges.length;
    expect(performanceCalibration(study, candidate).gaps).toHaveLength(targets);

    const assumed: ArchitectureEvidence = {
      id: "benchmark-only",
      targetKind: "edge",
      targetId: candidate.design.edges[0]!.id,
      aspect: "performance",
      confidence: "assumed",
      source: "documentation",
      path: "",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      claim: "A locality-matched benchmark is used as a placeholder.",
    };
    candidate.evidence = [assumed];
    expect(performanceCalibration(study, candidate).calibrated).toBe(false);
  });

  it("requires observed runtime or user evidence for every modeled target", () => {
    const base = pizzaStudy();
    const candidate = structuredClone(base.candidates[0]!);
    const targets = [
      ...candidate.design.nodes.map((node) => ({ kind: "node" as const, id: node.id })),
      ...candidate.design.edges.map((edge) => ({ kind: "edge" as const, id: edge.id })),
    ];
    candidate.evidence = targets.map((target, index) => ({
      id: `perf-${index}`,
      targetKind: target.kind,
      targetId: target.id,
      aspect: "performance",
      confidence: "observed",
      source: index % 2 ? "user" : "runtime",
      path: "",
      lineStart: null,
      lineEnd: null,
      symbol: "",
      claim: "Observed data supports this target's numeric inputs.",
    }));
    const study: Study = {
      ...base,
      repository: {
        name: "checkout",
        rootHint: "",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: [],
        capturedAt: 1,
      },
      candidates: [candidate],
      activeCandidateId: candidate.id,
    };
    expect(performanceCalibration(study, candidate)).toMatchObject({
      required: true,
      calibrated: true,
      gaps: [],
    });
  });

  it("does not let evidence relabel a zero timing sentinel as calibrated", () => {
    const base = pizzaStudy();
    const candidate = structuredClone(base.candidates[0]!);
    const server = candidate.design.nodes.find((node) => node.kind === "server")!;
    server.server!.serviceTime = { kind: "deterministic", value: 0 };
    candidate.evidence = [
      ...candidate.design.nodes.map((node, index) => ({
        id: `perf-node-${index}`,
        targetKind: "node" as const,
        targetId: node.id,
        aspect: "performance" as const,
        confidence: "observed" as const,
        source: "runtime" as const,
        path: "",
        lineStart: null,
        lineEnd: null,
        symbol: "",
        claim: "Observed performance data.",
      })),
      ...candidate.design.edges.map((edge, index) => ({
        id: `perf-edge-${index}`,
        targetKind: "edge" as const,
        targetId: edge.id,
        aspect: "performance" as const,
        confidence: "observed" as const,
        source: "runtime" as const,
        path: "",
        lineStart: null,
        lineEnd: null,
        symbol: "",
        claim: "Observed performance data.",
      })),
    ];
    const study: Study = {
      ...base,
      repository: {
        name: "checkout",
        rootHint: "",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: [],
        capturedAt: 1,
      },
      candidates: [candidate],
      activeCandidateId: candidate.id,
    };

    expect(performanceCalibration(study, candidate)).toMatchObject({
      calibrated: false,
      gaps: [expect.objectContaining({ targetKind: "node", targetId: server.id })],
    });
  });
});
