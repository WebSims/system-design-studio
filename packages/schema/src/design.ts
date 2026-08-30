import { z } from "zod";

/**
 * Upper bounds on the fields that drive the closed-form solvers' loop counts.
 *
 * These are not taste. The Erlang recursions and the M/M/c/K state enumeration are
 * O(c) and O(c+k), and the live preview evaluates them per station, per request class,
 * inside a fixed-point loop. A concurrency of 1e9 typed into the inspector therefore did
 * not merely produce a slow estimate — it froze the studio permanently, on the main
 * thread, with no way back.
 *
 * The limits are set where the model stops describing anything real. A single station
 * holding a million requests in service at once, or a queue with a million waiters, is
 * already past any system these numbers would help you reason about.
 *
 * `MAX_EFFECTIVE_CONCURRENCY` is checked separately in `validateDesign`, because the
 * quantity that reaches the solver is a PRODUCT — `concurrency * replicas` — and
 * bounding each factor on its own still permits a product that is not solvable.
 */
export const MAX_CONCURRENCY = 1_000_000;
export const MAX_REPLICAS = 10_000;
export const MAX_QUEUE_CAPACITY = 1_000_000;
export const MAX_EFFECTIVE_CONCURRENCY = 1_000_000;

/**
 * A service-time / latency distribution.
 *
 * Every duration in the model is a distribution, never a scalar. This is the
 * single most important schema decision: the legacy engine used fixed constants
 * with a +/-30% multiplicative fudge, which produces neither a real mean nor a
 * real tail, so percentiles were meaningless.
 *
 * All durations are in MILLISECONDS.
 */
export const DistributionSchema = z.discriminatedUnion("kind", [
  /** Constant. Useful for tests and for deterministic protocol overheads. */
  z.object({ kind: z.literal("deterministic"), value: z.number().nonnegative() }),
  /** Exponential, mean = `mean`. The M/M/* service assumption. */
  z.object({ kind: z.literal("exponential"), mean: z.number().positive() }),
  /**
   * Lognormal expressed by the moments people actually know: the mean and the
   * p99. Real service times are roughly lognormal; asking an engineer for
   * (mu, sigma) of the underlying normal is asking them to do algebra.
   */
  z.object({
    kind: z.literal("lognormal"),
    mean: z.number().positive(),
    p99: z.number().positive(),
  }),
  z.object({
    kind: z.literal("uniform"),
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  /** Heavy tail. `alpha` <= 2 has infinite variance, <= 1 infinite mean. */
  z.object({
    kind: z.literal("pareto"),
    scale: z.number().positive(),
    alpha: z.number().positive(),
  }),
]);
export type Distribution = z.infer<typeof DistributionSchema>;

/**
 * What a station does when its queue is full.
 *
 * `shed` rejects immediately: bounded latency, visible errors, and the
 * analytically tractable case (M/M/c/K with loss).
 *
 * `block` waits anyway, which makes `queueCapacity` advisory. That is not a
 * cop-out: in an open-loop arrival process there is no upstream buffer to apply
 * back-pressure to, so "blocking" can only mean queueing regardless. Modelled
 * honestly instead of pretending back-pressure exists where the topology
 * provides none.
 */
export const AdmissionPolicySchema = z.enum(["shed", "block"]);
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;

export const QueueDisciplineSchema = z.enum(["fifo", "lifo"]);
export type QueueDiscipline = z.infer<typeof QueueDisciplineSchema>;

export const NodeKindSchema = z.enum([
  "client",
  "loadbalancer",
  "server",
  "cache",
  "database",
  "queue",
  "gateway",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/**
 * A cited constant.
 *
 * Every default in the benchmark library carries its provenance, and the UI
 * renders it. The alternative is what the legacy engine did: a server took 34ms
 * because `PROCMS.server = 34`, with no way for a reader to tell whether that was
 * measured, remembered, or invented. For a tool whose output is meant to be
 * defended in a design review, an un-sourced constant is a liability.
 */
export const CitationSchema = z.object({
  /** Plausible range, not a confidence interval: reality varies by deployment. */
  range: z.tuple([z.number(), z.number()]).optional(),
  source: z.string(),
  asOf: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

// ---------------------------------------------------------------------------
// request classes
// ---------------------------------------------------------------------------

/**
 * A named kind of request.
 *
 * Exists so "3% of traffic hits the expensive endpoint" is expressible. The
 * legacy engine had no such concept and sent every request down every outgoing
 * edge of a node unconditionally, which silently invented a workload the user
 * never described.
 *
 * `serviceMultiplier` scales service demand at every station the class visits, so
 * a "heavy" class can be defined once rather than per node.
 */
export const RequestClassSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  /** Relative share of traffic. Normalised across classes at run time. */
  weight: z.number().positive().default(1),
  serviceMultiplier: z.number().positive().default(1),
});
export type RequestClass = z.infer<typeof RequestClassSchema>;

// ---------------------------------------------------------------------------
// node configs
// ---------------------------------------------------------------------------

/**
 * How work arrives at the system.
 *
 * The first two are stationary: the rate never changes, so the system has a steady
 * state and aggregate percentiles mean something.
 *
 * The rest are TIME-VARYING, and that changes what can honestly be reported. A
 * design under a ramp has no steady state by construction, so a single p99 over the
 * whole run is an average across regimes that never coexisted -- part of it measured
 * at 100/s and part at 1000/s. For those, the tool reports the time series and the
 * moment the SLO first broke, and says why it is withholding the aggregate.
 *
 * They are worth having anyway, because they answer questions a steady-state run
 * cannot: how far a design gets before it breaks, whether it survives a spike, and
 * whether it recovers afterwards.
 */
export const ArrivalProcessSchema = z.discriminatedUnion("kind", [
  /**
   * Poisson: exponential inter-arrival times, mean 1/rate. The M/M/*
   * arrival assumption and the correct default for independent users.
   */
  z.object({ kind: z.literal("poisson"), ratePerSec: z.number().positive() }),
  /** Perfectly spaced arrivals. Strictly better than Poisson at the same rate. */
  z.object({ kind: z.literal("deterministic"), ratePerSec: z.number().positive() }),
  /**
   * Linear ramp across the whole run.
   *
   * A load test in one run: the offered rate rises steadily and the first SLO breach
   * marks the capacity limit. Its answer runs slightly HIGH compared with a
   * steady-state search, because queues take time to fill -- the system is still
   * catching up with the load when the load has already moved on. That lag is real
   * and is reported rather than corrected away.
   */
  z.object({
    kind: z.literal("ramp"),
    fromRatePerSec: z.number().nonnegative(),
    toRatePerSec: z.number().positive(),
  }),
  /**
   * A steady base with a burst in the middle.
   *
   * Tests two things a ramp cannot: whether the design survives a sudden multiple of
   * normal load, and how long it takes to drain afterwards. Recovery time is often
   * the more interesting number, because a queue built during a spike keeps hurting
   * requests that arrive after it has passed.
   */
  z.object({
    kind: z.literal("spike"),
    baseRatePerSec: z.number().positive(),
    peakRatePerSec: z.number().positive(),
    /** When the spike starts, simulated seconds from t=0. */
    atSec: z.number().nonnegative(),
    durationSec: z.number().positive(),
  }),
  /** Piecewise-constant rate. Each step takes effect at its time and holds. */
  z.object({
    kind: z.literal("steps"),
    ratePerSec: z.number().positive(),
    steps: z
      .array(z.object({ atSec: z.number().nonnegative(), ratePerSec: z.number().positive() }))
      .default([]),
  }),
]);
export type ArrivalProcess = z.infer<typeof ArrivalProcessSchema>;

/** True when the rate changes over time, so there is no steady state. */
export function isTimeVarying(arrival: ArrivalProcess): boolean {
  return arrival.kind === "ramp" || arrival.kind === "spike" || arrival.kind === "steps";
}

/** Offered rate at simulated time `tMs`, for any arrival process. */
export function rateAt(arrival: ArrivalProcess, tMs: number, durationMs: number): number {
  switch (arrival.kind) {
    case "poisson":
    case "deterministic":
      return arrival.ratePerSec;
    case "ramp": {
      const progress = durationMs > 0 ? Math.min(1, Math.max(0, tMs / durationMs)) : 0;
      return arrival.fromRatePerSec + (arrival.toRatePerSec - arrival.fromRatePerSec) * progress;
    }
    case "spike": {
      const startMs = arrival.atSec * 1000;
      const endMs = startMs + arrival.durationSec * 1000;
      return tMs >= startMs && tMs < endMs ? arrival.peakRatePerSec : arrival.baseRatePerSec;
    }
    case "steps": {
      let rate = arrival.ratePerSec;
      for (const step of arrival.steps) {
        if (tMs >= step.atSec * 1000) rate = step.ratePerSec;
      }
      return rate;
    }
  }
}

/**
 * Scale every rate in an arrival process by the same factor.
 *
 * Shape-preserving on purpose: scaling a ramp keeps it a ramp with the same slope
 * ratio, and scaling a spike keeps its peak-to-base ratio. A knee search that
 * flattened the profile while scaling it would be changing two things at once and
 * attributing the result to load alone.
 */
export function scaleArrival(arrival: ArrivalProcess, factor: number): ArrivalProcess {
  const f = Math.max(1e-9, factor);
  switch (arrival.kind) {
    case "poisson":
    case "deterministic":
      return { ...arrival, ratePerSec: Math.max(0.01, arrival.ratePerSec * f) };
    case "ramp":
      return {
        ...arrival,
        fromRatePerSec: arrival.fromRatePerSec * f,
        toRatePerSec: Math.max(0.01, arrival.toRatePerSec * f),
      };
    case "spike":
      return {
        ...arrival,
        baseRatePerSec: Math.max(0.01, arrival.baseRatePerSec * f),
        peakRatePerSec: Math.max(0.01, arrival.peakRatePerSec * f),
      };
    case "steps":
      return {
        ...arrival,
        ratePerSec: Math.max(0.01, arrival.ratePerSec * f),
        steps: arrival.steps.map((st) => ({
          ...st,
          ratePerSec: Math.max(0.01, st.ratePerSec * f),
        })),
      };
  }
}

/** Highest rate the process ever offers. Needed to bound thinning. */
export function peakRate(arrival: ArrivalProcess): number {
  switch (arrival.kind) {
    case "poisson":
    case "deterministic":
      return arrival.ratePerSec;
    case "ramp":
      return Math.max(arrival.fromRatePerSec, arrival.toRatePerSec);
    case "spike":
      return Math.max(arrival.baseRatePerSec, arrival.peakRatePerSec);
    case "steps":
      return Math.max(arrival.ratePerSec, ...arrival.steps.map((s) => s.ratePerSec));
  }
}

/** Time-average rate over a run of `durationMs`. Used for reporting offered load. */
export function meanRate(arrival: ArrivalProcess, durationMs: number): number {
  switch (arrival.kind) {
    case "poisson":
    case "deterministic":
      return arrival.ratePerSec;
    case "ramp":
      return (arrival.fromRatePerSec + arrival.toRatePerSec) / 2;
    case "spike": {
      const spikeMs = Math.min(durationMs, arrival.durationSec * 1000);
      const baseMs = Math.max(0, durationMs - spikeMs);
      return durationMs > 0
        ? (arrival.baseRatePerSec * baseMs + arrival.peakRatePerSec * spikeMs) / durationMs
        : arrival.baseRatePerSec;
    }
    case "steps": {
      // Integrate the piecewise-constant rate over the run.
      const points = [{ atSec: 0, ratePerSec: arrival.ratePerSec }, ...arrival.steps].sort(
        (a, b) => a.atSec - b.atSec
      );
      let area = 0;
      for (let i = 0; i < points.length; i++) {
        const startMs = points[i]!.atSec * 1000;
        if (startMs >= durationMs) break;
        const endMs = i + 1 < points.length ? Math.min(durationMs, points[i + 1]!.atSec * 1000) : durationMs;
        area += points[i]!.ratePerSec * Math.max(0, endMs - startMs);
      }
      return durationMs > 0 ? area / durationMs : arrival.ratePerSec;
    }
  }
}

/**
 * A population of long-lived connections.
 *
 * EVERYTHING ELSE IN THIS MODEL IS A REQUEST THAT ARRIVES AND LEAVES. A CONNECTION
 * IS NOT.
 *
 * A WebSocket sits open for minutes or hours, occupying a file descriptor and a
 * memory buffer the whole time. That makes the binding constraint completely
 * different from a request/response service: the question is not how many requests
 * per second a box can serve but how many sockets it can hold, and the failure is a
 * refused connection rather than a slow response.
 *
 * Modelling it needs a resource held across a session rather than across a service
 * time, which is why this arrives as its own concept instead of a large concurrency
 * number on a server.
 */
export const ConnectionPopulationSchema = z.object({
  /** Concurrent connections this population maintains. */
  count: z.number().int().positive(),
  /**
   * Seconds over which the initial connections are established.
   *
   * Not zero, and not cosmetic. Opening twenty thousand sockets in the same instant
   * is a thundering herd that no real deployment experiences at start-up, and letting
   * it happen would make every run begin with an artificial handshake storm that has
   * nothing to do with the design.
   */
  establishOverSec: z.number().positive().default(30),
  /**
   * Session length before a client reconnects. Null means connections never drop.
   *
   * Real sessions end -- tab closed, network changed, phone slept -- and each ending
   * is a new handshake for someone to pay for. A model where connections are
   * established once and held forever understates accept work by however often
   * reality churns.
   */
  sessionDuration: DistributionSchema.nullable().default(null),
  /**
   * A mass disconnection partway through the run.
   *
   * The failure mode that actually takes realtime systems down. When a gateway dies,
   * every connection it held reconnects at once, and the surviving gateways receive a
   * handshake burst far larger than their steady-state accept load -- while still
   * serving everyone they already had. Modelling it is the difference between knowing
   * a design holds 20,000 connections and knowing it survives losing a third of them.
   */
  disruption: z
    .object({
      atSec: z.number().nonnegative(),
      /** Share of connections dropped, [0,1]. */
      fraction: z.number().min(0).max(1),
      /** Seconds over which the dropped connections come back. 0 = all at once. */
      reconnectOverSec: z.number().nonnegative().default(0),
    })
    .nullable()
    .default(null),
});
export type ConnectionPopulation = z.infer<typeof ConnectionPopulationSchema>;

export const ClientConfigSchema = z.object({
  /**
   * Message arrival process.
   *
   * With a connection population this is the TOTAL message rate across all
   * connections, not a per-connection figure. Keeping it a plain total means every
   * existing tool -- load scaling, the knee search, ramps -- keeps working unchanged
   * on a realtime design.
   */
  arrival: ArrivalProcessSchema,
  /** Per-request end-to-end budget, ms. Null = no deadline. */
  timeoutMs: z.number().positive().nullable().default(null),
  /** Long-lived connections this client holds, in addition to sending messages. */
  connections: ConnectionPopulationSchema.nullable().default(null),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

/**
 * A capacity-limited service station.
 *
 * `concurrency` is the `c` in M/M/c: how many requests can be *in service*
 * simultaneously. `queueCapacity` is how many may wait. Their absence in the
 * legacy engine is why it could never surface a bottleneck: with unbounded
 * concurrency there is no contention, and without contention latency is
 * independent of load.
 */
export const ServerConfigSchema = z.object({
  concurrency: z.number().int().positive().max(MAX_CONCURRENCY),
  /** Null = unbounded queue (the M/M/c assumption). */
  queueCapacity: z.number().int().nonnegative().max(MAX_QUEUE_CAPACITY).nullable().default(null),
  serviceTime: DistributionSchema,
  admissionPolicy: AdmissionPolicySchema.default("block"),
  queueDiscipline: QueueDisciplineSchema.default("fifo"),
  /**
   * Independent identical instances behind this node. Total capacity is
   * `replicas * concurrency`; modelled as one station with c = r*c so that
   * closed-form M/M/c applies exactly.
   */
  replicas: z.number().int().positive().max(MAX_REPLICAS).default(1),
  /**
   * How this station calls its dependencies.
   *
   * `parallel` is fork-join: all calls issue at once and the request waits for
   * the slowest. `sequential` adds them up. The difference is large and it is a
   * genuine architectural choice, so it is explicit rather than assumed.
   */
  fanout: z.enum(["parallel", "sequential"]).default("parallel"),
  /**
   * Whether a request keeps occupying a concurrency slot while it waits on
   * dependencies.
   *
   * TRUE models thread-per-request with blocking I/O: a worker is tied up for the
   * whole downstream call. This is the mechanism by which a slow dependency
   * exhausts its caller's worker pool and a local slowdown becomes a system-wide
   * outage -- the most common shape of a real cascading failure.
   *
   * FALSE models a non-blocking runtime, where the slot covers only the station's
   * own CPU work and the continuation is cheap. A chain of such stations is a
   * genuine Jackson network, so it is exactly solvable in closed form.
   *
   * The default is `true` because it is the more common deployment and the more
   * dangerous one. Getting this wrong in either direction changes the predicted
   * capacity of every caller in the graph.
   */
  blocksOnDependencies: z.boolean().default(true),
  /**
   * Probability a request fails at this station for reasons unrelated to load.
   *
   * Bugs, bad deploys, a dependency this model does not include. Kept separate
   * from the failures the model derives itself -- shedding, timeouts, drops --
   * because those are consequences of the design and this is an input to it.
   *
   * Without it there is nothing for a retry to retry or a circuit breaker to
   * trip on, which is why it arrives alongside them.
   */
  failureProbability: z.number().min(0).max(1).default(0),
  /**
   * Failure probability when the station is fully busy, interpolated linearly from
   * `failureProbability` at idle.
   *
   * Real services do not fail at a constant rate; they fail MORE when overloaded --
   * memory pressure, connection limits, timeouts inside code the model does not
   * see. That correlation is what makes a cascade self-reinforcing: load raises
   * failures, failures raise retries, retries raise load. With a constant failure
   * rate the loop has no gain and the worst outcome is a linear slowdown.
   *
   * Null means the rate does not vary with load, which is the conservative
   * assumption and remains the default.
   */
  failureAtSaturation: z.number().min(0).max(1).nullable().default(null),
  citation: CitationSchema.optional(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Load-balancer selection algorithms.
 *
 * The choice matters far more than intuition suggests. Random assignment to N
 * queues has maximum load growing like log n / log log n, while sampling two
 * queues and taking the shorter drops it to log log n -- the "power of two
 * choices" result. That is an exponential improvement from one extra probe, and
 * a tool that models only round-robin cannot show it.
 */
export const LbAlgorithmSchema = z.enum([
  "round-robin",
  "random",
  "least-connections",
  "power-of-two-choices",
]);
export type LbAlgorithm = z.infer<typeof LbAlgorithmSchema>;

/**
 * Passive health checking, also called outlier detection.
 *
 * Passive rather than active: health is inferred from the failures of real
 * traffic, not from a separate probe endpoint. That is both what most proxies
 * actually do and the more honest thing to model -- a probe endpoint frequently
 * reports healthy while real requests fail.
 *
 * Ejection is what makes a balancer more than a splitter. Without it, a broken
 * backend keeps receiving its full share of traffic forever, and the failures it
 * produces are exactly the ones that trigger retries elsewhere.
 */
export const HealthCheckSchema = z.object({
  enabled: z.boolean().default(false),
  /** Failure rate above which a backend is ejected, [0,1]. */
  failureThreshold: z.number().min(0).max(1).default(0.5),
  /** Minimum observations before a backend can be judged, to avoid ejecting on noise. */
  minimumRequests: z.number().int().positive().default(20),
  /** How long a backend stays ejected before being tried again, ms. */
  ejectionMs: z.number().positive().default(10_000),
  /**
   * Never eject more than this fraction of backends.
   *
   * The guard that stops health checking from causing the outage it is meant to
   * contain: under a shared failure -- a bad deploy, a dependency everyone uses --
   * every backend looks unhealthy at once, and ejecting them all removes the
   * capacity that was still partially working.
   */
  maxEjectedFraction: z.number().min(0).max(1).default(0.5),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const LoadBalancerConfigSchema = z.object({
  algorithm: LbAlgorithmSchema.default("round-robin"),
  /** The proxy's own overhead. Small, but it is not free and it can saturate. */
  serviceTime: DistributionSchema.default({ kind: "deterministic", value: 0.5 }),
  concurrency: z.number().int().positive().max(MAX_CONCURRENCY).default(1024),
  healthCheck: HealthCheckSchema.default({}),
  citation: CitationSchema.optional(),
});
export type LoadBalancerConfig = z.infer<typeof LoadBalancerConfigSchema>;

/**
 * Cache key population.
 *
 * `fixed` states a hit ratio outright, for when you have measured one.
 * `zipf` derives it from a key population and cache capacity, which is what
 * lets the tool answer "how much cache do I need?" rather than requiring the
 * answer as input. Real access patterns are close to Zipf, and skew is the whole
 * reason small caches work at all.
 */
export const KeyspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), hitRatio: z.number().min(0).max(1) }),
  z.object({
    kind: z.literal("zipf"),
    /** Distinct keys in the population. */
    keys: z.number().int().positive(),
    /** Zipf exponent. 0 = uniform, ~1 is typical for web workloads. */
    skew: z.number().min(0).default(0.9),
  }),
]);
export type Keyspace = z.infer<typeof KeyspaceSchema>;

export const CacheConfigSchema = z.object({
  /** Entries the cache holds before evicting. Ignored for a fixed hit ratio. */
  capacity: z.number().int().positive().max(MAX_QUEUE_CAPACITY).default(10_000),
  keyspace: KeyspaceSchema.default({ kind: "zipf", keys: 100_000, skew: 0.9 }),
  /** Time to serve a hit. */
  serviceTime: DistributionSchema.default({ kind: "deterministic", value: 0.2 }),
  concurrency: z.number().int().positive().max(MAX_CONCURRENCY).default(512),
  /** Entry lifetime, ms. Null = no expiry. */
  ttlMs: z.number().positive().nullable().default(null),
  citation: CitationSchema.optional(),
});
export type CacheConfig = z.infer<typeof CacheConfigSchema>;

/**
 * A database, modelled as TWO nested resources.
 *
 * A connection pool caps concurrent connections; inside it, the engine can only
 * execute so many queries at once (cores, disk queue depth). Separating them
 * matters because it explains the most common capacity mistake in practice:
 * raising the pool size does NOT raise throughput once execution is the
 * constraint, it only converts pool-wait into execution-wait and lengthens the
 * queue. Total capacity is `parallelism / serviceTime`, whatever the pool size.
 *
 * Collapsing the two into one number, as a single-resource model must, makes that
 * effect impossible to see and "just increase the pool" look like a fix.
 */
export const DatabaseConfigSchema = z.object({
  poolSize: z.number().int().positive().max(MAX_CONCURRENCY).default(20),
  /** Queries genuinely executing at once. Usually cores, or disk queue depth. */
  parallelism: z.number().int().positive().max(MAX_CONCURRENCY).default(8),
  serviceTime: DistributionSchema,
  /** Waiters allowed on the pool. Null = unbounded. */
  queueCapacity: z.number().int().nonnegative().max(MAX_QUEUE_CAPACITY).nullable().default(null),
  admissionPolicy: AdmissionPolicySchema.default("block"),
  /** Probability a query fails for reasons unrelated to load. */
  failureProbability: z.number().min(0).max(1).default(0),
  /** Failure probability at full execution utilization. See `ServerConfig`. */
  failureAtSaturation: z.number().min(0).max(1).nullable().default(null),
  citation: CitationSchema.optional(),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/**
 * An asynchronous queue.
 *
 * THE IMPORTANT PROPERTY IS THAT PUBLISHING RETURNS IMMEDIATELY.
 *
 * A queue is a decoupling boundary: the caller's latency includes the publish,
 * not the consumer's work. Modelling it synchronously (as the legacy engine did,
 * fanning out to consumers and then returning) misses the entire point of having
 * one, and hides the failure mode that actually bites -- a backlog that grows
 * without bound while every request still looks fast.
 *
 * So the queue reports its own health separately: backlog depth, backlog age, and
 * whether consumers are keeping up.
 */
export const QueueConfigSchema = z.object({
  /** Messages the queue can hold. Null = unbounded. */
  maxDepth: z.number().int().positive().nullable().default(null),
  /** Consumers draining it. This is the queue's service capacity. */
  consumers: z.number().int().positive().max(MAX_CONCURRENCY).default(1),
  /** Time for one consumer to handle one message. */
  consumerServiceTime: DistributionSchema.default({ kind: "exponential", mean: 50 }),
  /** Publish overhead paid by the caller. */
  publishTime: DistributionSchema.default({ kind: "deterministic", value: 1 }),
  citation: CitationSchema.optional(),
});
export type QueueConfig = z.infer<typeof QueueConfigSchema>;

/**
 * A realtime gateway: the thing that holds the sockets.
 *
 * Two capacities, and they constrain different things:
 *
 *   `connectionCapacity` is how many sockets one instance can hold at once -- file
 *   descriptors, and the memory each connection's buffers occupy. This is what
 *   "20,000 concurrent users" is really asking about, and it has nothing to do with
 *   throughput.
 *
 *   `pushConcurrency` is how much work the instance can do at once, whether accepting
 *   a handshake or delivering a message. A gateway can be holding its full complement
 *   of idle sockets while entirely unable to keep up with delivery, or the reverse.
 *
 * Conflating them is the standard mistake, and it produces confident answers to the
 * wrong question.
 */
export const GatewayConfigSchema = z.object({
  /** Sockets ONE instance can hold. */
  connectionCapacity: z.number().int().positive().max(50_000_000).default(10_000),
  replicas: z.number().int().positive().max(MAX_REPLICAS).default(1),
  /**
   * Handshake cost: TLS, auth, session setup.
   *
   * Far more expensive than a message, which is why a reconnect storm hurts so much
   * more than an equivalent burst of traffic.
   */
  acceptTime: DistributionSchema.default({ kind: "lognormal", mean: 5, p99: 40 }),
  /** Cost of pushing one message to one connection. */
  pushTime: DistributionSchema.default({ kind: "deterministic", value: 0.05 }),
  /**
   * Concurrent work slots per instance, shared between accepts and pushes.
   *
   * Small on purpose. A gateway's push work is CPU-bound serialization and socket
   * writes on an event loop, so the honest figure is single digits per instance -- not
   * the hundreds that a connection count invites. Setting it high is the mistake that
   * makes fan-out look free: twenty thousand deliveries a second against two hundred
   * slots is nothing, and against eight it is half the machine.
   */
  pushConcurrency: z.number().int().positive().max(MAX_CONCURRENCY).default(4),
  /** Memory per held connection, for a footprint estimate. Zero for a push-only station. */
  memoryPerConnectionKb: z.number().nonnegative().default(40),
  citation: CitationSchema.optional(),
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const NodeSchema = z.object({
  id: z.string().min(1),
  kind: NodeKindSchema,
  label: z.string(),
  /** Canvas position. Purely presentational; the engine ignores it. */
  x: z.number(),
  y: z.number(),
  client: ClientConfigSchema.optional(),
  server: ServerConfigSchema.optional(),
  loadbalancer: LoadBalancerConfigSchema.optional(),
  cache: CacheConfigSchema.optional(),
  database: DatabaseConfigSchema.optional(),
  queue: QueueConfigSchema.optional(),
  gateway: GatewayConfigSchema.optional(),
});
export type SdsNode = z.infer<typeof NodeSchema>;

// ---------------------------------------------------------------------------
// call policies
// ---------------------------------------------------------------------------

/**
 * Which failures are worth retrying.
 *
 * Retrying the wrong thing is worse than not retrying. A shed request means the
 * dependency is already over capacity, so retrying it adds load to something that
 * just said it had none -- the textbook way to convert a brownout into an outage.
 * A timeout is ambiguous: the work may have completed, so retrying a
 * non-idempotent operation can double-apply it.
 */
export const RetryableReasonSchema = z.enum(["error", "timeout", "shed", "network"]);
export type RetryableReason = z.infer<typeof RetryableReasonSchema>;

export const BackoffSchema = z.object({
  kind: z.enum(["none", "fixed", "exponential"]).default("exponential"),
  baseMs: z.number().nonnegative().default(20),
  maxMs: z.number().nonnegative().default(1000),
  /**
   * Randomise each delay over [0, computed].
   *
   * Not cosmetic. Without jitter, every client that failed at the same instant
   * retries at the same instant, so the recovering dependency is hit by a
   * synchronised wave and fails again. Jitter is what turns a thundering herd back
   * into a Poisson process, and it costs nothing.
   */
  jitter: z.boolean().default(true),
});
export type Backoff = z.infer<typeof BackoffSchema>;

export const RetryPolicySchema = z.object({
  /** TOTAL attempts including the first. 1 means no retrying. */
  maxAttempts: z.number().int().min(1).default(3),
  backoff: BackoffSchema.default({}),
  retryOn: z.array(RetryableReasonSchema).default(["error", "timeout"]),
  /**
   * Retry budget: the share of extra calls retries may add, as a fraction of
   * original calls. Null disables the cap.
   *
   * THE SINGLE MOST IMPORTANT FIELD IN THIS FILE.
   *
   * Unbudgeted retries multiply load on a struggling dependency by the attempt
   * count exactly when it can least afford it, and each layer multiplies again:
   * three tiers retrying three times is 27x. A budget makes retries a bounded tax
   * on the healthy case rather than an amplifier of the unhealthy one. 10% is the
   * conventional starting point.
   */
  budgetRatio: z.number().min(0).nullable().default(0.1),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * A circuit breaker over one caller-to-dependency edge.
 *
 * Its purpose is not to protect the dependency; it is to stop the CALLER from
 * spending its own capacity waiting on something that is already failing. A
 * blocking caller with a dead dependency ties up a worker per request for the
 * whole timeout, and that is how a downstream failure becomes an upstream outage.
 * Failing fast returns those workers immediately.
 */
export const CircuitBreakerSchema = z.object({
  enabled: z.boolean().default(false),
  /** Failure rate over the window that opens the circuit, [0,1]. */
  failureThreshold: z.number().min(0).max(1).default(0.5),
  /** Observations required before the rate is trusted. */
  minimumRequests: z.number().int().positive().default(20),
  /** Rolling window the failure rate is measured over, ms. */
  windowMs: z.number().positive().default(10_000),
  /** How long the circuit stays open before probing again, ms. */
  openMs: z.number().positive().default(5000),
  /** Concurrent probes allowed while half-open. */
  halfOpenProbes: z.number().int().positive().default(1),
});
export type CircuitBreaker = z.infer<typeof CircuitBreakerSchema>;

/**
 * A bulkhead: a cap on concurrent outstanding calls to one dependency.
 *
 * The direct fix for the failure mode a blocking caller creates. Without one, a
 * dependency that slows from 10ms to 2s consumes every worker the caller has, and
 * requests that do not even touch that dependency start queueing behind the ones
 * that do. A bulkhead confines the damage to the traffic that needs the slow
 * dependency, which is the definition of graceful degradation.
 */
export const BulkheadSchema = z.object({
  enabled: z.boolean().default(false),
  maxConcurrent: z.number().int().positive().max(MAX_CONCURRENCY).default(16),
  /** Waiters allowed for a bulkhead slot. 0 means reject immediately. */
  queueCapacity: z.number().int().nonnegative().max(MAX_QUEUE_CAPACITY).default(0),
});
export type Bulkhead = z.infer<typeof BulkheadSchema>;

export const CallPolicySchema = z.object({
  /**
   * Per-ATTEMPT timeout, ms. Null inherits only the client's end-to-end deadline.
   *
   * Distinct from the client deadline on purpose: a per-attempt timeout is what
   * makes retrying possible at all, since without one a hung attempt consumes the
   * entire budget. Setting it too low is its own failure mode -- attempts are
   * abandoned that would have succeeded, and each abandoned attempt is replaced by
   * a retry, so the dependency does more work and gets slower still.
   */
  timeoutMs: z.number().positive().nullable().default(null),
  retry: RetryPolicySchema.nullable().default(null),
  circuitBreaker: CircuitBreakerSchema.default({}),
  bulkhead: BulkheadSchema.default({}),
});
export type CallPolicy = z.infer<typeof CallPolicySchema>;

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------

/**
 * A connection, carrying the routing decision.
 *
 * Routing lives on edges rather than nodes because that is how it reads on a
 * canvas: an edge states which classes traverse it and how often. What the source
 * node's KIND then does with its set of eligible edges differs:
 *
 *   loadbalancer  picks exactly one, by its algorithm and the edges' weights
 *   server        traverses each eligible edge, per that edge's probability
 *   cache         traverses its single edge only on a miss (read-through)
 *   queue         its edges are consumers, not callees
 *
 * Keeping the per-edge data uniform and the dispatch rule per-kind avoids a
 * routing DSL while still expressing every case Phase 2 needs.
 */
export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /**
   * One-way network latency. The legacy engine used a single 520ms constant for
   * every edge in the graph, so topology had no effect on latency.
   */
  latency: DistributionSchema.default({ kind: "deterministic", value: 0 }),
  /** Probability [0,1] a message is dropped in transit. */
  lossProbability: z.number().min(0).max(1).default(0),
  /** Request classes that use this edge. Empty = all classes. */
  classes: z.array(z.string()).default([]),
  /**
   * Probability a request at the source traverses this edge.
   *
   * Lets a dependency be called on only some requests -- a cache lookup skipped
   * for writes, an audit call on 5% of traffic -- without inventing a class.
   */
  probability: z.number().min(0).max(1).default(1),
  /** Relative weight for load-balancer target selection. */
  weight: z.number().positive().default(1),
  /**
   * One call across this edge becomes this many downstream calls.
   *
   * THE NUMBER THAT DEFINES A REALTIME SYSTEM'S COST.
   *
   * A chat message sent to a room of fifty is one inbound request and fifty outbound
   * deliveries. The read path is trivial and the write path is amplified fiftyfold,
   * so a design sized on message rate is undersized by the room size -- and the room
   * size is a product decision that nobody thinks of as a capacity decision.
   *
   * Deliberately a real multiplier rather than an equivalent increase in service
   * time: fifty deliveries occupy fifty slots and queue independently, and collapsing
   * them into one longer call would hide exactly the contention being modelled. The
   * cost is that a fan-out run simulates far more work than its message rate
   * suggests, which is the honest price of the effect being real.
   */
  fanoutFactor: z.number().int().positive().default(1),
  /**
   * Timeout, retry, circuit-breaker and bulkhead settings for this call.
   *
   * On the edge rather than the node because that is what these things are: the
   * caller's client configuration for one particular dependency. The same service
   * routinely retries its cache aggressively and its payment provider not at all.
   */
  policy: CallPolicySchema.default({}),
});
export type SdsEdge = z.infer<typeof EdgeSchema>;

// ---------------------------------------------------------------------------
// scenario
// ---------------------------------------------------------------------------

export const ScenarioSchema = z.object({
  /**
   * Simulated seconds to run, INCLUDING warm-up.
   *
   * The default is minutes of simulated time, not the 60s that feels natural.
   * Sixty seconds is an instinct inherited from real-time animation, where a
   * 60-second experiment cost 60 seconds of waiting. Decoupled from the frame
   * loop there is no such cost -- a 1200-second run completes in a fraction of a
   * second -- and being stingy actively harms the result: sample size required
   * for a given accuracy scales as 1/(1-rho)^2, so a short run is noisiest at
   * exactly the high utilizations a capacity tool is consulted about. See
   * `requiredSamples` in @sds/core.
   */
  durationSec: z.number().positive().default(1200),
  /**
   * Simulated seconds discarded before metrics start accumulating.
   *
   * A queueing system starts empty, which is not its steady state. Measuring
   * from t=0 biases every latency figure downward. The transient relaxes on the
   * same 1/(1-rho)^2 timescale as everything else, so this scales with the run
   * rather than being a fixed few seconds. Non-negotiable for any number the tool
   * is willing to print.
   */
  warmupSec: z.number().nonnegative().default(200),
  /** Seed for the run. Same seed + same model => identical trace, always. */
  seed: z.number().int().nonnegative().default(1),
  /** Cap on retained trace events, so a long run cannot exhaust memory. */
  traceLimit: z.number().int().nonnegative().default(5000),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** SLO targets used by the analyzer to answer "does this design pass?". */
export const SloSchema = z.object({
  p99LatencyMs: z.number().positive().nullable().default(null),
  maxErrorRatePct: z.number().min(0).max(100).nullable().default(null),
});
export type Slo = z.infer<typeof SloSchema>;

export const DESIGN_SCHEMA_VERSION = 5 as const;

export const DesignSchema = z.object({
  version: z.literal(DESIGN_SCHEMA_VERSION),
  name: z.string().default("untitled design"),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  /** Empty means a single implicit class carrying all traffic. */
  classes: z.array(RequestClassSchema).default([]),
  scenario: ScenarioSchema,
  slo: SloSchema,
});
export type Design = z.infer<typeof DesignSchema>;

/** The implicit class used when a design declares none. */
export const DEFAULT_CLASS: RequestClass = {
  id: "default",
  label: "requests",
  weight: 1,
  serviceMultiplier: 1,
};

export function classesOf(design: Design): RequestClass[] {
  return design.classes.length > 0 ? design.classes : [DEFAULT_CLASS];
}
