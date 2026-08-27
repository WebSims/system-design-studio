import { runSimulation, type RunResult } from "@sds/core";
import type { Design } from "@sds/schema";
import { enumerateKnobs, sloBreach, withScenario, type Knob, type SloBreach } from "./knobs";

/**
 * WHICH KNOB ACTUALLY MATTERS?
 *
 * A ranked utilization list says where the queue is. It does not say what to
 * change, and the two are not always the same node: a station at 60% can dominate
 * latency if every request visits it three times, and a station at 90% can be
 * irrelevant if it is off the critical path for most traffic.
 *
 * So sensitivity is MEASURED, not reasoned about. Each parameter is perturbed and
 * the design re-simulated. That is two runs per knob, which is affordable only
 * because the engine is headless.
 *
 * ELASTICITY, NOT ABSOLUTE CHANGE
 *
 * Results are reported as elasticity -- percent change in the outcome per percent
 * change in the parameter -- so a concurrency of 4 and a cache of 20,000 are
 * comparable. An absolute ranking would just rediscover which parameters happen to
 * have large numbers.
 *
 * INTEGER KNOBS ARE MEASURED AGAINST WHAT ACTUALLY CHANGED
 *
 * Perturbing a concurrency of 4 by 20% and rounding gives 5, a real change of 25%.
 * Elasticity is computed against the realised change, not the requested one, or
 * every small integer parameter would look more powerful than it is.
 */

export interface Sensitivity {
  knobId: string;
  label: string;
  kind: Knob["kind"];
  nodeId?: string;
  edgeId?: string;
  baseValue: number;
  /** The value actually simulated in the improving direction. */
  improvedValue: number;
  /** Realised fractional change in the parameter. */
  parameterDelta: number;
  baseP99Ms: number;
  improvedP99Ms: number;
  /**
   * Fractional change in p99 per fractional change in the parameter.
   *
   * Signed in the ordinary economic sense, which means the sign depends on the
   * parameter and NOT on whether the change helped. Raising concurrency lowers p99,
   * so its elasticity is negative; lowering service time also lowers p99, so its
   * elasticity is positive. Both are improvements.
   *
   * Use `improvementMs` to compare "how much did this help" across knobs -- it is
   * direction-independent by construction. Elasticity answers a different question:
   * how strongly this parameter couples to latency at all.
   *
   * Null when the parameter could not be moved (an integer already at its floor),
   * which is itself worth reporting rather than silently dropping.
   */
  elasticity: number | null;
  /** Absolute p99 improvement, ms. Positive is better. */
  improvementMs: number;
  /** True when the perturbation turned a failing design into a passing one. */
  fixesSlo: boolean;
  /** True when it broke a passing design. */
  breaksSlo: boolean;
}

export interface SensitivityReport {
  baseP99Ms: number;
  baseBreach: SloBreach;
  /** Ranked by absolute p99 improvement, largest first. */
  results: Sensitivity[];
  simulations: number;
  wallMs: number;
  /** Perturbation size actually requested, as a fraction. */
  perturbation: number;
  notes: string[];
}

export interface SensitivityOptions {
  /** Fractional perturbation in the improving direction. */
  perturbation?: number;
  probeDurationSec?: number;
  seed?: number;
  /** Restrict to these knob kinds, e.g. only capacity. */
  kinds?: Knob["kind"][];
}

export function sensitivity(design: Design, opts: SensitivityOptions = {}): SensitivityReport {
  const wallStart = Date.now();
  const perturbation = opts.perturbation ?? 0.2;
  const probeDurationSec = opts.probeDurationSec ?? Math.max(120, design.scenario.durationSec / 6);
  const seed = opts.seed ?? design.scenario.seed;

  const probeDesign = withScenario(design, {
    durationSec: probeDurationSec,
    warmupSec: Math.max(10, probeDurationSec * 0.2),
    traceLimit: 0,
  });

  // The SAME seed for every probe. Independent RNG streams mean the arrival
  // sequence is then bit-identical across probes, so a measured difference is
  // attributable to the parameter and not to a different workload. Without common
  // random numbers this whole exercise would be dominated by run-to-run noise.
  const base = runSimulation(probeDesign, { seed, collectTrace: false });
  const baseP99Ms = base.endToEnd.p99;
  const baseBreach = sloBreach(base);
  let simulations = 1;

  let knobs = enumerateKnobs(probeDesign);
  if (opts.kinds) knobs = knobs.filter((k) => opts.kinds!.includes(k.kind));

  const results: Sensitivity[] = [];
  const notes: string[] = [];

  for (const knob of knobs) {
    // Move in the direction that should help, so every result is comparable as
    // "what does improving this buy".
    const target = knob.largerIsBetter
      ? knob.value * (1 + perturbation)
      : knob.value * (1 - perturbation);
    const clamped = Math.max(knob.min, knob.integer ? Math.round(target) : target);

    if (clamped === knob.value) {
      results.push({
        knobId: knob.id,
        label: knob.label,
        kind: knob.kind,
        nodeId: knob.nodeId,
        edgeId: knob.edgeId,
        baseValue: knob.value,
        improvedValue: knob.value,
        parameterDelta: 0,
        baseP99Ms,
        improvedP99Ms: baseP99Ms,
        elasticity: null,
        improvementMs: 0,
        fixesSlo: false,
        breaksSlo: false,
      });
      continue;
    }

    const perturbed = knob.apply(probeDesign, clamped);
    const run: RunResult = runSimulation(perturbed, { seed, collectTrace: false });
    simulations++;

    const realisedDelta = (clamped - knob.value) / knob.value;
    const p99Delta = baseP99Ms > 0 ? (run.endToEnd.p99 - baseP99Ms) / baseP99Ms : 0;
    const breach = sloBreach(run);

    results.push({
      knobId: knob.id,
      label: knob.label,
      kind: knob.kind,
      nodeId: knob.nodeId,
      edgeId: knob.edgeId,
      baseValue: knob.value,
      improvedValue: clamped,
      parameterDelta: realisedDelta,
      baseP99Ms,
      improvedP99Ms: run.endToEnd.p99,
      elasticity: realisedDelta !== 0 ? p99Delta / realisedDelta : null,
      improvementMs: baseP99Ms - run.endToEnd.p99,
      fixesSlo: baseBreach !== null && breach === null,
      breaksSlo: baseBreach === null && breach !== null,
    });
  }

  results.sort((a, b) => b.improvementMs - a.improvementMs);

  if (baseBreach === "instability") {
    notes.push(
      "the baseline has no steady state, so its p99 is a function of run length. Differences below " +
        "are still directional but their magnitudes are not meaningful until the design is stable."
    );
  }
  const immovable = results.filter((r) => r.elasticity === null);
  if (immovable.length > 0) {
    notes.push(
      `${immovable.length} parameter${immovable.length === 1 ? "" : "s"} could not be moved by ` +
        `${(perturbation * 100).toFixed(0)}% (already at the floor, or rounding leaves them unchanged).`
    );
  }
  const noEffect = results.filter(
    (r) => r.elasticity !== null && Math.abs(r.improvementMs) < baseP99Ms * 0.01
  );
  if (noEffect.length > 0) {
    notes.push(
      `${noEffect.length} parameter${noEffect.length === 1 ? "" : "s"} changed p99 by under 1%. ` +
        `Spending effort there is spending it in the wrong place.`
    );
  }

  return {
    baseP99Ms,
    baseBreach,
    results,
    simulations,
    wallMs: Date.now() - wallStart,
    perturbation,
    notes,
  };
}
