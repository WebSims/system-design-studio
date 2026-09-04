import { describe, it, expect } from "vitest";
import {
  ArchitectureEvidenceSchema,
  CorrectnessContractSchema,
  DesignSchema,
  StudySchema,
  applyStudyContract,
  blankDesign,
  blankStudy,
  clearStudyResults,
  isPlaceholderWorkload,
  studyContractLock,
  validateDesign,
  validateStudy,
  type Study,
} from "@sds/schema";
import { assemblePortfolio } from "@sds/study";

/**
 * The empty study is the product's first screen, so it has to be a first-class document rather
 * than a special case the rest of the code works around. Everything here is about the path a new
 * user actually takes: open the app, then define a problem.
 */
describe("the placeholder workload", () => {
  it("is what a blank study is born with, and is recognised by value", () => {
    const study = blankStudy({ id: "s1" });
    expect(isPlaceholderWorkload(study.workload)).toBe(true);
    // Key order does not matter: a saved document may come back reordered.
    const reordered = JSON.parse(JSON.stringify({ ...study.workload, arrival: { ratePerSec: 50, kind: "poisson" } }));
    expect(isPlaceholderWorkload(reordered)).toBe(true);
  });

  it("stops being the placeholder when any field changes", () => {
    const study = blankStudy({ id: "s1" });
    expect(isPlaceholderWorkload({ ...study.workload, durationSec: 600 })).toBe(false);
    expect(isPlaceholderWorkload({ ...study.workload, arrival: { kind: "poisson", ratePerSec: 51 } })).toBe(false);
    expect(isPlaceholderWorkload(applyStudyContract(study, { workload: { seeds: [1, 2] } }).workload)).toBe(false);
  });

  it("is not the placeholder when the study is created with its workload", () => {
    const study = blankStudy({ id: "s1", workload: { arrival: { kind: "deterministic", ratePerSec: 12 } } });
    expect(isPlaceholderWorkload(study.workload)).toBe(false);
    expect(study.workload.durationSec).toBe(1200);
    expect(() => StudySchema.parse(study)).not.toThrow();
  });

  it("the lock explains that versions share the yardstick", () => {
    const study = blankStudy({ id: "s1" });
    const locked = { ...study, evaluations: { k: {} as never } };
    expect(() => applyStudyContract(locked, { workload: { durationSec: 5 } })).toThrow(/new version cannot change it/);
  });
});

describe("the empty study", () => {
  it("is a valid study, so nothing downstream needs an empty-case branch", () => {
    const study = blankStudy({ id: "s1" });
    expect(() => StudySchema.parse(study)).not.toThrow();
    expect(study.repositorySnapshots).toEqual([]);
    expect(study.activeRepositorySnapshotId).toBeNull();
    expect(study.issueRegistry).toEqual([]);
    expect(study.candidates).toEqual([]);
    expect(validateStudy(study)).toEqual([]);
  });

  it("stores the repository revision an architecture snapshot came from", () => {
    const study = StudySchema.parse({
      ...blankStudy({ id: "s1", now: 12 }),
      repositorySnapshots: [{
        id: "repo-1",
        name: "checkout-service",
        rootHint: "services/checkout",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: [],
        excludedScope: [],
        changedPaths: [],
        workingTreeFingerprint: "",
        capturedAt: 12,
      }],
      activeRepositorySnapshotId: "repo-1",
    });
    expect(study.repositorySnapshots[0]?.revision).toBe("abc123");
    expect(study.repositorySnapshots[0]?.scope).toEqual([]);
  });

  it("rejects source line evidence without a path or with a backwards range", () => {
    const base = {
      id: "api-route",
      targetKind: "node" as const,
      targetId: "api",
      confidence: "observed" as const,
      source: "code" as const,
      claim: "the checkout route calls the order service",
    };
    expect(() => ArchitectureEvidenceSchema.parse({ ...base, lineStart: 20 })).toThrow(/path/);
    expect(() =>
      ArchitectureEvidenceSchema.parse({ ...base, path: "src/api.ts", lineStart: 20, lineEnd: 10 })
    ).toThrow(/lineEnd/);
    expect(ArchitectureEvidenceSchema.parse({ ...base, path: "src/api.ts" }).aspect).toBe("architecture");
  });

  it("compares to a claim that says what to do, not that everything failed", () => {
    // "0 were tested; each failed a gate" is vacuously true of nothing and reads as a fault report
    // on a study that has not been asked a question yet.
    const result = assemblePortfolio(blankStudy({ id: "s1" }));
    expect(result.frontier).toEqual([]);
    expect(result.claim).toMatch(/no candidate architectures/i);
    expect(result.claim).not.toMatch(/failed/i);
  });

  it("carries a name and problem when one is given", () => {
    const study = blankStudy({ id: "s1", name: "seats", problem: "sell each seat once" });
    expect(study.name).toBe("seats");
    expect(study.problem).toBe("sell each seat once");
  });
});

describe("the manual design", () => {
  it("starts as a schema-valid canvas without inventing a system", () => {
    const design = blankDesign();
    expect(design.name).toBe("manual design");
    expect(design.nodes).toEqual([]);
    expect(design.edges).toEqual([]);
    expect(design.classes).toEqual([]);
    expect(design.workflow).toBeNull();
    expect(design.slo).toEqual({ p99LatencyMs: null, maxErrorRatePct: null });
    expect(design.scenario).toEqual({
      durationSec: 1200,
      warmupSec: 200,
      seed: 1,
      traceLimit: 5000,
    });
    expect(validateDesign(design)).toEqual([
      expect.objectContaining({ severity: "warning", code: "no-client" }),
    ]);
  });

  it("warns about zero-cost work and components that no work source can reach", () => {
    const design = DesignSchema.parse({
      ...blankDesign(),
      nodes: [
        {
          id: "browser",
          kind: "client",
          label: "browser",
          x: 0,
          y: 0,
          client: { arrival: { kind: "poisson", ratePerSec: 1 } },
        },
        {
          id: "api",
          kind: "server",
          label: "api",
          x: 320,
          y: 0,
          server: {
            concurrency: 1,
            fanout: "sequential",
            serviceTime: { kind: "deterministic", value: 0 },
          },
        },
        {
          id: "orphan",
          kind: "server",
          label: "unreachable worker",
          x: 320,
          y: 240,
          server: {
            concurrency: 1,
            fanout: "sequential",
            serviceTime: { kind: "deterministic", value: 1 },
          },
        },
      ],
      edges: [
        {
          id: "browser-api",
          from: "browser",
          to: "api",
          latency: { kind: "deterministic", value: 0.25 },
          fanoutFactor: 1,
        },
      ],
    });
    const issues = validateDesign(design);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "zero-node-service-time", nodeId: "api" })
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "unreachable-from-client", nodeId: "orphan" })
    );
  });
});

describe("the yardstick freezes once results exist", () => {
  const withEvaluation = (study: Study): Study => ({
    ...study,
    evaluations: { "some-key": {} as never },
  });

  it("is editable while the study is still only a question", () => {
    const study = blankStudy({ id: "s1" });
    expect(studyContractLock(study).locked).toBe(false);
    const updated = applyStudyContract(study, { workload: { durationSec: 60 } });
    expect(updated.workload.durationSec).toBe(60);
  });

  it("locks once an evaluation is cached, naming the reason", () => {
    const study = withEvaluation(blankStudy({ id: "s1" }));
    const lock = studyContractLock(study);
    expect(lock.locked).toBe(true);
    expect(lock.reason).toMatch(/evaluation/);
    expect(() => applyStudyContract(study, { workload: { durationSec: 5 } })).toThrow(/locked/);
  });

  it("locks once a candidate is promoted, naming the candidate", () => {
    const study = { ...blankStudy({ id: "s1" }), promotedCandidateId: "c1" };
    const lock = studyContractLock(study);
    expect(lock.locked).toBe(true);
    expect(lock.reason).toMatch(/c1/);
  });

  it("refuses the change that matters most: weakening an invariant after a failure", () => {
    // The sequence this exists to stop is not malice, it is helpfulness. A design fails an
    // invariant, and the obvious next move for anything optimising "make it pass" is to delete
    // the invariant.
    // Parsed rather than hand-built, so the test uses the same defaults the product does and
    // cannot drift from them.
    const withInvariant = CorrectnessContractSchema.parse({
      invariants: [
        {
          id: "no-oversell",
          label: "never allocate more than exist",
          scope: "safety",
          expr: {
            kind: "compare",
            op: "<=",
            left: { kind: "count", collection: "claims", where: null },
            right: { kind: "lit", value: 1 },
          },
          message: "oversold",
        },
      ],
    });
    const study = withEvaluation(
      applyStudyContract(blankStudy({ id: "s1" }), { correctness: withInvariant })
    );
    expect(() =>
      applyStudyContract(study, { correctness: CorrectnessContractSchema.parse({ invariants: [] }) })
    ).toThrow(/locked/);
  });

  it("unfreezes only by visibly discarding the results, and the promotion with them", () => {
    const study = { ...withEvaluation(blankStudy({ id: "s1" })), promotedCandidateId: "c1" };
    const cleared = clearStudyResults(study);
    expect(cleared.evaluations).toEqual({});
    // A promotion is a decision about results that are being deleted, so it cannot survive them.
    expect(cleared.promotedCandidateId).toBeNull();
    expect(cleared.approval).toBeNull();
    expect(studyContractLock(cleared).locked).toBe(false);
  });
});
