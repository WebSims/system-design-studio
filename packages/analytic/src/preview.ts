import { mean as distMean, scv as distScv } from "@sds/core";
import type { Design, SdsNode } from "@sds/schema";
import {
  allenCunneenWqMs,
  pkWqMs,
  solveMMc,
  solveMMcK,
} from "./queueing";

/** Cs^2 within this distance of 1 is treated as exponential, so M/M/c applies exactly. */
const EXPONENTIAL_SCV_TOLERANCE = 1e-9;

export type QueueingModel = "M/M/c" | "M/M/c/K" | "M/G/1" | "M/G/c (approx)";

export interface NodePreview {
  nodeId: string;
  label: string;
  capacity: number;
  arrivalRatePerSec: number;
  serviceMeanMs: number;
  serviceScv: number;
  /** lambda / (c * mu). At or above 1 there is no steady state. */
  rho: number;
  /** Time-weighted busy fraction, accounting for rejected arrivals. */
  utilization: number;
  stable: boolean;
  wqMs: number;
  wMs: number;
  lq: number;
  l: number;
  /** Exact sojourn p99 where the model supports it, else null. */
  p99Ms: number | null;
  blockingProbability: number;
  model: QueueingModel;
  approximate: boolean;
}

export interface ClientPreview {
  clientId: string;
  label: string;
  offeredRatePerSec: number;
  /** Requests per second expected to complete successfully. */
  throughputPerSec: number;
  endToEndMeanMs: number | null;
  endToEndP99Ms: number | null;
}

export interface DesignPreview {
  stable: boolean;
  /** Highest-utilization station: the thing to fix first. */
  bottleneckNodeId: string | null;
  bottleneckUtilization: number;
  offeredRatePerSec: number;
  throughputPerSec: number;
  nodes: NodePreview[];
  clients: ClientPreview[];
  /** Overall mean, weighted by each client's throughput. */
  endToEndMeanMs: number | null;
  /** Null when no exact closed form applies; `p99Reason` says why. */
  endToEndP99Ms: number | null;
  p99Reason: string | null;
  /** True if any number above rests on an approximation. */
  approximate: boolean;
  notes: string[];
}

/** Kahn topological order. Cycles are rejected upstream by the schema validator. */
function topoOrder(design: Design): string[] {
  const indegree = new Map<string, number>();
  for (const n of design.nodes) indegree.set(n.id, 0);
  for (const e of design.edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of design.edges.filter((x) => x.from === id)) {
      const d = (indegree.get(e.to) ?? 1) - 1;
      indegree.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return order;
}

function isExponential(scv: number): boolean {
  return Math.abs(scv - 1) < EXPONENTIAL_SCV_TOLERANCE;
}

/**
 * Solve a design in closed form.
 *
 * Correct for a chain of independent M/M/c stations by Burke's theorem: the
 * departure process of a stationary M/M/c queue is itself Poisson at the same
 * rate, so each downstream station also sees Poisson arrivals and can be solved
 * independently. That is why a tandem of stations decomposes at all -- it is a
 * theorem, not an approximation, and it is worth knowing which of the two you are
 * relying on.
 *
 * Where a station's service time is not exponential the decomposition no longer
 * follows from Burke, and the result is flagged approximate rather than quietly
 * presented as exact.
 */
export function previewDesign(design: Design): DesignPreview {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const order = topoOrder(design);
  const notes: string[] = [];

  /** Arrival rate entering each node, per second. */
  const lambdaIn = new Map<string, number>();
  /** Rate successfully leaving each node. */
  const lambdaOut = new Map<string, number>();
  const previews = new Map<string, NodePreview>();

  let anyApproximate = false;
  let stationCount = 0;

  // Single pass in topological order: every node's inbound rate is fully
  // accumulated before it is solved, which is exactly what the ordering buys us.
  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;

    if (node.kind === "client") {
      lambdaOut.set(id, node.client?.arrival.ratePerSec ?? 0);
    } else {
      const lambda = lambdaIn.get(id) ?? 0;
      const preview = solveStation(node, lambda);
      previews.set(id, preview);
      stationCount++;
      if (preview.approximate) anyApproximate = true;
      lambdaOut.set(id, lambda * (1 - preview.blockingProbability));
    }

    // Propagate downstream, attenuated by edge loss.
    for (const e of design.edges) {
      if (e.from !== id) continue;
      const delivered = (lambdaOut.get(id) ?? 0) * (1 - e.lossProbability);
      lambdaIn.set(e.to, (lambdaIn.get(e.to) ?? 0) + delivered);
    }
  }

  const nodes = design.nodes
    .filter((n) => n.kind === "server")
    .map((n) => previews.get(n.id)!)
    .filter(Boolean);

  const stable = nodes.every((n) => n.stable);

  let bottleneckNodeId: string | null = null;
  let bottleneckUtilization = 0;
  for (const n of nodes) {
    // Compare on rho, not utilization: a shedding station pins utilization near
    // 1 while rho keeps rising, and rho is what says how far past capacity it is.
    if (n.rho > bottleneckUtilization) {
      bottleneckUtilization = n.rho;
      bottleneckNodeId = n.nodeId;
    }
  }

  // ---- per-client end-to-end ----
  const clients: ClientPreview[] = [];
  for (const c of design.nodes.filter((n) => n.kind === "client")) {
    const chain = walkChain(design, c.id);
    let meanMs: number | null = 0;
    let survival = 1;
    for (const step of chain) {
      const p = previews.get(step.toId);
      survival *= 1 - step.lossProbability;
      if (!p) continue;
      if (!p.stable || meanMs === null) {
        meanMs = null;
        continue;
      }
      meanMs += distMean(step.latency) + p.wMs;
      survival *= 1 - p.blockingProbability;
    }
    const offered = c.client?.arrival.ratePerSec ?? 0;
    clients.push({
      clientId: c.id,
      label: c.label,
      offeredRatePerSec: offered,
      throughputPerSec: offered * survival,
      endToEndMeanMs: meanMs,
      // Exact only for a single M/M/c station: the sum of independent sojourn
      // times has no simple closed-form quantile, and summing per-station p99s
      // is the classic error that overstates the tail badly.
      endToEndP99Ms:
        chain.length === 1 && previews.get(chain[0]!.toId)?.model === "M/M/c"
          ? addLatency(previews.get(chain[0]!.toId)!.p99Ms, distMean(chain[0]!.latency))
          : null,
    });
  }

  const offeredRatePerSec = clients.reduce((s, c) => s + c.offeredRatePerSec, 0);
  const throughputPerSec = clients.reduce((s, c) => s + c.throughputPerSec, 0);

  let endToEndMeanMs: number | null = null;
  if (clients.length > 0 && clients.every((c) => c.endToEndMeanMs !== null)) {
    const weight = clients.reduce((s, c) => s + c.throughputPerSec, 0);
    endToEndMeanMs =
      weight > 0
        ? clients.reduce((s, c) => s + c.endToEndMeanMs! * c.throughputPerSec, 0) / weight
        : clients.reduce((s, c) => s + c.endToEndMeanMs!, 0) / clients.length;
  }

  let endToEndP99Ms: number | null = null;
  let p99Reason: string | null = null;
  if (clients.length === 1 && clients[0]!.endToEndP99Ms !== null) {
    endToEndP99Ms = clients[0]!.endToEndP99Ms;
  } else if (!stable) {
    p99Reason = "no steady state: the queue grows without bound, so no percentile exists";
  } else if (stationCount > 1 || clients.length > 1) {
    p99Reason =
      "exact percentiles across multiple stations need a convolution the closed form does not provide — press Run";
  } else if (anyApproximate) {
    p99Reason =
      "service time is not exponential, so only an approximate mean is available in closed form — press Run";
  } else {
    p99Reason = "not available for this configuration — press Run";
  }

  if (anyApproximate) {
    notes.push(
      "one or more stations use the Allen-Cunneen M/G/c approximation; the simulation is authoritative"
    );
  }
  if (!stable) {
    notes.push("at least one station is saturated: arrivals exceed service capacity");
  }

  return {
    stable,
    bottleneckNodeId,
    bottleneckUtilization,
    offeredRatePerSec,
    throughputPerSec,
    nodes,
    clients,
    endToEndMeanMs,
    endToEndP99Ms,
    p99Reason,
    approximate: anyApproximate,
    notes,
  };
}

function addLatency(a: number | null, b: number): number | null {
  return a === null ? null : a + b;
}

interface ChainStep {
  toId: string;
  latency: Design["edges"][number]["latency"];
  lossProbability: number;
}

function walkChain(design: Design, fromId: string): ChainStep[] {
  const steps: ChainStep[] = [];
  const seen = new Set([fromId]);
  let current = fromId;
  for (;;) {
    const out = design.edges.filter((e) => e.from === current);
    if (out.length !== 1) return steps;
    const e = out[0]!;
    if (seen.has(e.to)) return steps;
    seen.add(e.to);
    steps.push({ toId: e.to, latency: e.latency, lossProbability: e.lossProbability });
    current = e.to;
  }
}

function solveStation(node: SdsNode, lambda: number): NodePreview {
  const cfg = node.server!;
  const c = cfg.concurrency * cfg.replicas;
  const serviceMeanMs = distMean(cfg.serviceTime);
  const serviceScv = distScv(cfg.serviceTime);
  const mu = 1000 / serviceMeanMs;
  const exponential = isExponential(serviceScv);
  const shedding = cfg.queueCapacity !== null && cfg.admissionPolicy === "shed";

  if (shedding) {
    const k = cfg.queueCapacity!;
    const s = solveMMcK(lambda, mu, c, k);
    return {
      nodeId: node.id,
      label: node.label,
      capacity: c,
      arrivalRatePerSec: lambda,
      serviceMeanMs,
      serviceScv,
      rho: s.rho,
      utilization: s.utilization,
      // A shedding station always has a steady state: the queue is bounded, so
      // latency stays finite no matter how far arrivals exceed capacity. What
      // rises instead is the rejection rate. That is the whole argument for
      // shedding, made visible.
      stable: true,
      wqMs: s.wqMs,
      wMs: s.wMs,
      lq: s.lq,
      l: s.l,
      p99Ms: null,
      blockingProbability: s.blockingProbability,
      model: "M/M/c/K",
      approximate: !exponential,
    };
  }

  if (exponential) {
    const s = solveMMc({ lambda, mu, c });
    return {
      nodeId: node.id,
      label: node.label,
      capacity: c,
      arrivalRatePerSec: lambda,
      serviceMeanMs,
      serviceScv,
      rho: s.rho,
      utilization: Math.min(1, s.rho),
      stable: s.stable,
      wqMs: s.wqMs,
      wMs: s.wMs,
      lq: s.lq,
      l: s.l,
      p99Ms: s.quantileMs(0.99),
      blockingProbability: 0,
      model: "M/M/c",
      approximate: false,
    };
  }

  // Non-exponential service.
  const wqMs =
    c === 1 ? pkWqMs(lambda, serviceMeanMs, serviceScv) : allenCunneenWqMs(lambda, serviceMeanMs, serviceScv, c);
  const rho = lambda / (c * mu);
  const stable = rho < 1;
  const wMs = stable ? wqMs + serviceMeanMs : Number.POSITIVE_INFINITY;
  return {
    nodeId: node.id,
    label: node.label,
    capacity: c,
    arrivalRatePerSec: lambda,
    serviceMeanMs,
    serviceScv,
    rho,
    utilization: Math.min(1, rho),
    stable,
    wqMs,
    wMs,
    lq: stable ? (lambda * wqMs) / 1000 : Number.POSITIVE_INFINITY,
    l: stable ? (lambda * wMs) / 1000 : Number.POSITIVE_INFINITY,
    p99Ms: null,
    blockingProbability: 0,
    // M/G/1's mean is exact (Pollaczek-Khinchine); M/G/c's is not.
    model: c === 1 ? "M/G/1" : "M/G/c (approx)",
    approximate: c !== 1,
  };
}
