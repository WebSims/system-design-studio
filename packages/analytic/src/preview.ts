import { mean as distMean, scv as distScv, zipfTopMass } from "@sds/core";
import { classesOf, type Design, type RequestClass, type SdsEdge, type SdsNode } from "@sds/schema";
import { allenCunneenWqMs, pkWqMs, solveMMc, solveMMcK } from "./queueing";

/** Cs^2 within this distance of 1 is treated as exponential, so M/M/c applies exactly. */
const EXPONENTIAL_SCV_TOLERANCE = 1e-9;

export type QueueingModel =
  | "M/M/c"
  | "M/M/c/K"
  | "M/G/1"
  | "M/G/c (approx)"
  | "async queue"
  | "n/a";

export interface NodePreview {
  nodeId: string;
  label: string;
  kind: SdsNode["kind"];
  capacity: number;
  arrivalRatePerSec: number;
  /** Station's own service time, excluding dependency calls. */
  ownServiceMeanMs: number;
  /**
   * Service time including time spent holding this station's slot while waiting
   * on dependencies. This is what determines utilization, and it is why a slow
   * database saturates its callers' worker pools.
   */
  effectiveServiceMeanMs: number;
  serviceScv: number;
  /** lambda / (c * mu). At or above 1 there is no steady state. */
  rho: number;
  utilization: number;
  stable: boolean;
  wqMs: number;
  /** Mean response time of this station as seen by its caller. */
  wMs: number;
  lq: number;
  l: number;
  p99Ms: number | null;
  blockingProbability: number;
  model: QueueingModel;
  approximate: boolean;
  /** Set when the closed form cannot cover this node exactly. */
  caveat: string | null;
  /** Cache only: the perfect-cache hit ratio for this capacity and key skew. */
  hitRatio?: number;
  /** Queue only. */
  queue?: {
    drainCapacityPerSec: number;
    /** Above 1 the backlog grows without bound. */
    load: number;
    backlogStable: boolean;
  };
  /** Database only. */
  database?: {
    poolSize: number;
    parallelism: number;
    /** min(pool, parallelism): the real concurrency limit. */
    effectiveConcurrency: number;
    poolIsBinding: boolean;
    maxThroughputPerSec: number;
  };
}

export interface ClassPreview {
  classId: string;
  label: string;
  share: number;
  offeredRatePerSec: number;
  throughputPerSec: number;
  endToEndMeanMs: number | null;
  endToEndP99Ms: number | null;
  /** True when the mean is a lower bound because of fork-join. */
  meanIsLowerBound: boolean;
}

export interface DesignPreview {
  stable: boolean;
  /** Highest-utilization station: the thing to fix first. */
  bottleneckNodeId: string | null;
  bottleneckUtilization: number;
  offeredRatePerSec: number;
  throughputPerSec: number;
  nodes: NodePreview[];
  classes: ClassPreview[];
  endToEndMeanMs: number | null;
  endToEndP99Ms: number | null;
  meanIsLowerBound: boolean;
  p99Reason: string | null;
  approximate: boolean;
  /** Async queues whose consumers cannot keep up, even though requests look fine. */
  asyncBacklogWarning: string | null;
  notes: string[];
}

/** Kahn topological order. Cycles are rejected upstream by the schema validator. */
function topoOrder(design: Design): string[] {
  const indegree = new Map<string, number>();
  for (const n of design.nodes) indegree.set(n.id, 0);
  for (const e of design.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of design.edges) {
      if (e.from !== id) continue;
      const d = (indegree.get(e.to) ?? 1) - 1;
      indegree.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  // Any node left out sits on a cycle; the validator reports that separately.
  for (const n of design.nodes) if (!order.includes(n.id)) order.push(n.id);
  return order;
}

function isExponential(scv: number): boolean {
  return Math.abs(scv - 1) < EXPONENTIAL_SCV_TOLERANCE;
}

const key = (nodeId: string, classId: string) => `${nodeId}|${classId}`;

/**
 * Edges a class may use from a node, and the share of that class's traffic each
 * one carries.
 *
 * Load balancers split traffic across backends; every other kind calls each
 * eligible dependency with its own probability. Round-robin, least-connections and
 * power-of-two-choices all even out to a 1/n split in the mean, which is what the
 * closed form needs -- their difference is in the VARIANCE of queue lengths, which
 * only the simulation can show.
 */
function routeShares(
  design: Design,
  node: SdsNode,
  classId: string
): Array<{ edge: SdsEdge; share: number }> {
  const eligible = design.edges.filter(
    (e) => e.from === node.id && (e.classes.length === 0 || e.classes.includes(classId))
  );
  if (eligible.length === 0) return [];

  if (node.kind === "loadbalancer") {
    if (node.loadbalancer!.algorithm === "random") {
      const total = eligible.reduce((s, e) => s + e.weight, 0);
      return eligible.map((e) => ({ edge: e, share: e.weight / total }));
    }
    return eligible.map((e) => ({ edge: e, share: 1 / eligible.length }));
  }

  return eligible.map((e) => ({ edge: e, share: e.probability }));
}

/** Perfect-cache hit ratio for a capacity and key population. */
function analyticHitRatio(node: SdsNode): number {
  const cfg = node.cache!;
  if (cfg.keyspace.kind === "fixed") return cfg.keyspace.hitRatio;
  return zipfTopMass(cfg.keyspace.keys, cfg.keyspace.skew, cfg.capacity);
}

/**
 * Solve a design in closed form.
 *
 * TWO PASSES, AND BOTH DIRECTIONS MATTER.
 *
 * Forward (topological): arrival rate per node per class, attenuated by edge loss,
 * split by load balancers, and reduced by cache hit ratio -- only misses reach the
 * origin.
 *
 * Backward (reverse topological): effective service time per node. A station holds
 * its slot while waiting on dependencies, so its service time is its own work plus
 * its dependencies' response time. That coupling is what makes a slow database
 * saturate its callers, and it means a station's utilization cannot be computed
 * without first solving everything downstream of it.
 *
 * WHAT IS EXACT AND WHAT IS NOT
 *
 * A leaf station with exponential service is exact M/M/c. Once a station waits on
 * dependencies it is "simultaneous resource possession", which has no product-form
 * solution, so the composite service time is an approximation and is labelled one.
 * Fork-join makes the mean a lower bound rather than an estimate, since E[max]
 * exceeds max(E). The simulation is authoritative in both cases.
 */
export function previewDesign(design: Design): DesignPreview {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const order = topoOrder(design);
  const classes = classesOf(design);
  const totalWeight = classes.reduce((s, c) => s + c.weight, 0);
  const notes: string[] = [];

  // ---- forward pass: arrival rates per (node, class) ----
  const lambdaIn = new Map<string, number>();
  const bump = (nodeId: string, classId: string, amount: number) => {
    const k = key(nodeId, classId);
    lambdaIn.set(k, (lambdaIn.get(k) ?? 0) + amount);
  };

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;

    for (const cls of classes) {
      let outbound: number;
      if (node.kind === "client") {
        const rate = node.client?.arrival.ratePerSec ?? 0;
        outbound = rate * (totalWeight > 0 ? cls.weight / totalWeight : 0);
      } else {
        outbound = lambdaIn.get(key(id, cls.id)) ?? 0;
        // Only cache MISSES continue to the origin.
        if (node.kind === "cache") outbound *= 1 - analyticHitRatio(node);
      }
      if (outbound <= 0) continue;

      for (const { edge, share } of routeShares(design, node, cls.id)) {
        bump(edge.to, cls.id, outbound * share * (1 - edge.lossProbability));
      }
    }
  }

  // ---- backward pass: effective service and response time ----
  const previews = new Map<string, NodePreview>();
  /** Mean response time of a node as its caller sees it, per class. */
  const responseMs = new Map<string, number>();
  /**
   * Probability a call into this node ultimately succeeds, per class.
   *
   * Computed recursively because a request only succeeds if it survives every
   * station it visits and every branch it fans out to. An earlier version derived
   * throughput from edge loss alone, which silently ignored load shedding and
   * reported 150/s of throughput for a station whose capacity was 100/s.
   */
  const successProb = new Map<string, number>();
  let anyApproximate = false;
  let anyForkJoin = false;
  let asyncBacklogWarning: string | null = null;

  for (const id of [...order].reverse()) {
    const node = byId.get(id);
    if (!node || node.kind === "client") continue;

    /** Expected time this node spends waiting on dependencies, per class. */
    const dependencyMs = new Map<string, number>();
    for (const cls of classes) {
      const routes = routeShares(design, node, cls.id);
      if (routes.length === 0) {
        dependencyMs.set(cls.id, 0);
        continue;
      }
      const legs = routes.map(({ edge, share }) => {
        // Both directions cross the wire.
        const net = 2 * distMean(edge.latency);
        const downstream = responseMs.get(key(edge.to, cls.id)) ?? 0;
        return { cost: net + downstream, share };
      });

      let total: number;
      if (node.kind === "loadbalancer") {
        // Exactly one backend is chosen, so the cost is the weighted average.
        total = legs.reduce((s, l) => s + l.cost * l.share, 0);
      } else if (node.kind === "queue") {
        // Consumers call downstream, and nobody is waiting. Contributes nothing
        // to request latency.
        total = 0;
      } else if (node.kind === "cache") {
        // Origin is reached only on a miss, and that is already reflected in the
        // arrival rate; here it is the conditional cost.
        total = (1 - analyticHitRatio(node)) * legs.reduce((s, l) => s + l.cost, 0);
      } else {
        const parallel = node.server?.fanout !== "sequential";
        const called = legs.filter((l) => l.share > 0);
        if (parallel && called.length > 1) {
          anyForkJoin = true;
          // E[max] > max(E). Using max(E) makes the result a lower bound, which is
          // stated rather than presented as an estimate.
          total = called.reduce((m, l) => Math.max(m, l.cost * 1), 0);
        } else {
          total = called.reduce((s, l) => s + l.cost * l.share, 0);
        }
      }
      dependencyMs.set(cls.id, total);
    }

    // Whether waiting on a dependency occupies this station's own slot.
    //
    // A thread-per-request server does hold it, and that is how a slow dependency
    // exhausts its caller's pool. A non-blocking server does not, which makes a
    // chain of them a genuine Jackson network and therefore exactly solvable. A
    // cache does not either: in a cache-aside deployment the application performs
    // the origin fetch, so the cache is idle during it.
    const holdsSlot =
      node.kind === "server"
        ? node.server!.blocksOnDependencies
        : node.kind === "loadbalancer";

    const preview = solveStation(node, classes, totalWeight, lambdaIn, dependencyMs, holdsSlot);
    previews.set(node.id, preview);
    if (preview.approximate) anyApproximate = true;

    if (node.kind === "queue" && preview.queue && !preview.queue.backlogStable) {
      asyncBacklogWarning =
        `queue "${node.label}" cannot keep up: ${preview.arrivalRatePerSec.toFixed(0)}/s arriving ` +
        `against ${preview.queue.drainCapacityPerSec.toFixed(0)}/s of consumer capacity. ` +
        `The backlog grows without bound. Request latency stays healthy because publishing returns ` +
        `immediately, so this failure does not show up in any percentile.`;
    }

    for (const cls of classes) {
      // A caller waits for this node's own queueing and service, which already
      // includes its dependency time via the effective service distribution.
      responseMs.set(key(node.id, cls.id), preview.stable ? preview.wMs : Number.POSITIVE_INFINITY);

      // Survival through this node and everything it calls.
      const survivesHere = 1 - preview.blockingProbability;
      const routes = routeShares(design, node, cls.id);
      let downstreamSurvival = 1;

      if (node.kind === "queue") {
        // Consumers run detached; a publish succeeding does not depend on them.
        downstreamSurvival = 1;
      } else if (node.kind === "loadbalancer") {
        downstreamSurvival = routes.reduce(
          (s, r) =>
            s +
            r.share *
              (1 - r.edge.lossProbability) *
              (successProb.get(key(r.edge.to, cls.id)) ?? 1),
          0
        );
      } else if (node.kind === "cache") {
        const h = analyticHitRatio(node);
        const originSurvival = routes.reduce(
          (s, r) => s * (1 - r.edge.lossProbability) * (successProb.get(key(r.edge.to, cls.id)) ?? 1),
          1
        );
        downstreamSurvival = h + (1 - h) * originSurvival;
      } else {
        // Every branch that is taken must succeed; a branch not taken cannot fail.
        downstreamSurvival = routes.reduce((s, r) => {
          const ifTaken =
            (1 - r.edge.lossProbability) * (successProb.get(key(r.edge.to, cls.id)) ?? 1);
          return s * (r.share * ifTaken + (1 - r.share));
        }, 1);
      }

      successProb.set(key(node.id, cls.id), survivesHere * downstreamSurvival);
    }
  }

  const nodes = design.nodes
    .filter((n) => n.kind !== "client")
    .map((n) => previews.get(n.id))
    .filter((p): p is NodePreview => Boolean(p));

  // A saturated async queue does not make requests slow, so it must not make the
  // whole design "unstable" -- it gets its own warning instead.
  const stable = nodes.every((n) => n.kind === "queue" || n.stable);

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

  // ---- per-class end-to-end ----
  const classPreviews: ClassPreview[] = classes.map((cls) => {
    const clients = design.nodes.filter((n) => n.kind === "client");
    let offered = 0;
    let latency: number | null = 0;
    let survival = 1;
    let singleStationExact = true;
    let stationCount = 0;

    for (const client of clients) {
      const rate = client.client?.arrival.ratePerSec ?? 0;
      const share = totalWeight > 0 ? cls.weight / totalWeight : 0;
      offered += rate * share;
      for (const { edge } of routeShares(design, client, cls.id)) {
        const target = previews.get(edge.to);
        survival *=
          (1 - edge.lossProbability) * (successProb.get(key(edge.to, cls.id)) ?? 1);
        if (!target || latency === null) {
          latency = null;
          continue;
        }
        if (!target.stable && target.kind !== "queue") {
          latency = null;
          continue;
        }
        latency += 2 * distMean(edge.latency) + target.wMs;
        stationCount++;
        if (target.model !== "M/M/c" || (design.edges.filter((e) => e.from === edge.to).length > 0)) {
          singleStationExact = false;
        }
      }
    }

    const exactP99 =
      stationCount === 1 && singleStationExact && !anyForkJoin
        ? clientP99(design, cls, previews)
        : null;

    return {
      classId: cls.id,
      label: cls.label,
      share: totalWeight > 0 ? cls.weight / totalWeight : 0,
      offeredRatePerSec: offered,
      throughputPerSec: offered * survival,
      endToEndMeanMs: latency,
      endToEndP99Ms: exactP99,
      meanIsLowerBound: anyForkJoin,
    };
  });

  const offeredRatePerSec = classPreviews.reduce((s, c) => s + c.offeredRatePerSec, 0);
  const throughputPerSec = classPreviews.reduce((s, c) => s + c.throughputPerSec, 0);

  let endToEndMeanMs: number | null = null;
  if (classPreviews.length > 0 && classPreviews.every((c) => c.endToEndMeanMs !== null)) {
    const weight = classPreviews.reduce((s, c) => s + c.throughputPerSec, 0);
    endToEndMeanMs =
      weight > 0
        ? classPreviews.reduce((s, c) => s + c.endToEndMeanMs! * c.throughputPerSec, 0) / weight
        : classPreviews.reduce((s, c) => s + c.endToEndMeanMs!, 0) / classPreviews.length;
  }

  let endToEndP99Ms: number | null = null;
  let p99Reason: string | null = null;
  if (classPreviews.length === 1 && classPreviews[0]!.endToEndP99Ms !== null) {
    endToEndP99Ms = classPreviews[0]!.endToEndP99Ms;
  } else if (!stable) {
    p99Reason = "no steady state: the queue grows without bound, so no percentile exists";
  } else if (anyForkJoin) {
    p99Reason =
      "fork-join: the distribution of a maximum has no closed form, so even the mean is only a lower bound \u2014 press Run";
  } else if (nodes.filter((n) => n.kind !== "queue").length > 1 || classPreviews.length > 1) {
    p99Reason =
      "exact percentiles across multiple stations need a convolution the closed form does not provide \u2014 press Run";
  } else if (anyApproximate) {
    p99Reason =
      "service time is not exponential, so only an approximate mean is available in closed form \u2014 press Run";
  } else {
    p99Reason = "not available for this configuration \u2014 press Run";
  }

  if (anyApproximate) {
    notes.push(
      "some stations use approximations (Allen-Cunneen for M/G/c, or composite service time where a station waits on dependencies); the simulation is authoritative"
    );
  }
  if (anyForkJoin) {
    notes.push(
      "a station calls dependencies in parallel; the mean below is a lower bound because the expected maximum exceeds the maximum of the expectations"
    );
  }
  if (!stable) {
    notes.push("at least one station is saturated: arrivals exceed service capacity");
  }
  for (const n of nodes) {
    if (n.database?.poolIsBinding) {
      notes.push(
        `"${n.label}" has a pool of ${n.database.poolSize} below its execution parallelism of ${n.database.parallelism}, so connections are the constraint`
      );
    }
  }

  return {
    stable,
    bottleneckNodeId,
    bottleneckUtilization,
    offeredRatePerSec,
    throughputPerSec,
    nodes,
    classes: classPreviews,
    endToEndMeanMs,
    endToEndP99Ms,
    meanIsLowerBound: anyForkJoin,
    p99Reason,
    approximate: anyApproximate,
    asyncBacklogWarning,
    notes,
  };
}

/** Exact end-to-end p99 for the single-station case: station quantile + network. */
function clientP99(
  design: Design,
  cls: RequestClass,
  previews: Map<string, NodePreview>
): number | null {
  for (const client of design.nodes.filter((n) => n.kind === "client")) {
    for (const { edge } of routeShares(design, client, cls.id)) {
      const target = previews.get(edge.to);
      if (!target || target.p99Ms === null) return null;
      return target.p99Ms + 2 * distMean(edge.latency);
    }
  }
  return null;
}

/**
 * Solve one station.
 *
 * Multi-class traffic is aggregated the standard way for a shared FCFS station:
 * utilization is the sum of each class's demand, and the station is then solved
 * with the demand-weighted mean service time.
 */
function solveStation(
  node: SdsNode,
  classes: RequestClass[],
  totalWeight: number,
  lambdaIn: Map<string, number>,
  dependencyMs: Map<string, number>,
  holdsSlot: boolean
): NodePreview {
  void totalWeight;

  // ---- aggregate arrivals and demand across classes ----
  let lambda = 0;
  let slotDemandMsPerSec = 0; // sum of lambda_c * (time the slot is occupied)
  let ownDemand = 0;
  let detachedDependencyMsPerSec = 0; // dependency time NOT holding the slot
  for (const cls of classes) {
    const l = lambdaIn.get(key(node.id, cls.id)) ?? 0;
    if (l <= 0) continue;
    const own = ownServiceMs(node) * cls.serviceMultiplier;
    const dep = dependencyMs.get(cls.id) ?? 0;
    lambda += l;
    ownDemand += l * own;
    slotDemandMsPerSec += l * (own + (holdsSlot ? dep : 0));
    if (!holdsSlot) detachedDependencyMsPerSec += l * dep;
  }
  const effectiveServiceMeanMs = lambda > 0 ? slotDemandMsPerSec / lambda : ownServiceMs(node);
  const ownServiceMeanMs = lambda > 0 ? ownDemand / lambda : ownServiceMs(node);
  /** Dependency time the caller waits for but this station does not occupy a slot for. */
  const detachedDependencyMs = lambda > 0 ? detachedDependencyMsPerSec / lambda : 0;
  const holdsSlotForDependencies = effectiveServiceMeanMs > ownServiceMeanMs * 1.0000001;

  const base = {
    nodeId: node.id,
    label: node.label,
    kind: node.kind,
    arrivalRatePerSec: lambda,
    ownServiceMeanMs,
    effectiveServiceMeanMs,
    serviceScv: scvOf(node),
    blockingProbability: 0,
  };

  // ---- queue: an asynchronous boundary, not a synchronous station ----
  if (node.kind === "queue") {
    const cfg = node.queue!;
    const publishMs = distMean(cfg.publishTime);
    const consumerMs = distMean(cfg.consumerServiceTime);
    const drain = (cfg.consumers * 1000) / consumerMs;
    const load = drain > 0 ? lambda / drain : Number.POSITIVE_INFINITY;
    // A bounded queue drops on overflow, and that IS a request failure -- the
    // publish returns an error. Solved as M/M/c/K over the consumers, which is the
    // right model whether or not the consumers are keeping up.
    const dropProbability =
      cfg.maxDepth === null
        ? 0
        : solveMMcK(lambda, 1000 / consumerMs, cfg.consumers, cfg.maxDepth).blockingProbability;
    return {
      ...base,
      capacity: cfg.consumers,
      ownServiceMeanMs: publishMs,
      effectiveServiceMeanMs: publishMs,
      rho: load,
      utilization: Math.min(1, load),
      // The REQUEST path is always stable: publishing returns immediately no
      // matter how far behind the consumers are. The backlog is reported
      // separately, because conflating the two would either hide a real outage or
      // invent a latency problem that does not exist.
      stable: true,
      wqMs: 0,
      wMs: publishMs,
      lq: 0,
      l: 0,
      p99Ms: null,
      blockingProbability: dropProbability,
      model: "async queue",
      approximate: false,
      caveat:
        "publishing returns immediately, so this contributes only publish time to request latency",
      queue: {
        drainCapacityPerSec: drain,
        load,
        backlogStable: load < 1,
      },
    };
  }

  // ---- concurrency and admission per kind ----
  let c: number;
  let queueCapacity: number | null = null;
  let admission: "shed" | "block" = "block";
  let databaseInfo: NodePreview["database"];

  switch (node.kind) {
    case "server": {
      const cfg = node.server!;
      c = cfg.concurrency * cfg.replicas;
      queueCapacity = cfg.queueCapacity;
      admission = cfg.admissionPolicy;
      break;
    }
    case "loadbalancer":
      c = node.loadbalancer!.concurrency;
      break;
    case "cache":
      c = node.cache!.concurrency;
      break;
    case "database": {
      const cfg = node.database!;
      // You cannot execute more queries at once than you have connections, nor
      // more than the engine can run. The binding constraint is the smaller.
      c = Math.min(cfg.poolSize, cfg.parallelism);
      queueCapacity = cfg.queueCapacity;
      admission = cfg.admissionPolicy;
      databaseInfo = {
        poolSize: cfg.poolSize,
        parallelism: cfg.parallelism,
        effectiveConcurrency: c,
        poolIsBinding: cfg.poolSize < cfg.parallelism,
        maxThroughputPerSec: (c * 1000) / distMean(cfg.serviceTime),
      };
      break;
    }
    default:
      c = 1;
  }

  const mu = 1000 / Math.max(1e-9, effectiveServiceMeanMs);
  const exponential = isExponential(scvOf(node)) && !holdsSlotForDependencies;
  const shedding = queueCapacity !== null && admission === "shed";

  const extras = {
    hitRatio: node.kind === "cache" ? analyticHitRatio(node) : undefined,
    database: databaseInfo,
  };

  const compositeCaveat = holdsSlotForDependencies
    ? "holds its slot while waiting on dependencies, so its service time is a composite and the solution is approximate"
    : null;

  if (shedding) {
    const k = queueCapacity!;
    const s = solveMMcK(lambda, mu, c, k);
    return {
      ...base,
      ...extras,
      capacity: c,
      rho: s.rho,
      utilization: s.utilization,
      // A shedding station always has a steady state: the queue is bounded, so
      // latency stays finite no matter how far arrivals exceed capacity. What
      // rises instead is the rejection rate.
      stable: true,
      wqMs: s.wqMs,
      wMs: s.wMs + detachedDependencyMs,
      lq: s.lq,
      l: s.l,
      p99Ms: null,
      blockingProbability: s.blockingProbability,
      model: "M/M/c/K",
      approximate: !exponential,
      caveat: compositeCaveat,
    };
  }

  if (exponential) {
    const s = solveMMc({ lambda, mu, c });
    return {
      ...base,
      ...extras,
      capacity: c,
      rho: s.rho,
      utilization: Math.min(1, s.rho),
      stable: s.stable,
      wqMs: s.wqMs,
      wMs: s.wMs + detachedDependencyMs,
      lq: s.lq,
      l: s.l,
      // Exact only when the caller waits for nothing beyond this station.
      p99Ms: detachedDependencyMs > 0 ? null : s.quantileMs(0.99),
      model: "M/M/c",
      approximate: false,
      caveat: null,
    };
  }

  const wqMs =
    c === 1
      ? pkWqMs(lambda, effectiveServiceMeanMs, scvOf(node))
      : allenCunneenWqMs(lambda, effectiveServiceMeanMs, scvOf(node), c);
  const rho = lambda / (c * mu);
  const stationStable = rho < 1;
  const wMs = stationStable
    ? wqMs + effectiveServiceMeanMs + detachedDependencyMs
    : Number.POSITIVE_INFINITY;
  return {
    ...base,
    ...extras,
    capacity: c,
    rho,
    utilization: Math.min(1, rho),
    stable: stationStable,
    wqMs,
    wMs,
    lq: stationStable ? (lambda * wqMs) / 1000 : Number.POSITIVE_INFINITY,
    l: stationStable ? (lambda * wMs) / 1000 : Number.POSITIVE_INFINITY,
    p99Ms: null,
    model: c === 1 ? "M/G/1" : "M/G/c (approx)",
    approximate: c !== 1 || holdsSlotForDependencies,
    caveat: compositeCaveat,
  };
}

function ownServiceMs(node: SdsNode): number {
  switch (node.kind) {
    case "server":
      return distMean(node.server!.serviceTime);
    case "loadbalancer":
      return distMean(node.loadbalancer!.serviceTime);
    case "cache":
      return distMean(node.cache!.serviceTime);
    case "database":
      return distMean(node.database!.serviceTime);
    case "queue":
      return distMean(node.queue!.publishTime);
    default:
      return 0;
  }
}

function scvOf(node: SdsNode): number {
  switch (node.kind) {
    case "server":
      return distScv(node.server!.serviceTime);
    case "loadbalancer":
      return distScv(node.loadbalancer!.serviceTime);
    case "cache":
      return distScv(node.cache!.serviceTime);
    case "database":
      return distScv(node.database!.serviceTime);
    case "queue":
      return distScv(node.queue!.consumerServiceTime);
    default:
      return 1;
  }
}
