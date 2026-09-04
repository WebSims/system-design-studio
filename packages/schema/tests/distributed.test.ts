import { describe, expect, it } from "vitest";
import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  analyzeDistributedSemantics,
  validateDesign,
  type Design,
  type IsolationLevel,
} from "@sds/schema";

function feedbackDesign(asyncFeedback = true): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "bounded feedback",
    nodes: [
      {
        id: "source",
        kind: "client",
        label: "source",
        x: 0,
        y: 0,
        client: { arrival: { kind: "poisson", ratePerSec: 1 } },
      },
      {
        id: "a",
        kind: "server",
        label: "A",
        x: 200,
        y: 0,
        server: { concurrency: 4, serviceTime: { kind: "deterministic", value: 1 } },
      },
      {
        id: "b",
        kind: "server",
        label: "B",
        x: 400,
        y: 0,
        server: { concurrency: 4, serviceTime: { kind: "deterministic", value: 1 } },
      },
    ],
    edges: [
      { id: "entry", from: "source", to: "a" },
      { id: "forward", from: "a", to: "b" },
      {
        id: "feedback",
        from: "b",
        to: "a",
        semantics: asyncFeedback
          ? { kind: "asynchronous", channel: "event", maxHops: 2 }
          : { kind: "synchronous" },
      },
    ],
    scenario: { durationSec: 1, warmupSec: 0 },
    slo: {},
  });
}

describe("bounded edge semantics", () => {
  it("rejects synchronous cycles", () => {
    const issues = validateDesign(feedbackDesign(false));
    expect(issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error", code: "synchronous-cycle" })])
    );
  });

  it("permits feedback only through an explicitly bounded async handoff", () => {
    const design = feedbackDesign(true);
    expect(validateDesign(design).filter((issue) => issue.severity === "error")).toEqual([]);
    const report = analyzeDistributedSemantics(design);
    expect(report).toMatchObject({
      synchronousEdges: 2,
      asynchronousEdges: 1,
      hasBoundedFeedback: true,
      hasSynchronousCycle: false,
      liveness: "out-of-scope",
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "bounded-asynchronous-cycle" })])
    );
  });

  it("requires queue-labelled async links to touch a queue component", () => {
    const design = feedbackDesign(true);
    const feedback = design.edges.find((edge) => edge.id === "feedback")!;
    feedback.semantics = { kind: "asynchronous", channel: "queue", maxHops: 2 };
    expect(validateDesign(design).map((issue) => issue.code)).toContain("async-queue-without-queue");
  });
});

describe("replica quorum checks", () => {
  function replicated(
    readQuorum: number,
    writeQuorum: number,
    isolationLevel: IsolationLevel = "read-committed"
  ) {
    return DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "replicas",
      nodes: [
        {
          id: "source",
          kind: "client",
          label: "source",
          x: 0,
          y: 0,
          client: { arrival: { kind: "poisson", ratePerSec: 1 } },
        },
        {
          id: "db",
          kind: "database",
          label: "orders",
          x: 200,
          y: 0,
          database: {
            serviceTime: { kind: "deterministic", value: 1 },
            isolationLevel,
            replicaGroup: {
              id: "orders-rg",
              replicas: 3,
              readQuorum,
              writeQuorum,
            },
          },
        },
      ],
      edges: [{ id: "query", from: "source", to: "db" }],
      scenario: {
        durationSec: 2,
        warmupSec: 0,
        failures: [
          {
            id: "minority",
            kind: "replica-partition",
            replicaGroupId: "orders-rg",
            availableReplicas: 1,
            startSec: 0,
            durationSec: 1,
          },
        ],
      },
      slo: {},
    });
  }

  it("reports quorum intersection and deterministic partition availability", () => {
    const issues = validateDesign(replicated(2, 2));
    expect(issues.map((issue) => issue.code)).not.toContain("read-write-quorum-no-overlap");
    expect(issues.map((issue) => issue.code)).not.toContain("write-quorum-no-overlap");
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["partition-blocks-reads", "partition-blocks-writes"])
    );
  });

  it("rejects a serializable claim whose quorums cannot intersect", () => {
    const issues = validateDesign(replicated(1, 1, "serializable"));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "read-write-quorum-no-overlap" }),
        expect.objectContaining({ severity: "error", code: "write-quorum-no-overlap" }),
      ])
    );
  });

  it("bounds divergence and clock skew without claiming protocol liveness", () => {
    const design = replicated(2, 2);
    design.scenario.failures.push(
      {
        id: "stale-majority",
        kind: "replica-divergence",
        replicaGroupId: "orders-rg",
        staleReplicas: 2,
        versionLag: 3,
        startSec: 0,
        durationSec: 1,
      },
      {
        id: "clock-jump",
        kind: "clock-skew",
        replicaGroupId: "orders-rg",
        maxSkewMs: 500,
        startSec: 0,
        durationSec: 1,
      }
    );
    const report = analyzeDistributedSemantics(design);
    expect(report.liveness).toBe("out-of-scope");
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "divergent-read-quorum-possible",
        "clock-skew-outside-workflow-search",
      ])
    );
  });
});
