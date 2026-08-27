import { runSimulation } from "@sds/core";
import type { Design } from "@sds/schema";
import { enumerateKnobs, hasSlo, sloBreach, withScenario, type Knob, type SloBreach } from "./knobs";

/**
 * WHAT IS THE SMALLEST CHANGE THAT MEETS THE TARGET?
 *
 * Not "the cheapest": there is no cost model in this build, so any claim about
 * money would be invented. What this returns is a small SET OF CHANGES that makes
 * the design pass, found by measurement rather than by rule of thumb.
 *
 * The search is greedy on measured effect, then shrinks:
 *
 *   1. While the SLO is missed, try one step on each capacity knob, keep the step
 *      that helped most, repeat. Greedy is defensible here because capacity effects
 *      are close to monotone and largely separable -- adding servers to a station
 *      does not usually make another station worse.
 *
 *   2. Then walk back every change as far as the SLO still allows. Without this
 *      pass a greedy search over-provisions: the step that finally crossed the
 *      threshold is usually larger than it needed to be, and the earlier steps may
 *      have become unnecessary once a later one landed.
 *
 * WHAT IT DELIBERATELY WILL NOT DO
 *
 * Only capacity is searched -- concurrency, replicas, pool size, parallelism,
 * consumers, cache size. Service times are excluded because "make the code twice as
 * fast" is not a configuration change, and a search that proposed it would be
 * hiding the hard part in a number. Retry and breaker settings are excluded because
 * they trade error rate against load rather than strictly improving, so a search
 * optimising p99 alone would happily switch off protections.
 */

const CAPACITY_KINDS: Knob["kind"][] = [
  "concurrency",
  "replicas",
  "poolSize",
  "parallelism",
  "consumers",
  "cacheCapacity",
];

export interface ConfigChange {
  knobId: string;
  label: string;
  nodeId?: string;
  from: number;
  to: number;
  /** Multiple of the original value. */
  factor: number;
}

export interface ConfigSearchResult {
  found: boolean;
  changes: ConfigChange[];
  /** The design with every change applied, or the original when none was needed. */
  design: Design;
  beforeP99Ms: number;
  afterP99Ms: number;
  beforeBreach: SloBreach;
  afterBreach: SloBreach;
  simulations: number;
  wallMs: number;
  /** Why no configuration was found, when none was. */
  reason: string | null;
  notes: string[];
}

export interface ConfigSearchOptions {
  /** Multiplicative step applied per iteration. */
  step?: number;
  /** Maximum greedy iterations. */
  maxIterations?: number;
  /** Cap on how far any single knob may grow, as a multiple of its original value. */
  maxFactor?: number;
  probeDurationSec?: number;
  seed?: number;
}

export function searchConfig(
  design: Design,
  opts: ConfigSearchOptions = {}
): ConfigSearchResult {
  const wallStart = Date.now();
  const step = opts.step ?? 1.5;
  const maxIterations = opts.maxIterations ?? 12;
  const maxFactor = opts.maxFactor ?? 16;
  const probeDurationSec = opts.probeDurationSec ?? Math.max(120, design.scenario.durationSec / 6);
  const seed = opts.seed ?? design.scenario.seed;

  const base = (d: Design) =>
    withScenario(d, {
      durationSec: probeDurationSec,
      warmupSec: Math.max(10, probeDurationSec * 0.2),
      traceLimit: 0,
    });

  // Common random numbers throughout: identical seed, and independent RNG streams
  // mean the arrival sequence is bit-identical across candidates. Every measured
  // difference is then attributable to the configuration change.
  const evaluate = (d: Design) => runSimulation(base(d), { seed, collectTrace: false });

  let simulations = 0;
  const notes: string[] = [];

  if (!hasSlo(design)) {
    const r = evaluate(design);
    return {
      found: false,
      changes: [],
      design,
      beforeP99Ms: r.endToEnd.p99,
      afterP99Ms: r.endToEnd.p99,
      beforeBreach: null,
      afterBreach: null,
      simulations: 1,
      wallMs: Date.now() - wallStart,
      reason: "no SLO is set, so there is no target to search towards.",
      notes,
    };
  }

  const initial = evaluate(design);
  simulations++;
  const beforeP99Ms = initial.endToEnd.p99;
  const beforeBreach = sloBreach(initial);

  if (beforeBreach === null) {
    return {
      found: true,
      changes: [],
      design,
      beforeP99Ms,
      afterP99Ms: beforeP99Ms,
      beforeBreach: null,
      afterBreach: null,
      simulations,
      wallMs: Date.now() - wallStart,
      reason: null,
      notes: ["the design already meets its SLO; no changes are needed."],
    };
  }

  // ---- greedy growth ----
  let current = design;
  /** Cumulative factor applied to each knob, so caps are enforced across steps. */
  const applied = new Map<string, number>();
  let currentResult = initial;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (sloBreach(currentResult) === null) break;

    const knobs = enumerateKnobs(current).filter((k) => CAPACITY_KINDS.includes(k.kind));
    let best: { knob: Knob; value: number; p99: number; breach: SloBreach; score: number } | null =
      null;

    /**
     * Rank candidates lexicographically: passing beats failing, and among equals the
     * lower p99 wins.
     *
     * Ordering on breach FIRST is not cosmetic. An unstable run's p99 is a function
     * of how long it ran, so it can come out deceptively small -- a naive comparison
     * on p99 alone would prefer a candidate that is still diverging over one that is
     * merely slow.
     */
    const scoreOf = (breach: SloBreach, p99: number) => (breach === null ? 0 : 1e9) + p99;

    for (const knob of knobs) {
      const cumulative = applied.get(knob.id) ?? 1;
      if (cumulative >= maxFactor) continue;
      const target = knob.integer
        ? Math.max(knob.value + 1, Math.round(knob.value * step))
        : knob.value * step;
      const candidate = knob.apply(current, target);
      const r = evaluate(candidate);
      simulations++;
      const breach = sloBreach(r);
      const score = scoreOf(breach, r.endToEnd.p99);
      if (!best || score < best.score) {
        best = { knob, value: target, p99: r.endToEnd.p99, breach, score };
      }
    }

    if (!best) {
      notes.push(`every capacity knob reached its ${maxFactor}x cap without meeting the SLO.`);
      break;
    }
    // No measurable progress: stop rather than churn.
    if (best.breach !== null && best.p99 >= currentResult.endToEnd.p99 * 0.995) {
      notes.push(
        "no single capacity increase improved p99 further, so the limit is not capacity. " +
          "Look at service time, retry amplification, or the workload itself."
      );
      break;
    }

    current = best.knob.apply(current, best.value);
    // Cumulative factor against the ORIGINAL value, so the cap bounds total growth
    // rather than the size of any single step.
    applied.set(
      best.knob.id,
      (applied.get(best.knob.id) ?? 1) * (best.value / best.knob.value)
    );
    currentResult = evaluate(current);
    simulations++;
  }

  const passed = sloBreach(currentResult) === null;

  // ---- shrink pass ----
  //
  // The step that finally crossed the threshold is usually bigger than needed, and
  // earlier steps can become redundant once a later one lands. Walking each change
  // back is what turns "a configuration that works" into "a configuration that is
  // not obviously wasteful".
  if (passed) {
    const original = new Map(enumerateKnobs(design).map((k) => [k.id, k.value]));
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 20) {
      improved = false;
      for (const knob of enumerateKnobs(current).filter((k) => CAPACITY_KINDS.includes(k.kind))) {
        const originalValue = original.get(knob.id);
        if (originalValue === undefined || knob.value <= originalValue) continue;
        const target = knob.integer
          ? Math.max(originalValue, knob.value - 1)
          : Math.max(originalValue, knob.value / 1.2);
        if (target >= knob.value) continue;
        const candidate = knob.apply(current, target);
        const r = evaluate(candidate);
        simulations++;
        if (sloBreach(r) === null) {
          current = candidate;
          currentResult = r;
          improved = true;
        }
      }
    }
  }

  // ---- report the diff ----
  const originalKnobs = new Map(enumerateKnobs(design).map((k) => [k.id, k]));
  const changes: ConfigChange[] = [];
  for (const knob of enumerateKnobs(current)) {
    const before = originalKnobs.get(knob.id);
    if (!before || before.value === knob.value) continue;
    changes.push({
      knobId: knob.id,
      label: knob.label,
      nodeId: knob.nodeId,
      from: before.value,
      to: knob.value,
      factor: knob.value / before.value,
    });
  }
  changes.sort((a, b) => b.factor - a.factor);

  return {
    found: passed,
    changes,
    design: current,
    beforeP99Ms,
    afterP99Ms: currentResult.endToEnd.p99,
    beforeBreach,
    afterBreach: sloBreach(currentResult),
    simulations,
    wallMs: Date.now() - wallStart,
    reason: passed
      ? null
      : "no combination of capacity increases within the search bounds met the SLO. " +
        "Capacity is not the constraint here.",
    notes,
  };
}
