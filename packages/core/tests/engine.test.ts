import { describe, expect, it } from "vitest";
import { DESIGN_SCHEMA_VERSION, DesignSchema, type Design } from "@sds/schema";
import { defaultDesign } from "@sds/models";
import { requiredSamples } from "../src/confidence";
import { runSimulation } from "../src/run";

function station(overrides: {
  lambda: number;
  serviceMeanMs: number;
  c: number;
  durationSec?: number;
  warmupSec?: number;
  seed?: number;
  queueCapacity?: number | null;
  admissionPolicy?: "shed" | "block";
  timeoutMs?: number | null;
  lossProbability?: number;
}): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "t",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: {
          arrival: { kind: "poisson", ratePerSec: overrides.lambda },
          timeoutMs: overrides.timeoutMs ?? null,
        },
      },
      {
        id: "station",
        kind: "server",
        label: "station",
        x: 200,
        y: 0,
        server: {
          concurrency: overrides.c,
          queueCapacity: overrides.queueCapacity ?? null,
          serviceTime: { kind: "exponential", mean: overrides.serviceMeanMs },
          admissionPolicy: overrides.admissionPolicy ?? "block",
          queueDiscipline: "fifo",
          replicas: 1,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        from: "client",
        to: "station",
        latency: { kind: "deterministic", value: 1 },
        lossProbability: overrides.lossProbability ?? 0,
      },
    ],
    scenario: {
      durationSec: overrides.durationSec ?? 120,
      warmupSec: overrides.warmupSec ?? 20,
      seed: overrides.seed ?? 7,
      traceLimit: 500,
    },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

describe("invariants hold on every run", () => {
  /**
   * These are checked inside the engine and surfaced in `result.invariants`, not
   * only asserted here. A simulator that quietly violates conservation of
   * requests or Little's Law emits numbers that look entirely plausible and are
   * wrong; the failure mode we want is "the tool flags its own output as
   * suspect", never "the tool is confidently incorrect".
   */
  const scenarios: Array<[string, Design]> = [
    ["lightly loaded", station({ lambda: 10, serviceMeanMs: 20, c: 1 })],
    ["near saturation", station({ lambda: 45, serviceMeanMs: 20, c: 1 })],
    ["multi-server", station({ lambda: 150, serviceMeanMs: 40, c: 8 })],
    ["shedding under overload", station({ lambda: 200, serviceMeanMs: 40, c: 4, queueCapacity: 8, admissionPolicy: "shed" })],
    ["with client timeouts", station({ lambda: 60, serviceMeanMs: 40, c: 2, timeoutMs: 100 })],
    ["with packet loss", station({ lambda: 40, serviceMeanMs: 20, c: 2, lossProbability: 0.05 })],
    ["saturated and unstable", station({ lambda: 80, serviceMeanMs: 20, c: 1 })],
  ];

  for (const [name, design] of scenarios) {
    it(`all invariants pass: ${name}`, () => {
      const r = runSimulation(design);
      const failed = r.invariants.filter((i) => !i.passed);
      expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    });
  }

  it("reports Little's Law with a real numerical error, not a rubber stamp", () => {
    const r = runSimulation(station({ lambda: 40, serviceMeanMs: 20, c: 1, durationSec: 600, warmupSec: 60 }));
    const little = r.invariants.find((i) => i.name.startsWith("Little"))!;
    expect(little.passed).toBe(true);
    expect(little.error).toBeDefined();
    expect(little.error!).toBeLessThan(0.05);
    // A tolerance so loose it can never fail is not a check. Confirm the measured
    // error is genuinely small rather than merely inside a generous bound.
    expect(little.error!).toBeLessThan(0.02);
  });

  it("counts every request exactly once across success, failure and in-flight", () => {
    const r = runSimulation(station({ lambda: 100, serviceMeanMs: 40, c: 2, queueCapacity: 4, admissionPolicy: "shed" }));
    const conservation = r.invariants.find((i) => i.name === "request conservation")!;
    expect(conservation.passed).toBe(true);
    expect(r.errors.total).toBe(r.errors.shed + r.errors.timeout + r.errors.network);
  });
});

describe("determinism", () => {
  /**
   * Reproducibility is a correctness requirement, not a nicety. A tool whose
   * answer changes between identical runs cannot be used to compare two designs,
   * which is the entire purpose. The legacy engine called global `Math.random()`
   * from a dozen sites and had no seed at all.
   */
  it("identical design and seed produce an identical result", () => {
    const design = station({ lambda: 45, serviceMeanMs: 20, c: 2 });
    const a = runSimulation(design);
    const b = runSimulation(design);
    // Compare everything except the wall-clock timing, which is not simulated.
    const strip = (r: typeof a) => JSON.stringify({ ...r, wallMs: 0 });
    expect(strip(a)).toBe(strip(b));
  });

  it("different seeds produce different results", () => {
    // Otherwise the seed is not actually reaching the generators.
    const a = runSimulation(station({ lambda: 45, serviceMeanMs: 20, c: 2, seed: 1 }));
    const b = runSimulation(station({ lambda: 45, serviceMeanMs: 20, c: 2, seed: 2 }));
    expect(a.endToEnd.mean).not.toBe(b.endToEnd.mean);
  });

  it("changing capacity leaves the arrival sequence untouched", () => {
    /**
     * COMMON RANDOM NUMBERS.
     *
     * The single most valuable property of independent per-purpose streams. If
     * arrivals were drawn from a stream shared with service times, adding a
     * server would change how many draws the service stream consumed and thereby
     * shift every subsequent arrival. The two runs would then differ in workload
     * as well as in configuration, and the difference in the result would not be
     * attributable to the change -- silently invalidating any A/B comparison the
     * tool offers.
     *
     * Verified by checking that the total number of arrivals at the station is
     * identical across configurations that differ only in capacity.
     */
    const a = runSimulation(station({ lambda: 40, serviceMeanMs: 20, c: 1, seed: 42 }));
    const b = runSimulation(station({ lambda: 40, serviceMeanMs: 20, c: 4, seed: 42 }));
    const arrivalsA = a.nodes.find((n) => n.nodeId === "station")!.arrivals;
    const arrivalsB = b.nodes.find((n) => n.nodeId === "station")!.arrivals;
    expect(arrivalsA).toBe(arrivalsB);
    // And the configurations must genuinely differ in outcome.
    expect(b.endToEnd.mean).toBeLessThan(a.endToEnd.mean);
  });

  it("the default design runs and is reproducible", () => {
    const a = runSimulation(defaultDesign());
    const b = runSimulation(defaultDesign());
    expect(a.endToEnd.p99).toBe(b.endToEnd.p99);
    expect(a.endToEnd.count).toBeGreaterThan(1000);
  });
});

describe("instability is reported as instability, not as a latency number", () => {
  /**
   * When arrivals exceed service capacity the queue grows for as long as you run,
   * so every latency statistic is a function of run length rather than of the
   * design. Reporting "p99 = 4.2s" there is meaningless: run twice as long and it
   * roughly doubles. This behaviour is the honest alternative.
   */
  it("flags a saturated station as unstable and names it", () => {
    const r = runSimulation(station({ lambda: 60, serviceMeanMs: 20, c: 1, durationSec: 300, warmupSec: 30 }));
    expect(r.stability.stable).toBe(false);
    expect(r.stability.worstNodeId).toBe("station");
    expect(r.stability.worstQueueSlopePerSec).toBeGreaterThan(1);
  });

  it("latency of an unstable system does grow with run length, as claimed", () => {
    // Demonstrates why the number is withheld rather than merely asserting it.
    const short = runSimulation(station({ lambda: 60, serviceMeanMs: 20, c: 1, durationSec: 200, warmupSec: 20 }));
    const long = runSimulation(station({ lambda: 60, serviceMeanMs: 20, c: 1, durationSec: 800, warmupSec: 20 }));
    expect(long.endToEnd.p99).toBeGreaterThan(short.endToEnd.p99 * 1.5);
  });

  it("does not flag a stable station as unstable", () => {
    const r = runSimulation(station({ lambda: 40, serviceMeanMs: 20, c: 1, durationSec: 600, warmupSec: 60 }));
    expect(r.stability.stable).toBe(true);
  });

  it("an unstable design fails its SLO regardless of measured latency", () => {
    const design = DesignSchema.parse({
      ...station({ lambda: 60, serviceMeanMs: 20, c: 1 }),
      slo: { p99LatencyMs: 100_000, maxErrorRatePct: 100 },
    });
    const r = runSimulation(design);
    expect(r.stability.stable).toBe(false);
    expect(r.sloPassed).toBe(false);
  });
});

describe("throughput saturates while offered load keeps rising", () => {
  it("throughput cannot exceed capacity", () => {
    // c=1 at 20ms service => at most 50 req/s can ever complete. The legacy
    // engine throttled emission at 150 in-flight packets for RENDERING reasons
    // (engine.jsx:92), so measured throughput flattened for a reason that had
    // nothing to do with the system under study -- a bottleneck reported by the
    // renderer. Here the ceiling is the modelled capacity and nothing else.
    const capacity = 50;
    for (const lambda of [80, 160, 320]) {
      const r = runSimulation(station({ lambda, serviceMeanMs: 20, c: 1, durationSec: 200, warmupSec: 20 }));
      expect(r.throughputPerSec).toBeLessThanOrEqual(capacity * 1.02);
      expect(r.throughputPerSec).toBeGreaterThan(capacity * 0.9);
      expect(r.offeredRatePerSec).toBe(lambda);
    }
  });
});

describe("timeouts and loss", () => {
  it("client timeouts bound the latency of successful requests", () => {
    const timeoutMs = 120;
    const r = runSimulation(station({ lambda: 70, serviceMeanMs: 40, c: 2, timeoutMs }));
    expect(r.endToEnd.max).toBeLessThanOrEqual(timeoutMs);
    expect(r.errors.timeout).toBeGreaterThan(0);
  });

  it("edge loss applies in both directions, because a response crosses the wire too", () => {
    /**
     * A request/response pair traverses each edge twice, so a 10% per-traversal
     * drop rate loses 1 - 0.9^2 = 19% of requests, not 10%.
     *
     * Phase 1 only modelled the request leg. Counting both is physically right and
     * it matters as soon as a design spans zones: a five-hop path across 1ms links
     * is 10ms of pure network, which is most of a cache's latency budget.
     */
    const p = 0.1;
    const expected = 1 - (1 - p) ** 2;
    const r = runSimulation(station({ lambda: 30, serviceMeanMs: 20, c: 4, lossProbability: p, durationSec: 400, warmupSec: 40 }));
    const observed = r.errors.network / (r.errors.network + r.endToEnd.count);
    expect(observed).toBeGreaterThan(expected - 0.02);
    expect(observed).toBeLessThan(expected + 0.02);
  });
});

describe("trace collection", () => {
  it("samples a trace without exceeding the configured limit", () => {
    const r = runSimulation(station({ lambda: 100, serviceMeanMs: 20, c: 4 }));
    expect(r.trace.hops.length + r.trace.visits.length).toBeLessThanOrEqual(500);
    expect(r.trace.sampleEvery).toBeGreaterThan(1);
    for (const hop of r.trace.hops) expect(hop.tEnd).toBeGreaterThanOrEqual(hop.tStart);
    for (const v of r.trace.visits) expect(v.tExit).toBeGreaterThanOrEqual(v.tEnqueue);
  });

  it("skipping the trace does not change the measured result", () => {
    // The visualization must be a pure observer. If collecting a trace perturbed
    // the numbers, the animation and the analysis would be describing different
    // systems -- exactly the coupling this rewrite exists to remove.
    const design = station({ lambda: 60, serviceMeanMs: 20, c: 2 });
    const withTrace = runSimulation(design, { collectTrace: true });
    const without = runSimulation(design, { collectTrace: false });
    expect(without.endToEnd.mean).toBe(withTrace.endToEnd.mean);
    expect(without.throughputPerSec).toBe(withTrace.throughputPerSec);
    expect(without.trace.hops.length).toBe(0);
  });
});

describe("the engine states its own precision", () => {
  /**
   * Discovered while validating the preview: the original default scenario (60
   * simulated seconds) disagreed with the exact solution by 13% at rho = 0.8,
   * purely from under-sampling. A tool that presents that as a result is
   * confidently wrong, which is the exact failure this whole rewrite exists to
   * eliminate. So the engine now reports how many samples it collected against
   * how many the observed utilization requires.
   */
  it("flags a run that is too short for its utilization", () => {
    const short = runSimulation(station({ lambda: 80, serviceMeanMs: 50, c: 4, durationSec: 60, warmupSec: 10 }));
    expect(short.confidence.sufficient).toBe(false);
    expect(short.confidence.samples).toBeLessThan(short.confidence.requiredSamples);
    expect(short.confidence.approxRelativeError).toBeGreaterThan(0.03);
    expect(short.confidence.note).toMatch(/Raise the run duration/);
  });

  it("accepts a run that is long enough", () => {
    // rho = 0.8 (lambda 80, c 4, 40ms service => c*mu = 100/s), comfortably stable.
    const long = runSimulation(station({ lambda: 80, serviceMeanMs: 40, c: 4, durationSec: 1200, warmupSec: 200 }));
    expect(long.confidence.sufficient).toBe(true);
    expect(long.confidence.approxRelativeError).toBeLessThan(0.025);
  });

  it("reports terrible precision for a saturated system rather than pretending", () => {
    // lambda 80 against c*mu = 80/s exactly: no steady state, so no statistic is
    // trustworthy however long the run. The error model must say so loudly.
    const saturated = runSimulation(station({ lambda: 80, serviceMeanMs: 50, c: 4, durationSec: 1200, warmupSec: 200 }));
    expect(saturated.stability.stable).toBe(false);
    expect(saturated.confidence.approxRelativeError).toBeGreaterThan(0.1);
  });

  it("always reports the tail as less precise than the mean", () => {
    // The p99 is what an SLO is written against, so it must never inherit the
    // mean's error figure.
    const r = runSimulation(defaultDesign());
    expect(r.confidence.approxTailRelativeError).toBeGreaterThan(r.confidence.approxRelativeError);
  });

  it("requires dramatically more samples at high utilization", () => {
    // The 1/(1-rho)^2 scaling, asserted rather than merely documented.
    expect(requiredSamples(0.9) / requiredSamples(0.5)).toBeCloseTo(25, 1);
  });

  it("the shipped default design is long enough to be trusted", () => {
    // Guards against the default regressing back to a comfortable-looking but
    // under-sampled duration.
    const r = runSimulation(defaultDesign());
    expect(r.confidence.sufficient).toBe(true);
  });
});

describe("Phase 1 scope is enforced rather than guessed at", () => {
  it("rejects a cycle instead of silently truncating it", () => {
    /**
     * The legacy engine tolerated cycles by carrying an `ancestors` set and a hard
     * depth cap of 8 (engine.jsx:186,193), which quietly simulated a different
     * topology from the one drawn. A cycle means a retry or a feedback path and
     * neither exists until Phase 3, so the honest response is to say so.
     */
    const design = DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "cycle",
      nodes: [
        { id: "c", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 10 } } },
        { id: "a", kind: "server", label: "a", x: 1, y: 0, server: { concurrency: 1, serviceTime: { kind: "exponential", mean: 10 } } },
        { id: "b", kind: "server", label: "b", x: 2, y: 0, server: { concurrency: 1, serviceTime: { kind: "exponential", mean: 10 } } },
      ],
      edges: [
        { id: "e1", from: "c", to: "a" },
        { id: "e2", from: "a", to: "b" },
        { id: "e3", from: "b", to: "a" },
      ],
      scenario: {},
      slo: {},
    });
    expect(() => runSimulation(design)).toThrow(/loops/);
  });

  it("rejects a design with structural errors instead of running it", () => {
    const design = DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "broken",
      nodes: [{ id: "c", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 10 } } }],
      edges: [{ id: "e1", from: "c", to: "nonexistent" }],
      scenario: {},
      slo: {},
    });
    expect(() => runSimulation(design)).toThrow(/not runnable/);
  });
});
