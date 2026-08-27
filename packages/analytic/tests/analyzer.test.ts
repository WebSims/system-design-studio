import { describe, expect, it } from "vitest";
import { runSimulation } from "@sds/core";
import { solveMMc } from "@sds/analytic";
import { DesignSchema, type Design, type SdsEdge } from "@sds/schema";
import { asyncWritePath, cachedReadPath, retryStorm, retryStormContained } from "@sds/models";
import {
  analyse,
  criticalPath,
  enumerateKnobs,
  findKnee,
  loadCurve,
  offeredRate,
  scaleLoad,
  searchConfig,
  sensitivity,
  sloBreach,
} from "@sds/analyze";
import { previewDesign } from "../src/preview";
import { relError } from "./harness";

const previewDesignStable = (d: Design): boolean => previewDesign(d).stable;

/**
 * PHASE 4 VALIDATION: THE ANALYZER
 *
 * The knee has an exact answer, which makes it the anchor of this file. For a single
 * M/M/c station the sojourn-time p99 is known in closed form, so the load at which
 * it crosses an SLO target can be computed by inverting that formula -- and the
 * search must land on the same number.
 *
 * Critical-path attribution is likewise checked against per-station analytic
 * shares, not against a previous run.
 *
 * Where no exact answer exists (config search, findings), the tests assert the
 * property that makes the output trustworthy: that a search result actually passes,
 * that a shrink pass really is minimal, that a finding fires only when its
 * condition holds and not otherwise.
 */

const PROBE = { probeDurationSec: 200, seed: 7 } as const;

/**
 * Shorten a design's scenario.
 *
 * The findings tests check that a condition FIRES, not the precision of the number
 * that triggered it. Running the shipped examples at full length would spend fifty
 * seconds apiece to reach a conclusion that is unambiguous in five, and a validation
 * gate nobody runs because it is slow protects nothing.
 */
function quick(design: Design, durationSec = 120): Design {
  return DesignSchema.parse({
    ...design,
    scenario: {
      ...design.scenario,
      durationSec,
      warmupSec: Math.max(10, durationSec * 0.2),
      traceLimit: 0,
    },
  });
}

function station(o: {
  lambda: number;
  meanMs: number;
  c: number;
  p99TargetMs?: number | null;
  maxErrorPct?: number | null;
  durationSec?: number;
}): Design {
  return DesignSchema.parse({
    version: 5,
    name: "knee",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: { arrival: { kind: "poisson", ratePerSec: o.lambda }, timeoutMs: null },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 1,
        y: 0,
        server: {
          concurrency: o.c,
          serviceTime: { kind: "exponential", mean: o.meanMs },
        },
      },
    ],
    edges: [{ id: "e", from: "client", to: "api", latency: { kind: "deterministic", value: 0 } }],
    classes: [],
    scenario: { durationSec: o.durationSec ?? 400, warmupSec: 60, seed: 7, traceLimit: 0 },
    slo: {
      p99LatencyMs: o.p99TargetMs === undefined ? 200 : o.p99TargetMs,
      maxErrorRatePct: o.maxErrorPct ?? null,
    },
  });
}

/**
 * The exact load at which a single M/M/c station's p99 crosses `targetMs`.
 *
 * Found by bisecting on lambda over the closed-form quantile. This is the number the
 * knee search has to reproduce, and having it means the search is checked against
 * theory rather than against itself.
 */
function analyticKneeRate(meanMs: number, c: number, targetMs: number): number {
  const mu = 1000 / meanMs;
  const ceiling = c * mu;
  let lo = 0;
  let hi = ceiling * 0.9999;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const q = solveMMc({ lambda: mid, mu, c }).quantileMs(0.99);
    if (q !== null && q <= targetMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------

describe("knee finding matches the closed-form crossing", () => {
  const cases = [
    { meanMs: 20, c: 1, targetMs: 150 },
    { meanMs: 40, c: 4, targetMs: 300 },
    { meanMs: 25, c: 8, targetMs: 200 },
  ];

  for (const { meanMs, c, targetMs } of cases) {
    it(`finds the p99 crossing for c=${c}, ${meanMs}ms service, ${targetMs}ms target`, () => {
      const exact = analyticKneeRate(meanMs, c, targetMs);
      // Start well below the knee so the search has to expand upward to find it.
      const design = station({
        lambda: exact * 0.5,
        meanMs,
        c,
        p99TargetMs: targetMs,
        durationSec: 400,
      });

      // Long probes: the search is limited by each probe's p99 precision, not by its
      // bracket, so buying accuracy means buying samples.
      const knee = findKnee(design, { probeDurationSec: 1200, seed: 7, refineSteps: 11, tolerance: 0.01 });
      expect(knee.unavailableReason).toBeNull();
      expect(knee.breach).toBe("latency");
      expect(relError(knee.maxRatePerSec, exact)).toBeLessThan(0.12);
      expect(knee.maxRatePerSec).toBeLessThanOrEqual(knee.firstFailingRatePerSec!);
      // And the reported precision must be honest about the residual error.
      expect(knee.precisionFraction).toBeGreaterThan(0);
    });
  }

  it("reports headroom relative to current load", () => {
    const meanMs = 40;
    const c = 4;
    const targetMs = 300;
    const exact = analyticKneeRate(meanMs, c, targetMs);
    const current = exact * 0.5;
    const knee = findKnee(station({ lambda: current, meanMs, c, p99TargetMs: targetMs }), PROBE);
    // Roughly twice the current load should fit.
    expect(knee.headroomFraction).toBeGreaterThan(0.6);
    expect(relError(knee.currentRatePerSec, current)).toBeLessThan(1e-6);
  });

  it("searches downward when the design already fails", () => {
    // Offered load above the analytic ceiling: no steady state at all.
    const design = station({ lambda: 300, meanMs: 20, c: 1, p99TargetMs: 150 });
    const knee = findKnee(design, PROBE);
    expect(knee.headroomFraction).toBeLessThan(0);
    expect(knee.maxRatePerSec).toBeLessThan(knee.currentRatePerSec);
    // c=1 at 20ms cannot exceed 50/s whatever the target.
    expect(knee.maxRatePerSec).toBeLessThan(50);
  });

  it("identifies instability rather than latency when capacity runs out first", () => {
    // A target so generous that the queue diverges before the p99 crosses it.
    const design = station({ lambda: 20, meanMs: 20, c: 1, p99TargetMs: 100_000 });
    const knee = findKnee(design, PROBE);
    expect(knee.breach).toBe("instability");
    // The absolute ceiling is c/E[S] = 50/s.
    expect(knee.maxRatePerSec).toBeLessThan(52);
    expect(knee.maxRatePerSec).toBeGreaterThan(40);
  });

  it("declines to search when no SLO is set", () => {
    const design = station({ lambda: 40, meanMs: 20, c: 4, p99TargetMs: null });
    const knee = findKnee(design, PROBE);
    expect(knee.unavailableReason).toMatch(/no SLO/);
    expect(knee.simulations).toBe(0);
  });

  it("costs a couple of dozen simulations, which is the point of a headless engine", () => {
    const knee = findKnee(station({ lambda: 60, meanMs: 40, c: 4 }), PROBE);
    expect(knee.simulations).toBeGreaterThan(4);
    expect(knee.simulations).toBeLessThan(40);
  });

  it("reports its own precision, and short probes report worse precision", () => {
    /**
     * The knee is limited by probe noise, not by the bracket: near the crossing the
     * latency curve is steep, so a few percent of p99 uncertainty becomes a larger
     * uncertainty in the rate. Quoting a knee to three digits from short probes would
     * be false precision.
     */
    const design = station({ lambda: 30, meanMs: 40, c: 4, p99TargetMs: 300 });
    const short = findKnee(design, { probeDurationSec: 120, seed: 7 });
    const long = findKnee(design, { probeDurationSec: 900, seed: 7 });
    expect(short.probeTailError).toBeGreaterThan(long.probeTailError);
    expect(short.precisionNote).toMatch(/knee located to about/);
  });

  it("the curve is ordered and brackets the reported knee", () => {
    const knee = findKnee(station({ lambda: 60, meanMs: 40, c: 4 }), PROBE);
    for (let i = 1; i < knee.curve.length; i++) {
      expect(knee.curve[i]!.ratePerSec).toBeGreaterThanOrEqual(knee.curve[i - 1]!.ratePerSec);
    }
    const passing = knee.curve.filter((p) => p.meetsSlo);
    expect(Math.max(...passing.map((p) => p.ratePerSec))).toBeCloseTo(knee.maxRatePerSec, 4);
  });
});

describe("load curve shows throughput saturating", () => {
  it("throughput flattens at capacity while offered load keeps rising", () => {
    const curve = loadCurve(station({ lambda: 40, meanMs: 20, c: 1 }), {
      from: 0.5,
      to: 4,
      points: 8,
      probeDurationSec: 200,
      seed: 3,
    });
    const ceiling = 1000 / 20; // c=1 at 20ms => 50/s
    const last = curve[curve.length - 1]!;
    expect(last.ratePerSec).toBeGreaterThan(ceiling * 2);
    expect(last.throughputPerSec).toBeLessThanOrEqual(ceiling * 1.05);
    // And it is monotone non-decreasing up to that ceiling.
    expect(curve[0]!.throughputPerSec).toBeLessThan(last.throughputPerSec);
  });
});

describe("critical-path attribution is exact for the mean", () => {
  /**
   * Expectation is linear, so end-to-end mean latency is exactly the sum of
   * per-station contributions plus network. That identity is the check.
   */
  function chain(stations: Array<{ meanMs: number; c: number }>, lambda: number, latencyMs: number): Design {
    const nodes: unknown[] = [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: { arrival: { kind: "poisson", ratePerSec: lambda } },
      },
    ];
    const edges: unknown[] = [];
    let prev = "client";
    stations.forEach((s, i) => {
      const id = `s${i}`;
      nodes.push({
        id,
        kind: "server",
        label: id,
        x: i + 1,
        y: 0,
        server: {
          concurrency: s.c,
          serviceTime: { kind: "exponential", mean: s.meanMs },
          // Non-blocking, so each station's self time is its own and the chain is a
          // Jackson network with exact per-station solutions to compare against.
          blocksOnDependencies: false,
        },
      });
      edges.push({
        id: `e${i}`,
        from: prev,
        to: id,
        latency: { kind: "deterministic", value: latencyMs },
      });
      prev = id;
    });
    return DesignSchema.parse({
      version: 5,
      name: "chain",
      nodes,
      edges,
      classes: [],
      scenario: { durationSec: 900, warmupSec: 150, seed: 5, traceLimit: 0 },
      slo: { p99LatencyMs: null, maxErrorRatePct: null },
    });
  }

  it("contributions sum to the end-to-end mean", () => {
    const design = chain([{ meanMs: 30, c: 1 }, { meanMs: 20, c: 1 }, { meanMs: 40, c: 2 }], 20, 2);
    const result = runSimulation(design, { collectTrace: false });
    const path = criticalPath(result);
    expect(Math.abs(path.residualFraction)).toBeLessThan(0.02);
    expect(relError(path.accountedMs, path.endToEndMeanMs)).toBeLessThan(0.02);
  });

  it("per-station shares match the analytic per-station response times", () => {
    const lambda = 20;
    const specs = [{ meanMs: 30, c: 1 }, { meanMs: 20, c: 1 }, { meanMs: 40, c: 2 }];
    const design = chain(specs, lambda, 0);
    const result = runSimulation(design, { collectTrace: false });
    const path = criticalPath(result);

    const analytic = specs.map((s) => solveMMc({ lambda, mu: 1000 / s.meanMs, c: s.c }).wMs);
    const total = analytic.reduce((a, b) => a + b, 0);

    specs.forEach((_, i) => {
      const contribution = path.contributions.find((c) => c.id === `s${i}`)!;
      expect(relError(contribution.totalMs, analytic[i]!)).toBeLessThan(0.08);
      expect(relError(contribution.share, analytic[i]! / total)).toBeLessThan(0.08);
    });
  });

  it("network time is attributed and counts both directions", () => {
    const latencyMs = 5;
    const design = chain([{ meanMs: 10, c: 8 }], 20, latencyMs);
    const path = criticalPath(runSimulation(design, { collectTrace: false }));
    const net = path.contributions.find((c) => c.kind === "network")!;
    // One edge, traversed once per request, two legs.
    expect(net.totalMs).toBeGreaterThan(latencyMs * 1.8);
    expect(net.totalMs).toBeLessThan(latencyMs * 2.2);
  });

  it("names the dominant station", () => {
    // s2 at 40ms over 1 server is by far the largest contributor.
    const design = chain([{ meanMs: 5, c: 8 }, { meanMs: 5, c: 8 }, { meanMs: 40, c: 1 }], 20, 0);
    const path = criticalPath(runSimulation(design, { collectTrace: false }));
    expect(path.contributions[0]!.id).toBe("s2");
    expect(path.contributions[0]!.share).toBeGreaterThan(0.7);
  });

  it("withholds p99 attribution and explains why", () => {
    const design = chain([{ meanMs: 20, c: 2 }], 40, 0);
    const path = criticalPath(runSimulation(design, { collectTrace: false }));
    expect(path.p99Attribution).toBeNull();
    expect(path.p99Reason).toMatch(/does not decompose/);
  });

  it("flags fork-join, where shares cannot sum to the request's experience", () => {
    const design = DesignSchema.parse({
      version: 5,
      name: "fanout",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 30 } } },
        { id: "api", kind: "server", label: "api", x: 1, y: 0, server: { concurrency: 256, serviceTime: { kind: "deterministic", value: 1 }, fanout: "parallel" } },
        { id: "a", kind: "server", label: "a", x: 2, y: 0, server: { concurrency: 64, serviceTime: { kind: "exponential", mean: 40 } } },
        { id: "b", kind: "server", label: "b", x: 2, y: 1, server: { concurrency: 64, serviceTime: { kind: "exponential", mean: 60 } } },
      ],
      edges: [
        { id: "e1", from: "client", to: "api" },
        { id: "e2", from: "api", to: "a" },
        { id: "e3", from: "api", to: "b" },
      ],
      classes: [],
      scenario: { durationSec: 400, warmupSec: 60, seed: 2, traceLimit: 0 },
      slo: {},
    });
    const path = criticalPath(runSimulation(design, { collectTrace: false }));
    expect(path.caveat).toMatch(/parallel/);
    // Shares add up to more work than the request waited for, which is the point.
    expect(path.accountedMs).toBeGreaterThan(path.endToEndMeanMs);
  });
});

describe("sensitivity ranks by measured effect", () => {
  it("capacity at the bottleneck beats capacity anywhere else", () => {
    const design = DesignSchema.parse({
      version: 5,
      name: "sens",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 90 } } },
        // Roomy: 90/s x 2ms over 64 slots is nothing.
        { id: "api", kind: "server", label: "api", x: 1, y: 0, server: { concurrency: 64, serviceTime: { kind: "exponential", mean: 2 }, blocksOnDependencies: false } },
        // Tight: 90/s x 40ms needs 3.6 of 4 slots.
        { id: "db", kind: "server", label: "db", x: 2, y: 0, server: { concurrency: 4, serviceTime: { kind: "exponential", mean: 40 } } },
      ],
      edges: [
        { id: "e1", from: "client", to: "api" },
        { id: "e2", from: "api", to: "db" },
      ],
      classes: [],
      scenario: { durationSec: 400, warmupSec: 60, seed: 4, traceLimit: 0 },
      slo: { p99LatencyMs: 200 },
    });

    const report = sensitivity(design, { probeDurationSec: 250, seed: 4, kinds: ["concurrency"] });
    const best = report.results[0]!;
    expect(best.nodeId).toBe("db");
    expect(best.improvementMs).toBeGreaterThan(0);

    const apiKnob = report.results.find((r) => r.nodeId === "api")!;
    // Adding capacity where there is no queue does essentially nothing.
    expect(Math.abs(apiKnob.improvementMs)).toBeLessThan(best.improvementMs / 4);
  });

  it("elasticity is signed by the parameter, not by whether it helped", () => {
    const design = DesignSchema.parse({
      version: 5,
      name: "sens2",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 90 } } },
        { id: "db", kind: "server", label: "db", x: 1, y: 0, server: { concurrency: 4, serviceTime: { kind: "exponential", mean: 40 } } },
      ],
      edges: [{ id: "e", from: "client", to: "db" }],
      classes: [],
      scenario: { durationSec: 400, warmupSec: 60, seed: 4, traceLimit: 0 },
      slo: { p99LatencyMs: 200 },
    });
    const report = sensitivity(design, { probeDurationSec: 250, seed: 4 });

    const concurrency = report.results.find((r) => r.kind === "concurrency")!;
    const serviceTime = report.results.find((r) => r.kind === "serviceTime")!;

    // Both perturbations improve latency, and `improvementMs` says so for both --
    // that is the direction-independent measure.
    expect(concurrency.improvementMs).toBeGreaterThan(0);
    expect(serviceTime.improvementMs).toBeGreaterThan(0);

    // Elasticity is signed in the ordinary sense, so the signs differ: raising
    // concurrency lowers p99 (negative), lowering service time also lowers p99
    // (positive). A number whose sign flipped with the knob's direction would be
    // one the reader has to decode.
    expect(concurrency.elasticity).toBeLessThan(0);
    expect(serviceTime.elasticity).toBeGreaterThan(0);
  });

  it("measures integer knobs against the change that actually happened", () => {
    // Concurrency 4 perturbed by 20% rounds to 5, a real change of 25%.
    const design = DesignSchema.parse({
      version: 5,
      name: "sens3",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 80 } } },
        { id: "db", kind: "server", label: "db", x: 1, y: 0, server: { concurrency: 4, serviceTime: { kind: "exponential", mean: 40 } } },
      ],
      edges: [{ id: "e", from: "client", to: "db" }],
      classes: [],
      scenario: { durationSec: 300, warmupSec: 50, seed: 1, traceLimit: 0 },
      slo: { p99LatencyMs: 250 },
    });
    const report = sensitivity(design, { probeDurationSec: 200, seed: 1, kinds: ["concurrency"] });
    const knob = report.results.find((r) => r.nodeId === "db")!;
    expect(knob.improvedValue).toBe(5);
    expect(knob.parameterDelta).toBeCloseTo(0.25, 6);
  });

  it("reports knobs that cannot be moved rather than silently dropping them", () => {
    const design = DesignSchema.parse({
      version: 5,
      name: "sens4",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 10 } } },
        { id: "s", kind: "server", label: "s", x: 1, y: 0, server: { concurrency: 1, serviceTime: { kind: "exponential", mean: 10 }, replicas: 1 } },
      ],
      edges: [{ id: "e", from: "client", to: "s" }],
      classes: [],
      scenario: { durationSec: 200, warmupSec: 40, seed: 1, traceLimit: 0 },
      slo: { p99LatencyMs: 500 },
    });
    const report = sensitivity(design, { probeDurationSec: 150, seed: 1, kinds: ["replicas"] });
    // replicas 1 x 1.2 rounds back to 1: unmovable, and said so.
    const replicas = report.results.find((r) => r.kind === "replicas")!;
    expect(replicas.elasticity).toBeNull();
    expect(report.notes.join(" ")).toMatch(/could not be moved/);
  });
});

describe("config search finds a passing configuration and does not over-provision", () => {
  it("returns no changes when the design already passes", () => {
    const design = station({ lambda: 20, meanMs: 20, c: 4, p99TargetMs: 300 });
    const search = searchConfig(design, { probeDurationSec: 200, seed: 2 });
    expect(search.found).toBe(true);
    expect(search.changes).toEqual([]);
    expect(search.notes.join(" ")).toMatch(/already meets/);
  });

  it("finds enough capacity to meet a target it currently misses", () => {
    /**
     * c=1 at 20ms is 50/s of capacity against 45/s offered: stable but at rho = 0.9,
     * where p99 is around 900ms. The 150ms target is reachable with more
     * concurrency, which matters -- an exponential 20ms service has a p99 of about
     * 92ms from its own tail alone, so any target below that is unreachable at ANY
     * capacity and would be testing the wrong thing.
     */
    const design = station({ lambda: 45, meanMs: 20, c: 1, p99TargetMs: 150 });
    const before = runSimulation(design, { collectTrace: false });
    expect(sloBreach(before)).not.toBeNull();

    const search = searchConfig(design, { probeDurationSec: 250, seed: 2 });
    expect(search.found).toBe(true);
    expect(search.changes.length).toBeGreaterThan(0);
    expect(search.afterP99Ms).toBeLessThan(search.beforeP99Ms);

    // And the proposed design genuinely passes on a full-length run, not just on the
    // short probe the search used.
    const verified = runSimulation(search.design, { collectTrace: false });
    expect(sloBreach(verified)).toBeNull();
  });

  it("the shrink pass leaves a configuration that is minimal in one step", () => {
    /**
     * The property that distinguishes a search result from a shrug. Every change it
     * proposes must be necessary: dialling any single one back by one unit has to
     * break the SLO again.
     */
    const design = station({ lambda: 45, meanMs: 20, c: 1, p99TargetMs: 150 });
    const search = searchConfig(design, { probeDurationSec: 250, seed: 2 });
    expect(search.found).toBe(true);

    for (const change of search.changes) {
      const knob = enumerateKnobs(search.design).find((k) => k.id === change.knobId)!;
      const stepped = knob.integer ? knob.value - 1 : knob.value / 1.2;
      if (stepped < change.from) continue; // already back at the original
      const weakened = knob.apply(search.design, stepped);
      const r = runSimulation(
        DesignSchema.parse({
          ...weakened,
          scenario: { ...weakened.scenario, durationSec: 250, warmupSec: 50, traceLimit: 0 },
        }),
        { seed: 2, collectTrace: false }
      );
      expect(sloBreach(r)).not.toBeNull();
    }
  });

  it("says so when capacity is not the constraint", () => {
    /**
     * A target below the service-time tail. An exponential 40ms service has a p99 of
     * about 184ms from its own variability, with no queueing at all, so no amount of
     * concurrency reaches 5ms. The search must say that rather than grow forever.
     */
    const design = station({ lambda: 10, meanMs: 40, c: 1, p99TargetMs: 5 });
    const search = searchConfig(design, { probeDurationSec: 150, seed: 2, maxIterations: 4 });
    expect(search.found).toBe(false);
    expect(search.reason).toMatch(/not the constraint|met the SLO/);
  });

  it("declines when no SLO is set", () => {
    const design = station({ lambda: 20, meanMs: 20, c: 4, p99TargetMs: null });
    const search = searchConfig(design, { probeDurationSec: 150, seed: 2 });
    expect(search.reason).toMatch(/no SLO/);
  });
});

describe("findings fire on their conditions, and not otherwise", () => {
  it("a healthy design produces no critical findings", () => {
    const design = station({ lambda: 20, meanMs: 20, c: 8, p99TargetMs: 300 });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    expect(report.findings.filter((f) => f.severity === "critical")).toEqual([]);
  });

  it("reports instability first, and says nothing else matters until it is fixed", () => {
    const design = station({ lambda: 80, meanMs: 20, c: 1, p99TargetMs: 200 });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    expect(report.findings[0]!.id).toBe("instability");
    expect(report.findings[0]!.remediation).toMatch(/Nothing else in this report/);
  });

  it("reports retry amplification with a budget remediation", () => {
    const design = quick(retryStorm());
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id === "retry-amplification")!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("critical");
    expect(finding.evidence).toMatch(/attempts for/);
    expect(finding.remediation).toMatch(/retry budget of 10%/);
  });

  it("does not report amplification once it is contained", () => {
    const design = quick(retryStormContained());
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    expect(report.findings.find((f) => f.id === "retry-amplification")).toBeUndefined();
  });

  it("reports a growing async backlog with a consumer count to reach", () => {
    const design = quick(asyncWritePath());
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id === "async-backlog")!;
    expect(finding).toBeDefined();
    expect(finding.remediation).toMatch(/raise consumers from 4 to at least/);
  });

  it("flags an undersized connection pool with the value to raise it to", () => {
    const design = DesignSchema.parse({
      version: 5,
      name: "pool",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 50 } } },
        {
          id: "db",
          kind: "database",
          label: "db",
          x: 1,
          y: 0,
          database: { poolSize: 2, parallelism: 8, serviceTime: { kind: "exponential", mean: 20 } },
        },
      ],
      edges: [{ id: "e", from: "client", to: "db" }],
      classes: [],
      scenario: { durationSec: 300, warmupSec: 50, seed: 1, traceLimit: 0 },
      slo: { p99LatencyMs: 300 },
    });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id === "pool-undersized:db")!;
    expect(finding).toBeDefined();
    expect(finding.remediation).toMatch(/from 2 to 8/);
  });

  it("flags retries that have no budget, and retries of shed requests", () => {
    const design = DesignSchema.parse({
      version: 5,
      name: "bad-retries",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 50 } } },
        { id: "s", kind: "server", label: "s", x: 1, y: 0, server: { concurrency: 32, serviceTime: { kind: "exponential", mean: 5 } } },
      ],
      edges: [
        {
          id: "e",
          from: "client",
          to: "s",
          policy: {
            retry: {
              maxAttempts: 3,
              retryOn: ["error", "shed"],
              budgetRatio: null,
              backoff: { kind: "fixed", baseMs: 10, maxMs: 100, jitter: false },
            },
          },
        } as Partial<SdsEdge>,
      ],
      classes: [],
      scenario: { durationSec: 200, warmupSec: 40, seed: 1, traceLimit: 0 },
      slo: { p99LatencyMs: 200 },
    });
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    expect(report.findings.find((f) => f.id === "no-retry-budget:e")).toBeDefined();
    expect(report.findings.find((f) => f.id === "retry-on-shed:e")).toBeDefined();
    expect(report.findings.find((f) => f.id === "no-jitter:e")).toBeDefined();
  });

  it("flags multiple backends with no health checking", () => {
    const design = quick(cachedReadPath());
    const report = analyse(design, runSimulation(design, { collectTrace: false }));
    const finding = report.findings.find((f) => f.id === "no-health-check:lb")!;
    expect(finding).toBeDefined();
    expect(finding.remediation).toMatch(/33% of requests/);
  });

  it("reconciles a predicted-unstable design that the run reports as stable", () => {
    /**
     * The two methods can legitimately disagree: a client deadline turns an unbounded
     * queue into a bounded one by abandoning requests, which the closed form does not
     * model. Emitting a bare "predicted unstable" next to a stable run would read as
     * the tool contradicting itself, when it has actually found something -- the queue
     * is held down by throwing work away, not by spare capacity.
     */
    /**
     * Full length deliberately. A short run cannot tell "still filling towards a
     * timeout-bounded plateau" from "growing without bound" -- at 120s this same
     * design reports UNSTABLE, and correctly so, because the slope really is still
     * positive. The distinction needs enough window to see the plateau, which is
     * itself worth knowing about the stability verdict.
     */
    const design = retryStorm();
    const result = runSimulation(design, { collectTrace: false });
    expect(result.stability.stable).toBe(true);
    expect(previewDesignStable(design)).toBe(false);

    const report = analyse(design, result);
    const finding = report.findings.find((f) => f.id === "instability-bounded-by-timeouts")!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("critical");
    expect(finding.evidence).toMatch(/gave up before completing/);
    expect(finding.remediation).toMatch(/do not read the stable verdict as headroom/);
    // And the bare predicted-only finding must NOT also be present.
    expect(report.findings.find((f) => f.id === "instability-predicted")).toBeUndefined();
  });

  it("works from the closed form alone, before any simulation", () => {
    // What lets the studio show findings while the design is still being edited.
    const design = station({ lambda: 200, meanMs: 20, c: 1, p99TargetMs: 100 });
    const report = analyse(design, null);
    expect(report.result).toBeNull();
    expect(report.criticalPath).toBeNull();
    expect(report.findings.some((f) => f.id === "instability-predicted")).toBe(true);
    expect(report.summary).toMatch(/predicted from the closed form/);
  });

  it("every finding carries evidence and a specific remediation", () => {
    /**
     * The rule the whole file exists to enforce. A claim without its numbers cannot
     * be checked, and advice the reader has to translate into an action is half
     * advice.
     */
    for (const build of [retryStorm, asyncWritePath, cachedReadPath]) {
      const design = quick(build());
      const report = analyse(design, runSimulation(design, { collectTrace: false }));
      for (const f of report.findings) {
        expect(f.evidence.length).toBeGreaterThan(20);
        expect(f.remediation.length).toBeGreaterThan(20);
        // Evidence must contain at least one number.
        expect(/\d/.test(f.evidence)).toBe(true);
      }
    }
  });
});

describe("load scaling preserves the workload mix", () => {
  it("scales every client by the same factor", () => {
    const design = cachedReadPath();
    const base = offeredRate(design);
    const scaled = scaleLoad(design, 2.5);
    expect(relError(offeredRate(scaled), base * 2.5)).toBeLessThan(1e-9);
    // Class weights are untouched, so the mix is identical.
    expect(scaled.classes).toEqual(design.classes);
  });
});
