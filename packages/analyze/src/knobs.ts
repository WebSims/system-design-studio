import { DesignSchema, type Design, type SdsNode } from "@sds/schema";
import { mean as distMean, type RunResult } from "@sds/core";

/**
 * Shared machinery for the analyzer: scaling load, judging an SLO, and enumerating
 * the parameters a design can actually be changed by.
 *
 * All three exist because the analyzer's job is not to describe one run but to
 * explore the space around it -- "how much more load survives this", "which knob
 * matters", "what is the smallest change that meets the target". That exploration
 * is only affordable because the engine is headless: a knee search is a dozen full
 * simulations and a sensitivity sweep is two per knob. Under the previous
 * frame-driven architecture each of those runs would have taken as long as the
 * simulated window.
 */

/** Total offered load across every client, per second. */
export function offeredRate(design: Design): number {
  return design.nodes.reduce((sum, n) => sum + (n.client?.arrival.ratePerSec ?? 0), 0);
}

/**
 * Scale every client's arrival rate by the same factor.
 *
 * Uniform scaling on purpose: it preserves the traffic mix, so a knee found this
 * way answers "how much more of the SAME workload survives" rather than conflating
 * a capacity limit with a change in what the users are doing.
 */
export function scaleLoad(design: Design, factor: number): Design {
  return DesignSchema.parse({
    ...design,
    nodes: design.nodes.map((n) =>
      n.client
        ? {
            ...n,
            client: {
              ...n.client,
              arrival: {
                ...n.client.arrival,
                ratePerSec: Math.max(0.01, n.client.arrival.ratePerSec * factor),
              },
            },
          }
        : n
    ),
  });
}

/** Override the scenario, e.g. to use shorter probe runs during a search. */
export function withScenario(
  design: Design,
  patch: Partial<Design["scenario"]>
): Design {
  return DesignSchema.parse({ ...design, scenario: { ...design.scenario, ...patch } });
}

export type SloBreach = "latency" | "errors" | "instability" | "async-backlog" | null;

/**
 * Does this run meet its SLO, and if not, what broke first?
 *
 * Instability is checked before latency because an unstable system has no
 * steady-state latency to compare: whatever p99 the run recorded is a function of
 * how long it ran. Reporting "latency breach" there would attribute a run-length
 * artefact to the design.
 *
 * A growing async backlog counts as a breach even though every percentile is
 * green. It is a real outage in progress, and a knee search that ignored it would
 * happily report headroom on a system whose queue never drains.
 */
export function sloBreach(result: RunResult): SloBreach {
  if (!result.stability.stable) return "instability";
  if (result.stability.asyncBacklogWarning) return "async-backlog";
  const { p99LatencyMs, maxErrorRatePct } = result.design.slo;
  if (p99LatencyMs !== null && result.endToEnd.p99 > p99LatencyMs) return "latency";
  if (maxErrorRatePct !== null && result.errors.ratePct > maxErrorRatePct) return "errors";
  return null;
}

export function meetsSlo(result: RunResult): boolean {
  return sloBreach(result) === null;
}

/** True when the design states any target at all to search against. */
export function hasSlo(design: Design): boolean {
  return design.slo.p99LatencyMs !== null || design.slo.maxErrorRatePct !== null;
}

// ---------------------------------------------------------------------------
// knobs
// ---------------------------------------------------------------------------

export type KnobKind =
  | "concurrency"
  | "replicas"
  | "serviceTime"
  | "poolSize"
  | "parallelism"
  | "cacheCapacity"
  | "consumers"
  | "edgeLatency";

/**
 * One parameter of a design that can be varied.
 *
 * `direction` records which way is an improvement, so sensitivity results can be
 * reported as "raising this helps" rather than as a bare signed number the reader
 * has to interpret. `integer` matters more than it looks: perturbing a
 * concurrency of 4 by 20% and rounding gives 5, an actual 25% change, and an
 * elasticity computed against the requested 20% would be wrong.
 */
export interface Knob {
  id: string;
  label: string;
  kind: KnobKind;
  nodeId?: string;
  edgeId?: string;
  value: number;
  integer: boolean;
  /** Whether a LARGER value is expected to improve the outcome. */
  largerIsBetter: boolean;
  /** Smallest sensible value, so a search cannot propose nonsense. */
  min: number;
  apply: (design: Design, value: number) => Design;
}

function patchNode(design: Design, nodeId: string, fn: (n: SdsNode) => SdsNode): Design {
  return DesignSchema.parse({
    ...design,
    nodes: design.nodes.map((n) => (n.id === nodeId ? fn(n) : n)),
  });
}

/**
 * Scale a distribution's location while preserving its shape.
 *
 * Shape preservation is the point: Cs^2 drives queueing delay through the
 * (1 + Cs^2) factor, so a perturbation that quietly changed the variability would
 * measure two effects at once and attribute both to "service time".
 */
function scaleDistribution(d: Design["nodes"][number]["server"] extends undefined ? never : any, factor: number): unknown {
  switch (d.kind) {
    case "deterministic":
      return { ...d, value: d.value * factor };
    case "exponential":
      return { ...d, mean: Math.max(0.001, d.mean * factor) };
    case "lognormal":
      return { ...d, mean: Math.max(0.001, d.mean * factor), p99: Math.max(0.002, d.p99 * factor) };
    case "uniform":
      return { ...d, min: d.min * factor, max: d.max * factor };
    case "pareto":
      return { ...d, scale: Math.max(0.001, d.scale * factor) };
    default:
      return d;
  }
}

/** Every parameter of this design worth varying. */
export function enumerateKnobs(design: Design): Knob[] {
  const knobs: Knob[] = [];

  for (const node of design.nodes) {
    const id = node.id;

    if (node.server) {
      const cfg = node.server;
      knobs.push({
        id: `${id}.concurrency`,
        label: `${node.label} concurrency`,
        kind: "concurrency",
        nodeId: id,
        value: cfg.concurrency,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            server: { ...n.server!, concurrency: Math.max(1, Math.round(v)) },
          })),
      });
      knobs.push({
        id: `${id}.replicas`,
        label: `${node.label} replicas`,
        kind: "replicas",
        nodeId: id,
        value: cfg.replicas,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            server: { ...n.server!, replicas: Math.max(1, Math.round(v)) },
          })),
      });
      knobs.push({
        id: `${id}.serviceTime`,
        label: `${node.label} service time`,
        kind: "serviceTime",
        nodeId: id,
        value: distMean(cfg.serviceTime),
        integer: false,
        largerIsBetter: false,
        min: 0.001,
        apply: (d, v) => {
          const factor = v / Math.max(1e-9, distMean(cfg.serviceTime));
          return patchNode(d, id, (n) => ({
            ...n,
            server: { ...n.server!, serviceTime: scaleDistribution(n.server!.serviceTime, factor) as never },
          }));
        },
      });
    }

    if (node.database) {
      const cfg = node.database;
      knobs.push({
        id: `${id}.poolSize`,
        label: `${node.label} pool size`,
        kind: "poolSize",
        nodeId: id,
        value: cfg.poolSize,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            database: { ...n.database!, poolSize: Math.max(1, Math.round(v)) },
          })),
      });
      knobs.push({
        id: `${id}.parallelism`,
        label: `${node.label} query parallelism`,
        kind: "parallelism",
        nodeId: id,
        value: cfg.parallelism,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            database: { ...n.database!, parallelism: Math.max(1, Math.round(v)) },
          })),
      });
      knobs.push({
        id: `${id}.serviceTime`,
        label: `${node.label} query time`,
        kind: "serviceTime",
        nodeId: id,
        value: distMean(cfg.serviceTime),
        integer: false,
        largerIsBetter: false,
        min: 0.001,
        apply: (d, v) => {
          const factor = v / Math.max(1e-9, distMean(cfg.serviceTime));
          return patchNode(d, id, (n) => ({
            ...n,
            database: {
              ...n.database!,
              serviceTime: scaleDistribution(n.database!.serviceTime, factor) as never,
            },
          }));
        },
      });
    }

    if (node.cache) {
      const cfg = node.cache;
      knobs.push({
        id: `${id}.cacheCapacity`,
        label: `${node.label} capacity`,
        kind: "cacheCapacity",
        nodeId: id,
        value: cfg.capacity,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            cache: { ...n.cache!, capacity: Math.max(1, Math.round(v)) },
          })),
      });
      knobs.push({
        id: `${id}.concurrency`,
        label: `${node.label} concurrency`,
        kind: "concurrency",
        nodeId: id,
        value: cfg.concurrency,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            cache: { ...n.cache!, concurrency: Math.max(1, Math.round(v)) },
          })),
      });
    }

    if (node.queue) {
      const cfg = node.queue;
      knobs.push({
        id: `${id}.consumers`,
        label: `${node.label} consumers`,
        kind: "consumers",
        nodeId: id,
        value: cfg.consumers,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            queue: { ...n.queue!, consumers: Math.max(1, Math.round(v)) },
          })),
      });
    }

    if (node.loadbalancer) {
      knobs.push({
        id: `${id}.concurrency`,
        label: `${node.label} concurrency`,
        kind: "concurrency",
        nodeId: id,
        value: node.loadbalancer.concurrency,
        integer: true,
        largerIsBetter: true,
        min: 1,
        apply: (d, v) =>
          patchNode(d, id, (n) => ({
            ...n,
            loadbalancer: { ...n.loadbalancer!, concurrency: Math.max(1, Math.round(v)) },
          })),
      });
    }
  }

  for (const e of design.edges) {
    const mean = distMean(e.latency);
    // A zero-latency edge has nothing to vary, and perturbing it by a factor would
    // stay at zero forever.
    if (mean <= 0) continue;
    knobs.push({
      id: `${e.id}.latency`,
      label: `${e.from} \u2192 ${e.to} latency`,
      kind: "edgeLatency",
      edgeId: e.id,
      value: mean,
      integer: false,
      largerIsBetter: false,
      min: 0.001,
      apply: (d, v) => {
        const factor = v / Math.max(1e-9, mean);
        return DesignSchema.parse({
          ...d,
          edges: d.edges.map((x) =>
            x.id === e.id ? { ...x, latency: scaleDistribution(x.latency, factor) as never } : x
          ),
        });
      },
    });
  }

  return knobs;
}
