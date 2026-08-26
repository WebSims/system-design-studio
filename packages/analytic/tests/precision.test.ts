import { describe, expect, it } from "vitest";
import {
  meanRelativeError,
  requiredSamples,
  runSimulation,
  tailErrorMultiplier,
} from "@sds/core";
import { DesignSchema } from "@sds/schema";
import { durationForRho, singleStation } from "./harness";

/**
 * DOES THE TOOL'S SELF-ASSESSMENT SURVIVE CONTACT WITH REALITY?
 *
 * Everywhere else in this suite the engine is checked against queueing theory.
 * Here the engine's claim about its OWN PRECISION is checked against the observed
 * seed-to-seed spread. Without this, the confidence report is just another
 * confident number -- and it was: an earlier version reported "accurate to roughly
 * 1.0%" for a design whose p99 varied from 262ms to 302ms across seeds.
 *
 * A precision claim nobody validates is worse than no claim, because it converts
 * uncertainty into false assurance.
 */

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

function relativeSd(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance) / mean;
}

describe("reported precision brackets the observed spread", () => {
  const cases = [0.5, 0.7, 0.8];

  for (const rho of cases) {
    it(`mean and p99 spread are within the reported error at rho=${rho}`, () => {
      const serviceMeanMs = 40;
      const c = 4;
      const lambda = (rho * c * 1000) / serviceMeanMs;
      const { durationSec, warmupSec } = durationForRho(lambda, rho);
      const design = DesignSchema.parse({
        ...singleStation({ lambda, serviceMeanMs, c }),
        scenario: { durationSec, warmupSec, seed: 1, traceLimit: 0 },
      });

      const runs = SEEDS.map((seed) => runSimulation(design, { seed, collectTrace: false }));
      const observedMeanSd = relativeSd(runs.map((r) => r.endToEnd.mean));
      const observedTailSd = relativeSd(runs.map((r) => r.endToEnd.p99));
      const reported = runs[0]!.confidence;

      // The claim must be the right order of magnitude in both directions: not so
      // optimistic that it hides real variance, not so pessimistic that it is
      // useless. A factor of two either way.
      expect(observedMeanSd).toBeLessThan(reported.approxRelativeError * 2);
      expect(observedMeanSd).toBeGreaterThan(reported.approxRelativeError / 2);

      expect(observedTailSd).toBeLessThan(reported.approxTailRelativeError * 2);
      expect(observedTailSd).toBeGreaterThan(reported.approxTailRelativeError / 2);

      // And the central claim of the whole exercise: the tail is noisier than the
      // mean, so it cannot honestly share the mean's error figure.
      expect(observedTailSd).toBeGreaterThan(observedMeanSd);
      expect(reported.approxTailRelativeError).toBeGreaterThan(reported.approxRelativeError);
    });
  }

  it("a single run's p99 can miss the exact answer by far more than the mean's error", () => {
    /**
     * The observation that prompted this file. The default design's analytic p99 is
     * 276.7ms; seed 1 measures 302ms, a 9% miss, while the mean is accurate to
     * ~2%. Anyone reading a single run's p99 as a precise figure is being misled,
     * so the tool now says so.
     */
    const lambda = 80;
    const design = DesignSchema.parse({
      ...singleStation({ lambda, serviceMeanMs: 40, c: 4 }),
      scenario: { durationSec: 1200, warmupSec: 200, seed: 1, traceLimit: 0 },
    });
    const p99s = SEEDS.map((seed) => runSimulation(design, { seed, collectTrace: false }).endToEnd.p99);
    const spread = (Math.max(...p99s) - Math.min(...p99s)) / (p99s.reduce((a, b) => a + b, 0) / p99s.length);
    // Range across seeds exceeds 10% of the central value at this utilization.
    expect(spread).toBeGreaterThan(0.1);
  });
});

describe("error models behave sensibly", () => {
  it("required samples scale as 1/(1-rho)^2", () => {
    expect(requiredSamples(0.9) / requiredSamples(0.5)).toBeCloseTo(25, 1);
    expect(requiredSamples(0.8) / requiredSamples(0.6)).toBeCloseTo(4, 1);
  });

  it("mean error falls as 1/sqrt(N)", () => {
    const a = meanRelativeError(10_000, 0.5);
    const b = meanRelativeError(40_000, 0.5);
    expect(a / b).toBeCloseTo(2, 2);
  });

  it("mean error rises with utilization at fixed N", () => {
    expect(meanRelativeError(50_000, 0.9)).toBeGreaterThan(meanRelativeError(50_000, 0.5));
  });

  it("the tail multiplier is always above 1 and rises with utilization", () => {
    expect(tailErrorMultiplier(0)).toBeGreaterThan(1);
    expect(tailErrorMultiplier(0.9)).toBeGreaterThan(tailErrorMultiplier(0.5));
    // Matches the measured 1.30 at rho=0.5 and 2.38 at rho=0.9.
    expect(tailErrorMultiplier(0.5)).toBeCloseTo(1.3, 2);
    expect(tailErrorMultiplier(0.9)).toBeCloseTo(2.38, 2);
  });

  it("never claims finite precision from zero samples", () => {
    expect(meanRelativeError(0, 0.5)).toBe(Number.POSITIVE_INFINITY);
  });
});
