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

/**
 * Phase 1 node types. Deliberately two.
 *
 * The vertical slice exists to prove the whole pipeline against closed-form
 * queueing results; a wider palette before the gate is green just multiplies
 * the surface that could be wrong.
 */
export const NodeKindSchema = z.enum(["client", "server"]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

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
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

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

export const NodeSchema = z.object({
  id: z.string().min(1),
  kind: NodeKindSchema,
  label: z.string(),
  /** Canvas position. Purely presentational; the engine ignores it. */
  x: z.number(),
  y: z.number(),
  client: ClientConfigSchema.optional(),
  server: ServerConfigSchema.optional(),
});
export type SdsNode = z.infer<typeof NodeSchema>;

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
});
export type SdsEdge = z.infer<typeof EdgeSchema>;

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

export const DESIGN_SCHEMA_VERSION = 1 as const;

export const DesignSchema = z.object({
  version: z.literal(DESIGN_SCHEMA_VERSION),
  name: z.string().default("untitled design"),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  scenario: ScenarioSchema,
  slo: SloSchema,
});
export type Design = z.infer<typeof DesignSchema>;
