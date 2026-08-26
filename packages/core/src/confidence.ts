/**
 * How many samples a run needs, and how much error it still has.
 *
 * A discrete-event simulation estimates statistics from a finite and heavily
 * AUTOCORRELATED sample: consecutive requests share a queue state, so N requests
 * carry far less information than N independent draws. The relaxation time of an
 * M/M/c queue scales as 1/(1-rho)^2, and so does the sample size required for a
 * given relative error.
 *
 * The practical consequence is severe and easy to miss. At rho = 0.5 a few
 * thousand requests give a usable mean. At rho = 0.9 the same accuracy needs
 * hundreds of thousands. A tool that runs a fixed 60 simulated seconds regardless
 * of utilization is therefore precise exactly where precision does not matter and
 * noisy exactly where it does.
 *
 * THE NUMBERS HERE ARE MEASURED, NOT ASSUMED.
 *
 * Standard deviation across 24 independent seeds, with each run sized by
 * `requiredSamples` below:
 *
 *   rho    N         mean SD   p99 SD   p99.9 SD   p99/mean
 *   0.5    12,073    1.38%     1.80%     3.58%      1.30
 *   0.7    33,388    1.86%     3.14%     4.45%      1.69
 *   0.8    75,103    1.94%     4.32%     5.29%      2.23
 *   0.9    300,231   3.21%     7.64%    14.35%      2.38
 *
 * Two things fall out of that table, and an earlier version of this file got both
 * wrong by asserting a flat 1% instead of measuring:
 *
 *  1. The achievable accuracy on the MEAN at this sample sizing is around 2%, not
 *     1%. Claiming 1% was an over-statement of the tool's own precision.
 *
 *  2. TAIL PERCENTILES ARE SUBSTANTIALLY NOISIER THAN THE MEAN, and increasingly
 *     so as utilization rises. This matters more than the first point, because the
 *     p99 is the number an SLO is written against. Reporting a single accuracy
 *     figure covering both is precisely the kind of quiet over-claim this project
 *     exists to eliminate -- it was caught by observing that the default design's
 *     p99 varied from 262ms to 302ms across seeds while the tool cheerfully
 *     reported "accurate to roughly 1.0%".
 */

/**
 * Samples at which the mean's relative error is ~2%, when (1-rho) = 1.
 *
 * Deliberately not raised to hit 1%: that would need ~3.3x the samples (error
 * falls as 1/sqrt(N)) for a precision that does not change any decision the tool
 * supports. Reporting the achieved 2% honestly is worth more than spending 3x the
 * runtime to reach a rounder number.
 */
const SAMPLES_AT_UNIT_GAP = 3000;

/** Above this, further sampling costs runtime without changing conclusions. */
const MAX_USEFUL_SAMPLES = 400_000;

/**
 * Samples required for roughly 2% relative error on the mean at utilization
 * `rho`. Returns a modest fixed figure for saturated-but-bounded systems, whose
 * queues cannot grow and therefore converge quickly.
 */
export function requiredSamples(rho: number): number {
  if (!Number.isFinite(rho) || rho >= 1) return 60_000;
  if (rho <= 0) return SAMPLES_AT_UNIT_GAP;
  const gap = 1 - rho;
  return Math.min(MAX_USEFUL_SAMPLES, Math.ceil(SAMPLES_AT_UNIT_GAP / (gap * gap)));
}

/**
 * Estimated relative standard error of the MEAN.
 *
 * Model: error ~ k(rho)/sqrt(N) with k = 1/(1-rho), the autocorrelation inflation
 * implied by the 1/(1-rho)^2 relaxation scaling. Checked against the table above:
 * predicts 1.8% where 1.38%-1.94% was measured over rho = 0.5-0.8, and is
 * somewhat optimistic at rho = 0.9 (predicts 1.8% against 3.2% measured).
 */
export function meanRelativeError(samples: number, rho: number): number {
  if (samples <= 0) return Number.POSITIVE_INFINITY;
  const gap = Math.max(0.02, 1 - Math.min(rho, 0.999));
  return 1 / gap / Math.sqrt(samples);
}

/**
 * How much noisier the p99 is than the mean.
 *
 * Asymptotic theory for an exponential tail gives a ratio of
 * sqrt(q/(1-q)) / -ln(1-q) = 2.16 at q = 0.99, for INDEPENDENT samples. Measured
 * ratios rise with utilization (1.30 at rho=0.5 to 2.38 at rho=0.9) because
 * autocorrelation inflates the tail estimator faster than the mean, so a flat
 * factor would be wrong at both ends. This is an empirical fit to the table
 * above, not a derivation.
 */
export function tailErrorMultiplier(rho: number): number {
  const r = Math.max(0, Math.min(1, rho));
  return 1.3 + 2.7 * Math.max(0, r - 0.5);
}

export interface ConfidenceReport {
  /** Departures recorded in the measurement window. */
  samples: number;
  /** Samples that would bring the mean's error under the acceptable threshold. */
  requiredSamples: number;
  /** Highest station utilization observed, which sets the requirement. */
  drivingUtilization: number;
  sufficient: boolean;
  /** Estimated relative standard error of the mean. */
  approxRelativeError: number;
  /**
   * Estimated relative standard error of the p99 -- typically 1.3x to 2.4x the
   * figure above. Reported separately because the p99 is what an SLO is written
   * against, and quoting the mean's precision for it overstates confidence in the
   * one number that decides pass or fail.
   */
  approxTailRelativeError: number;
  note: string;
}

/**
 * The error at which an estimate is called good enough to act on.
 *
 * Sufficiency is judged on the ESTIMATED ERROR, not on a sample count crossing
 * `requiredSamples`. The distinction matters: `requiredSamples` is proportional to
 * 1/(1-rho)^2 evaluated at the *measured* utilization, which is itself noisy, so
 * near high load a hair's difference in measured rho (0.800 vs 0.810) moves the
 * threshold by thousands of samples and the verdict flips on nothing. Error is
 * monotone in sample count and only mildly sensitive to rho, so the verdict is
 * stable and means what it says.
 */
const ACCEPTABLE_MEAN_ERROR = 0.03;

/** Samples needed to bring the mean's error under `ACCEPTABLE_MEAN_ERROR`. */
function samplesForAcceptableError(rho: number): number {
  const gap = Math.max(0.02, 1 - Math.min(rho, 0.999));
  const k = 1 / gap;
  return Math.ceil((k / ACCEPTABLE_MEAN_ERROR) ** 2);
}

export function assessConfidence(
  samples: number,
  maxUtilization: number,
  observedSec: number
): ConfidenceReport {
  const meanErr = meanRelativeError(samples, maxUtilization);
  const tailErr = meanErr * tailErrorMultiplier(maxUtilization);
  const sufficient = meanErr <= ACCEPTABLE_MEAN_ERROR;
  const required = samplesForAcceptableError(maxUtilization);

  const suggestedSec =
    samples > 0 ? Math.ceil((observedSec * required) / samples) : Math.ceil(observedSec * 10);

  const precision =
    `mean \u00b1${(meanErr * 100).toFixed(1)}%, p99 \u00b1${(tailErr * 100).toFixed(1)}% ` +
    `(1 sigma, seed to seed)`;

  return {
    samples,
    requiredSamples: required,
    drivingUtilization: maxUtilization,
    sufficient,
    approxRelativeError: meanErr,
    approxTailRelativeError: tailErr,
    note: sufficient
      ? `${samples.toLocaleString()} samples at ${(maxUtilization * 100).toFixed(0)}% utilization. ` +
        `Estimated precision: ${precision}. Tail percentiles are noisier than the mean, ` +
        `and p99.9 noisier still.`
      : `Only ${samples.toLocaleString()} samples at ${(maxUtilization * 100).toFixed(0)}% utilization. ` +
        `Estimated precision: ${precision}, which is too loose to act on. ` +
        `Raise the run duration to about ${suggestedSec}s (~${required.toLocaleString()} samples).`,
  };
}

