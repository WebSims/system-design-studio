import { describe, expect, it } from "vitest";
import { runSimulation } from "@sds/core";
import { DESIGN_SCHEMA_VERSION, DesignSchema, type Design, type SdsEdge } from "@sds/schema";
import { chat20k, chatReconnectStorm } from "@sds/models";
import { analyse } from "@sds/analyze";
import { previewDesign } from "../src/preview";
import { relError } from "./harness";

/**
 * PHASE 7 VALIDATION: STATEFUL CONNECTIONS AND FAN-OUT
 *
 * Two new primitives, and both are exactly testable.
 *
 * Connections held obey Little's Law: a population reconnecting every session-length
 * holds (accept rate x session length) descriptors. That is the same L = lambda x W
 * identity the engine already checks on requests, applied to a resource whose service
 * time is measured in minutes rather than milliseconds -- so it is a genuine check of
 * the new code path rather than a restatement of the old one.
 *
 * Fan-out is exact by construction: N deliveries per message means exactly N times the
 * downstream traversals, and any deviation is a bug in the expansion.
 */

const SEEDS = [1, 2, 3, 4];

function chat(o: {
  connections: number;
  capacity: number;
  replicas?: number;
  messageRatePerSec?: number;
  sessionSec?: number | null;
  establishOverSec?: number;
  fanout?: number;
  pushConcurrency?: number;
  pushMs?: number;
  acceptMs?: number;
  durationSec?: number;
  warmupSec?: number;
  disruption?: { atSec: number; fraction: number; reconnectOverSec?: number } | null;
}): Design {
  const nodes: unknown[] = [
    {
      id: "users",
      kind: "client",
      label: "users",
      x: 0,
      y: 0,
      client: {
        arrival: { kind: "poisson", ratePerSec: o.messageRatePerSec ?? 100 },
        timeoutMs: null,
        connections: {
          count: o.connections,
          establishOverSec: o.establishOverSec ?? 10,
          sessionDuration:
            o.sessionSec === null
              ? null
              : { kind: "exponential", mean: (o.sessionSec ?? 60) * 1000 },
          disruption: o.disruption ?? null,
        },
      },
    },
    {
      id: "gw",
      kind: "gateway",
      label: "gw",
      x: 1,
      y: 0,
      gateway: {
        connectionCapacity: o.capacity,
        replicas: o.replicas ?? 1,
        acceptTime: { kind: "deterministic", value: o.acceptMs ?? 1 },
        pushTime: { kind: "deterministic", value: o.pushMs ?? 0.1 },
        pushConcurrency: o.pushConcurrency ?? 64,
        memoryPerConnectionKb: 40,
      },
    },
    {
      id: "sink",
      kind: "server",
      label: "sink",
      x: 2,
      y: 0,
      server: {
        concurrency: 4096,
        serviceTime: { kind: "deterministic", value: 0.1 },
        blocksOnDependencies: false,
      },
    },
  ];

  const edges: unknown[] = [
    { id: "e-in", from: "users", to: "gw", latency: { kind: "deterministic", value: 0 } },
    {
      id: "e-out",
      from: "gw",
      to: "sink",
      latency: { kind: "deterministic", value: 0 },
      fanoutFactor: o.fanout ?? 1,
    },
  ];

  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "chat-test",
    nodes,
    edges,
    classes: [],
    scenario: {
      durationSec: o.durationSec ?? 200,
      warmupSec: o.warmupSec ?? 40,
      seed: 1,
      traceLimit: 0,
    },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

const gw = (r: ReturnType<typeof runSimulation>) => r.nodes.find((n) => n.nodeId === "gw")!;

// ---------------------------------------------------------------------------

describe("connections are held, not served", () => {
  it("holds exactly the offered population when capacity allows", () => {
    const r = runSimulation(chat({ connections: 5000, capacity: 10_000, sessionSec: null }), {
      collectTrace: false,
    });
    const c = gw(r).connections!;
    expect(c.heldNow).toBe(5000);
    expect(c.avgHeld).toBeGreaterThan(4900);
    expect(c.refused).toBe(0);
  });

  it("refuses the excess when the population exceeds capacity", () => {
    /**
     * The failure mode that has no analogue in a request/response model. A refused
     * connection is not a slow response; the user gets nothing at all.
     */
    const r = runSimulation(
      chat({ connections: 6000, capacity: 4000, sessionSec: null, durationSec: 120, warmupSec: 20 }),
      { collectTrace: false }
    );
    const c = gw(r).connections!;
    expect(c.heldNow).toBe(4000);
    expect(c.capacity).toBe(4000);
    // The 2000 that cannot be held keep retrying, so refusals accumulate well past 2000.
    expect(c.refused).toBeGreaterThan(1000);
    expect(r.connectionsRefused).toBeGreaterThan(0);
  });

  it("spreads capacity across replicas", () => {
    const r = runSimulation(
      chat({ connections: 9000, capacity: 5000, replicas: 2, sessionSec: null }),
      { collectTrace: false }
    );
    const c = gw(r).connections!;
    expect(c.capacity).toBe(10_000);
    expect(c.heldNow).toBe(9000);
    expect(c.refused).toBe(0);
  });

  it("reports a memory footprint proportional to connections held", () => {
    const r = runSimulation(chat({ connections: 8000, capacity: 20_000, sessionSec: null }), {
      collectTrace: false,
    });
    const c = gw(r).connections!;
    // 8000 sockets at 40 KB each.
    expect(relError(c.peakMemoryMb, (8000 * 40) / 1024)).toBeLessThan(0.02);
  });

  it("establishes the population gradually rather than as a herd", () => {
    /**
     * Twenty thousand handshakes in the same instant is a thundering herd no real
     * deployment experiences at start-up. Letting it happen would begin every run with
     * an artificial accept storm that has nothing to do with the design.
     */
    const spread = runSimulation(
      chat({
        connections: 4000,
        capacity: 10_000,
        sessionSec: null,
        establishOverSec: 60,
        acceptMs: 2,
        pushConcurrency: 8,
        warmupSec: 0,
        durationSec: 120,
      }),
      { collectTrace: false }
    );
    const herd = runSimulation(
      chat({
        connections: 4000,
        capacity: 10_000,
        sessionSec: null,
        establishOverSec: 0.001,
        acceptMs: 2,
        pushConcurrency: 8,
        warmupSec: 0,
        durationSec: 120,
      }),
      { collectTrace: false }
    );
    // Same handshake work either way, but arriving all at once it queues.
    expect(gw(herd).connections!.acceptLatency.p99).toBeGreaterThan(
      gw(spread).connections!.acceptLatency.p99 * 5
    );
  });
});

describe("Little's Law applies to connections", () => {
  /**
   * The strongest check on the new code path, and exact.
   *
   * A population of N with sessions of mean S holds N descriptors and generates N/S
   * handshakes per second. Both quantities are measured by independent mechanisms --
   * held from a time-weighted occupancy integral, accepts from a counter -- so the
   * identity would break if either were wrong.
   */
  for (const { connections, sessionSec } of [
    { connections: 3000, sessionSec: 30 },
    { connections: 6000, sessionSec: 60 },
    { connections: 2000, sessionSec: 15 },
  ]) {
    it(`accept rate is population/session for N=${connections}, S=${sessionSec}s`, () => {
      const expectedAccepts = connections / sessionSec;
      const results = SEEDS.map((seed) =>
        runSimulation(
          chat({
            connections,
            capacity: 50_000,
            sessionSec,
            establishOverSec: 5,
            // Ample accept capacity, so churn is not throttled by handshake work.
            pushConcurrency: 512,
            acceptMs: 0.5,
            durationSec: 240,
            warmupSec: 90,
          }),
          { seed, collectTrace: false }
        )
      );
      const measuredAccepts =
        results.reduce((s, r) => s + gw(r).connections!.acceptRatePerSec, 0) / results.length;
      const measuredHeld =
        results.reduce((s, r) => s + gw(r).connections!.avgHeld, 0) / results.length;

      expect(relError(measuredAccepts, expectedAccepts)).toBeLessThan(0.06);
      // And the population itself is held: L = lambda x W with W the session length.
      expect(relError(measuredHeld, expectedAccepts * sessionSec)).toBeLessThan(0.06);
      expect(relError(measuredHeld, connections)).toBeLessThan(0.05);
    });
  }

  it("sessions that never end generate no churn", () => {
    const r = runSimulation(
      chat({ connections: 4000, capacity: 10_000, sessionSec: null, warmupSec: 60 }),
      { collectTrace: false }
    );
    // Every connection was established during warm-up, so no accepts are measured.
    expect(gw(r).connections!.accepted).toBe(0);
    expect(gw(r).connections!.heldNow).toBe(4000);
  });
});

describe("fan-out is exact", () => {
  for (const fanout of [1, 5, 20, 50]) {
    it(`one message becomes exactly ${fanout} deliveries`, () => {
      const r = runSimulation(
        chat({
          connections: 100,
          capacity: 1000,
          sessionSec: null,
          messageRatePerSec: 50,
          fanout,
          durationSec: 120,
          warmupSec: 20,
        }),
        { collectTrace: false }
      );
      const sink = r.nodes.find((n) => n.nodeId === "sink")!;
      const messages = r.endToEnd.count + r.errors.total;
      // Deliveries at the sink are exactly fanout per message.
      expect(relError(sink.arrivals / messages, fanout)).toBeLessThan(0.01);
      expect(r.largestFanout).toBe(fanout);
      // Total downstream work: one inbound hop plus `fanout` deliveries.
      expect(relError(r.callsPerMessage, 1 + fanout)).toBeLessThan(0.02);
    });
  }

  it("fan-out multiplies delivery load, not message load", () => {
    const build = (fanout: number) =>
      chat({
        connections: 100,
        capacity: 1000,
        sessionSec: null,
        messageRatePerSec: 200,
        fanout,
        // Tight delivery capacity so the multiplier shows up as utilization.
        pushConcurrency: 8,
        pushMs: 0.5,
        durationSec: 120,
        warmupSec: 20,
      });
    const light = runSimulation(build(2), { collectTrace: false });
    const heavy = runSimulation(build(20), { collectTrace: false });

    const sinkLoad = (r: ReturnType<typeof runSimulation>) =>
      r.nodes.find((n) => n.nodeId === "sink")!.arrivalRatePerSec;
    expect(relError(sinkLoad(heavy) / sinkLoad(light), 10)).toBeLessThan(0.05);
    // Message throughput is unchanged: the amplification is entirely downstream.
    expect(relError(heavy.offeredRatePerSec, light.offeredRatePerSec)).toBeLessThan(0.01);
  });
});

describe("a gateway does not hold its work slot across downstream calls", () => {
  it("utilization reflects only its own push work", () => {
    /**
     * A gateway is event-driven: forwarding a frame does not occupy the loop while the
     * downstream call is outstanding. Modelling it as blocking charged the gateway for
     * the entire downstream path and made a station doing 0.26 core-seconds of work per
     * second read as 74% utilized -- pointing the bottleneck at the wrong component.
     */
    const r = runSimulation(
      chat({
        connections: 100,
        capacity: 1000,
        sessionSec: null,
        messageRatePerSec: 200,
        pushMs: 0.5,
        pushConcurrency: 8,
        durationSec: 120,
        warmupSec: 20,
      }),
      { collectTrace: false }
    );
    // 200 messages/s at 0.5ms each over 8 slots is 200 x 0.0005 / 8 = 1.25%.
    const expected = (200 * 0.0005) / 8;
    expect(relError(gw(r).utilization, expected)).toBeLessThan(0.25);
    expect(gw(r).utilization).toBeLessThan(0.05);
  });
});

describe("a reconnect storm starves delivery", () => {
  /**
   * The failure realtime systems actually have, and it is invisible to any
   * steady-state measurement. When an instance dies its connections come back at once,
   * handshakes cost far more than messages, and both draw on the same work pool -- so
   * people who never disconnected see their messages stall.
   */
  const build = (disrupt: boolean) =>
    chat({
      connections: 8000,
      capacity: 20_000,
      replicas: 1,
      sessionSec: 600,
      establishOverSec: 20,
      messageRatePerSec: 500,
      acceptMs: 5,
      pushMs: 0.2,
      // A small pool, as an event loop is.
      pushConcurrency: 8,
      durationSec: 160,
      warmupSec: 40,
      disruption: disrupt ? { atSec: 80, fraction: 0.3, reconnectOverSec: 0 } : null,
    });

  it("drops the configured share and brings them all back", () => {
    const r = runSimulation(build(true), { collectTrace: false });
    const c = gw(r).connections!;
    expect(c.droppedByFault).toBe(Math.floor(8000 * 0.3));
    // They reconnect, so the population recovers.
    expect(c.heldNow).toBeGreaterThan(7900);
    expect(c.accepted).toBeGreaterThan(c.droppedByFault);
  });

  it("handshake work starves message delivery", () => {
    const calm = runSimulation(build(false), { collectTrace: false });
    const storm = runSimulation(build(true), { collectTrace: false });

    const calmPush = gw(calm).connections!.pushLatency.p99;
    const stormPush = gw(storm).connections!.pushLatency.p99;
    // Delivery latency degrades sharply for everyone, not just the reconnecting users.
    expect(stormPush).toBeGreaterThan(calmPush * 10);
    // And accepts back up behind the same pool.
    expect(gw(storm).connections!.acceptLatency.p99).toBeGreaterThan(
      gw(calm).connections!.acceptLatency.p99 * 5
    );
  });

  it("spreading the reconnects reduces the damage", () => {
    // The mitigation, and it costs nothing: the same connections come back, just not
    // all in the same instant.
    const atOnce = runSimulation(build(true), { collectTrace: false });
    const spread = runSimulation(
      chat({
        connections: 8000,
        capacity: 20_000,
        sessionSec: 600,
        establishOverSec: 20,
        messageRatePerSec: 500,
        acceptMs: 5,
        pushMs: 0.2,
        pushConcurrency: 8,
        durationSec: 160,
        warmupSec: 40,
        disruption: { atSec: 80, fraction: 0.3, reconnectOverSec: 30 },
      }),
      { collectTrace: false }
    );
    expect(gw(spread).connections!.acceptLatency.p99).toBeLessThan(
      gw(atOnce).connections!.acceptLatency.p99
    );
  });
});

describe("invariants hold for connection and fan-out designs", () => {
  const scenarios: Array<[string, Design]> = [
    ["held connections", chat({ connections: 5000, capacity: 10_000, sessionSec: null })],
    ["churning connections", chat({ connections: 4000, capacity: 10_000, sessionSec: 30 })],
    ["over capacity", chat({ connections: 6000, capacity: 3000, sessionSec: null })],
    ["fan-out 20x", chat({ connections: 200, capacity: 1000, sessionSec: null, fanout: 20 })],
    [
      "reconnect storm",
      chat({
        connections: 4000,
        capacity: 10_000,
        sessionSec: 300,
        disruption: { atSec: 90, fraction: 0.4 },
        durationSec: 160,
        warmupSec: 40,
      }),
    ],
  ];

  for (const [name, design] of scenarios) {
    it(`all invariants pass: ${name}`, () => {
      const r = runSimulation(design);
      const failed = r.invariants.filter((i) => !i.passed);
      expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    });
  }

  it("a forced drop and a graceful close never release the same descriptor", () => {
    /**
     * The bug this guards against was real. The gateway used to release descriptors on
     * a fault while the holding processes were still parked on their session timers;
     * those processes then closed a connection that no longer existed, the count was
     * decremented twice, and the storm never happened because nobody was told their
     * connection had gone. A revoke handshake fixed it, and the invariant is what
     * proves it.
     */
    const r = runSimulation(
      chat({
        connections: 3000,
        capacity: 8000,
        sessionSec: 40,
        disruption: { atSec: 80, fraction: 0.5 },
        durationSec: 160,
        warmupSec: 30,
      })
    );
    const inv = r.invariants.find((i) => i.name.includes("connections"))!;
    expect(inv.passed).toBe(true);
    expect(gw(r).connections!.droppedByFault).toBe(1500);
  });
});

describe("the closed form predicts connection behaviour", () => {
  it("predicts connections held and the churn rate", () => {
    const design = chat({
      connections: 6000,
      capacity: 20_000,
      sessionSec: 60,
      pushConcurrency: 512,
      acceptMs: 0.5,
      durationSec: 240,
      warmupSec: 90,
    });
    const preview = previewDesign(design);
    const node = preview.nodes.find((n) => n.nodeId === "gw")!;
    expect(node.connections).toBeDefined();
    expect(node.connections!.held).toBe(6000);
    expect(node.connections!.refused).toBe(0);
    // 6000 connections with 60s sessions is 100 handshakes a second, forever.
    expect(relError(node.connections!.acceptRatePerSec, 100)).toBeLessThan(1e-6);

    const measured = gw(runSimulation(design, { collectTrace: false })).connections!;
    expect(relError(measured.acceptRatePerSec, node.connections!.acceptRatePerSec)).toBeLessThan(0.08);
    expect(relError(measured.avgHeld, node.connections!.held)).toBeLessThan(0.05);
  });

  it("predicts refusals before the simulation runs", () => {
    const preview = previewDesign(
      chat({ connections: 9000, capacity: 4000, sessionSec: null })
    );
    const node = preview.nodes.find((n) => n.nodeId === "gw")!;
    expect(node.connections!.held).toBe(4000);
    expect(node.connections!.refused).toBe(5000);
    expect(preview.notes.join(" ")).toMatch(/refuse 5,000 connections/);
  });

  it("accounts for fan-out in the predicted arrival rate", () => {
    const design = chat({
      connections: 100,
      capacity: 1000,
      sessionSec: null,
      messageRatePerSec: 200,
      fanout: 20,
    });
    const preview = previewDesign(design);
    const sink = preview.nodes.find((n) => n.nodeId === "sink")!;
    // 200 messages/s becomes 4000 deliveries/s.
    expect(relError(sink.arrivalRatePerSec, 4000)).toBeLessThan(1e-6);
  });
});

describe("findings surface the realtime failure modes", () => {
  it("reports refused connections as critical", () => {
    const design = chat({
      connections: 9000,
      capacity: 4000,
      sessionSec: null,
      durationSec: 120,
      warmupSec: 20,
    });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id === "connections-refused:gw")!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("critical");
    expect(finding.remediation).toMatch(/hard failure, not a slow response/);
  });

  it("warns when connection headroom could not survive losing an instance", () => {
    // Two instances at 80% held: losing one leaves 160% of capacity needed.
    const design = chat({
      connections: 8000,
      capacity: 5000,
      replicas: 2,
      sessionSec: null,
      durationSec: 120,
      warmupSec: 20,
    });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id === "connection-headroom:gw")!;
    expect(finding).toBeDefined();
    expect(finding.remediation).toMatch(/losing one of 2 instances/);
    expect(finding.remediation).toMatch(/would not/);
  });

  it("reports fan-out with the delivery rate it implies", () => {
    const design = chat({
      connections: 200,
      capacity: 1000,
      sessionSec: null,
      messageRatePerSec: 300,
      fanout: 20,
      pushConcurrency: 8,
      pushMs: 0.5,
      durationSec: 120,
      warmupSec: 20,
    });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id.startsWith("fanout:"))!;
    expect(finding).toBeDefined();
    expect(finding.evidence).toMatch(/deliveries\/s/);
    expect(finding.remediation).toMatch(/product decision/);
  });
});

describe("the shipped chat examples answer the original question", () => {
  it("20k users: holds them all, and fan-out is where the work is", () => {
    const r = runSimulation(chat20k(), { collectTrace: false });
    const gateway = r.nodes.find((n: { nodeId: string }) => n.nodeId === "gw")!;
    const delivery = r.nodes.find((n: { nodeId: string }) => n.nodeId === "delivery")!;

    expect(r.connectionsHeld).toBeGreaterThan(19_500);
    expect(r.connectionsRefused).toBe(0);
    expect(gateway.connections!.capacity).toBe(40_000);

    // 1,000 messages/s becomes about 20,000 deliveries/s.
    expect(r.largestFanout).toBe(20);
    expect(relError(delivery.arrivalRatePerSec / r.offeredRatePerSec, 20)).toBeLessThan(0.05);

    // The gateway is idle and delivery is where the load sits, which is the lesson:
    // holding sockets is cheap, pushing to them is not.
    expect(gateway.utilization).toBeLessThan(0.1);
    expect(delivery.utilization).toBeGreaterThan(0.3);
    expect(r.sloPassed).toBe(true);
  });

  it("losing a gateway: delivery stalls for everyone", () => {
    const calm = runSimulation(chat20k(), { collectTrace: false });
    const storm = runSimulation(chatReconnectStorm(), { collectTrace: false });

    const stormGw = storm.nodes.find((n: { nodeId: string }) => n.nodeId === "gw")!.connections!;
    const calmGw = calm.nodes.find((n: { nodeId: string }) => n.nodeId === "gw")!.connections!;

    expect(stormGw.droppedByFault).toBe(5000);
    // Accept rate rises well above the steady churn, and both accept and delivery
    // latency degrade -- for users who never disconnected.
    expect(stormGw.acceptRatePerSec).toBeGreaterThan(calmGw.acceptRatePerSec * 2);
    expect(stormGw.acceptLatency.p99).toBeGreaterThan(calmGw.acceptLatency.p99 * 10);
    expect(stormGw.pushLatency.p99).toBeGreaterThan(calmGw.pushLatency.p99 * 10);
  });

  it("both examples keep every invariant", () => {
    for (const build of [chat20k, chatReconnectStorm]) {
      const r = runSimulation(build());
      expect(r.invariants.filter((i) => !i.passed).map((f) => f.name)).toEqual([]);
    }
  });
});
