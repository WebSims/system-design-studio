import {
  mean as distMean,
  meanNetworkRoundTripMs,
  scv as distScv,
  zipfTopMass,
} from "@sds/core";
import {
  classesOf,
  isTimeVarying,
  meanRate,
  type Design,
  type RequestClass,
  type SdsEdge,
  type SdsNode,
} from "@sds/schema";
import { allenCunneenWqMs, pkWqMs, solveMMc, solveMMcK } from "./queueing";

/** Amplification above this is called out as a retry storm. Matches @sds/core. */
const RETRY_AMPLIFICATION_THRESHOLD = 1.25;

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
  /**
   * P(this station takes longer than `tMs`), where the model can say.
   *
   * Exact for M/M/c. Null elsewhere, in which case the preview cannot anticipate
   * timeout-driven retries and says so rather than guessing.
   */
  survivalAt: ((tMs: number) => number) | null;
  blockingProbability: number;
  model: QueueingModel;
  approximate: boolean;
  /** Set when the closed form cannot cover this node exactly. */
  caveat: string | null;
  /**
   * Why this station is saturated, when it is.
   *
   * `own` means its own work exceeds its capacity. `dependency` means it inherited
   * the saturation: a blocking caller whose dependency has no steady state has an
   * infinite effective service time, and so an infinite rho, through no fault of
   * its own.
   *
   * The distinction decides who gets blamed. Without it the caller always wins the
   * highest-rho comparison -- infinity beats any finite number -- and the tool
   * points at the victim instead of the cause.
   */
  saturationCause: "own" | "dependency" | null;
  /** Cache only: the perfect-cache hit ratio for this capacity and key skew. */
  hitRatio?: number;
  /** Queue only. */
  queue?: {
    drainCapacityPerSec: number;
    /** Above 1 the backlog grows without bound. */
    load: number;
    backlogStable: boolean;
  };
  /** Gateway only: the connection side, which constrains a different thing. */
  connections?: {
    capacity: number;
    /** Connections predicted to be held, by Little's Law. */
    held: number;
    utilization: number;
    /** Connections that cannot be held and will be refused. */
    refused: number;
    /** Handshakes per second from session churn. */
    acceptRatePerSec: number;
    memoryMb: number;
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

export interface EdgePreview {
  edgeId: string;
  from: string;
  to: string;
  /** Expected attempts per call, from the dependency's predicted failure rate. */
  amplification: number;
  /** Predicted probability one attempt fails, [0,1]. */
  attemptFailureProbability: number;
  /** Predicted probability the call ultimately succeeds after retries. */
  successProbability: number;
  maxAttempts: number;
  budgetRatio: number | null;
  /** True when the budget is what is holding amplification down. */
  budgetBinding: boolean;
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
  edges: EdgePreview[];
  /** Attempts issued over calls requested, across every edge. */
  retryAmplification: number;
  retryStormWarning: string | null;
  /**
   * False when the retry feedback loop has no fixed point.
   *
   * Retries raise load, load raises failures, failures raise retries. When that
   * loop has positive gain the iteration diverges -- and that divergence IS the
   * retry storm, not a numerical artefact. Reported rather than papered over with a
   * capped result.
   */
  converged: boolean;
  iterations: number;
  notes: string[];
}

/** Kahn topological order for a selected set of links. */
function topoOrderFor(
  design: Design,
  include: (edge: SdsEdge) => boolean
): { order: string[]; cyclic: boolean } {
  const indegree = new Map<string, number>();
  for (const n of design.nodes) indegree.set(n.id, 0);
  for (const e of design.edges) {
    if (include(e)) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of design.edges) {
      if (e.from !== id || !include(e)) continue;
      const d = (indegree.get(e.to) ?? 1) - 1;
      indegree.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return { order, cyclic: order.length !== design.nodes.length };
}

/**
 * A full DAG keeps its historical order. A bounded feedback topology instead
 * orders only synchronous links; validation guarantees that subgraph is a DAG.
 */
function topoOrder(design: Design): { order: string[]; boundedFeedback: boolean } {
  const full = topoOrderFor(design, () => true);
  if (!full.cyclic) return { order: full.order, boundedFeedback: false };
  const sync = topoOrderFor(design, (edge) => edge.semantics.kind === "synchronous");
  return {
    order: [
      ...sync.order,
      ...design.nodes.map((node) => node.id).filter((id) => !sync.order.includes(id)),
    ],
    boundedFeedback: true,
  };
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

/**
 * Propagate expected load through a feedback graph by expanding only the state
 * that makes it finite: how many times each asynchronous edge has been crossed.
 * Synchronous cycles are rejected before preview, so every path either terminates
 * or consumes a visible hop budget.
 */
function boundedArrivalRates(
  design: Design,
  classes: readonly RequestClass[],
  totalWeight: number,
  durationMs: number,
  attemptMultiplier: ReadonlyMap<string, number>
): { lambdaIn: Map<string, number>; truncated: boolean } {
  interface Pending {
    nodeId: string;
    classId: string;
    rate: number;
    hops: Readonly<Record<string, number>>;
  }

  const byId = new Map(design.nodes.map((node) => [node.id, node]));
  const lambdaIn = new Map<string, number>();
  const pending: Pending[] = [];
  const MAX_PATH_STATES = 100_000;
  let expanded = 0;

  const dispatch = (item: Pending): void => {
    const node = byId.get(item.nodeId);
    if (!node || item.rate <= 0) return;
    let outbound = item.rate;
    if (node.kind === "cache") outbound *= 1 - analyticHitRatio(node);
    if (outbound <= 0) return;

    for (const { edge, share } of routeShares(design, node, item.classId)) {
      let hops = item.hops;
      if (edge.semantics.kind === "asynchronous") {
        const used = item.hops[edge.id] ?? 0;
        if (used >= edge.semantics.maxHops) continue;
        hops = { ...item.hops, [edge.id]: used + 1 };
      }
      const multiplier = attemptMultiplier.get(edge.id) ?? 1;
      const rate =
        outbound *
        share *
        multiplier *
        edge.fanoutFactor *
        (1 - edge.network.lossProbability);
      if (rate <= 0) continue;
      const targetKey = key(edge.to, item.classId);
      lambdaIn.set(targetKey, (lambdaIn.get(targetKey) ?? 0) + rate);
      pending.push({ nodeId: edge.to, classId: item.classId, rate, hops });
    }
  };

  for (const client of design.nodes.filter((node) => node.kind === "client")) {
    for (const cls of classes) {
      const rate = client.client ? meanRate(client.client.arrival, durationMs) : 0;
      dispatch({
        nodeId: client.id,
        classId: cls.id,
        rate: rate * (totalWeight > 0 ? cls.weight / totalWeight : 0),
        hops: {},
      });
    }
  }

  let head = 0;
  while (head < pending.length && expanded < MAX_PATH_STATES) {
    dispatch(pending[head++]!);
    expanded++;
  }
  return { lambdaIn, truncated: head < pending.length };
}

/**
 * Expected attempts per call, and the resulting success probability.
 *
 * With per-attempt failure probability p and at most n attempts, attempts follow a
 * truncated geometric distribution:
 *
 *   E[attempts] = (1 - p^n) / (1 - p)        success = 1 - p^n
 *
 * Both exact, and both testable against the simulation -- which is what makes retry
 * amplification a predicted quantity rather than a vibe.
 *
 * A retry budget caps the multiplier at 1 + ratio, because it limits retries to
 * that share of original calls. That cap is the entire reason budgets exist: it
 * turns amplification from something that grows with the failure rate into
 * something bounded by configuration.
 */
export function retryMath(
  p: number,
  maxAttempts: number,
  budgetRatio: number | null
): { attempts: number; success: number; budgetBinding: boolean } {
  const n = Math.max(1, maxAttempts);
  const clamped = Math.min(Math.max(p, 0), 1);
  const unbudgeted =
    clamped >= 1 ? n : (1 - Math.pow(clamped, n)) / (1 - clamped);
  const success = 1 - Math.pow(clamped, n);

  if (budgetRatio === null) {
    return { attempts: unbudgeted, success, budgetBinding: false };
  }
  const cap = 1 + budgetRatio;
  if (unbudgeted <= cap) {
    return { attempts: unbudgeted, success, budgetBinding: false };
  }
  // Budget-limited: only `cap` attempts per call on average, so the effective
  // success rate falls back towards what a smaller attempt count would achieve.
  const effectiveAttempts = cap;
  const effectiveSuccess = 1 - Math.pow(clamped, effectiveAttempts);
  return { attempts: effectiveAttempts, success: effectiveSuccess, budgetBinding: true };
}

/**
 * Expected total backoff a caller waits across its retries.
 *
 * Approximate on purpose: the exact figure depends on which attempt succeeded, and
 * the difference is small next to the attempts themselves. Included at all because
 * omitting it would understate how long a retrying caller holds its slot.
 */
function expectedBackoffMs(edge: SdsEdge, expectedAttempts: number): number {
  const retry = edge.policy.retry;
  if (!retry) return 0;
  const b = retry.backoff;
  const retries = Math.max(0, expectedAttempts - 1);
  if (retries === 0 || b.kind === "none") return 0;
  let total = 0;
  for (let i = 1; i <= Math.ceil(retries); i++) {
    const raw = b.kind === "fixed" ? b.baseMs : Math.min(b.maxMs, b.baseMs * Math.pow(2, i - 1));
    // Full jitter halves the expected delay.
    total += (b.jitter ? raw / 2 : raw) * Math.min(1, retries - (i - 1));
  }
  return total;
}

/**
 * Probability a single attempt on this edge fails.
 *
 * Three independent sources, which multiply:
 *   - the message is dropped in transit
 *   - the dependency (or anything below it) returns a failure
 *   - the attempt exceeds its own timeout
 *
 * The third term is the one that matters near saturation and the one that is easy
 * to omit: a dependency at 95% utilization succeeds almost every time it is allowed
 * to finish, and times out constantly. Omitting it makes the preview blind to
 * exactly the retry amplification that causes storms.
 */
function attemptFailureProbability(
  edge: SdsEdge,
  previews: Map<string, NodePreview>,
  successProb: Map<string, number>,
  classId: string
): number {
  const delivered = 1 - edge.network.lossProbability;
  const downstreamSuccess = successProb.get(key(edge.to, classId)) ?? 1;

  let completesInTime = 1;
  const timeout = edge.policy.timeoutMs;
  if (timeout !== null) {
    const target = previews.get(edge.to);
    const survival = target?.survivalAt;
    if (survival) {
      // Budget excludes the two network legs, which the attempt also has to fit in.
      const netMs = meanNetworkRoundTripMs(edge.network);
      completesInTime = 1 - survival(Math.max(0, timeout - netMs));
    }
  }

  return Math.min(1, Math.max(0, 1 - delivered * downstreamSuccess * completesInTime));
}

/** Load-independent failure probability declared on a station. */
function stationFailureProbability(node: SdsNode): number {
  if (node.kind === "server") return node.server!.failureProbability;
  if (node.kind === "database") return node.database!.failureProbability;
  if (node.kind === "lock") return node.lock!.failureProbability;
  return 0;
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
  const durationMs = design.scenario.durationSec * 1000;
  const topologyOrder = topoOrder(design);
  const order = topologyOrder.order;
  const classes = classesOf(design);
  const totalWeight = classes.reduce((s, c) => s + c.weight, 0);
  const notes: string[] = [];
  if (design.scenario.failures.length > 0) {
    notes.push(
      "the closed-form preview represents the healthy baseline and does not average failure-timeline windows; run the deterministic simulation to measure them"
    );
  }
  if (topologyOrder.boundedFeedback) {
    notes.push(
      "expected load through asynchronous feedback is expanded only to each link's explicit hop budget; general liveness is out of scope"
    );
  }

  /**
   * FIXED-POINT ITERATION.
   *
   * Retries make the graph circular in a way the topology does not show: load on a
   * dependency depends on its failure rate, its failure rate depends on its load,
   * and retries connect the two. A single forward pass cannot solve that, so the
   * two passes are iterated until arrival rates stop moving.
   *
   * When the loop has positive gain -- each round of retries causing more failures
   * than it recovers -- the iteration diverges, and that divergence is not a
   * numerical nuisance. It IS the retry storm. Reporting non-convergence is more
   * honest than capping the numbers and presenting a fixed point that does not
   * exist.
   */
  const MAX_ITERATIONS = 60;
  const CONVERGENCE_TOLERANCE = 1e-4;

  /** Expected attempts per call on each edge, updated each iteration. */
  const attemptMultiplier = new Map<string, number>();
  /** Probability a call succeeds after retries, per edge. */
  const retrySuccess = new Map<string, number>();

  let lambdaIn = new Map<string, number>();
  let previews = new Map<string, NodePreview>();
  let successProb = new Map<string, number>();
  let anyApproximate = false;
  let anyForkJoin = false;
  let asyncBacklogWarning: string | null = null;
  let converged = false;
  let iterations = 0;
  let boundedPropagationTruncated = false;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    iterations = iteration;
    const previousLambda = lambdaIn;

    // ---- forward pass: arrival rates per (node, class) ----
    lambdaIn = new Map<string, number>();
    const bump = (nodeId: string, classId: string, amount: number) => {
      const k = key(nodeId, classId);
      lambdaIn.set(k, (lambdaIn.get(k) ?? 0) + amount);
    };

    if (topologyOrder.boundedFeedback) {
      const bounded = boundedArrivalRates(
        design,
        classes,
        totalWeight,
        durationMs,
        attemptMultiplier
      );
      lambdaIn = bounded.lambdaIn;
      boundedPropagationTruncated ||= bounded.truncated;
    } else {
      for (const id of order) {
        const node = byId.get(id);
        if (!node) continue;

        for (const cls of classes) {
          let outbound: number;
          if (node.kind === "client") {
            // Time-average rate: for a ramp or a spike the closed form can only speak
            // about the average regime, which is stated in the notes below.
            const rate = node.client ? meanRate(node.client.arrival, durationMs) : 0;
            outbound = rate * (totalWeight > 0 ? cls.weight / totalWeight : 0);
          } else {
            outbound = lambdaIn.get(key(id, cls.id)) ?? 0;
            // Only cache MISSES continue to the origin.
            if (node.kind === "cache") outbound *= 1 - analyticHitRatio(node);
          }
          if (outbound <= 0) continue;

          for (const { edge, share } of routeShares(design, node, cls.id)) {
            // Retries multiply the load the dependency actually sees. This is the term
            // that closes the feedback loop, and the reason a single pass is not enough.
            const multiplier = attemptMultiplier.get(edge.id) ?? 1;
            // Fan-out multiplies the load a dependency sees, and by far the larger factor
            // in a realtime design: a room of twenty turns one message into twenty
            // deliveries. Omitting it would understate delivery load by the room size.
            bump(
              edge.to,
              cls.id,
              outbound * share * multiplier * edge.fanoutFactor * (1 - edge.network.lossProbability)
            );
          }
        }
      }
    }

    // ---- backward pass: effective service and response time ----
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
    successProb = new Map<string, number>();

    for (const id of [...order].reverse()) {
      const node = byId.get(id);
      if (!node || node.kind === "client") continue;

      /** Expected time this node spends waiting on dependencies, per class. */
      const dependencyMs = new Map<string, number>();
      for (const cls of classes) {
        const routes = routeShares(design, node, cls.id).filter(
          ({ edge }) => edge.semantics.kind === "synchronous"
        );
        if (routes.length === 0) {
          dependencyMs.set(cls.id, 0);
          continue;
        }
        const legs = routes.map(({ edge, share }) => {
          // Both directions cross the wire.
          const net = meanNetworkRoundTripMs(edge.network);
          const downstream = responseMs.get(key(edge.to, cls.id)) ?? 0;
          // A retrying caller holds its slot across every attempt plus the backoff
          // between them. That inflation is why retries hurt the CALLER as well as
          // the dependency, and it is easy to miss.
          const attempts = attemptMultiplier.get(edge.id) ?? 1;
          const backoff = expectedBackoffMs(edge, attempts);
          return { cost: attempts * (net + downstream) + backoff, share };
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

      const preview = solveStation(
      node,
      classes,
      totalWeight,
      lambdaIn,
      dependencyMs,
      holdsSlot,
      design
    );
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

        // Survival through this node and everything it calls. Station failure is
        // independent of queueing failure, so the two multiply.
        const ownFailure = stationFailureProbability(node);
        const survivesHere = (1 - preview.blockingProbability) * (1 - ownFailure);
        const routes = routeShares(design, node, cls.id);
        let downstreamSurvival = 1;

        if (node.kind === "queue") {
          // Consumers run detached; a publish succeeding does not depend on them.
          downstreamSurvival = 1;
        } else if (node.kind === "loadbalancer") {
          downstreamSurvival = routes.reduce((s, r) => {
            if (r.edge.semantics.kind === "asynchronous") return s + r.share;
            const raw =
              (1 - r.edge.network.lossProbability) *
              (successProb.get(key(r.edge.to, cls.id)) ?? 1);
            return s + r.share * (retrySuccess.get(r.edge.id) ?? raw);
          }, 0);
        } else if (node.kind === "cache") {
          const h = analyticHitRatio(node);
          const originSurvival = routes.reduce((s, r) => {
            if (r.edge.semantics.kind === "asynchronous") return s;
            const raw =
              (1 - r.edge.network.lossProbability) *
              (successProb.get(key(r.edge.to, cls.id)) ?? 1);
            return s * (retrySuccess.get(r.edge.id) ?? raw);
          }, 1);
          downstreamSurvival = h + (1 - h) * originSurvival;
        } else {
          // Every branch that is taken must succeed; a branch not taken cannot fail.
          downstreamSurvival = routes.reduce((s, r) => {
            if (r.edge.semantics.kind === "asynchronous") return s;
            const raw =
              (1 - r.edge.network.lossProbability) *
              (successProb.get(key(r.edge.to, cls.id)) ?? 1);
            // Retries recover some failures, so the caller sees a better success rate
            // than one attempt would give.
            const ifTaken = retrySuccess.get(r.edge.id) ?? raw;
            return s * (r.share * ifTaken + (1 - r.share));
          }, 1);
        }

        successProb.set(key(node.id, cls.id), survivesHere * downstreamSurvival);
      }
    }


    // ---- update the retry feedback terms ----
    let maxDelta = 0;
    for (const e of design.edges) {
      const retry = e.policy.retry;
      const attemptFailure = attemptFailureProbability(e, previews, successProb, classes[0]!.id);

      const math = retry
        ? retryMath(attemptFailure, retry.maxAttempts, retry.budgetRatio)
        : { attempts: 1, success: 1 - attemptFailure, budgetBinding: false };

      const previous = attemptMultiplier.get(e.id) ?? 1;
      // Damped update: an undamped one oscillates badly near the stability edge and
      // can report divergence for a system that does have a fixed point.
      const next = previous + 0.5 * (math.attempts - previous);
      attemptMultiplier.set(e.id, next);
      retrySuccess.set(e.id, math.success);
      maxDelta = Math.max(maxDelta, Math.abs(next - previous));
    }

    // Convergence is judged on arrival rates, the quantity everything else derives
    // from.
    let lambdaDelta = 0;
    for (const [k, v] of lambdaIn) {
      const before = previousLambda.get(k) ?? 0;
      const scale = Math.max(1, Math.abs(v), Math.abs(before));
      lambdaDelta = Math.max(lambdaDelta, Math.abs(v - before) / scale);
    }

    if (iteration > 1 && lambdaDelta < CONVERGENCE_TOLERANCE && maxDelta < CONVERGENCE_TOLERANCE) {
      converged = true;
      break;
    }
  }

  if (boundedPropagationTruncated) {
    converged = false;
    notes.push(
      "bounded feedback expanded beyond 100,000 path states; the closed-form preview is incomplete, so use deterministic simulation for this topology"
    );
  }

  const nodes = design.nodes
    .filter((n) => n.kind !== "client")
    .map((n) => previews.get(n.id))
    .filter((p): p is NodePreview => Boolean(p));

  // A saturated async queue does not make requests slow, so it must not make the
  // whole design "unstable" -- it gets its own warning instead.
  const stable = nodes.every((n) => n.kind === "queue" || n.stable);

  /**
   * Blame the cause, not the victim.
   *
   * A blocking caller whose dependency has no steady state inherits an infinite
   * effective service time, and infinity beats every finite rho. Comparing rho
   * naively therefore points at the caller and says its capacity is 0/s, which is
   * both useless and wrong: the thing to fix is downstream. So stations whose
   * saturation is inherited are considered only if nothing else is saturated.
   */
  const rootCauses = nodes.filter((n) => n.saturationCause !== "dependency");
  const candidates = rootCauses.length > 0 ? rootCauses : nodes;

  let bottleneckNodeId: string | null = null;
  let bottleneckUtilization = 0;
  for (const n of candidates) {
    // Compare on rho, not utilization: a shedding station pins utilization near
    // 1 while rho keeps rising, and rho is what says how far past capacity it is.
    if (n.rho > bottleneckUtilization) {
      bottleneckUtilization = n.rho;
      bottleneckNodeId = n.nodeId;
    }
  }

  const inherited = nodes.filter((n) => n.saturationCause === "dependency");
  if (inherited.length > 0 && bottleneckNodeId !== null) {
    notes.push(
      `${inherited.map((n) => `"${n.label}"`).join(", ")} ` +
        `${inherited.length === 1 ? "is" : "are"} saturated as a consequence, not a cause: ` +
        `holding a slot while waiting on a dependency that has no steady state. Fix the ` +
        `bottleneck first.`
    );
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
      const rate = client.client ? meanRate(client.client.arrival, durationMs) : 0;
      const share = totalWeight > 0 ? cls.weight / totalWeight : 0;
      offered += rate * share;
      for (const { edge } of routeShares(design, client, cls.id).filter(
        ({ edge }) => edge.semantics.kind === "synchronous"
      )) {
        const target = previews.get(edge.to);
        survival *=
          (1 - edge.network.lossProbability) * (successProb.get(key(edge.to, cls.id)) ?? 1);
        if (!target || latency === null) {
          latency = null;
          continue;
        }
        if (!target.stable && target.kind !== "queue") {
          latency = null;
          continue;
        }
        latency += meanNetworkRoundTripMs(edge.network) + target.wMs;
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

  // ---- retry summary ----
  const edgePreviews: EdgePreview[] = design.edges.map((e) => {
    const retry = e.policy.retry;
    const attemptFailure = attemptFailureProbability(e, previews, successProb, classes[0]!.id);
    const math = retry
      ? retryMath(attemptFailure, retry.maxAttempts, retry.budgetRatio)
      : { attempts: 1, success: 1 - attemptFailure, budgetBinding: false };
    return {
      edgeId: e.id,
      from: e.from,
      to: e.to,
      amplification: attemptMultiplier.get(e.id) ?? math.attempts,
      attemptFailureProbability: attemptFailure,
      successProbability: math.success,
      maxAttempts: retry?.maxAttempts ?? 1,
      budgetRatio: retry?.budgetRatio ?? null,
      budgetBinding: math.budgetBinding,
    };
  });

  // Weight by predicted load: an amplified edge carrying no traffic is not a storm.
  let weightedAttempts = 0;
  let weightedCalls = 0;
  for (const e of edgePreviews) {
    const load = classes.reduce((sum, c) => sum + (lambdaIn.get(key(e.to, c.id)) ?? 0), 0);
    if (load <= 0) continue;
    weightedCalls += load;
    weightedAttempts += load * e.amplification;
  }
  const retryAmplification = weightedCalls > 0 ? weightedAttempts / weightedCalls : 1;

  const worstEdge = edgePreviews.reduce<EdgePreview | null>(
    (worst, e) => (!worst || e.amplification > worst.amplification ? e : worst),
    null
  );
  let retryStormWarning: string | null = null;
  if (worstEdge && worstEdge.amplification > RETRY_AMPLIFICATION_THRESHOLD) {
    const fromLabel = byId.get(worstEdge.from)?.label ?? worstEdge.from;
    const toLabel = byId.get(worstEdge.to)?.label ?? worstEdge.to;
    retryStormWarning =
      `retries on "${fromLabel}" \u2192 "${toLabel}" multiply load by ` +
      `${worstEdge.amplification.toFixed(2)}x, because ` +
      `${(worstEdge.attemptFailureProbability * 100).toFixed(0)}% of attempts fail. ` +
      (worstEdge.budgetRatio === null
        ? "There is no retry budget capping this."
        : worstEdge.budgetBinding
          ? `The ${(worstEdge.budgetRatio * 100).toFixed(0)}% budget is holding it down.`
          : `The ${(worstEdge.budgetRatio * 100).toFixed(0)}% budget is not binding yet.`);
  }

  if (!converged) {
    notes.push(
      "retry feedback has no fixed point: each round of retries causes more failures than it recovers, so load diverges. This is a retry storm, not a numerical problem."
    );
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
    if (n.connections && n.connections.refused > 0) {
      notes.push(
        `"${n.label}" will refuse ${Math.round(n.connections.refused).toLocaleString()} connections: ` +
          `${Math.round(n.connections.held + n.connections.refused).toLocaleString()} offered against ` +
          `${n.connections.capacity.toLocaleString()} of capacity. A refused connection is a hard ` +
          `failure, not a slow response.`
      );
    }
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
    edges: edgePreviews,
    retryAmplification,
    retryStormWarning,
    converged,
    iterations,
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
    for (const { edge } of routeShares(design, client, cls.id).filter(
      ({ edge }) => edge.semantics.kind === "synchronous"
    )) {
      const target = previews.get(edge.to);
      if (!target || target.p99Ms === null) return null;
      return target.p99Ms + meanNetworkRoundTripMs(edge.network);
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
/**
 * Connections a gateway will hold, and whether it can.
 *
 * Distribution across gateways is assumed even, which is what a connection-aware
 * balancer achieves and what sticky hashing approximates. Accept rate follows from
 * Little's Law inverted: holding N connections with sessions of length S means
 * N/S handshakes per second, forever. That figure is easy to forget and it is the load
 * a reconnect storm multiplies.
 */
function gatewayConnections(node: SdsNode, design: Design): NodePreview["connections"] {
  const cfg = node.gateway!;
  const capacity = cfg.connectionCapacity * cfg.replicas;

  // Populations whose connections can reach this gateway.
  const gateways = design.nodes.filter((n) => n.kind === "gateway" && n.gateway);
  const totalCapacity = gateways.reduce(
    (s, g) => s + g.gateway!.connectionCapacity * g.gateway!.replicas,
    0
  );
  const offered = design.nodes.reduce((s, n) => s + (n.client?.connections?.count ?? 0), 0);
  // Share proportional to capacity, which is what an even spread produces.
  const share = totalCapacity > 0 ? capacity / totalCapacity : 0;
  const wanted = offered * share;
  const held = Math.min(capacity, wanted);
  const refused = Math.max(0, wanted - capacity);

  // Churn: each session that ends is a handshake for someone to pay for.
  let acceptRatePerSec = 0;
  for (const n of design.nodes) {
    const pop = n.client?.connections;
    if (!pop) continue;
    if (pop.sessionDuration === null) continue;
    const sessionSec = distMean(pop.sessionDuration) / 1000;
    if (sessionSec > 0) acceptRatePerSec += (pop.count * share) / sessionSec;
  }

  return {
    capacity,
    held,
    utilization: capacity > 0 ? held / capacity : 0,
    refused,
    acceptRatePerSec,
    memoryMb: (held * cfg.memoryPerConnectionKb) / 1024,
  };
}

function solveStation(
  node: SdsNode,
  classes: RequestClass[],
  totalWeight: number,
  lambdaIn: Map<string, number>,
  dependencyMs: Map<string, number>,
  holdsSlot: boolean,
  design: Design
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
  /** True when a dependency's lack of a steady state made this station's demand infinite. */
  const inheritedSaturation = !Number.isFinite(effectiveServiceMeanMs);
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
      survivalAt: null,
      saturationCause: load >= 1 ? "own" : null,
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

  // ---- gateway: connections are a separate constraint from throughput ----
  //
  // Connections held follow Little's Law exactly: a population reconnecting every
  // session-length holds (accept rate x session length) descriptors. That is the same
  // L = lambda x W identity the engine checks on requests, applied to a resource whose
  // service time is measured in minutes.

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
    case "gateway":
      c = node.gateway!.pushConcurrency * node.gateway!.replicas;
      break;
    case "lock": {
      // A lock service is a plain station in the closed form. Its interesting
      // behaviour -- leases expiring under a holder still working -- is a state
      // property, and no queueing formula can see it. The preview therefore models
      // only its cost, and the correctness explorer answers the other question.
      const cfg = node.lock!;
      c = cfg.concurrency;
      queueCapacity = cfg.queueCapacity;
      admission = cfg.admissionPolicy;
      break;
    }
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
    connections: node.kind === "gateway" ? gatewayConnections(node, design) : undefined,
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
      survivalAt: null,
      saturationCause: inheritedSaturation ? "dependency" : null,
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
      survivalAt: detachedDependencyMs > 0 ? null : s.survivalAt,
      saturationCause: s.stable ? null : inheritedSaturation ? "dependency" : "own",
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
    survivalAt: null,
    saturationCause: stationStable ? null : inheritedSaturation ? "dependency" : "own",
    model: c === 1 ? "M/G/1" : "M/G/c (approx)",
    approximate: c !== 1 || holdsSlotForDependencies,
    caveat: compositeCaveat,
  };
}

function ownServiceMs(node: SdsNode): number {
  switch (node.kind) {
    case "gateway":
      return distMean(node.gateway!.pushTime);
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
    case "lock":
      return distMean(node.lock!.serviceTime);
    default:
      return 0;
  }
}

function scvOf(node: SdsNode): number {
  switch (node.kind) {
    case "gateway":
      return distScv(node.gateway!.pushTime);
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
    case "lock":
      return distScv(node.lock!.serviceTime);
    default:
      return 1;
  }
}
