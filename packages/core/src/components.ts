import type { Design, NodeKind, SdsEdge, SdsNode } from "@sds/schema";
import { CallSite } from "./callsite";
import { mean as distMean, sample, scv } from "./distribution";
import { LatencyHistogram } from "./histogram";
import { Resource } from "./resource";
import type { RngBundle } from "./rng";
import { Sim, acquire, delay, suspend, type Process } from "./sim";
import { TimeSeries } from "./timeseries";
import { ZipfSampler } from "./zipf";
import type {
  CacheMetrics,
  ConnectionMetrics,
  InvariantReport,
  DatabaseMetrics,
  ErrorReason,
  LatencySummary,
  LoadBalancerMetrics,
  LockMetrics,
  NodeResult,
  QueueMetrics,
  SeriesData,
} from "./result";

export interface Outcome {
  ok: boolean;
  reason?: ErrorReason;
}

const OK: Outcome = { ok: true };

/** Per-request state that travels with a request through the graph. */
export interface RequestCtx {
  requestId: number;
  classId: string;
  /** Scales service demand at every station this request visits. */
  serviceMultiplier: number;
  /** Absolute simulated time the client gives up, or null. */
  deadlineAt: number | null;
  traced: boolean;
  /**
   * Generated domain fields for this request: user id, claim id, idempotency key.
   *
   * Absent for designs with no workflow, which is every design that existed before state
   * arrived. Present and STABLE ACROSS RETRIES for the fields declared as derived from
   * request content -- that stability is the whole mechanism by which an idempotent
   * handler recognises a retry, so it is generated once per logical request rather than
   * per attempt.
   */
  domain?: Record<string, string | number | boolean>;
}

export interface TraceSink {
  hop(
    requestId: number,
    edgeId: string,
    tStart: number,
    tEnd: number,
    delivered: boolean,
    forward: boolean
  ): void;
  visit(
    requestId: number,
    nodeId: string,
    tEnqueue: number,
    tServiceStart: number | null,
    tExit: number,
    outcome: "served" | "shed" | "timeout" | "hit" | "miss" | "error"
  ): void;
  canTrace(): boolean;
}

export interface ComponentEnv {
  sim: Sim;
  rng: RngBundle;
  design: Design;
  components: Map<string, Component>;
  outgoing: Map<string, SdsEdge[]>;
  /** Per-edge failure-policy state, keyed by edge id. */
  callSites: Map<string, CallSite>;
  /**
   * Attempts made across each edge, keyed by edge id.
   *
   * Counted for EVERY edge, not just ones with a policy, because critical-path
   * attribution needs the real traversal count per edge. Inferring it from the
   * destination's visit count double-counts whenever several edges share a target:
   * three services calling one cache would each be credited with the cache's full
   * traffic, and the network share would come out three times too large.
   */
  edgeTraversals: Map<string, number>;
  trace: TraceSink;
  /** True once warm-up is over. Components record nothing before that. */
  measuring: () => boolean;
  /**
   * Stateful workflow execution, when the design declares one.
   *
   * Typed loosely here to avoid a cycle: `workflow.ts` imports `ComponentEnv`, and the
   * server component needs to invoke the runtime. The narrow interface is the whole
   * contract between the two, and keeping it narrow is what stops the workflow layer
   * from growing tendrils into every component.
   */
  workflow?: WorkflowHost;
}

/** The part of the workflow runtime a component is allowed to see. */
export interface WorkflowHost {
  handlesRoot(nodeId: string): boolean;
  setHandlerNode(nodeId: string): void;
  runRoot(ctx: RequestCtx): Process<Outcome>;
}

/**
 * A held connection.
 *
 * Carries its own revocation state so a forced drop and a graceful close cannot both
 * release the same descriptor. An earlier version had the gateway release slots
 * directly on a fault while the holding processes were still parked on their session
 * timers; those processes then closed a connection that no longer existed, the
 * descriptor count was decremented twice, and the reconnect storm never happened
 * because nobody was told their connection had gone.
 */
export interface ConnectionToken {
  revoked: boolean;
  /** Invoked by the gateway when the connection is dropped by a fault. */
  onRevoke: (() => void) | null;
}

/** Outcome of trying to establish a long-lived connection. */
export interface ConnectResult {
  held: boolean;
  reason?: ErrorReason;
  /** Time spent waiting for and completing the handshake, ms. */
  acceptMs: number;
  /** Present only when `held`. Pass back to `disconnect`. */
  token?: ConnectionToken;
}

export interface Component {
  readonly node: SdsNode;
  handle(ctx: RequestCtx): Process<Outcome>;
  /**
   * Establish a long-lived connection, if this component can hold one.
   *
   * Separate from `handle` because the lifecycle is inverted. A request is handled and
   * departs within the call; a connection is acquired here, held by the CALLER for as
   * long as the session lasts, and released later. Only a gateway implements it.
   */
  connect?(ctx: RequestCtx): Process<ConnectResult>;
  /** Release a previously held connection. A no-op if it was already revoked. */
  disconnect?(token: ConnectionToken): void;
  /**
   * Forcibly close up to `count` held connections, returning how many were closed.
   *
   * Models an instance failing or being restarted. The clients holding those
   * connections then come back through accept, which is the reconnect storm.
   */
  dropConnections?(count: number): number;
  /** Requests currently queued or in service. Used by load-balancer algorithms. */
  load(): number;
  /** Instantaneous state for session snapshots; unlike metrics, this is not averaged. */
  occupancy(): ComponentOccupancy;
  resetStats(): void;
  sample(tSec: number): void;
  result(observedSec: number): NodeResult;
  /**
   * Exact conservation checks, reported on every run.
   *
   * Lives on the component rather than being reconstructed from `NodeResult`
   * because the identity needs occupancy at the warm-up boundary, which the
   * result type does not carry. An earlier version tried to reconstruct it and
   * produced a check that failed on correct runs -- a false alarm is as damaging
   * to trust as a missed one.
   */
  invariants(): InvariantReport[];
  /** Long-running processes this component needs (queue consumers). */
  processes?(): Process<void>[];
}

export interface ComponentOccupancy {
  queued: number;
  inService: number;
  total: number;
}

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

function series(ts: TimeSeries): SeriesData {
  return { name: ts.name, points: ts.values().map((p) => ({ t: p.t, value: p.value })) };
}

function summarize(h: LatencyHistogram): LatencySummary {
  return {
    count: h.count,
    mean: h.mean,
    min: h.min,
    max: h.max,
    relativeError: h.relativeError,
    ...h.percentiles(),
  };
}

/** Service times must advance the clock, or an empty-service loop never ends. */
const MIN_SERVICE_MS = 1e-9;

/**
 * Everything a capacity-limited component shares: a resource, sampled service
 * time, occupancy series, and residency measurement.
 */
abstract class StationComponent implements Component {
  protected readonly resource: Resource;
  protected readonly queueSeries: TimeSeries;
  protected readonly utilSeries: TimeSeries;
  protected readonly residency = new LatencyHistogram();
  /**
   * Time attributable to THIS station: its own queue wait plus its own service.
   *
   * Deliberately excludes time spent waiting on dependencies, even though a
   * blocking station holds its slot throughout. Residency and self time diverge
   * exactly where a station blocks on a dependency, and both numbers are needed
   * for different questions:
   *
   *   residency answers "how long is a slot tied up here" -- the capacity question
   *   self time answers "how much of the end-to-end latency is this station's fault"
   *
   * Critical-path attribution needs the second. Using residency instead would
   * double-count: a caller's residency already contains its dependency's residency,
   * so the shares would sum to far more than 100% and the deepest station would be
   * blamed once for every layer above it.
   */
  protected readonly selfTime = new LatencyHistogram();
  private lastBusyIntegral = 0;
  private lastSampleT = 0;

  constructor(
    readonly node: SdsNode,
    protected readonly env: ComponentEnv,
    opts: {
      capacity: number;
      queueCapacity: number | null;
      discipline: "fifo" | "lifo";
      admissionPolicy: "shed" | "block";
    }
  ) {
    this.resource = new Resource(env.sim, {
      id: node.id,
      capacity: opts.capacity,
      queueCapacity: opts.queueCapacity,
      discipline: opts.discipline,
      admissionPolicy: opts.admissionPolicy,
    });
    this.queueSeries = new TimeSeries(`${node.id}.queueLength`);
    this.utilSeries = new TimeSeries(`${node.id}.utilization`);
  }

  abstract handle(ctx: RequestCtx): Process<Outcome>;
  protected abstract serviceMeanMs(): number;
  protected abstract serviceScv(): number;

  load(): number {
    return this.resource.inServiceCount + this.resource.queueLength;
  }

  occupancy(): ComponentOccupancy {
    const queued = this.resource.queueLength;
    const inService = this.resource.inServiceCount;
    return { queued, inService, total: queued + inService };
  }

  resetStats(): void {
    this.resource.resetStats();
    this.queueSeries.reset();
    this.utilSeries.reset();
    this.residency.reset();
    this.selfTime.reset();
    this.lastBusyIntegral = 0;
    this.lastSampleT = this.env.sim.now;
  }

  sample(tSec: number): void {
    this.queueSeries.push(tSec, this.resource.queueLength);
    const s = this.resource.stats();
    const busy = s.utilization * s.observedMs * this.resource.capacity;
    const dt = this.env.sim.now - this.lastSampleT;
    const windowUtil = dt > 0 ? (busy - this.lastBusyIntegral) / (dt * this.resource.capacity) : 0;
    this.utilSeries.push(tSec, Math.max(0, Math.min(1, windowUtil)));
    this.lastBusyIntegral = busy;
    this.lastSampleT = this.env.sim.now;
  }

  protected recordResidency(enteredAt: number): void {
    if (this.env.measuring()) this.residency.record(this.env.sim.now - enteredAt);
  }

  /** Queue wait plus own service, excluding any dependency call. */
  protected recordSelfTime(waitMs: number, serviceMs: number): void {
    if (this.env.measuring()) this.selfTime.record(Math.max(0, waitMs + serviceMs));
  }

  /**
   * Failure probability at this instant, interpolated from the station's own load.
   *
   * Real services fail more when overloaded -- memory pressure, connection limits,
   * timeouts inside code the model does not represent. That correlation is what gives
   * a cascade positive gain: load raises failures, failures raise retries, retries
   * raise load. With a constant failure rate the loop has no gain at all and the
   * worst outcome is a linear slowdown.
   *
   * Read from INSTANTANEOUS occupancy rather than the time-averaged utilization,
   * because the effect is meant to bite during a burst rather than after one.
   *
   * Load EXCLUDES the request being served and INCLUDES the queue. Both matter:
   *
   *   Counting itself would put a floor of 1/capacity under the pressure term, so a
   *   single-slot station would always look fully loaded and a 4-slot one would never
   *   read below 25%. At low utilization that inflates the failure rate several-fold,
   *   for a station that is in fact nearly idle.
   *
   *   Counting the queue matters because a station with every slot busy and forty
   *   requests waiting is under far more pressure than the same station with nothing
   *   waiting, and the failure mechanisms being modelled -- memory, connections,
   *   internal timeouts -- track the backlog rather than just the workers.
   */
  protected failureProbabilityNow(base: number, atSaturation: number | null): number {
    if (atSaturation === null) return base;
    const others = this.resource.inServiceCount - 1 + this.resource.queueLength;
    const busy = Math.min(1, Math.max(0, others / Math.max(1, this.resource.capacity)));
    return base + (atSaturation - base) * busy;
  }

  /**
   * Exact conservation identities for one resource.
   *
   *   arrivals + queued-at-start   == admitted + shed + abandoned + queued-now
   *   admitted + in-service-at-start == completed + in-service-now
   *
   * The boundary terms are not optional. Measurement begins at the warm-up
   * boundary with requests already queued and in service, so the naive forms are
   * simply false through no fault of the engine.
   */
  protected resourceInvariant(resource: Resource, label: string): InvariantReport {
    const s = resource.stats();
    const queueLhs = s.arrivals + s.queuedAtStart;
    const queueRhs = s.admitted + s.shed + s.abandoned + s.currentQueueLength;
    const serviceLhs = s.admitted + s.inServiceAtStart;
    const serviceRhs = s.completed + s.currentInService;
    const passed = queueLhs === queueRhs && serviceLhs === serviceRhs;
    return {
      name: `${label} bookkeeping`,
      passed,
      detail: passed
        ? `queue balance ${queueLhs} = ${queueRhs}; service balance ${serviceLhs} = ${serviceRhs}`
        : `queue balance ${queueLhs} vs ${queueRhs}; service balance ${serviceLhs} vs ${serviceRhs}`,
    };
  }

  invariants(): InvariantReport[] {
    return [this.resourceInvariant(this.resource, `station "${this.node.label}"`)];
  }

  result(observedSec: number): NodeResult {
    const s = this.resource.stats();
    return {
      nodeId: this.node.id,
      label: this.node.label,
      kind: this.node.kind,
      capacity: this.resource.capacity,
      utilization: s.utilization,
      avgQueueLength: s.avgQueueLength,
      maxQueueLength: s.maxQueueLength,
      avgInStation: s.avgInStation,
      arrivals: s.arrivals,
      admitted: s.admitted,
      shed: s.shed,
      abandoned: s.abandoned,
      completed: s.completed,
      avgWaitMs: s.admitted > 0 ? s.totalWaitMs / s.admitted : 0,
      serviceMeanMs: this.serviceMeanMs(),
      serviceScv: this.serviceScv(),
      arrivalRatePerSec: observedSec > 0 ? s.arrivals / observedSec : 0,
      residencyMs: summarize(this.residency),
      selfTimeMs: summarize(this.selfTime),
      visitsPerRequest: 0,
      queueLengthSeries: series(this.queueSeries),
      utilizationSeries: series(this.utilSeries),
    };
  }
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/** Edges from `node` that this request's class is allowed to use. */
function eligibleEdges(env: ComponentEnv, nodeId: string, ctx: RequestCtx): SdsEdge[] {
  const all = env.outgoing.get(nodeId) ?? [];
  return all.filter((e) => e.classes.length === 0 || e.classes.includes(ctx.classId));
}

/**
 * One attempt: cross the wire, invoke the target, cross back.
 *
 * BOTH DIRECTIONS COST NETWORK TIME.
 *
 * A request/response pair crosses the wire twice, so edge latency is applied
 * twice. This is why edge latency is documented as one-way: entering a round-trip
 * figure would double-count it.
 */
function* attemptCall(
  env: ComponentEnv,
  edge: SdsEdge,
  ctx: RequestCtx,
  deadlineAt: number | null
): Process<Outcome> {
  const netRng = env.rng.stream("network");
  const lossRng = env.rng.stream("failure");
  if (env.measuring()) {
    env.edgeTraversals.set(edge.id, (env.edgeTraversals.get(edge.id) ?? 0) + 1);
  }

  // ---- request leg ----
  const outStart = env.sim.now;
  const outWait = yield* delay(sample(edge.latency, netRng), deadlineAt);
  if (outWait.timedOut) {
    if (ctx.traced) env.trace.hop(ctx.requestId, edge.id, outStart, env.sim.now, false, true);
    return { ok: false, reason: "timeout" };
  }
  const droppedOut = lossRng.chance(edge.lossProbability);
  if (ctx.traced) {
    env.trace.hop(ctx.requestId, edge.id, outStart, env.sim.now, !droppedOut, true);
  }
  if (droppedOut) return { ok: false, reason: "network" };

  const target = env.components.get(edge.to);
  if (!target) return OK; // validated away upstream; nothing to call
  const outcome = yield* target.handle({ ...ctx, deadlineAt });
  if (!outcome.ok) return outcome;

  // ---- response leg ----
  const backStart = env.sim.now;
  const backWait = yield* delay(sample(edge.latency, netRng), deadlineAt);
  if (backWait.timedOut) {
    if (ctx.traced) env.trace.hop(ctx.requestId, edge.id, backStart, env.sim.now, false, false);
    return { ok: false, reason: "timeout" };
  }
  const droppedBack = lossRng.chance(edge.lossProbability);
  if (ctx.traced) {
    env.trace.hop(ctx.requestId, edge.id, backStart, env.sim.now, !droppedBack, false);
  }
  if (droppedBack) return { ok: false, reason: "network" };

  return OK;
}

/**
 * Make a call to a dependency, applying the caller's failure policies.
 *
 * ORDER MATTERS, AND THIS IS THE ORDER REAL CLIENTS USE:
 *
 *   1. Circuit breaker. If it is open the call fails immediately, without
 *      consuming a bulkhead slot or the caller's time. Failing fast is the entire
 *      point -- it returns the caller's worker instead of parking it on something
 *      already known to be broken.
 *   2. Bulkhead. Caps concurrent outstanding calls to this dependency, so a slow
 *      dependency cannot consume every worker the caller has.
 *   3. Per-attempt timeout, tightened against the client's end-to-end deadline.
 *      Whichever is sooner wins; a per-attempt timeout is what makes retrying
 *      possible, since a hung attempt would otherwise consume the whole budget.
 *   4. Retry with backoff, gated by the retry budget.
 *
 * The breaker sits outside the bulkhead and the bulkhead outside the retry loop,
 * because a rejection from either is the caller's own protection engaging -- and
 * retrying past your own protection defeats the mechanism that just fired.
 */
function* callThrough(env: ComponentEnv, edge: SdsEdge, ctx: RequestCtx): Process<Outcome> {
  const site = env.callSites.get(edge.id);
  // No policy state means no policies: take the plain path.
  if (!site) return yield* attemptCall(env, edge, ctx, ctx.deadlineAt);

  const measuring = env.measuring();
  site.enter(measuring);
  site.noteCall();

  let outcome: Outcome = { ok: false, reason: "error" };

  try {
    const maxAttempts = site.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // ---- 1. circuit breaker ----
      const admission = site.admit(measuring);
      if (!admission.allowed) {
        outcome = { ok: false, reason: "circuit-open" };
        return outcome;
      }

      // ---- 2. bulkhead ----
      let heldBulkhead = false;
      if (site.bulkhead) {
        const slot = yield* acquire(site.bulkhead, ctx.deadlineAt);
        if (!slot.granted) {
          site.noteBulkheadRejection(measuring);
          site.observe(false, admission.probe, measuring);
          outcome = {
            ok: false,
            reason: slot.reason === "timeout" ? "timeout" : "bulkhead-full",
          };
          return outcome;
        }
        heldBulkhead = true;
      }

      // ---- 3. per-attempt deadline ----
      const attemptTimeout = site.attemptTimeoutMs;
      const attemptDeadline =
        attemptTimeout === null
          ? ctx.deadlineAt
          : ctx.deadlineAt === null
            ? env.sim.now + attemptTimeout
            : Math.min(ctx.deadlineAt, env.sim.now + attemptTimeout);

      site.noteAttempt(measuring, attempt > 1);
      let attemptOutcome: Outcome;
      try {
        attemptOutcome = yield* attemptCall(env, edge, ctx, attemptDeadline);
      } finally {
        if (heldBulkhead) site.bulkhead!.release();
      }

      site.observe(attemptOutcome.ok, admission.probe, measuring);
      if (attemptOutcome.ok) {
        outcome = OK;
        return outcome;
      }
      outcome = attemptOutcome;

      // ---- 4. retry decision ----
      if (attempt >= maxAttempts) return outcome;
      if (!site.isRetryable(attemptOutcome.reason)) return outcome;
      if (!site.allowRetry(measuring)) return outcome;

      // The client's own deadline still applies: there is no point sleeping past it.
      if (ctx.deadlineAt !== null && env.sim.now >= ctx.deadlineAt) {
        outcome = { ok: false, reason: "timeout" };
        return outcome;
      }

      site.noteRetry();
      const backoff = site.backoffMs(attempt + 1, env.rng.stream("failure"));
      if (backoff > 0) {
        const waited = yield* delay(backoff, ctx.deadlineAt);
        if (waited.timedOut) {
          outcome = { ok: false, reason: "timeout" };
          return outcome;
        }
      }
    }
    return outcome;
  } finally {
    site.exit(outcome.ok, measuring);
  }
}

/**
 * Call every eligible dependency, honouring each edge's probability.
 *
 * Two modes, because the difference is architectural rather than incidental:
 * parallel is fork-join and costs `max(children)`, sequential costs `sum`. The
 * legacy engine called every downstream dependency of every node on every request,
 * unconditionally and always in parallel, which invented a workload the user never
 * described.
 */
function* callDependencies(
  env: ComponentEnv,
  nodeId: string,
  ctx: RequestCtx,
  fanout: "parallel" | "sequential"
): Process<Outcome> {
  const eligible = eligibleEdges(env, nodeId, ctx);
  if (eligible.length === 0) return OK;

  const routeRng = env.rng.stream("routing");
  const chosen = eligible.filter((e) => (e.probability >= 1 ? true : routeRng.chance(e.probability)));
  if (chosen.length === 0) return OK;

  /**
   * Expand fan-out into real, individual calls.
   *
   * A message to a room of fifty becomes fifty deliveries, each acquiring its own slot
   * and queueing independently. Charging one call fifty times the service time would
   * be far cheaper to simulate and would hide exactly the contention being modelled --
   * fifty deliveries compete with each other and with everything else, one long call
   * does not.
   *
   * The cost is that a fan-out run simulates far more work than its message rate
   * suggests. That is the honest price of the effect being real, and it is why the chat
   * examples use short scenarios.
   */
  const calls: Array<() => Process<Outcome>> = [];
  for (const e of chosen) {
    for (let i = 0; i < e.fanoutFactor; i++) {
      calls.push(() => callThrough(env, e, ctx));
    }
  }

  if (calls.length === 1) return yield* calls[0]!();

  if (fanout === "sequential") {
    for (const make of calls) {
      const outcome = yield* make();
      if (!outcome.ok) return outcome;
    }
    return OK;
  }

  const results = yield* env.sim.joinAll(calls.map((make) => make()));
  return results.find((r) => !r.ok) ?? OK;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/**
 * A service that does its own work and may call dependencies.
 *
 * IT HOLDS ITS SLOT ACROSS DEPENDENCY CALLS.
 *
 * This is the most consequential modelling decision in the file. A thread handling
 * a request keeps occupying its worker slot while it waits on a database or a
 * downstream service. That is precisely the mechanism by which a slow dependency
 * exhausts its caller's worker pool and a local slowdown becomes a system-wide
 * outage -- the single most common shape of a real cascading failure.
 *
 * A model that released the slot during I/O would show the dependency getting
 * slower and the caller staying healthy, which is the opposite of what happens.
 */
export class ServerComponent extends StationComponent {
  constructor(node: SdsNode, env: ComponentEnv) {
    const cfg = node.server!;
    super(node, env, {
      capacity: cfg.concurrency * cfg.replicas,
      queueCapacity: cfg.queueCapacity,
      discipline: cfg.queueDiscipline,
      admissionPolicy: cfg.admissionPolicy,
    });
  }

  protected serviceMeanMs(): number {
    return distMean(this.node.server!.serviceTime);
  }
  protected serviceScv(): number {
    return scv(this.node.server!.serviceTime);
  }

  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.server!;
    const env = this.env;
    const enqueuedAt = env.sim.now;

    const slot = yield* acquire(this.resource, ctx.deadlineAt);
    if (!slot.granted) {
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          null,
          env.sim.now,
          slot.reason === "shed" ? "shed" : "timeout"
        );
      }
      return { ok: false, reason: slot.reason ?? "timeout" };
    }

    const serviceStart = env.sim.now;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.resource.release();
    };

    try {
      const own = Math.max(
        MIN_SERVICE_MS,
        sample(cfg.serviceTime, env.rng.stream("service")) * ctx.serviceMultiplier
      );
      const served = yield* delay(own, ctx.deadlineAt);
      this.recordSelfTime(slot.waitedMs, env.sim.now - serviceStart);
      if (served.timedOut) {
        if (ctx.traced) {
          env.trace.visit(ctx.requestId, this.node.id, enqueuedAt, serviceStart, env.sim.now, "timeout");
        }
        return { ok: false, reason: "timeout" };
      }

      // Failure injected AFTER the work is done, not before: a server that fails
      // still consumed the capacity to discover that. Failing for free would make
      // an unhealthy dependency look cheap, which is the opposite of the truth and
      // would hide exactly the load a retry storm adds.
      const failureNow = this.failureProbabilityNow(
        cfg.failureProbability,
        cfg.failureAtSaturation
      );
      if (failureNow > 0 && env.rng.stream("failure").chance(failureNow)) {
        if (ctx.traced) {
          env.trace.visit(ctx.requestId, this.node.id, enqueuedAt, serviceStart, env.sim.now, "error");
        }
        return { ok: false, reason: "error" };
      }

      // A non-blocking runtime hands the slot back before waiting on I/O. A
      // thread-per-request server cannot, which is what makes it vulnerable to a
      // slow dependency.
      if (!cfg.blocksOnDependencies) release();

      /**
       * Either the workflow runs here, or generic dependency calls do.
       *
       * Not both, and the reason is that a workflow's operations NAME the stations they
       * hit -- a `conditionalWrite` on a collection stored at `db` calls `db`, and nothing
       * else. Also traversing every outgoing edge would double-charge the datastore: once
       * for the operation that actually happened and once for the topology's assumption
       * that a server calls everything downstream of it.
       *
       * The topology still matters: it supplies the network latency and the call policy
       * for each of those named hops, and it is still what puts the request on this
       * server in the first place.
       */
      const downstream =
        env.workflow?.handlesRoot(this.node.id) === true
          ? yield* this.runWorkflow(ctx)
          : yield* callDependencies(env, this.node.id, ctx, cfg.fanout);
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          serviceStart,
          env.sim.now,
          downstream.ok ? "served" : "timeout"
        );
      }
      return downstream;
    } finally {
      release();
      this.recordResidency(enqueuedAt);
    }
  }

  private *runWorkflow(ctx: RequestCtx): Process<Outcome> {
    const host = this.env.workflow!;
    host.setHandlerNode(this.node.id);
    return yield* host.runRoot(ctx);
  }
}

// ---------------------------------------------------------------------------
// load balancer
// ---------------------------------------------------------------------------

/** Passive health state for one backend. */
interface BackendHealth {
  successes: number;
  failures: number;
  ejectedUntil: number;
  ejections: number;
  ejectedMs: number;
  lastEjectStart: number;
  /**
   * Failure rate at the moment of the most recent ejection.
   *
   * Reported instead of the live rate, because observations are cleared on ejection
   * so a backend that was just ejected for failing 90% of the time would otherwise
   * display 0%. Showing the number that triggered the decision is what makes the
   * decision reviewable.
   */
  rateAtEjection: number;
}

export class LoadBalancerComponent extends StationComponent {
  private rrIndex = 0;
  private dispatched = new Map<string, number>();
  private dispatchTotal = 0;
  private health = new Map<string, BackendHealth>();
  private ejectionsWithheld = 0;
  private healthStart = 0;

  constructor(node: SdsNode, env: ComponentEnv) {
    const cfg = node.loadbalancer!;
    super(node, env, {
      capacity: cfg.concurrency,
      queueCapacity: null,
      discipline: "fifo",
      admissionPolicy: "block",
    });
  }

  protected serviceMeanMs(): number {
    return distMean(this.node.loadbalancer!.serviceTime);
  }
  protected serviceScv(): number {
    return scv(this.node.loadbalancer!.serviceTime);
  }

  override resetStats(): void {
    super.resetStats();
    this.dispatched = new Map();
    this.dispatchTotal = 0;
    this.ejectionsWithheld = 0;
    this.healthStart = this.env.sim.now;
    // Health observations are NOT cleared: which backends are currently ejected is
    // part of the steady state the warm-up was spent reaching.
    for (const h of this.health.values()) {
      h.successes = 0;
      h.failures = 0;
      h.ejections = 0;
      h.ejectedMs = 0;
      h.lastEjectStart = h.ejectedUntil > this.env.sim.now ? this.env.sim.now : 0;
    }
  }

  private healthOf(nodeId: string): BackendHealth {
    let h = this.health.get(nodeId);
    if (!h) {
      h = {
        successes: 0,
        failures: 0,
        ejectedUntil: 0,
        ejections: 0,
        ejectedMs: 0,
        lastEjectStart: 0,
        rateAtEjection: 0,
      };
      this.health.set(nodeId, h);
    }
    return h;
  }

  /**
   * Fold a lapsed ejection into the total ejected time.
   *
   * Ejection expiry is passive -- nothing fires when it happens -- so the elapsed
   * time is banked the next time anyone looks. Without this the reported ejected
   * fraction only ever reflects an ejection still in force at the moment the clock
   * stopped, which is close to useless.
   */
  private settleEjection(h: BackendHealth): void {
    if (h.lastEjectStart > 0 && h.ejectedUntil <= this.env.sim.now) {
      h.ejectedMs += Math.max(0, h.ejectedUntil - h.lastEjectStart);
      h.lastEjectStart = 0;
    }
  }

  /**
   * Backends currently eligible to receive traffic.
   *
   * If every backend has been ejected, traffic goes to all of them anyway. That is
   * not a fallback for tidiness -- it is the guard that stops health checking from
   * causing the outage it exists to prevent. Under a shared failure every backend
   * looks unhealthy at once, and routing to none of them converts a partial outage
   * into a total one.
   */
  private eligible(edges: SdsEdge[]): SdsEdge[] {
    const hc = this.node.loadbalancer!.healthCheck;
    if (!hc.enabled) return edges;
    const now = this.env.sim.now;
    const live = edges.filter((e) => {
      const h = this.healthOf(e.to);
      this.settleEjection(h);
      return h.ejectedUntil <= now;
    });
    return live.length > 0 ? live : edges;
  }

  /** Fold an outcome into a backend's health, ejecting it if it is now an outlier. */
  private observeBackend(nodeId: string, ok: boolean): void {
    const hc = this.node.loadbalancer!.healthCheck;
    if (!hc.enabled) return;
    const h = this.healthOf(nodeId);
    if (ok) h.successes++;
    else h.failures++;

    const total = h.successes + h.failures;
    if (total < hc.minimumRequests) return;
    const rate = h.failures / total;
    const now = this.env.sim.now;
    if (rate < hc.failureThreshold || h.ejectedUntil > now) return;

    // Respect the cap on how much capacity may be removed at once.
    const backends = this.env.outgoing.get(this.node.id) ?? [];
    const currentlyEjected = backends.filter((e) => this.healthOf(e.to).ejectedUntil > now).length;
    const maxEjected = Math.floor(backends.length * hc.maxEjectedFraction);
    if (currentlyEjected + 1 > maxEjected) {
      this.ejectionsWithheld++;
      return;
    }

    h.ejectedUntil = now + hc.ejectionMs;
    h.lastEjectStart = now;
    h.ejections++;
    h.rateAtEjection = rate;
    // Observations reset on ejection so the backend is judged afresh when it
    // returns, rather than being re-ejected instantly on its old record.
    h.successes = 0;
    h.failures = 0;
  }

  /**
   * Pick one backend.
   *
   * The algorithm is not a detail. Random assignment to n queues gives a maximum
   * load of about log n / log log n above average; sampling two and taking the
   * shorter drops that to log log n. One extra probe buys an exponential
   * improvement -- the "power of two choices" result -- and a model that only
   * implements round-robin cannot show it.
   *
   * Round-robin ignores edge weights here; weighted round-robin is not modelled,
   * and the other three use load/weight so a heavier backend absorbs more.
   */
  private select(edges: SdsEdge[]): SdsEdge {
    const cfg = this.node.loadbalancer!;
    const rng = this.env.rng.stream("routing");

    if (edges.length === 1) return edges[0]!;

    switch (cfg.algorithm) {
      case "round-robin": {
        const edge = edges[this.rrIndex % edges.length]!;
        this.rrIndex++;
        return edge;
      }

      case "random": {
        const total = edges.reduce((s, e) => s + e.weight, 0);
        let u = rng.next() * total;
        for (const e of edges) {
          u -= e.weight;
          if (u <= 0) return e;
        }
        return edges[edges.length - 1]!;
      }

      case "least-connections": {
        let best = edges[0]!;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const e of edges) {
          const score = (this.env.components.get(e.to)?.load() ?? 0) / e.weight;
          if (score < bestScore) {
            bestScore = score;
            best = e;
          }
        }
        return best;
      }

      case "power-of-two-choices": {
        const i = rng.nextInt(edges.length);
        let j = rng.nextInt(edges.length);
        if (j === i) j = (j + 1) % edges.length;
        const a = edges[i]!;
        const b = edges[j]!;
        const scoreA = (this.env.components.get(a.to)?.load() ?? 0) / a.weight;
        const scoreB = (this.env.components.get(b.to)?.load() ?? 0) / b.weight;
        return scoreA <= scoreB ? a : b;
      }
    }
  }

  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.loadbalancer!;
    const env = this.env;
    const enqueuedAt = env.sim.now;

    const slot = yield* acquire(this.resource, ctx.deadlineAt);
    if (!slot.granted) return { ok: false, reason: slot.reason ?? "timeout" };

    const serviceStart = env.sim.now;
    try {
      const own = Math.max(
        MIN_SERVICE_MS,
        sample(cfg.serviceTime, env.rng.stream("service"))
      );
      const served = yield* delay(own, ctx.deadlineAt);
      this.recordSelfTime(slot.waitedMs, env.sim.now - serviceStart);
      if (served.timedOut) return { ok: false, reason: "timeout" };

      const routable = eligibleEdges(env, this.node.id, ctx);
      if (routable.length === 0) return OK;

      const edge = this.select(this.eligible(routable));
      if (env.measuring()) {
        this.dispatched.set(edge.to, (this.dispatched.get(edge.to) ?? 0) + 1);
        this.dispatchTotal++;
      }

      const outcome = yield* callThrough(env, edge, ctx);
      this.observeBackend(edge.to, outcome.ok);
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          serviceStart,
          env.sim.now,
          outcome.ok ? "served" : "timeout"
        );
      }
      return outcome;
    } finally {
      this.resource.release();
      this.recordResidency(enqueuedAt);
    }
  }

  override result(observedSec: number): NodeResult {
    const base = super.result(observedSec);
    const now = this.env.sim.now;
    const span = Math.max(1, now - this.healthStart);
    const backends = (this.env.outgoing.get(this.node.id) ?? []).map((e) => {
      const count = this.dispatched.get(e.to) ?? 0;
      const h = this.health.get(e.to);
      if (h) this.settleEjection(h);
      const total = (h?.successes ?? 0) + (h?.failures ?? 0);
      // Plus any ejection still in force at the moment the clock stopped.
      const openNow = h && h.ejectedUntil > now ? now - Math.max(this.healthStart, h.lastEjectStart) : 0;
      return {
        nodeId: e.to,
        label: this.env.components.get(e.to)?.node.label ?? e.to,
        dispatched: count,
        sharePct: this.dispatchTotal > 0 ? (count / this.dispatchTotal) * 100 : 0,
        // Prefer the rate that caused the last ejection; fall back to the live rate
        // for a backend that has never been ejected.
        failureRate:
          h && h.ejections > 0 ? h.rateAtEjection : total > 0 ? h!.failures / total : 0,
        ejectedFraction: h ? Math.min(1, (h.ejectedMs + openNow) / span) : 0,
        ejections: h?.ejections ?? 0,
      };
    });
    const even = backends.length > 0 ? 100 / backends.length : 0;
    const worstImbalancePct = backends.reduce(
      (m, b) => Math.max(m, Math.abs(b.sharePct - even)),
      0
    );
    const lb: LoadBalancerMetrics = {
      algorithm: this.node.loadbalancer!.algorithm,
      dispatched: this.dispatchTotal,
      perBackend: backends,
      healthCheckEnabled: this.node.loadbalancer!.healthCheck.enabled,
      ejectionsWithheld: this.ejectionsWithheld,
      worstImbalancePct,
    };
    return { ...base, loadbalancer: lb };
  }
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

/**
 * A read-through cache over a real key population.
 *
 * The hit ratio is an OUTPUT. Keys are drawn from a Zipf population, looked up in
 * an actual LRU map with actual TTL expiry, and a miss actually calls the origin.
 * That is what lets the tool answer "how much cache do I need?" instead of
 * requiring the answer as an input, and it is why the legacy engine's cache was
 * inert -- its hit/miss branch always took the first matching transition, so the
 * hit ratio was permanently 100% and a miss never read anything.
 *
 * THE SLOT IS RELEASED BEFORE THE ORIGIN FETCH.
 *
 * Unlike a server, the cache does not hold its concurrency slot while the origin
 * is queried, because in a cache-aside deployment the *application* performs that
 * fetch -- Redis is not busy during it. Holding the slot would be badly wrong for
 * a single-threaded cache: one miss would block every other lookup for the
 * duration of a database query, making the cache itself look like the bottleneck.
 */
export class CacheComponent extends StationComponent {
  private readonly sampler: ZipfSampler | null;
  /** key -> absolute expiry time (Infinity when no TTL). Insertion order = LRU. */
  private entries = new Map<number, number>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;
  private readonly hitRatioSeries: TimeSeries;
  private windowHits = 0;
  private windowMisses = 0;

  constructor(node: SdsNode, env: ComponentEnv) {
    const cfg = node.cache!;
    super(node, env, {
      capacity: cfg.concurrency,
      queueCapacity: null,
      discipline: "fifo",
      admissionPolicy: "block",
    });
    this.sampler =
      cfg.keyspace.kind === "zipf"
        ? new ZipfSampler(cfg.keyspace.keys, cfg.keyspace.skew)
        : null;
    this.hitRatioSeries = new TimeSeries(`${node.id}.hitRatio`);
  }

  protected serviceMeanMs(): number {
    return distMean(this.node.cache!.serviceTime);
  }
  protected serviceScv(): number {
    return scv(this.node.cache!.serviceTime);
  }

  override resetStats(): void {
    super.resetStats();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
    this.windowHits = 0;
    this.windowMisses = 0;
    this.hitRatioSeries.reset();
    // Entries are NOT cleared: the cache's warm contents are part of the steady
    // state we spent the warm-up reaching. Emptying it here would measure a cold
    // cache and understate the hit ratio badly.
  }

  override sample(tSec: number): void {
    super.sample(tSec);
    const total = this.windowHits + this.windowMisses;
    this.hitRatioSeries.push(tSec, total > 0 ? this.windowHits / total : 0);
    this.windowHits = 0;
    this.windowMisses = 0;
  }

  /** True on a hit. Also performs LRU promotion and TTL expiry. */
  private lookup(key: number): boolean {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.env.sim.now) {
      this.entries.delete(key);
      if (this.env.measuring()) this.expirations++;
      return false;
    }
    // LRU promotion: delete and re-insert moves the key to the end of Map order.
    this.entries.delete(key);
    this.entries.set(key, expiry);
    return true;
  }

  private store(key: number): void {
    const cfg = this.node.cache!;
    const ttl = cfg.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, ttl === null ? Number.POSITIVE_INFINITY : this.env.sim.now + ttl);
    while (this.entries.size > cfg.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      if (this.env.measuring()) this.evictions++;
    }
  }

  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.cache!;
    const env = this.env;
    const enqueuedAt = env.sim.now;

    const slot = yield* acquire(this.resource, ctx.deadlineAt);
    if (!slot.granted) return { ok: false, reason: slot.reason ?? "timeout" };

    const serviceStart = env.sim.now;
    let key = -1;
    let hit: boolean;

    try {
      const lookupMs = Math.max(
        MIN_SERVICE_MS,
        sample(cfg.serviceTime, env.rng.stream("service"))
      );
      const served = yield* delay(lookupMs, ctx.deadlineAt);
      this.recordSelfTime(slot.waitedMs, env.sim.now - serviceStart);
      if (served.timedOut) return { ok: false, reason: "timeout" };

      if (this.sampler) {
        key = this.sampler.sample(env.rng.stream("cache"));
        hit = this.lookup(key);
      } else {
        const fixed = cfg.keyspace.kind === "fixed" ? cfg.keyspace.hitRatio : 1;
        hit = env.rng.stream("cache").chance(fixed);
      }

      if (env.measuring()) {
        if (hit) {
          this.hits++;
          this.windowHits++;
        } else {
          this.misses++;
          this.windowMisses++;
        }
      }
    } finally {
      // Released before the origin call, deliberately. See the class comment.
      this.resource.release();
      this.recordResidency(enqueuedAt);
    }

    if (ctx.traced) {
      env.trace.visit(
        ctx.requestId,
        this.node.id,
        enqueuedAt,
        serviceStart,
        env.sim.now,
        hit ? "hit" : "miss"
      );
    }

    if (hit) return OK;

    // ---- miss: read through to the origin ----
    const outcome = yield* callDependencies(env, this.node.id, ctx, "sequential");
    if (outcome.ok && this.sampler && key >= 0) this.store(key);
    return outcome;
  }

  override result(observedSec: number): NodeResult {
    const base = super.result(observedSec);
    const total = this.hits + this.misses;
    const cache: CacheMetrics = {
      hits: this.hits,
      misses: this.misses,
      hitRatio: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
      expirations: this.expirations,
      residentKeys: this.entries.size,
      hitRatioSeries: series(this.hitRatioSeries),
    };
    return { ...base, cache };
  }
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

/**
 * A database as two nested resources: a connection pool, then execution.
 *
 * The nesting is the point. A request acquires a connection, then waits for an
 * execution slot, then runs. Total capacity is `parallelism / E[S]` regardless of
 * pool size, which is why the most common capacity "fix" -- raise the pool --
 * changes nothing except where the waiting happens. A single-resource model
 * cannot express that, and so makes the wrong fix look right.
 *
 * Small pools are also genuinely better under overload: they push the queue
 * upstream where it is visible, instead of accepting hundreds of connections that
 * all then wait inside the database.
 */
export class DatabaseComponent extends StationComponent {
  private readonly execution: Resource;
  private readonly execSeries: TimeSeries;
  private execWaitTotal = 0;
  private execWaitCount = 0;
  private lastExecBusy = 0;
  private lastExecSampleT = 0;

  constructor(node: SdsNode, env: ComponentEnv) {
    const cfg = node.database!;
    // The outer resource is the pool: acquiring it is checking out a connection.
    super(node, env, {
      capacity: cfg.poolSize,
      queueCapacity: cfg.queueCapacity,
      discipline: "fifo",
      admissionPolicy: cfg.admissionPolicy,
    });
    this.execution = new Resource(env.sim, {
      id: `${node.id}:exec`,
      capacity: cfg.parallelism,
      queueCapacity: null,
      discipline: "fifo",
      admissionPolicy: "block",
    });
    this.execSeries = new TimeSeries(`${node.id}.executionUtilization`);
  }

  protected serviceMeanMs(): number {
    return distMean(this.node.database!.serviceTime);
  }
  protected serviceScv(): number {
    return scv(this.node.database!.serviceTime);
  }

  override load(): number {
    return this.execution.inServiceCount + this.execution.queueLength;
  }

  override occupancy(): ComponentOccupancy {
    const queued = this.execution.queueLength;
    const inService = this.execution.inServiceCount;
    return { queued, inService, total: queued + inService };
  }

  override resetStats(): void {
    super.resetStats();
    this.execution.resetStats();
    this.execSeries.reset();
    this.execWaitTotal = 0;
    this.execWaitCount = 0;
    this.lastExecBusy = 0;
    this.lastExecSampleT = this.env.sim.now;
  }

  override sample(tSec: number): void {
    super.sample(tSec);
    const s = this.execution.stats();
    const busy = s.utilization * s.observedMs * this.execution.capacity;
    const dt = this.env.sim.now - this.lastExecSampleT;
    const windowUtil = dt > 0 ? (busy - this.lastExecBusy) / (dt * this.execution.capacity) : 0;
    this.execSeries.push(tSec, Math.max(0, Math.min(1, windowUtil)));
    this.lastExecBusy = busy;
    this.lastExecSampleT = this.env.sim.now;
  }

  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.database!;
    const env = this.env;
    const enqueuedAt = env.sim.now;

    const conn = yield* acquire(this.resource, ctx.deadlineAt);
    if (!conn.granted) {
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          null,
          env.sim.now,
          conn.reason === "shed" ? "shed" : "timeout"
        );
      }
      return { ok: false, reason: conn.reason ?? "timeout" };
    }

    try {
      const exec = yield* acquire(this.execution, ctx.deadlineAt);
      if (!exec.granted) return { ok: false, reason: exec.reason ?? "timeout" };
      if (env.measuring()) {
        this.execWaitTotal += exec.waitedMs;
        this.execWaitCount++;
      }

      const serviceStart = env.sim.now;
      try {
        const queryMs = Math.max(
          MIN_SERVICE_MS,
          sample(cfg.serviceTime, env.rng.stream("service")) * ctx.serviceMultiplier
        );
        const served = yield* delay(queryMs, ctx.deadlineAt);
        this.recordSelfTime(conn.waitedMs + exec.waitedMs, env.sim.now - serviceStart);
        if (ctx.traced) {
          env.trace.visit(
            ctx.requestId,
            this.node.id,
            enqueuedAt,
            serviceStart,
            env.sim.now,
            served.timedOut ? "timeout" : "served"
          );
        }
        if (served.timedOut) return { ok: false, reason: "timeout" };
        // Execution occupancy, not pool occupancy: the real constraint is what is
        // running, and a large pool would otherwise dilute the signal. Excludes this
        // query and includes the queue, for the reasons in `failureProbabilityNow`.
        const others =
          this.execution.inServiceCount - 1 + this.execution.queueLength;
        const busy = Math.min(1, Math.max(0, others / Math.max(1, this.execution.capacity)));
        const failureNow =
          cfg.failureAtSaturation === null
            ? cfg.failureProbability
            : cfg.failureProbability +
              (cfg.failureAtSaturation - cfg.failureProbability) * busy;
        if (failureNow > 0 && env.rng.stream("failure").chance(failureNow)) {
          return { ok: false, reason: "error" };
        }
        return OK;
      } finally {
        this.execution.release();
      }
    } finally {
      this.resource.release();
      this.recordResidency(enqueuedAt);
    }
  }

  override invariants(): InvariantReport[] {
    return [
      this.resourceInvariant(this.resource, `pool "${this.node.label}"`),
      this.resourceInvariant(this.execution, `execution "${this.node.label}"`),
    ];
  }

  override result(observedSec: number): NodeResult {
    const base = super.result(observedSec);
    const cfg = this.node.database!;
    const pool = this.resource.stats();
    const exec = this.execution.stats();
    const db: DatabaseMetrics = {
      poolSize: cfg.poolSize,
      parallelism: cfg.parallelism,
      poolUtilization: pool.utilization,
      executionUtilization: exec.utilization,
      avgPoolWaitMs: pool.admitted > 0 ? pool.totalWaitMs / pool.admitted : 0,
      avgExecutionWaitMs: this.execWaitCount > 0 ? this.execWaitTotal / this.execWaitCount : 0,
      maxThroughputPerSec: (cfg.parallelism * 1000) / distMean(cfg.serviceTime),
    };
    return {
      ...base,
      // Report execution utilization as THE utilization: that is the real capacity
      // constraint, and reporting pool occupancy instead would flag a saturated
      // pool as the bottleneck when execution is what is full.
      capacity: cfg.parallelism,
      utilization: exec.utilization,
      utilizationSeries: series(this.execSeries),
      database: db,
    };
  }
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

interface QueuedMessage {
  enqueuedAt: number;
  classId: string;
  serviceMultiplier: number;
  requestId: number;
  traced: boolean;
}

/**
 * An asynchronous queue.
 *
 * PUBLISHING RETURNS IMMEDIATELY. That single property is what a queue is for, and
 * modelling it any other way misses the failure mode that actually bites: the
 * backlog grows without bound while every request still looks fast, because the
 * caller never waited for the work.
 *
 * The legacy engine enqueued, waited a fixed delay, fanned out to all consumers
 * and then returned to the caller (engine.jsx:169-178), decrementing the depth
 * immediately. The depth could therefore never exceed about one, so the single
 * most diagnostic signal in async capacity work was pinned at zero by
 * construction.
 *
 * Consumers are long-running processes that park when the backlog is empty and are
 * woken on publish -- no polling, so an idle queue costs no events.
 */
export class QueueComponent implements Component {
  private backlog: QueuedMessage[] = [];
  private head = 0;
  private idle: Array<() => void> = [];
  private inFlight = 0;

  private enqueued = 0;
  private consumed = 0;
  private dropped = 0;
  private readonly backlogAge = new LatencyHistogram();
  private readonly publishTime = new LatencyHistogram();
  private readonly backlogSeries: TimeSeries;

  private backlogIntegral = 0;
  private busyIntegral = 0;
  private depthAtStart = 0;
  private inFlightAtStart = 0;
  private lastTouch = 0;
  private statsStart = 0;
  private maxBacklog = 0;

  constructor(
    readonly node: SdsNode,
    private readonly env: ComponentEnv
  ) {
    this.backlogSeries = new TimeSeries(`${node.id}.backlog`);
    this.lastTouch = env.sim.now;
    this.statsStart = env.sim.now;
  }

  private get depth(): number {
    return this.backlog.length - this.head;
  }

  private touch(): void {
    const dt = this.env.sim.now - this.lastTouch;
    if (dt > 0) {
      this.backlogIntegral += this.depth * dt;
      this.busyIntegral += this.inFlight * dt;
      this.lastTouch = this.env.sim.now;
    }
  }

  load(): number {
    return this.depth + this.inFlight;
  }

  occupancy(): ComponentOccupancy {
    return { queued: this.depth, inService: this.inFlight, total: this.depth + this.inFlight };
  }

  resetStats(): void {
    this.touch();
    this.enqueued = 0;
    this.consumed = 0;
    this.dropped = 0;
    this.backlogAge.reset();
    this.publishTime.reset();
    this.backlogSeries.reset();
    this.backlogIntegral = 0;
    this.busyIntegral = 0;
    this.statsStart = this.env.sim.now;
    this.maxBacklog = this.depth;
    this.depthAtStart = this.depth;
    this.inFlightAtStart = this.inFlight;
  }

  sample(tSec: number): void {
    this.backlogSeries.push(tSec, this.depth);
  }

  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.queue!;
    const env = this.env;

    const publishMs = Math.max(
      MIN_SERVICE_MS,
      sample(cfg.publishTime, env.rng.stream("service"))
    );
    const publishStart = env.sim.now;
    const published = yield* delay(publishMs, ctx.deadlineAt);
    if (env.measuring()) this.publishTime.record(env.sim.now - publishStart);
    if (published.timedOut) return { ok: false, reason: "timeout" };

    this.touch();
    if (cfg.maxDepth !== null && this.depth >= cfg.maxDepth) {
      if (env.measuring()) this.dropped++;
      return { ok: false, reason: "queue-full" };
    }

    this.backlog.push({
      enqueuedAt: env.sim.now,
      classId: ctx.classId,
      serviceMultiplier: ctx.serviceMultiplier,
      requestId: ctx.requestId,
      traced: ctx.traced,
    });
    if (env.measuring()) this.enqueued++;
    if (this.depth > this.maxBacklog) this.maxBacklog = this.depth;

    const wake = this.idle.pop();
    if (wake) wake();

    // Returns OK without waiting for the consumer. This is the async boundary.
    return OK;
  }

  private dequeue(): QueuedMessage | null {
    if (this.head >= this.backlog.length) return null;
    const msg = this.backlog[this.head]!;
    this.head++;
    if (this.head > 4096 && this.head * 2 > this.backlog.length) {
      this.backlog = this.backlog.slice(this.head);
      this.head = 0;
    }
    return msg;
  }

  processes(): Process<void>[] {
    const cfg = this.node.queue!;
    return Array.from({ length: cfg.consumers }, () => this.consumer());
  }

  private consumer(): Process<void> {
    const self = this;
    const cfg = this.node.queue!;
    const env = this.env;

    return (function* (): Process<void> {
      for (;;) {
        if (self.depth === 0) {
          yield* suspend((resume) => {
            self.idle.push(resume);
          });
          continue;
        }
        const msg = self.dequeue();
        if (!msg) continue;

        self.touch();
        if (env.measuring()) self.backlogAge.record(env.sim.now - msg.enqueuedAt);
        self.inFlight++;

        const workMs = Math.max(
          MIN_SERVICE_MS,
          sample(cfg.consumerServiceTime, env.rng.stream("service")) * msg.serviceMultiplier
        );
        // Consumer work has no client deadline: nobody is waiting on it. That is
        // exactly why an unbounded backlog is dangerous rather than self-limiting.
        yield* delay(workMs, null);

        const ctx: RequestCtx = {
          requestId: msg.requestId,
          classId: msg.classId,
          serviceMultiplier: msg.serviceMultiplier,
          deadlineAt: null,
          traced: msg.traced,
        };
        yield* callDependencies(env, self.node.id, ctx, "sequential");

        self.touch();
        self.inFlight--;
        if (env.measuring()) self.consumed++;
      }
    })();
  }

  invariants(): InvariantReport[] {
    /**
     * A message is enqueued, dropped, still waiting, or being worked on. Nothing else,
     * and never twice.
     *
     * The boundary terms are not optional. Measurement starts at the warm-up boundary
     * with messages already backlogged and already being processed, so those are
     * consumed inside the window without having been enqueued inside it. An earlier
     * version omitted them and the check read `consumed <= enqueued`, which was simply
     * false at any non-empty boundary -- it went unnoticed until a design arrived whose
     * queue was actually busy when measurement began.
     */
    const lhs = this.enqueued + this.depthAtStart + this.inFlightAtStart;
    const rhs = this.consumed + this.depth + this.inFlight + this.dropped;
    const passed = lhs === rhs;
    return [
      {
        name: `queue "${this.node.label}" bookkeeping`,
        passed,
        detail: passed
          ? `${this.enqueued} enqueued + ${this.depthAtStart} waiting and ${this.inFlightAtStart} ` +
            `in flight at start = ${this.consumed} consumed + ${this.depth} waiting + ` +
            `${this.inFlight} in flight + ${this.dropped} dropped`
          : `in ${lhs} vs out ${rhs}: messages are being lost or double-counted`,
      },
    ];
  }

  result(observedSec: number): NodeResult {
    this.touch();
    const cfg = this.node.queue!;
    const span = this.env.sim.now - this.statsStart;
    const denom = span > 0 ? span : 1;
    const drainCapacity = (cfg.consumers * 1000) / distMean(cfg.consumerServiceTime);
    // Slope from the second half of the window: even a stable backlog trends while
    // it fills from the warm-up boundary.
    const growth = this.backlogSeries.slopePerSec(observedSec * 0.2);

    const queue: QueueMetrics = {
      enqueued: this.enqueued,
      consumed: this.consumed,
      dropped: this.dropped,
      consumers: cfg.consumers,
      avgBacklog: this.backlogIntegral / denom,
      maxBacklog: this.maxBacklog,
      backlogAge: summarize(this.backlogAge),
      consumerUtilization: this.busyIntegral / (denom * cfg.consumers),
      drainCapacityPerSec: drainCapacity,
      backlogSeries: series(this.backlogSeries),
      backlogGrowthPerSec: growth,
    };

    return {
      nodeId: this.node.id,
      label: this.node.label,
      kind: this.node.kind,
      capacity: cfg.consumers,
      utilization: queue.consumerUtilization,
      avgQueueLength: queue.avgBacklog,
      maxQueueLength: queue.maxBacklog,
      avgInStation: queue.avgBacklog + this.busyIntegral / denom,
      arrivals: this.enqueued + this.dropped,
      admitted: this.enqueued,
      shed: this.dropped,
      abandoned: 0,
      completed: this.consumed,
      avgWaitMs: queue.backlogAge.mean,
      serviceMeanMs: distMean(cfg.consumerServiceTime),
      serviceScv: scv(cfg.consumerServiceTime),
      arrivalRatePerSec: observedSec > 0 ? (this.enqueued + this.dropped) / observedSec : 0,
      residencyMs: summarize(this.backlogAge),
      // Only the synchronous publish is on the request's critical path; consumer
      // work is not, because nobody waits for it.
      selfTimeMs: summarize(this.publishTime),
      visitsPerRequest: 0,
      queueLengthSeries: series(this.backlogSeries),
      utilizationSeries: { name: "utilization", points: [] },
      queue,
    };
  }
}

// ---------------------------------------------------------------------------
// gateway
// ---------------------------------------------------------------------------

/**
 * A realtime gateway: the component that holds the sockets.
 *
 * TWO RESOURCES, CONSTRAINING DIFFERENT THINGS.
 *
 * `connections` is a semaphore held for an entire session -- minutes or hours, not
 * milliseconds. It is the only resource in this model with that lifetime, and it is
 * what "how many concurrent users" actually asks about. Its queue capacity is zero and
 * its policy is to shed, because a socket either gets a descriptor or is refused; there
 * is no queue of half-open connections waiting for one to free up.
 *
 * `work` is ordinary short-lived concurrency, shared between accepting handshakes and
 * pushing messages. Sharing it is deliberate and is where the interesting behaviour
 * lives: during a reconnect storm, handshake work starves message delivery, so
 * everyone still connected sees their messages stall because someone else's
 * connections dropped. Modelling accept and push as separate pools would lose exactly
 * that coupling.
 */
export class GatewayComponent implements Component {
  private readonly connections: Resource;
  private readonly work: Resource;
  private readonly connectionSeries: TimeSeries;
  private readonly workUtilSeries: TimeSeries;
  private readonly acceptLatency = new LatencyHistogram();
  private readonly pushLatency = new LatencyHistogram();
  private readonly residency = new LatencyHistogram();
  private readonly selfTime = new LatencyHistogram();

  private accepted = 0;
  private refused = 0;
  private disconnects = 0;
  private pushes = 0;
  private droppedByFault = 0;
  /** Tokens for every connection currently held, so faults can revoke them. */
  private readonly tokens = new Set<ConnectionToken>();
  private peakHeld = 0;
  private heldIntegral = 0;
  private lastTouch = 0;
  private statsStart = 0;
  private lastWorkBusy = 0;
  private lastSampleT = 0;

  constructor(
    readonly node: SdsNode,
    private readonly env: ComponentEnv
  ) {
    const cfg = node.gateway!;
    this.connections = new Resource(env.sim, {
      id: `${node.id}:connections`,
      capacity: cfg.connectionCapacity * cfg.replicas,
      // No queue: a socket is accepted or refused. Waiting for a descriptor that
      // might free up in an hour is not a thing clients do.
      queueCapacity: 0,
      discipline: "fifo",
      admissionPolicy: "shed",
    });
    this.work = new Resource(env.sim, {
      id: `${node.id}:work`,
      capacity: cfg.pushConcurrency * cfg.replicas,
      queueCapacity: null,
      discipline: "fifo",
      admissionPolicy: "block",
    });
    this.connectionSeries = new TimeSeries(`${node.id}.connections`);
    this.workUtilSeries = new TimeSeries(`${node.id}.workUtilization`);
    this.lastTouch = env.sim.now;
    this.statsStart = env.sim.now;
    this.lastSampleT = env.sim.now;
  }

  private touch(): void {
    const dt = this.env.sim.now - this.lastTouch;
    if (dt > 0) {
      this.heldIntegral += this.connections.inServiceCount * dt;
      this.lastTouch = this.env.sim.now;
    }
  }

  get held(): number {
    return this.connections.inServiceCount;
  }

  load(): number {
    return this.work.inServiceCount + this.work.queueLength;
  }

  occupancy(): ComponentOccupancy {
    const queued = this.work.queueLength;
    const inService = this.work.inServiceCount;
    return { queued, inService, total: queued + inService };
  }

  resetStats(): void {
    this.touch();
    this.connections.resetStats();
    this.work.resetStats();
    this.connectionSeries.reset();
    this.workUtilSeries.reset();
    this.acceptLatency.reset();
    this.pushLatency.reset();
    this.residency.reset();
    this.selfTime.reset();
    this.accepted = 0;
    this.refused = 0;
    this.disconnects = 0;
    this.pushes = 0;
    this.droppedByFault = 0;
    this.heldIntegral = 0;
    this.statsStart = this.env.sim.now;
    this.peakHeld = this.held;
    this.lastWorkBusy = 0;
    this.lastSampleT = this.env.sim.now;
  }

  sample(tSec: number): void {
    this.connectionSeries.push(tSec, this.held);
    const s = this.work.stats();
    const busy = s.utilization * s.observedMs * this.work.capacity;
    const dt = this.env.sim.now - this.lastSampleT;
    const windowUtil = dt > 0 ? (busy - this.lastWorkBusy) / (dt * this.work.capacity) : 0;
    this.workUtilSeries.push(tSec, Math.max(0, Math.min(1, windowUtil)));
    this.lastWorkBusy = busy;
    this.lastSampleT = this.env.sim.now;
  }

  /**
   * Take a descriptor, then do the handshake.
   *
   * In that order, and it matters: the descriptor is what runs out first at scale, and
   * a design that is refusing connections should refuse them before spending CPU on a
   * handshake it cannot complete. Doing the work first would report accept latency for
   * connections that were never going to be held.
   */
  *connect(ctx: RequestCtx): Process<ConnectResult> {
    const cfg = this.node.gateway!;
    const env = this.env;
    const start = env.sim.now;

    this.touch();
    const slot = yield* acquire(this.connections, ctx.deadlineAt);
    if (!slot.granted) {
      if (env.measuring()) this.refused++;
      return { held: false, reason: "shed", acceptMs: env.sim.now - start };
    }

    // Handshake work competes with message delivery for the same slots, which is what
    // makes a reconnect storm hurt the people who never disconnected.
    const workSlot = yield* acquire(this.work, ctx.deadlineAt);
    if (!workSlot.granted) {
      this.connections.release();
      if (env.measuring()) this.refused++;
      return { held: false, reason: workSlot.reason ?? "timeout", acceptMs: env.sim.now - start };
    }
    try {
      const acceptMs = Math.max(
        MIN_SERVICE_MS,
        sample(cfg.acceptTime, env.rng.stream("service"))
      );
      const done = yield* delay(acceptMs, ctx.deadlineAt);
      if (done.timedOut) {
        this.connections.release();
        if (env.measuring()) this.refused++;
        return { held: false, reason: "timeout", acceptMs: env.sim.now - start };
      }
    } finally {
      this.work.release();
    }

    this.touch();
    if (this.held > this.peakHeld) this.peakHeld = this.held;
    if (env.measuring()) {
      this.accepted++;
      this.acceptLatency.record(env.sim.now - start);
    }
    const token: ConnectionToken = { revoked: false, onRevoke: null };
    this.tokens.add(token);
    return { held: true, acceptMs: env.sim.now - start, token };
  }

  disconnect(token: ConnectionToken): void {
    // A revoked connection's descriptor was already returned when the fault hit.
    // Releasing again would decrement the count twice and quietly inflate capacity.
    if (token.revoked) return;
    token.revoked = true;
    this.tokens.delete(token);
    this.touch();
    this.connections.release();
    if (this.env.measuring()) this.disconnects++;
  }

  /**
   * Drop connections without the holder's cooperation.
   *
   * The descriptors are released here and the holding processes discover it when their
   * session ends -- which means a dropped connection's slot is freed immediately, as it
   * would be when a process dies, while the client's reconnect arrives a moment later.
   * That ordering is what produces the burst.
   */
  dropConnections(count: number): number {
    this.touch();
    let dropped = 0;
    for (const token of [...this.tokens]) {
      if (dropped >= count) break;
      this.tokens.delete(token);
      token.revoked = true;
      this.connections.release();
      if (this.env.measuring()) this.disconnects++;
      dropped++;
      // Waking the holder is what makes this a storm rather than a leak: it comes
      // straight back through accept instead of sitting out the rest of its session.
      token.onRevoke?.();
    }
    this.droppedByFault += dropped;
    return dropped;
  }

  /**
   * Handle a message: either inbound from a client, or a delivery to push.
   *
   * The same station and the same work pool for both, because on a real gateway they
   * are the same event loop.
   *
   * THE WORK SLOT IS RELEASED BEFORE CALLING DOWNSTREAM.
   *
   * A gateway is event-driven: forwarding a frame to an API does not occupy the loop
   * while the API thinks. Holding the slot -- as a thread-per-request server correctly
   * does -- charges the gateway for the entire downstream path, and at fan-out scale
   * that is catastrophically wrong. It made a gateway doing 0.26 core-seconds of real
   * work per second read as 74% utilized, and pointed the bottleneck at the wrong
   * component entirely.
   */
  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.gateway!;
    const env = this.env;
    const enqueuedAt = env.sim.now;

    const slot = yield* acquire(this.work, ctx.deadlineAt);
    if (!slot.granted) {
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          null,
          env.sim.now,
          slot.reason === "shed" ? "shed" : "timeout"
        );
      }
      return { ok: false, reason: slot.reason ?? "timeout" };
    }

    const serviceStart = env.sim.now;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.work.release();
    };

    try {
      const pushMs = Math.max(
        MIN_SERVICE_MS,
        sample(cfg.pushTime, env.rng.stream("service")) * ctx.serviceMultiplier
      );
      const served = yield* delay(pushMs, ctx.deadlineAt);
      if (env.measuring()) {
        this.pushes++;
        this.pushLatency.record(env.sim.now - enqueuedAt);
        this.selfTime.record(slot.waitedMs + (env.sim.now - serviceStart));
      }
      if (served.timedOut) return { ok: false, reason: "timeout" };

      // Hand the loop back before waiting on anything downstream.
      release();

      const downstream = yield* callDependencies(env, this.node.id, ctx, "parallel");
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          serviceStart,
          env.sim.now,
          downstream.ok ? "served" : "timeout"
        );
      }
      return downstream;
    } finally {
      release();
      if (env.measuring()) this.residency.record(env.sim.now - enqueuedAt);
    }
  }

  invariants(): InvariantReport[] {
    const c = this.connections.stats();
    const w = this.work.stats();
    // Forced drops release a descriptor without the holder having finished, so they
    // appear as completions here just like a graceful close. The identity still has to
    // balance -- that is the point of checking it.
    const connOk =
      c.arrivals + c.queuedAtStart === c.admitted + c.shed + c.abandoned + c.currentQueueLength &&
      c.admitted + c.inServiceAtStart === c.completed + c.currentInService;
    const workOk =
      w.arrivals + w.queuedAtStart === w.admitted + w.shed + w.abandoned + w.currentQueueLength &&
      w.admitted + w.inServiceAtStart === w.completed + w.currentInService;

    return [
      {
        name: `gateway "${this.node.label}" connections`,
        passed: connOk,
        detail: connOk
          ? `${this.accepted} accepted, ${this.refused} refused, ${this.disconnects} closed, ` +
            `${this.held} held now`
          : `connection bookkeeping does not balance`,
      },
      {
        name: `gateway "${this.node.label}" work`,
        passed: workOk,
        detail: workOk
          ? `${w.arrivals} work items, ${this.pushes} pushes`
          : `work bookkeeping does not balance`,
      },
    ];
  }

  result(observedSec: number): NodeResult {
    this.touch();
    const cfg = this.node.gateway!;
    const span = this.env.sim.now - this.statsStart;
    const denom = span > 0 ? span : 1;
    const w = this.work.stats();
    const capacity = cfg.connectionCapacity * cfg.replicas;
    const avgHeld = this.heldIntegral / denom;

    const connectionMetrics: ConnectionMetrics = {
      capacity,
      avgHeld,
      peakHeld: this.peakHeld,
      heldNow: this.held,
      utilization: capacity > 0 ? avgHeld / capacity : 0,
      accepted: this.accepted,
      refused: this.refused,
      closed: this.disconnects,
      droppedByFault: this.droppedByFault,
      acceptRatePerSec: observedSec > 0 ? this.accepted / observedSec : 0,
      acceptLatency: summarize(this.acceptLatency),
      pushes: this.pushes,
      pushRatePerSec: observedSec > 0 ? this.pushes / observedSec : 0,
      pushLatency: summarize(this.pushLatency),
      memoryMb: (avgHeld * cfg.memoryPerConnectionKb) / 1024,
      peakMemoryMb: (this.peakHeld * cfg.memoryPerConnectionKb) / 1024,
      workUtilization: w.utilization,
      connectionSeries: series(this.connectionSeries),
    };

    return {
      nodeId: this.node.id,
      label: this.node.label,
      kind: "gateway",
      // The work pool is the throughput constraint; connection capacity is reported
      // separately because it constrains a different thing entirely.
      capacity: this.work.capacity,
      utilization: w.utilization,
      avgQueueLength: w.avgQueueLength,
      maxQueueLength: w.maxQueueLength,
      avgInStation: w.avgInStation,
      arrivals: w.arrivals,
      admitted: w.admitted,
      shed: w.shed + this.refused,
      abandoned: w.abandoned,
      completed: w.completed,
      avgWaitMs: w.admitted > 0 ? w.totalWaitMs / w.admitted : 0,
      serviceMeanMs: distMean(cfg.pushTime),
      serviceScv: scv(cfg.pushTime),
      arrivalRatePerSec: observedSec > 0 ? w.arrivals / observedSec : 0,
      residencyMs: summarize(this.residency),
      selfTimeMs: summarize(this.selfTime),
      visitsPerRequest: 0,
      queueLengthSeries: series(this.connectionSeries),
      utilizationSeries: series(this.workUtilSeries),
      connections: connectionMetrics,
    };
  }
}

// ---------------------------------------------------------------------------
// lock service
// ---------------------------------------------------------------------------

/**
 * A lease service.
 *
 * WHAT THIS CLASS DOES AND DELIBERATELY DOES NOT DO
 *
 * It charges capacity and it measures. It does NOT decide who holds a lease.
 *
 * That split is the single most important structural decision in the stateful layer.
 * Lease ownership is shared mutable state with exactly the same status as a row in a
 * table, and it must be governed by the one kernel that both the breadth-first
 * explorer and this simulator call. If the lease table lived here, this component
 * would be a second implementation of mutual exclusion -- and a second implementation
 * is a second set of bugs, of which the worst class is "the simulator says safe and
 * the explorer says broken and neither is wrong about its own model".
 *
 * So the world state holds the leases, `stepOperation` grants and expires them, and
 * this component provides the two things the kernel has no way to know: how long the
 * round trip to the lock service took, and how contended it was.
 *
 * The metrics it reports are the ones that are invisible in latency: leases that
 * expired while held, and writes rejected for a stale fencing token. Both are events
 * where a design either did or did not have the property it claimed, and neither
 * shows up as a slow request.
 */
export class LockComponent extends StationComponent {
  private acquireAttempts = 0;
  private acquired = 0;
  private contended = 0;
  private released = 0;
  private expired = 0;
  private staleOwnerRejections = 0;
  private readonly waitTime = new LatencyHistogram();
  private readonly heldTime = new LatencyHistogram();
  private held = 0;
  private peakHeld = 0;
  private heldIntegral = 0;
  private lastHeldT = 0;
  private readonly heldSeries: TimeSeries;

  constructor(node: SdsNode, env: ComponentEnv) {
    const cfg = node.lock!;
    super(node, env, {
      capacity: cfg.concurrency,
      queueCapacity: cfg.queueCapacity,
      discipline: "fifo",
      admissionPolicy: cfg.admissionPolicy,
    });
    this.heldSeries = new TimeSeries(`${node.id}.leasesHeld`);
    this.lastHeldT = env.sim.now;
  }

  protected serviceMeanMs(): number {
    return distMean(this.node.lock!.serviceTime);
  }
  protected serviceScv(): number {
    return scv(this.node.lock!.serviceTime);
  }

  /**
   * One round trip to the lock service.
   *
   * Returns success or failure of the CALL, not of the lease. Whether the lease was
   * granted is the kernel's answer, and the caller applies the operation to the world
   * state after this returns. Conflating the two would make a contended lease look
   * like a failed request, and contention is normal.
   */
  *handle(ctx: RequestCtx): Process<Outcome> {
    const cfg = this.node.lock!;
    const env = this.env;
    const enqueuedAt = env.sim.now;

    const slot = yield* acquire(this.resource, ctx.deadlineAt);
    if (!slot.granted) {
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          null,
          env.sim.now,
          slot.reason === "shed" ? "shed" : "timeout"
        );
      }
      return { ok: false, reason: slot.reason ?? "timeout" };
    }

    try {
      if (env.measuring()) this.waitTime.record(slot.waitedMs);
      const serviceStart = env.sim.now;
      const serviceMs = Math.max(
        MIN_SERVICE_MS,
        sample(cfg.serviceTime, env.rng.stream("service")) * ctx.serviceMultiplier
      );
      const served = yield* delay(serviceMs, ctx.deadlineAt);
      this.recordSelfTime(slot.waitedMs, env.sim.now - serviceStart);
      if (ctx.traced) {
        env.trace.visit(
          ctx.requestId,
          this.node.id,
          enqueuedAt,
          serviceStart,
          env.sim.now,
          served.timedOut ? "timeout" : "served"
        );
      }
      if (served.timedOut) return { ok: false, reason: "timeout" };
      if (cfg.failureProbability > 0 && env.rng.stream("failure").chance(cfg.failureProbability)) {
        return { ok: false, reason: "error" };
      }
      return OK;
    } finally {
      this.resource.release();
      this.recordResidency(enqueuedAt);
    }
  }

  // ---- bookkeeping driven by the kernel ----------------------------------
  //
  // These are called by the workflow executor after the kernel has decided what
  // happened, so the counts here describe lease SEMANTICS while the station above
  // describes lease COST. Keeping them as explicit notifications rather than having
  // this class infer them from its own traffic is what stops the two from drifting.

  noteAcquireAttempt(): void {
    if (this.env.measuring()) this.acquireAttempts++;
  }

  noteAcquired(): void {
    this.touchHeld();
    this.held++;
    if (this.held > this.peakHeld) this.peakHeld = this.held;
    if (this.env.measuring()) this.acquired++;
  }

  noteContended(): void {
    if (this.env.measuring()) this.contended++;
  }

  noteReleased(heldMs: number): void {
    this.touchHeld();
    if (this.held > 0) this.held--;
    if (this.env.measuring()) {
      this.released++;
      this.heldTime.record(Math.max(0, heldMs));
    }
  }

  noteExpired(heldMs: number): void {
    this.touchHeld();
    if (this.held > 0) this.held--;
    if (this.env.measuring()) {
      this.expired++;
      this.heldTime.record(Math.max(0, heldMs));
    }
  }

  noteStaleOwnerRejection(): void {
    if (this.env.measuring()) this.staleOwnerRejections++;
  }

  /** Fold elapsed time into the time-weighted held-lease integral. */
  private touchHeld(): void {
    const now = this.env.sim.now;
    this.heldIntegral += this.held * (now - this.lastHeldT);
    this.lastHeldT = now;
  }

  override load(): number {
    return this.resource.inServiceCount + this.resource.queueLength;
  }

  override resetStats(): void {
    super.resetStats();
    this.acquireAttempts = 0;
    this.acquired = 0;
    this.contended = 0;
    this.released = 0;
    this.expired = 0;
    this.staleOwnerRejections = 0;
    this.waitTime.reset();
    this.heldTime.reset();
    // `held` is NOT reset: leases outstanding at the warm-up boundary are really
    // outstanding, and zeroing the count would make the release that follows
    // underflow. Peak and the integral restart from the current occupancy for the
    // same reason the resource keeps its `*AtStart` terms.
    this.peakHeld = this.held;
    this.heldIntegral = 0;
    this.lastHeldT = this.env.sim.now;
    this.heldSeries.reset();
  }

  override sample(tSec: number): void {
    super.sample(tSec);
    this.heldSeries.push(tSec, this.held);
  }

  override result(observedSec: number): NodeResult {
    const base = super.result(observedSec);
    const cfg = this.node.lock!;
    this.touchHeld();
    const observedMs = observedSec * 1000;
    const lock: LockMetrics = {
      acquireAttempts: this.acquireAttempts,
      acquired: this.acquired,
      contended: this.contended,
      released: this.released,
      expired: this.expired,
      staleOwnerRejections: this.staleOwnerRejections,
      fencingEnabled: cfg.fencingTokens,
      waitMs: summarize(this.waitTime),
      heldMs: summarize(this.heldTime),
      avgHeld: observedMs > 0 ? this.heldIntegral / observedMs : 0,
      peakHeld: this.peakHeld,
    };
    return { ...base, lock, queueLengthSeries: series(this.heldSeries) };
  }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function buildComponent(node: SdsNode, env: ComponentEnv): Component | null {
  switch (node.kind) {
    case "server":
      return new ServerComponent(node, env);
    case "loadbalancer":
      return new LoadBalancerComponent(node, env);
    case "cache":
      return new CacheComponent(node, env);
    case "database":
      return new DatabaseComponent(node, env);
    case "queue":
      return new QueueComponent(node, env);
    case "gateway":
      return new GatewayComponent(node, env);
    case "lock":
      return new LockComponent(node, env);
    case "client":
      return null; // clients originate work; they are not a station
  }
}

export const STATION_KINDS: NodeKind[] = [
  "server",
  "loadbalancer",
  "cache",
  "database",
  "queue",
  "gateway",
  "lock",
];

export { callDependencies, callThrough, eligibleEdges };
