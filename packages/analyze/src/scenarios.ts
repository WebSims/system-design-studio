import { runSimulation, type RunResult } from "@sds/core";
import { DesignSchema, type Design } from "@sds/schema";
import { hasSlo, offeredRate } from "./knobs";

/**
 * FINDING THE LIMIT WITH ONE RUN INSTEAD OF A DOZEN.
 *
 * A ramp raises offered load steadily and records the moment the SLO first breaks.
 * That is a load test in one simulation, against roughly ten for a binary search.
 *
 * IT ANSWERS SLIGHTLY HIGH, AND THAT IS PHYSICS RATHER THAN ERROR.
 *
 * A queue takes time to fill. During a ramp the system is always still catching up
 * with a load that has already moved on, so latency lags the offered rate and the
 * breach is recorded a little later -- at a little higher a rate -- than a
 * steady-state search would find. The faster the ramp, the larger the lag.
 *
 * That makes the two methods complementary rather than redundant: the steady-state
 * knee is what the design can SUSTAIN, and the ramp knee is what it can pass through.
 * A real load test has exactly this bias, which is worth knowing when someone quotes
 * one at you.
 *
 * The tool reports both and names the gap rather than averaging them into a single
 * number that is neither.
 */

export interface RampKnee {
  /** Offered rate when the SLO first broke, per second. */
  breachRatePerSec: number | null;
  /** Simulated seconds into the measurement window. */
  breachAtSec: number | null;
  breach: "latency" | "errors" | null;
  /** Rate the ramp reached by the end of the run. */
  finalRatePerSec: number;
  /** How fast the load rose, per second per second. */
  rampRatePerSecPerSec: number;
  /** The run itself, for its time series. */
  result: RunResult;
  unavailableReason: string | null;
  note: string;
}

export interface RampOptions {
  /** Rate to start from. Defaults to a tenth of the design's current load. */
  fromRatePerSec?: number;
  /** Rate to finish at. Defaults to four times the design's current load. */
  toRatePerSec?: number;
  durationSec?: number;
  seed?: number;
}

/**
 * Replace a design's clients with a single ramping client and run it once.
 *
 * Warm-up is forced to zero: there is no steady state for it to reach, and
 * discarding the first slice would just delete the bottom of the ramp along with the
 * baseline the breach is measured against.
 */
export function rampToFailure(design: Design, opts: RampOptions = {}): RampKnee {
  const current = offeredRate(design);
  const from = opts.fromRatePerSec ?? Math.max(0.1, current * 0.1);
  const to = opts.toRatePerSec ?? Math.max(from * 2, current * 4);
  const durationSec = opts.durationSec ?? Math.max(300, design.scenario.durationSec);

  const clients = design.nodes.filter((n) => n.client);
  if (clients.length === 0) {
    const result = runSimulation(design, { collectTrace: false });
    return {
      breachRatePerSec: null,
      breachAtSec: null,
      breach: null,
      finalRatePerSec: 0,
      rampRatePerSecPerSec: 0,
      result,
      unavailableReason: "no client offers any load, so there is nothing to ramp.",
      note: "",
    };
  }

  // Split the ramp across clients in proportion to their current share, so the
  // traffic mix is preserved as the total rises.
  const shares = clients.map((c) => {
    const rate = c.client?.arrival.kind === "poisson" || c.client?.arrival.kind === "deterministic"
      ? c.client.arrival.ratePerSec
      : 1;
    return { id: c.id, weight: rate };
  });
  const totalWeight = shares.reduce((s, x) => s + x.weight, 0) || clients.length;

  const ramped = DesignSchema.parse({
    ...design,
    nodes: design.nodes.map((n) => {
      if (!n.client) return n;
      const share = (shares.find((x) => x.id === n.id)?.weight ?? 1) / totalWeight;
      return {
        ...n,
        client: {
          ...n.client,
          arrival: {
            kind: "ramp" as const,
            fromRatePerSec: from * share,
            toRatePerSec: to * share,
          },
        },
      };
    }),
    scenario: { ...design.scenario, durationSec, warmupSec: 0, traceLimit: 0 },
  });

  if (!hasSlo(design)) {
    const result = runSimulation(ramped, { seed: opts.seed, collectTrace: false });
    return {
      breachRatePerSec: null,
      breachAtSec: null,
      breach: null,
      finalRatePerSec: to,
      rampRatePerSecPerSec: (to - from) / durationSec,
      result,
      unavailableReason:
        "no SLO is set, so there is no threshold for the ramp to cross. Set a p99 target or an error budget.",
      note: "",
    };
  }

  const result = runSimulation(ramped, { seed: opts.seed, collectTrace: false });
  const breach = result.firstBreach;
  const rampRate = (to - from) / durationSec;

  return {
    breachRatePerSec: breach?.offeredRatePerSec ?? null,
    breachAtSec: breach?.atSec ?? null,
    breach: breach?.breach ?? null,
    finalRatePerSec: to,
    rampRatePerSecPerSec: rampRate,
    result,
    unavailableReason: breach
      ? null
      : `the SLO held all the way to ${to.toFixed(0)}/s; raise the ramp's ceiling to find the limit.`,
    note:
      `load rose ${rampRate.toFixed(1)}/s per second. A ramp reports a slightly HIGHER limit than a ` +
      `steady-state search, because queues take time to fill and the system is always catching up ` +
      `with a load that has already moved on. The faster the ramp, the larger that lag.`,
  };
}

/**
 * A spike, and how long recovery takes afterwards.
 *
 * Recovery is usually the more interesting half. A queue built during a burst keeps
 * hurting requests that arrive after the burst has passed, so a design can pass the
 * spike itself and still spend minutes working through the backlog. That is invisible
 * to any steady-state measurement.
 */
export interface SpikeResult {
  peakRatePerSec: number;
  baseRatePerSec: number;
  /** Highest windowed p99 observed at any point, ms. */
  worstP99Ms: number;
  /** Windowed p99 during the calm period before the spike, ms. */
  baselineP99Ms: number;
  /**
   * Seconds after the spike ended before the windowed p99 returned to within 20% of
   * baseline. Null when it never did within the run.
   */
  recoverySec: number | null;
  survivedSpike: boolean;
  result: RunResult;
  note: string;
}

export function spikeTest(
  design: Design,
  opts: { multiple?: number; atSec?: number; durationSec?: number; runSec?: number; seed?: number } = {}
): SpikeResult {
  const base = offeredRate(design);
  const multiple = opts.multiple ?? 3;
  const peak = base * multiple;
  const spikeDurationSec = opts.durationSec ?? 30;
  const runSec = opts.runSec ?? Math.max(240, spikeDurationSec * 6);
  // Enough calm before the spike to establish a baseline, and enough after to observe
  // recovery -- which is the point of the exercise.
  const atSec = opts.atSec ?? Math.round(runSec * 0.3);

  const clients = design.nodes.filter((n) => n.client);
  const totalWeight =
    clients.reduce((s, c) => {
      const a = c.client!.arrival;
      return s + (a.kind === "poisson" || a.kind === "deterministic" ? a.ratePerSec : 1);
    }, 0) || clients.length;

  const spiked = DesignSchema.parse({
    ...design,
    nodes: design.nodes.map((n) => {
      if (!n.client) return n;
      const a = n.client.arrival;
      const own = a.kind === "poisson" || a.kind === "deterministic" ? a.ratePerSec : 1;
      const share = own / totalWeight;
      return {
        ...n,
        client: {
          ...n.client,
          arrival: {
            kind: "spike" as const,
            baseRatePerSec: Math.max(0.01, base * share),
            peakRatePerSec: Math.max(0.01, peak * share),
            atSec,
            durationSec: spikeDurationSec,
          },
        },
      };
    }),
    scenario: { ...design.scenario, durationSec: runSec, warmupSec: 0, traceLimit: 0 },
  });

  const result = runSimulation(spiked, { seed: opts.seed, collectTrace: false });
  const series = result.latencyP99Series.points;

  const before = series.filter((p) => p.t < atSec && p.value > 0);
  const baselineP99Ms =
    before.length > 0 ? before.reduce((s, p) => s + p.value, 0) / before.length : 0;
  const worstP99Ms = series.reduce((m, p) => Math.max(m, p.value), 0);

  const spikeEnd = atSec + spikeDurationSec;
  const threshold = baselineP99Ms * 1.2;
  let recoverySec: number | null = null;
  for (const p of series) {
    if (p.t <= spikeEnd) continue;
    if (p.value > 0 && p.value <= threshold) {
      recoverySec = p.t - spikeEnd;
      break;
    }
  }

  const target = design.slo.p99LatencyMs;
  const survivedSpike = target === null ? worstP99Ms <= baselineP99Ms * 2 : worstP99Ms <= target;

  return {
    peakRatePerSec: peak,
    baseRatePerSec: base,
    worstP99Ms,
    baselineP99Ms,
    recoverySec,
    survivedSpike,
    result,
    note:
      recoverySec === null
        ? `p99 had not returned to within 20% of its ${baselineP99Ms.toFixed(0)}ms baseline before the ` +
          `run ended. The backlog built during the spike is still being worked through, which is the ` +
          `part a steady-state measurement cannot see.`
        : `p99 returned to within 20% of baseline ${recoverySec.toFixed(0)}s after the spike ended. ` +
          `Recovery time matters on its own: a queue built during a burst keeps hurting requests that ` +
          `arrive after the burst has passed.`,
  };
}
