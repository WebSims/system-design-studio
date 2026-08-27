import { DesignSchema, type Design, type Distribution } from "@sds/schema";
import { requiredSamples, runSimulation, type RunResult } from "@sds/core";

/**
 * Sample sizing for statistical validation.
 *
 * Delegates to the engine's own `requiredSamples`, which documents the
 * 1/(1-rho)^2 scaling and the measured convergence behind the constant. Sharing
 * the formula is deliberate: the number the tool uses to judge its own precision
 * is the same number the test suite uses to size its runs, so the two cannot
 * disagree about what "enough samples" means.
 *
 * Sizing by REQUEST COUNT rather than by simulated duration matters too: a c=16
 * station at rho=0.9 has a very high arrival rate, and fixing the duration
 * instead would make that case 16x more expensive for no extra accuracy.
 */
export const samplesFor = requiredSamples;

/** Duration needed to collect `samplesFor(rho)` measured requests at `lambda`. */
export function durationForRho(lambda: number, rho: number): { durationSec: number; warmupSec: number } {
  const measured = samplesFor(rho) / lambda;
  // 15% warm-up: the transient from an empty system relaxes on the same
  // 1/(1-rho)^2 timescale, so it has to scale with the run.
  const warmupSec = Math.max(5, measured * 0.15);
  return { durationSec: Math.ceil(measured + warmupSec), warmupSec: Math.ceil(warmupSec) };
}

export interface StationSpec {
  lambda: number;
  serviceMeanMs: number;
  c: number;
  durationSec?: number;
  warmupSec?: number;
  seed?: number;
  serviceTime?: Distribution;
  queueCapacity?: number | null;
  admissionPolicy?: "shed" | "block";
}

/**
 * Single station: one Poisson client, one M/M/c server, zero network latency, so
 * measured sojourn time is purely queueing plus service.
 */
export function singleStation(opts: StationSpec): Design {
  return DesignSchema.parse({
    version: 4,
    name: "validation",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: { arrival: { kind: "poisson", ratePerSec: opts.lambda }, timeoutMs: null },
      },
      {
        id: "station",
        kind: "server",
        label: "station",
        x: 200,
        y: 0,
        server: {
          concurrency: opts.c,
          queueCapacity: opts.queueCapacity ?? null,
          serviceTime: opts.serviceTime ?? { kind: "exponential", mean: opts.serviceMeanMs },
          admissionPolicy: opts.admissionPolicy ?? "block",
          queueDiscipline: "fifo",
          replicas: 1,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        from: "client",
        to: "station",
        latency: { kind: "deterministic", value: 0 },
        lossProbability: 0,
      },
    ],
    scenario: {
      durationSec: opts.durationSec ?? 400,
      warmupSec: opts.warmupSec ?? 40,
      seed: opts.seed ?? 12345,
      traceLimit: 0,
    },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

export interface TandemSpec {
  lambda: number;
  serviceMeanMs: number[];
  c: number[];
  durationSec?: number;
  warmupSec?: number;
  seed?: number;
}

/** A tandem chain of M/M/c stations. */
export function tandem(opts: TandemSpec): Design {
  const nodes: unknown[] = [
    {
      id: "client",
      kind: "client",
      label: "client",
      x: 0,
      y: 0,
      client: { arrival: { kind: "poisson", ratePerSec: opts.lambda }, timeoutMs: null },
    },
  ];
  const edges: unknown[] = [];
  let prev = "client";
  opts.serviceMeanMs.forEach((meanMs, i) => {
    const id = `s${i}`;
    nodes.push({
      id,
      kind: "server",
      label: id,
      x: 200 * (i + 1),
      y: 0,
      server: {
        concurrency: opts.c[i]!,
        queueCapacity: null,
        serviceTime: { kind: "exponential", mean: meanMs },
        admissionPolicy: "block",
        queueDiscipline: "fifo",
        replicas: 1,
        // Non-blocking, so each station occupies its slot only for its own work.
        // That makes the chain a genuine Jackson network and keeps Burke's theorem
        // exactly applicable. The blocking case is a different model entirely --
        // simultaneous resource possession -- and is tested separately.
        blocksOnDependencies: false,
      },
    });
    edges.push({
      id: `e${i}`,
      from: prev,
      to: id,
      latency: { kind: "deterministic", value: 0 },
      lossProbability: 0,
    });
    prev = id;
  });

  return DesignSchema.parse({
    version: 4,
    name: "tandem",
    nodes,
    edges,
    scenario: {
      durationSec: opts.durationSec ?? 400,
      warmupSec: opts.warmupSec ?? 40,
      seed: opts.seed ?? 999,
      traceLimit: 0,
    },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

/** Independent seeds for replication. Fixed, so the suite is itself deterministic. */
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Memoized replication set.
 *
 * Several assertions (mean, tail, utilization, queue length) all interrogate the
 * same runs. Without caching, each would re-simulate and the suite would take
 * minutes for no additional confidence.
 */
const cache = new Map<string, RunResult[]>();

export function runReplications(design: Design, seeds: number[] = SEEDS): RunResult[] {
  const key = JSON.stringify({ design, seeds });
  const hit = cache.get(key);
  if (hit) return hit;
  const results = seeds.map((seed) => runSimulation(design, { seed, collectTrace: false }));
  cache.set(key, results);
  return results;
}

/** Run a single station sized automatically for the given utilization. */
export function runStation(spec: Omit<StationSpec, "durationSec" | "warmupSec">, rho: number): RunResult[] {
  const { durationSec, warmupSec } = durationForRho(spec.lambda, rho);
  return runReplications(singleStation({ ...spec, durationSec, warmupSec }));
}

export const meanOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function relError(actual: number, expected: number): number {
  if (expected === 0) return Math.abs(actual);
  return Math.abs(actual - expected) / Math.abs(expected);
}

/** Pull a station's per-node result out of every replication. */
export function stationStat(
  results: RunResult[],
  nodeId: string,
  pick: (n: RunResult["nodes"][number]) => number
): number {
  return meanOf(results.map((r) => pick(r.nodes.find((n) => n.nodeId === nodeId)!)));
}
