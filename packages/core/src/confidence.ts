/**
 * How many samples a run needs before its numbers mean anything.
 *
 * A discrete-event simulation estimates means from a finite and heavily
 * AUTOCORRELATED sample: consecutive requests share a queue state, so N requests
 * carry far less information than N independent draws. The relaxation time of an
 * M/M/c queue scales as 1/(1-rho)^2, and so does the sample size required for a
 * given relative error.
 *
 * The practical consequence is severe and easy to miss. At rho = 0.5 a few
 * thousand requests give ~1% accuracy. At rho = 0.9 the same accuracy needs
 * roughly three hundred thousand. A tool that runs a fixed 60 simulated seconds
 * regardless of utilization will therefore be precise exactly where precision does
 * not matter and noisy exactly where it does.
 *
 * This module exists so the engine can state that limit rather than hide it. The
 * constant was not guessed: convergence was measured directly on M/M/1 at
 * rho = 0.9, where relative error fell 5.4% -> 1.7% -> 1.0% -> 0.07% as the run
 * grew 64x, tracking 1/sqrt(N) as theory predicts.
 *
 * The legacy tool reported a mean over a one-second window -- a few dozen samples
 * -- with no indication that the figure was noise. Reporting a number without its
 * precision is the failure mode this guards against.
 */

/** Samples needed for ~1% relative error at rho where (1-rho) = 1. */
const SAMPLES_AT_UNIT_GAP = 3000;

/** Above this, further sampling is not worth the runtime. */
const MAX_USEFUL_SAMPLES = 400_000;

/**
 * Samples required for a roughly 1% relative error on the mean at utilization
 * `rho`. Returns a modest fixed figure for saturated-but-bounded systems, whose
 * queues cannot grow and therefore converge quickly.
 */
export function requiredSamples(rho: number): number {
  if (!Number.isFinite(rho) || rho >= 1) return 60_000;
  if (rho <= 0) return SAMPLES_AT_UNIT_GAP;
  const gap = 1 - rho;
  return Math.min(MAX_USEFUL_SAMPLES, Math.ceil(SAMPLES_AT_UNIT_GAP / (gap * gap)));
}

export interface ConfidenceReport {
  /** Departures recorded in the measurement window. */
  samples: number;
  /** Samples needed for ~1% relative error at the observed utilization. */
  requiredSamples: number;
  /** Highest station utilization observed, which sets the requirement. */
  drivingUtilization: number;
  sufficient: boolean;
  /**
   * Rough relative standard error, scaling as sqrt(required/actual). An estimate
   * of an estimate's error -- reported as approximate for exactly that reason.
   */
  approxRelativeError: number;
  note: string;
}

export function assessConfidence(
  samples: number,
  maxUtilization: number,
  observedSec: number
): ConfidenceReport {
  const required = requiredSamples(maxUtilization);
  const sufficient = samples >= required;
  // At `required` samples the error is ~1%; error scales as 1/sqrt(N).
  const approxRelativeError =
    samples > 0 ? 0.01 * Math.sqrt(required / samples) : Number.POSITIVE_INFINITY;

  const suggestedSec =
    samples > 0 ? Math.ceil((observedSec * required) / samples) : observedSec * 10;

  return {
    samples,
    requiredSamples: required,
    drivingUtilization: maxUtilization,
    sufficient,
    approxRelativeError,
    note: sufficient
      ? `${samples.toLocaleString()} samples at ${(maxUtilization * 100).toFixed(0)}% utilization: ` +
        `estimates are accurate to roughly ${(approxRelativeError * 100).toFixed(1)}%`
      : `only ${samples.toLocaleString()} samples at ${(maxUtilization * 100).toFixed(0)}% utilization, ` +
        `where ~${required.toLocaleString()} are needed for 1% accuracy. ` +
        `These figures carry roughly ${(approxRelativeError * 100).toFixed(1)}% error; ` +
        `raise the run duration to about ${suggestedSec}s to tighten them.`,
  };
}
