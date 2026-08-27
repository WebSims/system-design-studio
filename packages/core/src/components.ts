import type { Design, NodeKind, SdsEdge, SdsNode } from "@sds/schema";
import { mean as distMean, sample, scv } from "./distribution";
import { LatencyHistogram } from "./histogram";
import { Resource } from "./resource";
import type { RngBundle } from "./rng";
import { Sim, acquire, delay, suspend, type Process } from "./sim";
import { TimeSeries } from "./timeseries";
import { ZipfSampler } from "./zipf";
import type {
  CacheMetrics,
  InvariantReport,
  DatabaseMetrics,
  ErrorReason,
  LatencySummary,
  LoadBalancerMetrics,
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
    outcome: "served" | "shed" | "timeout" | "hit" | "miss"
  ): void;
  canTrace(): boolean;
}

export interface ComponentEnv {
  sim: Sim;
  rng: RngBundle;
  design: Design;
  components: Map<string, Component>;
  outgoing: Map<string, SdsEdge[]>;
  trace: TraceSink;
  /** True once warm-up is over. Components record nothing before that. */
  measuring: () => boolean;
}

export interface Component {
  readonly node: SdsNode;
  handle(ctx: RequestCtx): Process<Outcome>;
  /** Requests currently queued or in service. Used by load-balancer algorithms. */
  load(): number;
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

  resetStats(): void {
    this.resource.resetStats();
    this.queueSeries.reset();
    this.utilSeries.reset();
    this.residency.reset();
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
 * Traverse an edge, invoke the target, and come back.
 *
 * BOTH DIRECTIONS COST NETWORK TIME.
 *
 * A request/response pair crosses the wire twice, so edge latency is applied
 * twice. This is why edge latency is documented as one-way: entering a round-trip
 * figure would double-count it. It matters as soon as a design spans zones -- a
 * five-hop path across 1ms links is 10ms of pure network, which is most of a
 * cache's budget and none of a database's.
 */
function* callThrough(env: ComponentEnv, edge: SdsEdge, ctx: RequestCtx): Process<Outcome> {
  const netRng = env.rng.stream("network");
  const lossRng = env.rng.stream("failure");

  // ---- request leg ----
  const outStart = env.sim.now;
  const outWait = yield* delay(sample(edge.latency, netRng), ctx.deadlineAt);
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
  const outcome = yield* target.handle(ctx);
  if (!outcome.ok) return outcome;

  // ---- response leg ----
  const backStart = env.sim.now;
  const backWait = yield* delay(sample(edge.latency, netRng), ctx.deadlineAt);
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

  if (chosen.length === 1) {
    return yield* callThrough(env, chosen[0]!, ctx);
  }

  if (fanout === "sequential") {
    for (const e of chosen) {
      const outcome = yield* callThrough(env, e, ctx);
      if (!outcome.ok) return outcome;
    }
    return OK;
  }

  const results = yield* env.sim.joinAll(chosen.map((e) => callThrough(env, e, ctx)));
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
      if (served.timedOut) {
        if (ctx.traced) {
          env.trace.visit(ctx.requestId, this.node.id, enqueuedAt, serviceStart, env.sim.now, "timeout");
        }
        return { ok: false, reason: "timeout" };
      }

      // A non-blocking runtime hands the slot back before waiting on I/O. A
      // thread-per-request server cannot, which is what makes it vulnerable to a
      // slow dependency.
      if (!cfg.blocksOnDependencies) release();

      const downstream = yield* callDependencies(env, this.node.id, ctx, cfg.fanout);
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
}

// ---------------------------------------------------------------------------
// load balancer
// ---------------------------------------------------------------------------

export class LoadBalancerComponent extends StationComponent {
  private rrIndex = 0;
  private dispatched = new Map<string, number>();
  private dispatchTotal = 0;

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
      if (served.timedOut) return { ok: false, reason: "timeout" };

      const eligible = eligibleEdges(env, this.node.id, ctx);
      if (eligible.length === 0) return OK;

      const edge = this.select(eligible);
      if (env.measuring()) {
        this.dispatched.set(edge.to, (this.dispatched.get(edge.to) ?? 0) + 1);
        this.dispatchTotal++;
      }

      const outcome = yield* callThrough(env, edge, ctx);
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
    const backends = (this.env.outgoing.get(this.node.id) ?? []).map((e) => {
      const count = this.dispatched.get(e.to) ?? 0;
      return {
        nodeId: e.to,
        label: this.env.components.get(e.to)?.node.label ?? e.to,
        dispatched: count,
        sharePct: this.dispatchTotal > 0 ? (count / this.dispatchTotal) * 100 : 0,
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
  private readonly backlogSeries: TimeSeries;

  private backlogIntegral = 0;
  private busyIntegral = 0;
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

  resetStats(): void {
    this.touch();
    this.enqueued = 0;
    this.consumed = 0;
    this.dropped = 0;
    this.backlogAge.reset();
    this.backlogSeries.reset();
    this.backlogIntegral = 0;
    this.busyIntegral = 0;
    this.statsStart = this.env.sim.now;
    this.maxBacklog = this.depth;
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
    const published = yield* delay(publishMs, ctx.deadlineAt);
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
    // A message is enqueued, dropped, still waiting, or being worked on. Nothing
    // else, and never twice. Consumers run forever, so `consumed` lags by whatever
    // is in flight when the clock stops.
    const accounted = this.consumed + this.depth + this.inFlight;
    const passed = accounted <= this.enqueued + this.depth && this.consumed <= this.enqueued + this.depth;
    return [
      {
        name: `queue "${this.node.label}" bookkeeping`,
        passed,
        detail: passed
          ? `${this.enqueued} enqueued, ${this.consumed} consumed, ${this.depth} waiting, ` +
            `${this.inFlight} in flight, ${this.dropped} dropped`
          : `consumed ${this.consumed} exceeds what was enqueued (${this.enqueued})`,
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
      queueLengthSeries: series(this.backlogSeries),
      utilizationSeries: { name: "utilization", points: [] },
      queue,
    };
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
];

export { callDependencies, callThrough, eligibleEdges };
