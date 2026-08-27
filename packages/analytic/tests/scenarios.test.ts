import { describe, expect, it } from "vitest";
import { Rng, confidenceInterval, pairedDifference, runSimulation, tCritical95 } from "@sds/core";
import { DesignSchema, meanRate, peakRate, rateAt, type Design } from "@sds/schema";
import { correlatedCascade, rampToFailure as rampExample, trafficSpike } from "@sds/models";
import {
  checkErrorModel,
  compare,
  findKnee,
  rampToFailure,
  replicate,
  spikeTest,
} from "@sds/analyze";
import { relError } from "./harness";

/**
 * PHASE 5 VALIDATION: MEASURED UNCERTAINTY AND TIME-VARYING LOAD
 *
 * Two families of check.
 *
 * The statistical machinery is validated against its own definitions: a 95% interval
 * must contain the true mean about 95% of the time, and that is directly testable by
 * generating samples from a known distribution. No simulation needed, and no room for
 * a plausible-looking implementation to hide.
 *
 * The arrival profiles are validated against exact integrals. A ramp from a to b over
 * T must deliver (a+b)/2 x T arrivals; a spike must deliver base x (T-d) + peak x d.
 * Thinning is an exact algorithm, so these are equalities up to Poisson noise rather
 * than approximations.
 */

const SEEDS8 = [1, 2, 3, 4, 5, 6, 7, 8];

function station(o: {
  arrival: unknown;
  meanMs: number;
  c: number;
  durationSec?: number;
  warmupSec?: number;
  p99TargetMs?: number | null;
  failureProbability?: number;
  failureAtSaturation?: number | null;
}): Design {
  return DesignSchema.parse({
    version: 5,
    name: "phase5",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: { arrival: o.arrival, timeoutMs: null },
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
          failureProbability: o.failureProbability ?? 0,
          failureAtSaturation: o.failureAtSaturation ?? null,
        },
      },
    ],
    edges: [{ id: "e", from: "client", to: "api", latency: { kind: "deterministic", value: 0 } }],
    classes: [],
    scenario: {
      durationSec: o.durationSec ?? 300,
      warmupSec: o.warmupSec ?? 0,
      seed: 1,
      traceLimit: 0,
    },
    slo: { p99LatencyMs: o.p99TargetMs === undefined ? 200 : o.p99TargetMs, maxErrorRatePct: null },
  });
}

// ---------------------------------------------------------------------------

describe("confidence intervals are correct by their own definition", () => {
  it("uses Student's t, not the normal quantile", () => {
    /**
     * At eight replications the difference matters: t(0.975, 7) is 2.365 against 1.96,
     * so using the normal would report an interval about 20% too narrow. Being
     * optimistic about your own uncertainty is the specific failure this guards.
     */
    expect(tCritical95(7)).toBeCloseTo(2.365, 3);
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(30)).toBeCloseTo(2.042, 3);
    // Beyond the table it converges to the normal.
    expect(tCritical95(1000)).toBeCloseTo(1.96, 6);
  });

  it("a 95% interval contains the true mean about 95% of the time", () => {
    /**
     * The definitional test. Samples are drawn from a normal with a known mean, so
     * coverage can be counted directly. An implementation that got the critical value
     * or the standard error wrong would show up here immediately as under- or
     * over-coverage.
     */
    const rng = new Rng(20260827);
    const trueMean = 40;
    const trueSd = 6;
    const trials = 4000;
    const n = 8;
    let covered = 0;

    for (let t = 0; t < trials; t++) {
      const sample = Array.from({ length: n }, () => trueMean + trueSd * rng.normal());
      const interval = confidenceInterval(sample);
      if (interval.low <= trueMean && trueMean <= interval.high) covered++;
    }
    const coverage = covered / trials;
    // Binomial standard error at 95% over 4000 trials is about 0.35 points, so a
    // correct implementation lands well inside 2 points.
    expect(coverage).toBeGreaterThan(0.93);
    expect(coverage).toBeLessThan(0.97);
  });

  it("the interval narrows as the square root of the sample count", () => {
    const rng = new Rng(7);
    const draw = (n: number) => Array.from({ length: n }, () => 10 + 3 * rng.normal());
    const wide = confidenceInterval(draw(8));
    const narrow = confidenceInterval(draw(128));
    // 16x the samples should be roughly 4x tighter. Loose bounds because each is a
    // single realisation.
    expect(narrow.standardError).toBeLessThan(wide.standardError / 2);
  });

  it("reports no interval from a single observation rather than a zero-width one", () => {
    const interval = confidenceInterval([42]);
    expect(interval.mean).toBe(42);
    expect(Number.isNaN(interval.halfWidth)).toBe(true);
    expect(interval.samples).toBe(1);
  });
});

describe("paired differences detect real changes and reject noise", () => {
  it("finds no difference between a design and itself", () => {
    // Identical designs on identical seeds produce identical runs, so every paired
    // difference is exactly zero. A framework that reported significance here would
    // be manufacturing findings.
    const values = [10, 12, 9, 11, 13, 8, 12, 10];
    const d = pairedDifference(values, values);
    expect(d.meanDifference).toBe(0);
    expect(d.significant).toBe(false);
  });

  it("detects a consistent shift smaller than the run-to-run spread", () => {
    /**
     * The whole argument for pairing. The samples swing between 80 and 130 -- a spread
     * far larger than the shift -- yet every pair moves down by exactly 5, so the
     * paired interval excludes zero comfortably.
     */
    const baseline = [100, 130, 85, 110, 95, 125, 90, 105];
    const candidate = baseline.map((v) => v - 5);
    const d = pairedDifference(baseline, candidate);
    expect(d.meanDifference).toBeCloseTo(-5, 9);
    expect(d.significant).toBe(true);
  });

  it("rejects a difference that is pure noise", () => {
    const rng = new Rng(11);
    const baseline = Array.from({ length: 8 }, () => 100 + 15 * rng.normal());
    const candidate = Array.from({ length: 8 }, () => 100 + 15 * rng.normal());
    const d = pairedDifference(baseline, candidate);
    expect(d.significant).toBe(false);
  });

  it("refuses to pair unequal counts rather than silently truncating", () => {
    expect(() => pairedDifference([1, 2, 3], [1, 2])).toThrow(/equal counts/);
  });
});

describe("arrival profiles integrate to the right totals", () => {
  /**
   * Thinning is exact, so these are equalities up to Poisson counting noise rather
   * than approximations. The naive alternative -- recomputing an exponential gap from
   * the instantaneous rate -- fails these: it assumes the rate holds for the whole
   * gap, so it lags a rising ramp and overshoots a falling one.
   */
  it("a ramp delivers the mean of its endpoints", () => {
    const durationSec = 400;
    const from = 20;
    const to = 220;
    const expected = ((from + to) / 2) * durationSec;

    const design = station({
      arrival: { kind: "ramp", fromRatePerSec: from, toRatePerSec: to },
      meanMs: 1,
      c: 4096,
      durationSec,
      p99TargetMs: null,
    });
    const counts = SEEDS8.map((seed) => {
      const r = runSimulation(design, { seed, collectTrace: false });
      return r.endToEnd.count + r.errors.total;
    });
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(relError(mean, expected)).toBeLessThan(0.02);
  });

  it("a spike delivers base plus peak over their respective windows", () => {
    const durationSec = 300;
    const base = 40;
    const peak = 400;
    const spikeSec = 30;
    const expected = base * (durationSec - spikeSec) + peak * spikeSec;

    const design = station({
      arrival: {
        kind: "spike",
        baseRatePerSec: base,
        peakRatePerSec: peak,
        atSec: 100,
        durationSec: spikeSec,
      },
      meanMs: 1,
      c: 4096,
      durationSec,
      p99TargetMs: null,
    });
    const counts = SEEDS8.map((seed) => {
      const r = runSimulation(design, { seed, collectTrace: false });
      return r.endToEnd.count + r.errors.total;
    });
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(relError(mean, expected)).toBeLessThan(0.03);
  });

  it("steps deliver each rate over its own window", () => {
    const durationSec = 300;
    const design = station({
      arrival: {
        kind: "steps",
        ratePerSec: 50,
        steps: [
          { atSec: 100, ratePerSec: 150 },
          { atSec: 200, ratePerSec: 100 },
        ],
      },
      meanMs: 1,
      c: 4096,
      durationSec,
      p99TargetMs: null,
    });
    const expected = 50 * 100 + 150 * 100 + 100 * 100;
    const counts = SEEDS8.map((seed) => {
      const r = runSimulation(design, { seed, collectTrace: false });
      return r.endToEnd.count + r.errors.total;
    });
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(relError(mean, expected)).toBeLessThan(0.03);
  });

  it("the rate helpers agree with the profiles they describe", () => {
    const ramp = { kind: "ramp" as const, fromRatePerSec: 10, toRatePerSec: 110 };
    expect(rateAt(ramp, 0, 1000)).toBeCloseTo(10, 9);
    expect(rateAt(ramp, 500, 1000)).toBeCloseTo(60, 9);
    expect(rateAt(ramp, 1000, 1000)).toBeCloseTo(110, 9);
    expect(meanRate(ramp, 1000)).toBeCloseTo(60, 9);
    expect(peakRate(ramp)).toBe(110);

    const spike = {
      kind: "spike" as const,
      baseRatePerSec: 10,
      peakRatePerSec: 100,
      atSec: 1,
      durationSec: 1,
    };
    expect(rateAt(spike, 500, 3000)).toBe(10);
    expect(rateAt(spike, 1500, 3000)).toBe(100);
    expect(rateAt(spike, 2500, 3000)).toBe(10);
    // 2s of base and 1s of peak over a 3s run.
    expect(meanRate(spike, 3000)).toBeCloseTo((10 * 2 + 100 * 1) / 3, 9);
  });

  it("the offered-rate series tracks the profile", () => {
    const design = station({
      arrival: { kind: "ramp", fromRatePerSec: 10, toRatePerSec: 210 },
      meanMs: 1,
      c: 4096,
      durationSec: 200,
      p99TargetMs: null,
    });
    const r = runSimulation(design, { collectTrace: false });
    const points = r.offeredRateSeries.points;
    expect(points.length).toBeGreaterThan(10);
    expect(points[0]!.value).toBeLessThan(30);
    expect(points.at(-1)!.value).toBeGreaterThan(190);
  });
});

describe("time-varying load is reported honestly", () => {
  it("flags a run as non-steady-state and qualifies its percentiles", () => {
    /**
     * A single p99 over a ramp averages across regimes that never coexisted -- part of
     * the sample taken at 50/s and part at 800/s. The figure is still computed, because
     * it is the right thing for a spike where most of the run IS the base rate, but the
     * caveat states what it does and does not mean.
     */
    const ramped = runSimulation(
      station({
        arrival: { kind: "ramp", fromRatePerSec: 20, toRatePerSec: 200 },
        meanMs: 10,
        c: 4,
        durationSec: 200,
      }),
      { collectTrace: false }
    );
    expect(ramped.steadyState).toBe(false);
    expect(ramped.aggregateCaveat).toMatch(/never coexisted/);

    const steady = runSimulation(
      station({ arrival: { kind: "poisson", ratePerSec: 100 }, meanMs: 10, c: 4, durationSec: 200 }),
      { collectTrace: false }
    );
    expect(steady.steadyState).toBe(true);
    expect(steady.aggregateCaveat).toBeNull();
  });

  it("records the first SLO breach and the rate at that moment", () => {
    const design = station({
      arrival: { kind: "ramp", fromRatePerSec: 20, toRatePerSec: 400 },
      meanMs: 10,
      c: 2,
      durationSec: 400,
      p99TargetMs: 150,
    });
    const r = runSimulation(design, { collectTrace: false });
    expect(r.firstBreach).not.toBeNull();
    expect(r.firstBreach!.breach).toBe("latency");
    // c=2 at 10ms is 200/s of capacity, so the breach must arrive below that.
    expect(r.firstBreach!.offeredRatePerSec).toBeLessThan(200);
    expect(r.firstBreach!.offeredRatePerSec).toBeGreaterThan(20);
    expect(r.firstBreach!.atSec).toBeGreaterThan(0);
  });

  it("reports no breach when the SLO holds for the whole ramp", () => {
    const design = station({
      arrival: { kind: "ramp", fromRatePerSec: 1, toRatePerSec: 20 },
      meanMs: 10,
      c: 8,
      durationSec: 200,
      p99TargetMs: 500,
    });
    expect(runSimulation(design, { collectTrace: false }).firstBreach).toBeNull();
  });

  it("warns when a warm-up window is combined with a ramp", () => {
    // There is no steady state for the warm-up to reach; it just deletes the bottom
    // of the ramp along with the baseline the breach is measured against.
    const design = station({
      arrival: { kind: "ramp", fromRatePerSec: 10, toRatePerSec: 100 },
      meanMs: 10,
      c: 4,
      durationSec: 200,
      warmupSec: 40,
    });
    const r = runSimulation(design, { collectTrace: false });
    expect(r.steadyState).toBe(false);
    // The design still runs; the warning is advisory.
    expect(r.endToEnd.count).toBeGreaterThan(0);
  });
});

describe("the ramp knee and the steady-state knee bracket the truth", () => {
  /**
   * Two independent methods for the same quantity, and they disagree in a predictable
   * direction. A ramp answers HIGH because queues take time to fill: the system is
   * always catching up with a load that has already moved on.
   *
   * That makes them complementary rather than redundant -- the steady-state knee is
   * what a design can sustain, the ramp knee is what it can pass through -- and a live
   * load test carries exactly the same bias.
   */
  it("the two methods agree to within a third of each other", () => {
    const meanMs = 20;
    const c = 4;
    const target = 200;
    const steadyDesign = station({
      arrival: { kind: "poisson", ratePerSec: 100 },
      meanMs,
      c,
      durationSec: 300,
      warmupSec: 60,
      p99TargetMs: target,
    });

    const steady = findKnee(steadyDesign, { probeDurationSec: 300, seed: 5 });
    expect(steady.unavailableReason).toBeNull();

    // A slow ramp, so the lag is small and the two methods converge.
    const ramp = rampToFailure(steadyDesign, {
      fromRatePerSec: 20,
      toRatePerSec: 400,
      durationSec: 2400,
      seed: 5,
    });
    expect(ramp.breachRatePerSec).not.toBeNull();

    /**
     * Agreement, but deliberately no claim about WHICH is higher.
     *
     * The lag pushes the ramp's answer up, and it is real -- the slope test below
     * demonstrates it directly. But the cross-method difference also carries the two
     * estimators' own biases: the steady-state search reports the last rate that
     * PASSED (below the true crossing) and does so from short, noisy probes, while the
     * ramp reads a merged rolling window. At this precision those biases are the same
     * size as the lag, so asserting a direction here would be asserting something the
     * measurement cannot support.
     */
    expect(relError(ramp.breachRatePerSec!, steady.maxRatePerSec)).toBeLessThan(0.35);
    expect(ramp.note).toMatch(/queues take time to fill/);
  });

  it("a steeper ramp reports a higher limit — the lag, measured directly", () => {
    /**
     * The direct evidence for the lag, and the reason the cross-method test above
     * declines to claim a direction. Same design, same measurement granularity, only
     * the slope differs: the steeper ramp reports the higher limit because the queue
     * has had less time to catch up.
     *
     * Worth knowing when someone quotes a load-test number without saying how fast
     * they ramped.
     */
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 100 },
      meanMs: 20,
      c: 4,
      durationSec: 300,
      p99TargetMs: 200,
    });
    /**
     * Duration held FIXED and the range varied, so the sample-window size is identical
     * on both sides. Varying the duration instead would change the measurement
     * granularity along with the slope and confound the two.
     */
    const slow = rampToFailure(design, {
      fromRatePerSec: 20,
      toRatePerSec: 300,
      durationSec: 600,
      seed: 3,
    });
    const fast = rampToFailure(design, {
      fromRatePerSec: 20,
      toRatePerSec: 1200,
      durationSec: 600,
      seed: 3,
    });
    expect(fast.rampRatePerSecPerSec).toBeGreaterThan(slow.rampRatePerSecPerSec);
    expect(fast.breachRatePerSec!).toBeGreaterThan(slow.breachRatePerSec!);
  });

  it("declines when there is no SLO to cross", () => {
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 50 },
      meanMs: 10,
      c: 8,
      p99TargetMs: null,
    });
    expect(rampToFailure(design).unavailableReason).toMatch(/no SLO/);
  });
});

describe("spike testing measures recovery, not just survival", () => {
  it("observes a latency excursion and a return to baseline", () => {
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 120 },
      meanMs: 20,
      c: 4,
      durationSec: 300,
      p99TargetMs: 400,
    });
    const spike = spikeTest(design, { multiple: 2.5, durationSec: 20, runSec: 400, seed: 4 });

    expect(spike.peakRatePerSec).toBeCloseTo(300, 6);
    // The burst hurts...
    expect(spike.worstP99Ms).toBeGreaterThan(spike.baselineP99Ms * 1.5);
    // ...and the design gets back to normal afterwards, which is the useful half.
    expect(spike.recoverySec).not.toBeNull();
    expect(spike.recoverySec!).toBeGreaterThan(0);
    expect(spike.note).toMatch(/Recovery time matters/);
  });

  it("says so when the backlog never drains within the run", () => {
    // Peak far above capacity, and a short run: the queue built during the spike is
    // still being worked through when the clock stops. Invisible to any steady-state
    // measurement.
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 150 },
      meanMs: 20,
      c: 4,
      durationSec: 200,
      p99TargetMs: 300,
    });
    const spike = spikeTest(design, { multiple: 6, durationSec: 60, runSec: 200, seed: 4 });
    expect(spike.recoverySec).toBeNull();
    expect(spike.note).toMatch(/still being worked through/);
  });
});

describe("replications measure the uncertainty the model predicts", () => {
  it("the measured interval agrees with the engine's modelled error", () => {
    /**
     * Two independent routes to the same quantity: a fitted formula and an observation.
     * Agreement is evidence the model is sound; disagreement would be a finding, and
     * the tool would then tell the reader to trust the measurement.
     */
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 80 },
      meanMs: 40,
      c: 4,
      durationSec: 600,
      warmupSec: 100,
      p99TargetMs: 400,
    });
    const rep = replicate(design, { replications: 8 });
    const check = checkErrorModel(rep);
    expect(check.agrees).toBe(true);
    expect(check.ratio).toBeGreaterThan(0.5);
    expect(check.ratio).toBeLessThan(2);
    expect(check.detail).toMatch(/the model holds/);
  });

  it("produces intervals for every headline metric", () => {
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 80 },
      meanMs: 40,
      c: 4,
      durationSec: 300,
      warmupSec: 60,
    });
    const rep = replicate(design, { replications: 6 });
    for (const key of ["p50Ms", "p99Ms", "throughputPerSec", "meanMs"] as const) {
      const interval = rep.intervals[key];
      expect(interval.samples).toBe(6);
      expect(interval.low).toBeLessThanOrEqual(interval.mean);
      expect(interval.high).toBeGreaterThanOrEqual(interval.mean);
    }
  });

  it("counts how many replications met the SLO", () => {
    // A design sitting on the boundary passes only sometimes, and a single run of it
    // would have reported whichever answer its seed happened to give.
    const design = station({
      arrival: { kind: "poisson", ratePerSec: 90 },
      meanMs: 40,
      c: 4,
      durationSec: 300,
      warmupSec: 60,
      p99TargetMs: 400,
    });
    const rep = replicate(design, { replications: 8 });
    expect(rep.sloPassCount).toBeGreaterThanOrEqual(0);
    expect(rep.sloPassCount).toBeLessThanOrEqual(8);
    expect(rep.breaches).toHaveLength(8);
  });
});

describe("paired comparison answers 'did my change help'", () => {
  const base = (c: number) =>
    station({
      arrival: { kind: "poisson", ratePerSec: 90 },
      meanMs: 40,
      c,
      durationSec: 400,
      warmupSec: 80,
      p99TargetMs: 400,
    });

  it("finds no difference between a design and itself", () => {
    /**
     * Exact, not approximate. Identical designs on identical seeds produce identical
     * runs, so every paired difference is exactly zero. Anything else would mean the
     * engine is not deterministic or the pairing is not really paired.
     */
    const comparison = compare(base(4), base(4), { replications: 4 });
    expect(comparison.paired).toBe(true);
    for (const m of comparison.metrics) {
      expect(m.difference.meanDifference).toBe(0);
      expect(m.verdict).toBe("no detectable change");
    }
  });

  it("detects added capacity as a significant improvement", () => {
    const comparison = compare(base(4), base(6), { replications: 6 });
    const p99 = comparison.metrics.find((m) => m.metric === "p99Ms")!;
    expect(p99.verdict).toBe("better");
    expect(p99.difference.significant).toBe(true);
    expect(p99.improvementFraction).toBeGreaterThan(0);
    // Utilization must fall too, which is the mechanism.
    const util = comparison.metrics.find((m) => m.metric === "maxUtilization")!;
    expect(util.improvementFraction).toBeGreaterThan(0);
  });

  it("detects removed capacity as a significant regression", () => {
    const comparison = compare(base(6), base(4), { replications: 6 });
    const p99 = comparison.metrics.find((m) => m.metric === "p99Ms")!;
    expect(p99.verdict).toBe("worse");
    expect(p99.improvementFraction).toBeLessThan(0);
  });

  it("pairing detects a change that an unpaired comparison would miss", () => {
    /**
     * The argument for pairing, made quantitatively. A small capacity change produces a
     * shift far smaller than the run-to-run spread of the p99. Paired, the shift is
     * visible because both sides saw the same workload; unpaired, it drowns.
     */
    const a = base(4);
    const b = base(5);
    const comparison = compare(a, b, { replications: 8 });
    const p99 = comparison.metrics.find((m) => m.metric === "p99Ms")!;

    // The per-seed differences are tight...
    const pairedHalfWidth = p99.difference.interval.halfWidth;
    // ...compared with the spread of either side on its own.
    const baselineSpread = comparison.baseline.intervals.p99Ms.halfWidth;
    expect(pairedHalfWidth).toBeLessThan(baselineSpread);
    expect(p99.difference.significant).toBe(true);
  });

  it("warns when the two sides offer different load", () => {
    // Then it is comparing two different questions rather than two answers to one.
    const a = base(4);
    const b = DesignSchema.parse({
      ...a,
      nodes: a.nodes.map((n) =>
        n.client
          ? { ...n, client: { ...n.client, arrival: { kind: "poisson", ratePerSec: 150 } } }
          : n
      ),
    });
    const comparison = compare(a, b, { replications: 3 });
    expect(comparison.notes.join(" ")).toMatch(/different load/);
  });

  it("reports how consistently each side met its SLO", () => {
    const comparison = compare(base(4), base(8), { replications: 5 });
    expect(comparison.sloSummary).toMatch(/baseline met its SLO in \d\/5/);
  });
});

describe("load-correlated failure gives a cascade positive gain", () => {
  it("failure rate rises with utilization", () => {
    /**
     * Real services fail more when overloaded. With a CONSTANT failure rate the
     * feedback loop has no gain and the worst outcome is a linear slowdown; the
     * correlation is what makes a cascade run away.
     */
    const build = (lambda: number) =>
      station({
        arrival: { kind: "poisson", ratePerSec: lambda },
        meanMs: 20,
        c: 4,
        durationSec: 300,
        warmupSec: 60,
        failureProbability: 0.01,
        failureAtSaturation: 0.5,
        p99TargetMs: null,
      });

    // c=4 at 20ms is 200/s of capacity.
    const quiet = runSimulation(build(40), { collectTrace: false });
    const busy = runSimulation(build(180), { collectTrace: false });

    /**
     * At rho = 0.2 the station is mostly idle and the failure rate stays far below the
     * 50% saturation figure -- but it does NOT collapse to the 1% baseline, and that is
     * correct rather than a bug.
     *
     * A request only samples the failure probability while it is being served, and the
     * occupancy it sees then is higher than the time-average: busy moments contain more
     * requests, so more requests experience them. That is the inspection paradox, and
     * it means load-correlated failure bites somewhat harder than a naive
     * base + (sat - base) x rho calculation suggests.
     */
    expect(quiet.errors.ratePct).toBeLessThan(15);
    expect(quiet.errors.ratePct).toBeGreaterThan(1);
    expect(busy.errors.ratePct).toBeGreaterThan(quiet.errors.ratePct * 3);
  });

  it("a constant failure rate does not vary with load", () => {
    const build = (lambda: number) =>
      station({
        arrival: { kind: "poisson", ratePerSec: lambda },
        meanMs: 20,
        c: 4,
        durationSec: 300,
        warmupSec: 60,
        failureProbability: 0.1,
        failureAtSaturation: null,
        p99TargetMs: null,
      });
    const quiet = runSimulation(build(40), { collectTrace: false });
    const busy = runSimulation(build(180), { collectTrace: false });
    expect(relError(busy.errors.ratePct, quiet.errors.ratePct)).toBeLessThan(0.15);
  });

  it("the shipped cascade example amplifies retries under its spike", () => {
    const r = runSimulation(correlatedCascade(), { collectTrace: false });
    expect(r.steadyState).toBe(false);
    expect(r.retryAmplification).toBeGreaterThan(1.2);
    expect(r.errors.ratePct).toBeGreaterThan(5);
  });
});

describe("the shipped time-varying examples behave as advertised", () => {
  it("the ramp example breaches its SLO partway up", () => {
    const r = runSimulation(rampExample(), { collectTrace: false });
    expect(r.steadyState).toBe(false);
    expect(r.firstBreach).not.toBeNull();
    // Ramps 50 -> 800/s; the database tops out near 530/s, so the breach is in between.
    expect(r.firstBreach!.offeredRatePerSec).toBeGreaterThan(100);
    expect(r.firstBreach!.offeredRatePerSec).toBeLessThan(800);
  });

  it("the spike example shows an excursion above its baseline", () => {
    const r = runSimulation(trafficSpike(), { collectTrace: false });
    const series = r.latencyP99Series.points;
    const before = series.filter((p) => p.t < 60 && p.value > 0);
    const during = series.filter((p) => p.t >= 60 && p.t <= 95);
    const baseline = before.reduce((s, p) => s + p.value, 0) / Math.max(1, before.length);
    const peak = during.reduce((m, p) => Math.max(m, p.value), 0);
    expect(peak).toBeGreaterThan(baseline * 2);
  });
});
