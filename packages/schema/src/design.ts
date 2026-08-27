import { z } from "zod";

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

/** How work arrives at the system. */
export const ArrivalProcessSchema = z.discriminatedUnion("kind", [
  /**
   * Poisson: exponential inter-arrival times, mean 1/rate. The M/M/*
   * arrival assumption and the correct default for independent users.
   */
  z.object({ kind: z.literal("poisson"), ratePerSec: z.number().positive() }),
  /** Perfectly spaced arrivals. Strictly better than Poisson at the same rate. */
  z.object({ kind: z.literal("deterministic"), ratePerSec: z.number().positive() }),
]);
export type ArrivalProcess = z.infer<typeof ArrivalProcessSchema>;

export const ClientConfigSchema = z.object({
  arrival: ArrivalProcessSchema,
  /** Per-request end-to-end budget, ms. Null = no deadline. */
  timeoutMs: z.number().positive().nullable().default(null),
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
  concurrency: z.number().int().positive(),
  /** Null = unbounded queue (the M/M/c assumption). */
  queueCapacity: z.number().int().nonnegative().nullable().default(null),
  serviceTime: DistributionSchema,
  admissionPolicy: AdmissionPolicySchema.default("block"),
  queueDiscipline: QueueDisciplineSchema.default("fifo"),
  /**
   * Independent identical instances behind this node. Total capacity is
   * `replicas * concurrency`; modelled as one station with c = r*c so that
   * closed-form M/M/c applies exactly.
   */
  replicas: z.number().int().positive().default(1),
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

export const LoadBalancerConfigSchema = z.object({
  algorithm: LbAlgorithmSchema.default("round-robin"),
  /** The proxy's own overhead. Small, but it is not free and it can saturate. */
  serviceTime: DistributionSchema.default({ kind: "deterministic", value: 0.5 }),
  concurrency: z.number().int().positive().default(1024),
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
  capacity: z.number().int().positive().default(10_000),
  keyspace: KeyspaceSchema.default({ kind: "zipf", keys: 100_000, skew: 0.9 }),
  /** Time to serve a hit. */
  serviceTime: DistributionSchema.default({ kind: "deterministic", value: 0.2 }),
  concurrency: z.number().int().positive().default(512),
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
  poolSize: z.number().int().positive().default(20),
  /** Queries genuinely executing at once. Usually cores, or disk queue depth. */
  parallelism: z.number().int().positive().default(8),
  serviceTime: DistributionSchema,
  /** Waiters allowed on the pool. Null = unbounded. */
  queueCapacity: z.number().int().nonnegative().nullable().default(null),
  admissionPolicy: AdmissionPolicySchema.default("block"),
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
  consumers: z.number().int().positive().default(1),
  /** Time for one consumer to handle one message. */
  consumerServiceTime: DistributionSchema.default({ kind: "exponential", mean: 50 }),
  /** Publish overhead paid by the caller. */
  publishTime: DistributionSchema.default({ kind: "deterministic", value: 1 }),
  citation: CitationSchema.optional(),
});
export type QueueConfig = z.infer<typeof QueueConfigSchema>;

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
});
export type SdsNode = z.infer<typeof NodeSchema>;

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

export const DESIGN_SCHEMA_VERSION = 2 as const;

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
