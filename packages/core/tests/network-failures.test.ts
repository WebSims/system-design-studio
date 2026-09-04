import { describe, expect, it } from "vitest";
import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  validateDesign,
  type Design,
  type FailureEvent,
} from "@sds/schema";
import { FailureController } from "../src/failures";
import { runSimulation } from "../src/run";
import { SimulationSession } from "../src/session";
import { Sim } from "../src/sim";

function oneHop(overrides: { failures?: FailureEvent[]; network?: Record<string, unknown> } = {}): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "network physics",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: { arrival: { kind: "deterministic", ratePerSec: 1 }, timeoutMs: null },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 200,
        y: 0,
        server: {
          concurrency: 1,
          queueCapacity: null,
          serviceTime: { kind: "deterministic", value: 1 },
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
        },
      },
    ],
    edges: [
      {
        id: "request",
        from: "client",
        to: "api",
        network: {
          propagationLatency: { kind: "deterministic", value: 2 },
          ...overrides.network,
        },
      },
    ],
    scenario: {
      durationSec: 2,
      warmupSec: 0,
      seed: 9,
      traceLimit: 100,
      failures: overrides.failures ?? [],
    },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

function withoutIdentity(result: ReturnType<typeof runSimulation>) {
  const { design: _design, wallMs: _wallMs, ...stable } = result;
  return stable;
}

describe("request-level network physics", () => {
  it("accounts for directional bytes, bandwidth, serialization, TCP setup and TLS", () => {
    const design = oneHop({
      network: {
        application: { kind: "http", version: "2" },
        transport: {
          kind: "tcp",
          connectionSetup: { kind: "deterministic", value: 5 },
          tls: { enabled: true, cost: { kind: "deterministic", value: 7 } },
          reuseProbability: 0,
        },
        requestBytes: 1000,
        responseBytes: 2000,
        bandwidthMbps: 1,
        requestSerialization: { kind: "deterministic", value: 3 },
        responseSerialization: { kind: "deterministic", value: 4 },
      },
    });

    const result = runSimulation(design, {
      manualRequests: [{ sourceNodeId: "client" }],
      warmupSec: 0,
    });
    const request = result.trace.hops.find((hop) => hop.forward)!;
    const response = result.trace.hops.find((hop) => !hop.forward)!;

    // request: 2 propagation + 3 serialization + 8 transfer + 5 TCP + 7 TLS
    expect(request.tEnd - request.tStart).toBe(25);
    expect(request.network).toMatchObject({
      bytes: 1000,
      propagationMs: 2,
      serializationMs: 3,
      transferMs: 8,
      connectionMs: 12,
      application: "http",
      transport: "tcp",
    });
    // response: 2 propagation + 4 serialization + 16 transfer; no second setup.
    expect(response.tEnd - response.tStart).toBe(22);
    expect(response.network?.connectionMs).toBe(0);
    expect(result.endToEnd.p50).toBe(48);
  });

  it("types future protocols but blocks execution until their semantics exist", () => {
    const grpc = DesignSchema.parse({
      ...oneHop(),
      edges: [
        {
          ...oneHop().edges[0],
          network: {
            ...oneHop().edges[0]!.network,
            application: { kind: "grpc", streaming: false },
          },
        },
      ],
    });
    expect(validateDesign(grpc)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "network-semantics-not-implemented" })
    );
    expect(() => runSimulation(grpc)).toThrow(/only simulates HTTP over TCP/);
  });
});

describe("failure timelines", () => {
  it("composes overlap multiplicatively, lets outage dominate, and recovers on time", () => {
    const sim = new Sim();
    const failures = new FailureController(sim);
    failures.add({
      id: "capacity-a",
      kind: "capacity-reduction",
      targetNodeId: "api",
      startSec: 0,
      durationSec: 1,
      factor: 0.5,
    });
    failures.add({
      id: "capacity-b",
      kind: "capacity-reduction",
      targetNodeId: "api",
      startSec: 0,
      durationSec: 1,
      factor: 0.5,
    });
    failures.add({
      id: "outage",
      kind: "node-outage",
      targetNodeId: "api",
      startSec: 0,
      durationSec: 1,
    });
    failures.add({
      id: "loss-a",
      kind: "request-loss",
      targetEdgeId: "request",
      startSec: 0,
      durationSec: 1,
      lossProbability: 0.2,
    });
    failures.add({
      id: "loss-b",
      kind: "request-loss",
      targetEdgeId: "request",
      startSec: 0,
      durationSec: 1,
      lossProbability: 0.5,
    });

    expect(failures.capacityFactor("api")).toBe(0);
    expect(failures.lossProbability("request", 0)).toBeCloseTo(0.6, 12);
    expect(failures.snapshot()).toHaveLength(5);

    sim.run(1000);
    expect(failures.capacityFactor("api")).toBe(1);
    expect(failures.lossProbability("request", 0)).toBe(0);
    expect(failures.snapshot()).toEqual([]);
  });

  it("applies overlapping service degradations at the service-start boundary", () => {
    const design = oneHop({
      failures: [
        {
          id: "slow-a",
          kind: "service-degradation",
          targetNodeId: "api",
          startSec: 0,
          durationSec: 1,
          factor: 2,
        },
        {
          id: "slow-b",
          kind: "service-degradation",
          targetNodeId: "api",
          startSec: 0,
          durationSec: 1,
          factor: 3,
        },
      ],
    });
    const result = runSimulation(design, {
      manualRequests: [{ sourceNodeId: "client" }],
      warmupSec: 0,
    });
    const visit = result.trace.visits.find((item) => item.nodeId === "api")!;
    expect(visit.tExit - visit.tServiceStart!).toBe(6);
  });

  it("makes configured and interactively injected events outcome-equivalent", () => {
    const event: FailureEvent = {
      id: "slow-api",
      kind: "service-degradation",
      targetNodeId: "api",
      startSec: 0,
      durationSec: 1,
      factor: 4,
    };
    const configured = new SimulationSession(oneHop({ failures: [event] }), { mode: "manual" });
    configured.injectRequest("client");
    const configuredResult = configured.finalize().result!;

    const interactive = new SimulationSession(oneHop(), { mode: "manual" });
    interactive.injectFailure(event);
    expect(interactive.snapshot().activeFailures).toEqual([event]);
    interactive.injectRequest("client");
    const interactiveResult = interactive.finalize().result!;

    expect(withoutIdentity(interactiveResult)).toEqual(withoutIdentity(configuredResult));
  });

  it("reports a request that reaches an outaged target as a station error", () => {
    const result = runSimulation(
      oneHop({
        failures: [
          {
            id: "api-down",
            kind: "node-outage",
            targetNodeId: "api",
            startSec: 0,
            durationSec: 1,
          },
        ],
      }),
      { manualRequests: [{ sourceNodeId: "client" }], warmupSec: 0 }
    );
    expect(result.errors.error).toBe(1);
    expect(result.endToEnd.count).toBe(0);
  });
});
