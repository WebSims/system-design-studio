import { PRESET_BY_ID } from "@sds/models";
import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  FailureEventSchema,
  type Design,
} from "@sds/schema";
import { describe, expect, it } from "vitest";
import {
  FAILURE_KINDS,
  failureTargetsFor,
  makeFailureEvent,
  type FailureKind,
} from "../src/panels/failureEditor";

function designWithEveryFailureTarget(): Design {
  const database = PRESET_BY_ID.postgres!.build("db", 600, 0);
  database.database!.replicaGroup = {
    id: "orders-rg",
    replicas: 3,
    readQuorum: 2,
    writeQuorum: 2,
    replicationLag: { kind: "deterministic", value: 0 },
    maxClockSkewMs: 0,
  };
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "failure editor",
    nodes: [
      PRESET_BY_ID.client!.build("client", 0, 0),
      PRESET_BY_ID.gateway!.build("gateway", 200, 0),
      PRESET_BY_ID["app-server"]!.build("api", 400, 0),
      database,
    ],
    edges: [
      { id: "client-gateway", from: "client", to: "gateway" },
      { id: "gateway-api", from: "gateway", to: "api" },
      { id: "api-db", from: "api", to: "db" },
    ],
    scenario: { durationSec: 60, warmupSec: 0, seed: 1, traceLimit: 100 },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

const targetFor = (kind: FailureKind): string => {
  if (kind === "edge-latency" || kind === "request-loss") return "api-db";
  if (kind === "gateway-disconnection") return "gateway";
  if (kind === "replica-partition" || kind === "replica-divergence" || kind === "clock-skew") {
    return "orders-rg";
  }
  return "api";
};

describe("failure timeline editor", () => {
  it("offers every schema failure and constructs a valid event for each", () => {
    const design = designWithEveryFailureTarget();
    expect(FAILURE_KINDS.map((item) => item.value)).toEqual([
      "node-outage",
      "capacity-reduction",
      "service-degradation",
      "edge-latency",
      "request-loss",
      "gateway-disconnection",
      "replica-partition",
      "replica-divergence",
      "clock-skew",
    ]);

    for (const { value: kind } of FAILURE_KINDS) {
      const event = makeFailureEvent({
        design,
        kind,
        targetId: targetFor(kind),
        id: `test-${kind}`,
        startSec: 5,
        durationSec: 10,
        strength: 50,
      });
      expect(FailureEventSchema.safeParse(event), kind).toMatchObject({ success: true });
    }
  });

  it("only offers targets accepted by each failure kind", () => {
    const design = designWithEveryFailureTarget();
    expect(failureTargetsFor(design, "node-outage").map((target) => target.id)).toEqual([
      "client",
      "gateway",
      "api",
      "db",
    ]);
    expect(failureTargetsFor(design, "capacity-reduction").map((target) => target.id)).toEqual([
      "gateway",
      "api",
      "db",
    ]);
    expect(failureTargetsFor(design, "gateway-disconnection").map((target) => target.id)).toEqual([
      "gateway",
    ]);
    expect(failureTargetsFor(design, "edge-latency").map((target) => target.id)).toEqual([
      "client-gateway",
      "gateway-api",
      "api-db",
    ]);
    expect(failureTargetsFor(design, "replica-partition")).toEqual([
      { id: "orders-rg", label: "orders-rg · database" },
    ]);
  });

  it("clamps slider-derived values before they reach the engine", () => {
    const design = designWithEveryFailureTarget();
    expect(
      makeFailureEvent({
        design,
        kind: "request-loss",
        targetId: "api-db",
        id: "loss",
        startSec: -10,
        durationSec: 0,
        strength: 140,
      })
    ).toMatchObject({ startSec: 0, durationSec: 0.1, lossProbability: 1 });
    expect(
      makeFailureEvent({
        design,
        kind: "replica-divergence",
        targetId: "orders-rg",
        id: "divergence",
        startSec: 0,
        durationSec: 1,
        strength: 140,
      })
    ).toMatchObject({ staleReplicas: 3 });
  });
});
