import {
  type OutcomeMeaning,
  confidenceInterval,
  pairedDifference,
  runSimulation,
  type Interval,
  type PairedDifference,
  type RunResult,
} from "@sds/core";
import type { Design } from "@sds/schema";
import { sloBreach, withScenario, type SloBreach } from "./knobs";

/**
 * MEASURED UNCERTAINTY, AND MEASURED DIFFERENCES.
 *
 * Two things this module provides that no single run can.
 *
 * First, a real confidence interval. Every precision figure the tool has reported so
 * far came from a calibrated model of the error. That was a large improvement on
 * silence, and it was still a model. Running independent seeds and measuring the
 * spread needs no calibration and no assumption about how error scales -- and the
 * modelled estimate can then be checked against it, which is the same two-independent-
 * routes discipline the engine itself is held to.
 *
 * Second, an answer to "did my change help". Comparing two single runs compares
 * noise: at 80% utilization a p99 moves ±4% between seeds, so any change smaller
 * than that is invisible and any change larger looks certain. A paired comparison
 * over shared seeds separates the two.
 */

export interface MetricIntervals {
  throughputPerSec: Interval;
  p50Ms: Interval;
  p90Ms: Interval;
  p99Ms: Interval;
  p999Ms: Interval;
  meanMs: Interval;
  errorRatePct: Interval;
  maxUtilization: Interval;
  retryAmplification: Interval;
}

export interface ReplicatedRun {
  design: Design;
  seeds: number[];
  /** Per-seed results, retained so callers can pair against another design. */
  runs: RunResult[];
  intervals: MetricIntervals;
  /** How many replications met the SLO. */
  sloPassCount: number;
  breaches: SloBreach[];
  /**
   * The engine's own modelled error estimate, averaged across replications.
   *
   * Kept beside the measured interval so the two can be compared. Agreement is
   * evidence the model is sound; disagreement is a finding.
   */
  modelledTailError: number;
  /** Measured relative half-width of the p99 interval. */
  measuredTailError: number;
  simulations: number;
  wallMs: number;
}

export interface ReplicateOptions {
  replications?: number;
  /** Explicit seeds. Overrides `replications`. */
  seeds?: number[];
  durationSec?: number;
  /**
   * What the workflow's outcome labels mean, from the study's product contract.
   *
   * Passed straight through to every replication. Without it the business tallies come back
   * as raw label counts with no interpretation, and `oversells` reads zero for a design that
   * oversells constantly -- which would let the eligibility gate pass it.
   */
  outcomes?: OutcomeMeaning;
}

/**
 * Seeds derived from the design's own seed.
 *
 * Derived rather than fixed so two designs replicated from the same base seed share
 * the same workload sequences -- which is exactly what makes a paired comparison
 * possible.
 */
function seedsFor(design: Design, count: number): number[] {
  const base = design.scenario.seed;
  return Array.from({ length: count }, (_, i) => base + i * 7919);
}

const METRIC_EXTRACTORS: Record<keyof MetricIntervals, (r: RunResult) => number> = {
  throughputPerSec: (r) => r.throughputPerSec,
  p50Ms: (r) => r.endToEnd.p50,
  p90Ms: (r) => r.endToEnd.p90,
  p99Ms: (r) => r.endToEnd.p99,
  p999Ms: (r) => r.endToEnd.p999,
  meanMs: (r) => r.endToEnd.mean,
  errorRatePct: (r) => r.errors.ratePct,
  maxUtilization: (r) =>
    r.nodes.reduce((m, n) => (n.kind === "client" ? m : Math.max(m, n.utilization)), 0),
  retryAmplification: (r) => r.retryAmplification,
};

export function replicate(design: Design, opts: ReplicateOptions = {}): ReplicatedRun {
  const wallStart = Date.now();
  const seeds = opts.seeds ?? seedsFor(design, opts.replications ?? 8);
  const target = opts.durationSec
    ? withScenario(design, { durationSec: opts.durationSec, traceLimit: 0 })
    : withScenario(design, { traceLimit: 0 });

  const runs = seeds.map((seed) =>
    runSimulation(target, { seed, collectTrace: false, ...(opts.outcomes ? { outcomes: opts.outcomes } : {}) })
  );

  const intervals = {} as MetricIntervals;
  for (const name of Object.keys(METRIC_EXTRACTORS) as Array<keyof MetricIntervals>) {
    intervals[name] = confidenceInterval(runs.map(METRIC_EXTRACTORS[name]));
  }

  const breaches = runs.map(sloBreach);
  const modelledTailError =
    runs.reduce((s, r) => s + r.confidence.approxTailRelativeError, 0) / runs.length;

  return {
    design: target,
    seeds,
    runs,
    intervals,
    sloPassCount: breaches.filter((b) => b === null).length,
    breaches,
    modelledTailError,
    measuredTailError: intervals.p99Ms.relativeHalfWidth,
    simulations: runs.length,
    wallMs: Date.now() - wallStart,
  };
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

export interface MetricComparison {
  metric: keyof MetricIntervals;
  label: string;
  /** True when a LOWER value is an improvement. */
  lowerIsBetter: boolean;
  difference: PairedDifference;
  /** Signed so positive always means "the candidate is better". */
  improvementFraction: number;
  verdict: "better" | "worse" | "no detectable change";
}

export interface Comparison {
  baseline: ReplicatedRun;
  candidate: ReplicatedRun;
  metrics: MetricComparison[];
  /** Whether each design met its SLO, and how consistently. */
  sloSummary: string;
  paired: boolean;
  simulations: number;
  wallMs: number;
  notes: string[];
}

const COMPARED: Array<{
  metric: keyof MetricIntervals;
  label: string;
  lowerIsBetter: boolean;
}> = [
  { metric: "p99Ms", label: "p99 latency", lowerIsBetter: true },
  { metric: "p50Ms", label: "p50 latency", lowerIsBetter: true },
  { metric: "meanMs", label: "mean latency", lowerIsBetter: true },
  { metric: "throughputPerSec", label: "throughput", lowerIsBetter: false },
  { metric: "errorRatePct", label: "error rate", lowerIsBetter: true },
  { metric: "maxUtilization", label: "peak utilization", lowerIsBetter: true },
  { metric: "retryAmplification", label: "retry amplification", lowerIsBetter: true },
];

/**
 * Compare two designs on the same seeds.
 *
 * PAIRING IS WHAT MAKES THIS WORK.
 *
 * Because the arrival stream is seeded independently of service, failure and routing,
 * two designs run under the same seed see a bit-identical workload. The per-seed
 * difference therefore cancels the workload variance entirely, leaving only the
 * effect of the change. An unpaired comparison of two eight-run averages would be
 * swamped by run-to-run spread and would report a real 10% improvement as "not
 * significant".
 *
 * This is the return on the independent-streams decision made in Phase 1, and the
 * reason it was worth making before there was anything to compare.
 */
export function compare(
  baselineDesign: Design,
  candidateDesign: Design,
  opts: ReplicateOptions = {}
): Comparison {
  const wallStart = Date.now();
  const seeds = opts.seeds ?? seedsFor(baselineDesign, opts.replications ?? 8);

  const baseline = replicate(baselineDesign, { ...opts, seeds });
  const candidate = replicate(candidateDesign, { ...opts, seeds });

  const notes: string[] = [];
  // Pairing is only valid if both sides really did see the same workload sequences.
  const paired =
    baseline.seeds.length === candidate.seeds.length &&
    baseline.seeds.every((s, i) => s === candidate.seeds[i]);
  if (!paired) {
    notes.push(
      "the two sides did not share seeds, so this comparison is unpaired and far less sensitive."
    );
  }

  const offeredDiffers =
    Math.abs(baseline.runs[0]!.offeredRatePerSec - candidate.runs[0]!.offeredRatePerSec) >
    baseline.runs[0]!.offeredRatePerSec * 0.001;
  if (offeredDiffers) {
    notes.push(
      "the two designs offer different load, so this compares two different questions " +
        "rather than two answers to one."
    );
  }
  if (!baseline.runs[0]!.steadyState || !candidate.runs[0]!.steadyState) {
    notes.push(
      "load varies over the run, so the aggregate percentiles being compared average across " +
        "regimes. The comparison is still paired and valid, but read it alongside the time series."
    );
  }

  const metrics: MetricComparison[] = COMPARED.map(({ metric, label, lowerIsBetter }) => {
    const difference = pairedDifference(
      baseline.runs.map(METRIC_EXTRACTORS[metric]),
      candidate.runs.map(METRIC_EXTRACTORS[metric])
    );
    // Normalise so positive always means better, whichever direction the metric runs.
    const improvementFraction = lowerIsBetter
      ? -difference.relativeDifference
      : difference.relativeDifference;
    const verdict: MetricComparison["verdict"] = !difference.significant
      ? "no detectable change"
      : improvementFraction > 0
        ? "better"
        : "worse";
    return { metric, label, lowerIsBetter, difference, improvementFraction, verdict };
  });

  const sloSummary =
    `baseline met its SLO in ${baseline.sloPassCount}/${baseline.seeds.length} runs, ` +
    `candidate in ${candidate.sloPassCount}/${candidate.seeds.length}` +
    (baseline.sloPassCount > 0 && baseline.sloPassCount < baseline.seeds.length
      ? ". A design that passes only sometimes is sitting on the boundary, and a single run of it " +
        "would have reported whichever answer its seed happened to give."
      : ".");

  return {
    baseline,
    candidate,
    metrics,
    sloSummary,
    paired,
    simulations: baseline.simulations + candidate.simulations,
    wallMs: Date.now() - wallStart,
    notes,
  };
}

/**
 * Does the engine's modelled error estimate agree with the measured interval?
 *
 * A self-check on the tool's own precision claim. The model is a fitted formula; the
 * interval is an observation. If they disagree by more than a factor of two the model
 * needs recalibrating, and the run should say so rather than quietly reporting a
 * figure it cannot support.
 */
export function checkErrorModel(replicated: ReplicatedRun): {
  agrees: boolean;
  ratio: number;
  detail: string;
} {
  const measured = replicated.measuredTailError;
  const modelled = replicated.modelledTailError;
  if (!Number.isFinite(measured) || measured === 0 || modelled === 0) {
    return {
      agrees: true,
      ratio: 1,
      detail: "not enough replications to check the error model against a measured interval.",
    };
  }
  // The modelled figure is a 1-sigma relative error; the interval is a 95% half-width,
  // which is about 2.36/sqrt(n) sigma for n=8. Compare on 1-sigma terms.
  const measuredSigma = replicated.intervals.p99Ms.sd / Math.max(1e-9, replicated.intervals.p99Ms.mean);
  const ratio = measuredSigma / modelled;
  const agrees = ratio > 0.5 && ratio < 2;
  return {
    agrees,
    ratio,
    detail: agrees
      ? `modelled p99 error \u00b1${(modelled * 100).toFixed(1)}% against a measured ` +
        `\u00b1${(measuredSigma * 100).toFixed(1)}% (1\u03c3 over ${replicated.seeds.length} seeds): ` +
        `the model holds.`
      : `modelled p99 error \u00b1${(modelled * 100).toFixed(1)}% against a measured ` +
        `\u00b1${(measuredSigma * 100).toFixed(1)}% \u2014 off by ${ratio.toFixed(1)}\u00d7. ` +
        `Trust the measured interval; the model needs recalibrating for this regime.`,
  };
}
