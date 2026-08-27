import { runSimulation, type RunResult } from "@sds/core";
import { previewDesign } from "@sds/analytic";
import type { Design } from "@sds/schema";
import { hasSlo, meetsSlo, offeredRate, scaleLoad, sloBreach, withScenario, type SloBreach } from "./knobs";

/**
 * WHERE DOES THIS DESIGN BREAK?
 *
 * The question a capacity review actually asks, and the one the previous engine
 * could not answer even in principle: it had no capacity limits, so latency never
 * rose with load, so there was no knee to find.
 *
 * Answered by binary search over offered load. That costs a dozen full simulations
 * per answer, which is affordable only because the engine is headless -- the same
 * search under a frame-driven model would take as many minutes as the runs are
 * long.
 *
 * MONOTONICITY IS AN ASSUMPTION, AND IT IS STATED
 *
 * Binary search assumes that if a design survives rate R it survives every rate
 * below R. That holds for latency and instability, which rise with load. It can
 * fail with load shedding, where a higher rate sheds more and can leave the
 * SURVIVING requests faster. The result records whether the assumption was
 * violated at any probe rather than silently returning a boundary that does not
 * bound anything.
 */

export interface KneeProbe {
  ratePerSec: number;
  /** Reported p99 uncertainty of this probe, as a fraction. */
  tailError: number;
  meetsSlo: boolean;
  breach: SloBreach;
  p99Ms: number;
  throughputPerSec: number;
  errorRatePct: number;
  maxUtilization: number;
  stable: boolean;
  bottleneckNodeId: string | null;
}

export interface KneeResult {
  /** Highest offered rate that met the SLO, per second. */
  maxRatePerSec: number;
  /** Lowest offered rate observed to FAIL. The true knee lies between the two. */
  firstFailingRatePerSec: number | null;
  currentRatePerSec: number;
  /** maxRate / currentRate - 1. Negative means the design is already over. */
  headroomFraction: number;
  /** What gives way first as load rises. */
  breach: SloBreach;
  /** Station that limits the design at the knee. */
  limitingNodeId: string | null;
  /** Every rate probed, in ascending order. Suitable for plotting. */
  curve: KneeProbe[];
  simulations: number;
  wallMs: number;
  /**
   * Set when a lower rate failed while a higher one passed, so the pass/fail
   * boundary is not a boundary. Usually load shedding.
   */
  nonMonotonic: boolean;
  /**
   * How precisely the knee is located, as a fraction of the rate.
   *
   * The search is limited not by its bracket but by the precision of each probe's
   * p99, and the two combine: near the crossing, dp99/d(lambda) is steep, so a few
   * percent of noise in p99 becomes a larger error in the rate. Reporting this
   * matters because a knee quoted to three digits from short probes would be
   * false precision, and false precision is the thing this project exists to
   * remove.
   */
  precisionFraction: number;
  /** Typical p99 error of the probe runs, as a fraction. */
  probeTailError: number;
  /** Human-readable statement of the above. */
  precisionNote: string;
  /** Null when the design states no SLO to search against. */
  unavailableReason: string | null;
}

export interface KneeOptions {
  /** Simulated seconds per probe. Shorter than a headline run, deliberately. */
  probeDurationSec?: number;
  /** Binary-search iterations after bracketing. */
  refineSteps?: number;
  /** Stop refining once the bracket is this tight, as a fraction of the rate. */
  tolerance?: number;
  /** Highest multiple of current load to consider. */
  maxFactor?: number;
  seed?: number;
}

const EMPTY: Omit<KneeResult, "unavailableReason"> = {
  precisionFraction: 0,
  probeTailError: 0,
  precisionNote: "",
  maxRatePerSec: 0,
  firstFailingRatePerSec: null,
  currentRatePerSec: 0,
  headroomFraction: 0,
  breach: null,
  limitingNodeId: null,
  curve: [],
  simulations: 0,
  wallMs: 0,
  nonMonotonic: false,
};

function probeAt(design: Design, factor: number, seed: number): KneeProbe {
  const scaled = scaleLoad(design, factor);
  const result = runSimulation(scaled, { seed, collectTrace: false });
  return summarize(result);
}

/**
 * Turn the bracket and the probe noise into a single precision figure.
 *
 * Two independent limits. The bracket is how far apart the last passing and first
 * failing rates are. The probe noise is the p99 uncertainty at each rate, which
 * translates into rate uncertainty through the slope of the latency curve --
 * estimated here from the probes themselves rather than assumed. The wider of the
 * two governs.
 */
function assessPrecision(
  probes: KneeProbe[],
  maxRatePerSec: number,
  firstFailingRatePerSec: number | null,
  probeTailError: number
): { precisionFraction: number; precisionNote: string } {
  const bracket =
    firstFailingRatePerSec !== null && maxRatePerSec > 0
      ? (firstFailingRatePerSec - maxRatePerSec) / maxRatePerSec
      : 0;

  // Local slope of p99 against rate, from the two probes nearest the crossing.
  const sorted = [...probes].sort((a, b) => a.ratePerSec - b.ratePerSec);
  let slopeFraction = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (a.meetsSlo && !b.meetsSlo && a.p99Ms > 0 && b.ratePerSec > a.ratePerSec) {
      const dP99 = (b.p99Ms - a.p99Ms) / a.p99Ms;
      const dRate = (b.ratePerSec - a.ratePerSec) / a.ratePerSec;
      if (dP99 > 0 && dRate > 0) slopeFraction = dP99 / dRate;
      break;
    }
  }
  // A p99 error of e translates to a rate error of e / (dp99/drate).
  const noiseDriven = slopeFraction > 0 ? probeTailError / slopeFraction : probeTailError;
  const precisionFraction = Math.max(bracket, noiseDriven);

  return {
    precisionFraction,
    precisionNote:
      `knee located to about ±${(precisionFraction * 100).toFixed(0)}% ` +
      `(bracket ±${(bracket * 100).toFixed(1)}%, probe p99 noise ` +
      `±${(probeTailError * 100).toFixed(1)}%). Lengthen probes to tighten it.`,
  };
}

function summarize(result: RunResult): KneeProbe {
  void 0;
  const breach = sloBreach(result);
  const stations = result.nodes.filter((n) => n.kind !== "client");
  const worst = stations.reduce<(typeof stations)[number] | null>(
    (m, n) => (!m || n.utilization > m.utilization ? n : m),
    null
  );
  return {
    ratePerSec: result.offeredRatePerSec,
    tailError: result.confidence.approxTailRelativeError,
    meetsSlo: breach === null,
    breach,
    p99Ms: result.endToEnd.p99,
    throughputPerSec: result.throughputPerSec,
    errorRatePct: result.errors.ratePct,
    maxUtilization: worst?.utilization ?? 0,
    stable: result.stability.stable,
    bottleneckNodeId: result.stability.worstNodeId ?? worst?.nodeId ?? null,
  };
}

/**
 * Find the highest offered load that still meets the SLO.
 *
 * The analytic preview supplies the bracket for free: the rate at which the
 * bottleneck reaches rho = 1 is an absolute ceiling no amount of load can pass, so
 * there is no point simulating above it. That is the hybrid earning its keep --
 * closed form to bound the search space, simulation to find the answer inside it.
 */
export function findKnee(design: Design, opts: KneeOptions = {}): KneeResult {
  const wallStart = Date.now();
  const current = offeredRate(design);

  if (!hasSlo(design)) {
    return {
      ...EMPTY,
      currentRatePerSec: current,
      unavailableReason:
        "no SLO is set, so there is no threshold to search for. Set a p99 target or an error budget.",
    };
  }
  if (current <= 0) {
    return {
      ...EMPTY,
      unavailableReason: "no client offers any load, so there is nothing to scale.",
    };
  }

  const probeDurationSec = opts.probeDurationSec ?? Math.max(120, design.scenario.durationSec / 6);
  const refineSteps = opts.refineSteps ?? 9;
  const tolerance = opts.tolerance ?? 0.02;
  const seed = opts.seed ?? design.scenario.seed;

  // Shorter probes than a headline run: the search is looking for a crossing, not
  // publishing a percentile. Precision per probe is traded for coverage, and the
  // returned curve makes that visible.
  const probeDesign = withScenario(design, {
    durationSec: probeDurationSec,
    warmupSec: Math.max(10, probeDurationSec * 0.2),
    traceLimit: 0,
  });

  // ---- bracket from the closed form ----
  const preview = previewDesign(probeDesign);
  const bottleneckRho = preview.bottleneckUtilization;
  const analyticCeilingFactor =
    bottleneckRho > 0 && Number.isFinite(bottleneckRho) ? 1 / bottleneckRho : (opts.maxFactor ?? 8);
  // A little past the analytic ceiling, because shedding designs remain stable
  // beyond rho = 1 and their real limit is an error rate rather than a queue.
  let hi = Math.min(opts.maxFactor ?? 8, Math.max(1.05, analyticCeilingFactor * 1.3));
  let lo = 0;

  const probes: KneeProbe[] = [];
  let simulations = 0;
  const run = (factor: number): KneeProbe => {
    const p = probeAt(probeDesign, factor, seed);
    probes.push(p);
    simulations++;
    return p;
  };

  // ---- is the design already failing? ----
  const atCurrent = run(1);
  if (!atCurrent.meetsSlo) {
    // Search downwards for the rate this design can actually carry.
    hi = 1;
    lo = 0;
    let best = 0;
    let bestBreach = atCurrent.breach;
    for (let i = 0; i < refineSteps; i++) {
      const mid = (lo + hi) / 2;
      const p = run(mid);
      if (p.meetsSlo) {
        lo = mid;
        best = mid;
      } else {
        hi = mid;
        bestBreach = p.breach;
      }
      if ((hi - lo) / Math.max(1e-9, hi) < tolerance) break;
    }
    probes.sort((a, b) => a.ratePerSec - b.ratePerSec);
    return {
      maxRatePerSec: best * current,
      firstFailingRatePerSec: hi * current,
      currentRatePerSec: current,
      headroomFraction: best - 1,
      breach: bestBreach,
      limitingNodeId: atCurrent.bottleneckNodeId,
      curve: probes,
      simulations,
      wallMs: Date.now() - wallStart,
      nonMonotonic: detectNonMonotonic(probes),
      probeTailError: typicalTailError(probes),
      ...assessPrecision(probes, best * current, hi * current, typicalTailError(probes)),
      unavailableReason: null,
    };
  }

  // ---- expand upward until something breaks ----
  lo = 1;
  let failing: KneeProbe | null = null;
  let factor = Math.max(1.25, Math.min(hi, 1.5));
  for (let i = 0; i < 8 && factor <= (opts.maxFactor ?? 8); i++) {
    const p = run(factor);
    if (!p.meetsSlo) {
      failing = p;
      hi = factor;
      break;
    }
    lo = factor;
    factor = Math.min(opts.maxFactor ?? 8, factor * 1.6);
  }

  if (!failing) {
    probes.sort((a, b) => a.ratePerSec - b.ratePerSec);
    return {
      maxRatePerSec: lo * current,
      firstFailingRatePerSec: null,
      currentRatePerSec: current,
      headroomFraction: lo - 1,
      breach: null,
      limitingNodeId: null,
      curve: probes,
      simulations,
      wallMs: Date.now() - wallStart,
      nonMonotonic: detectNonMonotonic(probes),
      probeTailError: typicalTailError(probes),
      ...assessPrecision(probes, lo * current, null, typicalTailError(probes)),
      unavailableReason: `holds at every rate probed, up to ${(lo * current).toFixed(0)}/s`,
    };
  }

  // ---- refine the bracket ----
  let breach = failing.breach;
  let limitingNodeId = failing.bottleneckNodeId;
  for (let i = 0; i < refineSteps; i++) {
    if ((hi - lo) / Math.max(1e-9, hi) < tolerance) break;
    const mid = (lo + hi) / 2;
    const p = run(mid);
    if (p.meetsSlo) {
      lo = mid;
    } else {
      hi = mid;
      breach = p.breach;
      limitingNodeId = p.bottleneckNodeId;
    }
  }

  probes.sort((a, b) => a.ratePerSec - b.ratePerSec);
  const tailError = typicalTailError(probes);
  return {
    maxRatePerSec: lo * current,
    firstFailingRatePerSec: hi * current,
    currentRatePerSec: current,
    headroomFraction: lo - 1,
    breach,
    limitingNodeId,
    curve: probes,
    simulations,
    wallMs: Date.now() - wallStart,
    nonMonotonic: detectNonMonotonic(probes),
    probeTailError: tailError,
    ...assessPrecision(probes, lo * current, hi * current, tailError),
    unavailableReason: null,
  };
}

/** Median probe tail error, so one noisy probe does not dominate. */
function typicalTailError(probes: KneeProbe[]): number {
  const errors = probes.map((p) => p.tailError).filter((e) => Number.isFinite(e)).sort((a, b) => a - b);
  if (errors.length === 0) return 0;
  return errors[Math.floor(errors.length / 2)]!;
}

/**
 * Did a lower rate fail while a higher one passed?
 *
 * If so the pass/fail boundary is not a boundary, and the reported knee should not
 * be read as one. Shedding designs do this: a higher rate rejects more work, and
 * the requests that survive can be faster than at a lower rate.
 */
function detectNonMonotonic(probes: KneeProbe[]): boolean {
  const sorted = [...probes].sort((a, b) => a.ratePerSec - b.ratePerSec);
  let seenFailure = false;
  for (const p of sorted) {
    if (!p.meetsSlo) seenFailure = true;
    else if (seenFailure) return true;
  }
  return false;
}

/**
 * Throughput and latency across a fixed range of load.
 *
 * Not a search -- an evenly spaced sweep, for plotting the shape of the curve
 * rather than locating a single crossing. Useful because the SHAPE is what tells
 * you whether a design degrades gracefully or falls off a cliff, and two designs
 * with the same knee can differ completely in what happens just past it.
 */
export function loadCurve(
  design: Design,
  opts: { from?: number; to?: number; points?: number; probeDurationSec?: number; seed?: number } = {}
): KneeProbe[] {
  const from = opts.from ?? 0.2;
  const to = opts.to ?? 2;
  const points = opts.points ?? 12;
  const probeDurationSec = opts.probeDurationSec ?? Math.max(120, design.scenario.durationSec / 6);
  const seed = opts.seed ?? design.scenario.seed;

  const probeDesign = withScenario(design, {
    durationSec: probeDurationSec,
    warmupSec: Math.max(10, probeDurationSec * 0.2),
    traceLimit: 0,
  });

  const out: KneeProbe[] = [];
  for (let i = 0; i < points; i++) {
    const factor = from + ((to - from) * i) / Math.max(1, points - 1);
    out.push(probeAt(probeDesign, factor, seed));
  }
  return out;
}

export { meetsSlo, sloBreach, offeredRate, scaleLoad };
