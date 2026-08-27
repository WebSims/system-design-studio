/**
 * Confidence intervals from independent replications.
 *
 * WHY THIS REPLACES A MODEL WITH A MEASUREMENT
 *
 * Until now the tool's precision claim came from a calibrated formula:
 * error ~ k(rho)/sqrt(N), fitted against a table of measured standard deviations.
 * That was a large improvement on claiming nothing, and it was still a model of the
 * error rather than the error itself. A model can be wrong in ways its own fit
 * cannot reveal.
 *
 * Running the same design under independent seeds and measuring the spread directly
 * needs no calibration and no assumption about how error scales. It costs N times
 * the simulations, which is affordable precisely because a run is milliseconds.
 *
 * The modelled estimate is kept, and checked against the measured interval on every
 * replicated run. Two independent routes to the same quantity is the same discipline
 * the engine itself is held to.
 *
 * STUDENT'S t, NOT 1.96
 *
 * Eight replications is a small sample, and the normal quantile understates the
 * interval badly there: t(0.975, 7) is 2.365 against 1.96, so using 1.96 would
 * report an interval about 20% too narrow. Being wrong in the optimistic direction
 * about your own uncertainty is the specific failure this module exists to prevent.
 */

/**
 * Two-sided 95% critical values of Student's t, by degrees of freedom.
 *
 * Tabulated rather than computed: the inverse t CDF needs an incomplete beta
 * function, and a 30-entry table covers every replication count anyone will use
 * while being trivially checkable against a statistics reference.
 */
const T_95: readonly number[] = [
  Number.NaN, // df 0 is meaningless
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** Two-sided 95% critical value for `df` degrees of freedom. */
export function tCritical95(df: number): number {
  if (df < 1) return Number.NaN;
  if (df <= 30) return T_95[df]!;
  // Beyond 30 df the t distribution is close enough to normal that the difference
  // is smaller than the noise in any figure this tool reports.
  return 1.96;
}

export interface Interval {
  /** Sample mean across replications. */
  mean: number;
  /** Sample standard deviation (n-1 denominator). */
  sd: number;
  /** Standard error of the mean. */
  standardError: number;
  /** Half-width of the 95% interval. */
  halfWidth: number;
  low: number;
  high: number;
  /** halfWidth / |mean|. Comparable across quantities of different scale. */
  relativeHalfWidth: number;
  samples: number;
}

const EMPTY_INTERVAL: Interval = {
  mean: 0,
  sd: 0,
  standardError: 0,
  halfWidth: 0,
  low: 0,
  high: 0,
  relativeHalfWidth: 0,
  samples: 0,
};

/**
 * 95% confidence interval for the mean of `values`.
 *
 * A single observation yields a point with no interval rather than a fabricated
 * one: with n = 1 there is no information about spread, and reporting a zero-width
 * interval would claim perfect precision from one sample.
 */
export function confidenceInterval(values: readonly number[]): Interval {
  const n = values.length;
  if (n === 0) return EMPTY_INTERVAL;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) {
    return {
      mean,
      sd: 0,
      standardError: 0,
      halfWidth: Number.NaN,
      low: Number.NaN,
      high: Number.NaN,
      relativeHalfWidth: Number.NaN,
      samples: 1,
    };
  }
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const standardError = sd / Math.sqrt(n);
  const halfWidth = tCritical95(n - 1) * standardError;
  return {
    mean,
    sd,
    standardError,
    halfWidth,
    low: mean - halfWidth,
    high: mean + halfWidth,
    relativeHalfWidth: mean !== 0 ? halfWidth / Math.abs(mean) : Number.POSITIVE_INFINITY,
    samples: n,
  };
}

export interface PairedDifference {
  /** Mean of (b - a) across the paired replications. */
  meanDifference: number;
  /** Mean difference as a fraction of the baseline mean. */
  relativeDifference: number;
  interval: Interval;
  /**
   * True when the 95% interval for the difference excludes zero.
   *
   * Reported instead of a p-value on purpose. A p-value invites the reader to
   * decide what it means; an interval that either contains zero or does not answers
   * the question that was actually asked -- did this change do anything.
   */
  significant: boolean;
  baselineMean: number;
  candidateMean: number;
  pairs: number;
}

/**
 * Paired comparison of two designs measured on the SAME seeds.
 *
 * Pairing is what makes small differences detectable. Because the arrival stream is
 * seeded independently of every other stream, two designs run under the same seed
 * see a bit-identical workload -- so the per-seed difference removes the workload
 * variance entirely and only the effect of the change remains. An unpaired
 * comparison of two 8-run averages would be swamped by the run-to-run spread and
 * would call a real 10% improvement "not significant".
 *
 * This is the payoff for the independent-streams decision made in Phase 1, and the
 * reason it was worth making then rather than later.
 */
export function pairedDifference(
  baseline: readonly number[],
  candidate: readonly number[]
): PairedDifference {
  if (baseline.length !== candidate.length) {
    throw new Error(
      `paired comparison needs equal counts, got ${baseline.length} and ${candidate.length}`
    );
  }
  const differences = candidate.map((v, i) => v - baseline[i]!);
  const interval = confidenceInterval(differences);
  const baselineMean = baseline.reduce((a, b) => a + b, 0) / Math.max(1, baseline.length);
  const candidateMean = candidate.reduce((a, b) => a + b, 0) / Math.max(1, candidate.length);
  const significant =
    interval.samples > 1 &&
    Number.isFinite(interval.low) &&
    (interval.low > 0 || interval.high < 0);

  return {
    meanDifference: interval.mean,
    relativeDifference: baselineMean !== 0 ? interval.mean / Math.abs(baselineMean) : 0,
    interval,
    significant,
    baselineMean,
    candidateMean,
    pairs: baseline.length,
  };
}

/** Format an interval as `mean ±halfWidth` with sensible precision. */
export function formatInterval(interval: Interval, unit = ""): string {
  if (!Number.isFinite(interval.halfWidth)) {
    return `${round(interval.mean)}${unit} (single run, no interval)`;
  }
  return `${round(interval.mean)}${unit} \u00b1${round(interval.halfWidth)}${unit}`;
}

function round(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
