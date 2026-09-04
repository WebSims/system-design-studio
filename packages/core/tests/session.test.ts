import { describe, expect, it } from "vitest";
import { DESIGN_SCHEMA_VERSION, DesignSchema, type Design } from "@sds/schema";
import { runSimulation } from "../src/run";
import { SimulationSession } from "../src/session";

function sessionDesign(durationSec = 2): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "session test",
    nodes: [
      {
        id: "browser",
        kind: "client",
        label: "browser",
        x: 0,
        y: 0,
        client: {
          arrival: { kind: "deterministic", ratePerSec: 10 },
          timeoutMs: null,
        },
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
          serviceTime: { kind: "deterministic", value: 100 },
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
        },
      },
    ],
    edges: [
      {
        id: "request",
        from: "browser",
        to: "api",
        latency: { kind: "deterministic", value: 1 },
        lossProbability: 0,
      },
    ],
    scenario: { durationSec, warmupSec: 0, seed: 17, traceLimit: 500 },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

const outcome = (result: ReturnType<typeof runSimulation>) => ({ ...result, wallMs: 0 });

describe("SimulationSession", () => {
  it("is byte-equivalent to the one-shot wrapper across event batches", () => {
    const design = sessionDesign();
    const expected = runSimulation(design);
    const session = new SimulationSession(design, { mode: "full" });

    while (!session.snapshot().resultAvailable) session.advanceEvents(7);

    expect(outcome(session.replayResult())).toEqual(outcome(expected));
  });

  it("is independent of virtual-time batch boundaries", () => {
    const design = sessionDesign();
    const small = new SimulationSession(design);
    const large = new SimulationSession(design);

    while (!small.snapshot().resultAvailable) small.advanceBy(37);
    large.advanceBy(large.snapshot().durationMs);

    expect(outcome(small.replayResult())).toEqual(outcome(large.replayResult()));
  });

  it("keeps pause and presentation speed out of the model and RNG", () => {
    const design = sessionDesign();
    const plain = new SimulationSession(design);
    const presented = new SimulationSession(design, { paused: true, presentationSpeed: 0.5 });

    presented.setPresentationSpeed(8);
    presented.setPaused(false);
    presented.setPaused(true);

    const a = plain.finalize().result!;
    const b = presented.finalize().result!;
    expect(outcome(a)).toEqual(outcome(b));
  });

  it("injects exactly one request per manual action and reports deltas", () => {
    const session = new SimulationSession(sessionDesign(1), { mode: "manual" });

    session.injectRequest("browser");
    const entered = session.advanceEvents(1);
    expect(entered.delta.eventsExecuted).toBe(1);
    expect(entered.delta.occupancy).toContainEqual({
      nodeId: "api",
      before: { queued: 0, inService: 0, total: 0 },
      after: { queued: 0, inService: 1, total: 1 },
    });

    const completed = session.finalize();
    const result = completed.result!;
    expect(result.endToEnd.count + result.errors.total).toBe(1);
    expect(new Set([...result.trace.hops, ...result.trace.visits].map((item) => item.requestId))).toEqual(
      new Set([0])
    );
    expect(completed.delta.trace.hops.length + completed.delta.trace.visits.length).toBeGreaterThan(0);
  });

  it("supports disabling sources before execution", () => {
    const session = new SimulationSession(sessionDesign(1), {
      mode: "full",
      enabledSourceIds: [],
    });
    const result = session.finalize().result!;
    expect(result.endToEnd.count + result.errors.total).toBe(0);
    expect(result.offeredRatePerSec).toBe(0);
  });

  it("rejects work after executable state invalidation", () => {
    const session = new SimulationSession(sessionDesign(), { mode: "manual" });
    const snapshot = session.invalidate("candidate revision changed");
    expect(snapshot.status).toBe("invalidated");
    expect(snapshot.invalidationReason).toBe("candidate revision changed");
    expect(() => session.injectRequest("browser")).toThrow(/invalidated/);
  });
});
