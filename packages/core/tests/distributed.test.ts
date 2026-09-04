import { describe, expect, it } from "vitest";
import { DESIGN_SCHEMA_VERSION, DesignSchema, type Design } from "@sds/schema";
import { FailureController, Sim, runSimulation } from "@sds/core";

function feedbackDesign(maxHops: number): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "async feedback runtime",
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
        server: { concurrency: 8, serviceTime: { kind: "deterministic", value: 1 }, fanout: "sequential" },
      },
      {
        id: "b",
        kind: "server",
        label: "B",
        x: 400,
        y: 0,
        server: { concurrency: 8, serviceTime: { kind: "deterministic", value: 1 }, fanout: "sequential" },
      },
    ],
    edges: [
      { id: "entry", from: "source", to: "a" },
      { id: "forward", from: "a", to: "b" },
      {
        id: "feedback",
        from: "b",
        to: "a",
        semantics: { kind: "asynchronous", channel: "event", maxHops },
      },
    ],
    scenario: { durationSec: 0.1, warmupSec: 0, traceLimit: 100 },
    slo: {},
  });
}

describe("bounded asynchronous execution", () => {
  it("detaches the caller and stops feedback at the visible per-edge budget", () => {
    const result = runSimulation(feedbackDesign(2), {
      manualRequests: [{ sourceNodeId: "source" }],
      warmupSec: 0,
      durationSec: 0.1,
    });
    const traversals = Object.fromEntries(result.edges.map((edge) => [edge.edgeId, edge.traversals]));
    expect(traversals).toEqual({ entry: 1, forward: 3, feedback: 2 });
    expect(result.errors.total).toBe(0);
    expect(result.endToEnd.count).toBe(1);
  });

  it("is deterministic across one-shot runs", () => {
    const design = feedbackDesign(4);
    const options = {
      manualRequests: [{ sourceNodeId: "source" }],
      warmupSec: 0,
      durationSec: 0.1,
    };
    const a = runSimulation(design, options);
    const b = runSimulation(design, options);
    expect({ ...a, wallMs: 0 }).toEqual({ ...b, wallMs: 0 });
  });

  it("honours async semantics after load-balancer route selection", () => {
    const design = DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "async balancer",
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
          id: "lb",
          kind: "loadbalancer",
          label: "router",
          x: 200,
          y: 0,
          loadbalancer: { serviceTime: { kind: "deterministic", value: 1 } },
        },
        {
          id: "worker",
          kind: "server",
          label: "worker",
          x: 400,
          y: 0,
          server: { concurrency: 1, serviceTime: { kind: "deterministic", value: 50 } },
        },
      ],
      edges: [
        { id: "entry", from: "source", to: "lb" },
        {
          id: "dispatch",
          from: "lb",
          to: "worker",
          semantics: { kind: "asynchronous", channel: "event", maxHops: 1 },
        },
      ],
      scenario: { durationSec: 0.1, warmupSec: 0 },
      slo: {},
    });
    const result = runSimulation(design, {
      manualRequests: [{ sourceNodeId: "source" }],
      durationSec: 0.1,
      warmupSec: 0,
    });
    expect(result.endToEnd.mean).toBeLessThan(10);
    expect(result.nodes.find((node) => node.nodeId === "worker")?.completed).toBe(1);
  });
});

describe("replica partitions", () => {
  function design(withPartition: boolean): Design {
    return DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "partition",
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
            poolSize: 2,
            parallelism: 2,
            serviceTime: { kind: "deterministic", value: 1 },
            replicaGroup: {
              id: "orders-rg",
              replicas: 3,
              readQuorum: 2,
              writeQuorum: 2,
            },
          },
        },
      ],
      edges: [{ id: "query", from: "source", to: "db" }],
      scenario: {
        durationSec: 0.1,
        warmupSec: 0,
        failures: withPartition
          ? [
              {
                id: "isolated",
                kind: "replica-partition",
                replicaGroupId: "orders-rg",
                availableReplicas: 1,
                startSec: 0,
                durationSec: 0.05,
              },
              {
                id: "stale",
                kind: "replica-divergence",
                replicaGroupId: "orders-rg",
                staleReplicas: 2,
                versionLag: 4,
                startSec: 0,
                durationSec: 0.05,
              },
              {
                id: "skew",
                kind: "clock-skew",
                replicaGroupId: "orders-rg",
                maxSkewMs: 250,
                startSec: 0,
                durationSec: 0.05,
              },
            ]
          : [],
      },
      slo: {},
    });
  }

  it("fails only the operation that is provably below every configured quorum", () => {
    const options = {
      manualRequests: [{ sourceNodeId: "source", atMs: 1 }],
      durationSec: 0.1,
      warmupSec: 0,
    };
    const healthy = runSimulation(design(false), options);
    const partitioned = runSimulation(design(true), options);
    expect(healthy.errors.total).toBe(0);
    expect(healthy.endToEnd.count).toBe(1);
    expect(partitioned.errors.total).toBe(1);
    expect(partitioned.errors.error).toBe(1);
    expect(partitioned.nodes.find((node) => node.nodeId === "db")?.database?.replication).toMatchObject({
      groupId: "orders-rg",
      minAvailableReplicas: 1,
      maxStaleReplicas: 2,
      maxClockSkewMs: 250,
    });
  });

  it("tracks partition, divergence and clock-skew windows deterministically", () => {
    const sim = new Sim();
    const failures = new FailureController(sim);
    failures.add({
      id: "partition",
      kind: "replica-partition",
      replicaGroupId: "rg",
      availableReplicas: 2,
      startSec: 0,
      durationSec: 1,
    });
    failures.add({
      id: "stale",
      kind: "replica-divergence",
      replicaGroupId: "rg",
      staleReplicas: 1,
      versionLag: 3,
      startSec: 0,
      durationSec: 1,
    });
    failures.add({
      id: "skew",
      kind: "clock-skew",
      replicaGroupId: "rg",
      maxSkewMs: 250,
      startSec: 0,
      durationSec: 1,
    });
    expect(failures.availableReplicas("rg", 5)).toBe(2);
    expect(failures.staleReplicas("rg")).toBe(1);
    expect(failures.clockSkewMs("rg", 20)).toBe(250);
    sim.run(1_001);
    expect(failures.availableReplicas("rg", 5)).toBe(5);
    expect(failures.staleReplicas("rg")).toBe(0);
    expect(failures.clockSkewMs("rg", 20)).toBe(20);
  });
});
