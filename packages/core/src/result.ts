import type { Design, NodeKind } from "@sds/schema";
import type { ConfidenceReport } from "./confidence";

export interface Percentiles {
  p50: number;
  p90: number;
  p99: number;
  p999: number;
}

export interface LatencySummary extends Percentiles {
  count: number;
  mean: number;
  min: number;
  max: number;
  /** Bound on the relative error of the percentiles above. */
  relativeError: number;
}

export interface SeriesData {
  name: string;
  points: { t: number; value: number }[];
}

export type ErrorReason =
  | "shed"
  | "timeout"
  | "network"
  | "queue-full"
  /** The dependency returned an error of its own. */
  | "error"
  /** The caller's circuit breaker refused to attempt the call. */
  | "circuit-open"
  /** The caller's bulkhead was full, so the call was never attempted. */
  | "bulkhead-full";

export interface ErrorBreakdown {
  total: number;
  shed: number;
  timeout: number;
  network: number;
  queueFull: number;
  /** Failures originating in a station rather than in queueing. */
  error: number;
  /** Failed fast by a circuit breaker. */
  circuitOpen: number;
  /** Rejected by a bulkhead. */
  bulkheadFull: number;
  ratePct: number;
}

/** Cache behaviour. The hit ratio is an OUTPUT, not an input. */
export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRatio: number;
  evictions: number;
  expirations: number;
  /** Distinct keys held at the end of the run. */
  residentKeys: number;
  hitRatioSeries: SeriesData;
}

/**
 * Database behaviour across both of its resources.
 *
 * Reported separately because the difference is the whole point: pool wait means
 * "not enough connections", execution wait means "not enough capacity", and only
 * the first is fixed by raising the pool size.
 */
export interface DatabaseMetrics {
  poolSize: number;
  parallelism: number;
  /** Fraction of connections checked out, time-weighted. */
  poolUtilization: number;
  /** Fraction of execution slots busy, time-weighted. This is the real capacity. */
  executionUtilization: number;
  avgPoolWaitMs: number;
  avgExecutionWaitMs: number;
  /** Requests per second the station could serve at most: parallelism / E[S]. */
  maxThroughputPerSec: number;
}

/** Queue behaviour. Tracked separately because it is an asynchronous boundary. */
export interface QueueMetrics {
  enqueued: number;
  consumed: number;
  dropped: number;
  consumers: number;
  /** Time-average backlog depth. */
  avgBacklog: number;
  maxBacklog: number;
  /** Time from enqueue to the start of consumption. The real "async latency". */
  backlogAge: LatencySummary;
  consumerUtilization: number;
  /** Messages per second the consumers could drain at most. */
  drainCapacityPerSec: number;
  backlogSeries: SeriesData;
  /**
   * Backlog growth, messages per second. Positive and sustained means consumers
   * are losing, and no amount of run time will let them catch up.
   */
  backlogGrowthPerSec: number;
}

export interface LoadBalancerMetrics {
  algorithm: string;
  dispatched: number;
  perBackend: Array<{
    nodeId: string;
    label: string;
    dispatched: number;
    sharePct: number;
    /** Observed failure rate used by health checking, [0,1]. */
    failureRate: number;
    /** Fraction of the window this backend spent ejected. */
    ejectedFraction: number;
    ejections: number;
  }>;
  /** True when outlier detection is on. */
  healthCheckEnabled: boolean;
  /** Ejections refused because too many backends were already out. */
  ejectionsWithheld: number;
  /**
   * Largest deviation of any backend's share from an even split, in percentage
   * points. The headline number for whether the algorithm is doing its job.
   */
  worstImbalancePct: number;
}

export interface NodeResult {
  nodeId: string;
  label: string;
  kind: NodeKind;
  /** Total service slots. For a database this is execution parallelism. */
  capacity: number;
  /** Time-weighted fraction of capacity busy, [0,1]. The bottleneck signal. */
  utilization: number;
  avgQueueLength: number;
  maxQueueLength: number;
  /** Time-average number in the station (queued + in service). */
  avgInStation: number;
  arrivals: number;
  admitted: number;
  shed: number;
  abandoned: number;
  completed: number;
  /** Mean queue wait, ms, over admitted requests. */
  avgWaitMs: number;
  /** Analytic mean service time, ms. */
  serviceMeanMs: number;
  /** Squared coefficient of variation of service time. */
  serviceScv: number;
  /** Offered arrival rate at this station, per second. */
  arrivalRatePerSec: number;
  /**
   * Time spent at this station including waiting for its own dependencies.
   *
   * Diverges from service time wherever a station holds its slot across
   * downstream calls, which is how a slow dependency exhausts a caller's worker
   * pool.
   */
  residencyMs: LatencySummary;
  /**
   * Latency attributable to THIS station: its own queue wait plus its own service,
   * excluding dependency calls.
   *
   * The number critical-path attribution needs. `residencyMs` cannot be used for
   * that: a blocking caller's residency already contains its dependency's, so
   * shares would sum well past 100% and the deepest station would be blamed once
   * per layer above it.
   */
  selfTimeMs: LatencySummary;
  /** Visits to this station per client request. Above 1 means it is called repeatedly. */
  visitsPerRequest: number;
  queueLengthSeries: SeriesData;
  utilizationSeries: SeriesData;
  cache?: CacheMetrics;
  database?: DatabaseMetrics;
  queue?: QueueMetrics;
  loadbalancer?: LoadBalancerMetrics;
}

export interface ClassResult {
  classId: string;
  label: string;
  /** Share of offered traffic, [0,1]. */
  share: number;
  throughputPerSec: number;
  latency: LatencySummary;
  errors: ErrorBreakdown;
}

/**
 * A checked physical law. Reported on every run, not only in tests.
 *
 * The point is not to reassure the user; it is that a simulator which silently
 * violates conservation of requests or Little's Law is producing numbers that
 * look plausible and are wrong. Surfacing the check means the failure mode is
 * "the tool says its own output is suspect" instead of "the tool is confidently
 * incorrect".
 */
export interface InvariantReport {
  name: string;
  passed: boolean;
  detail: string;
  /** Relative error where applicable. */
  error?: number;
  tolerance?: number;
}

export interface StabilityReport {
  /**
   * False when arrivals exceed service capacity somewhere: the queue grows
   * without bound, there is no steady state, and no latency figure is
   * meaningful. Reported instead of a number.
   */
  stable: boolean;
  /** Worst sustained queue growth across stations, items per second. */
  worstQueueSlopePerSec: number;
  /** Station responsible for the worst growth, if unstable. */
  worstNodeId: string | null;
  detail: string;
  /**
   * Set when a QUEUE backlog is growing without bound while request latency looks
   * healthy. Called out separately because it is invisible in the headline
   * numbers: publishing returns immediately, so an async system can be failing
   * badly while every percentile stays green.
   */
  asyncBacklogWarning: string | null;
  /**
   * Set when retries are materially amplifying load.
   *
   * Its own field because the symptom is easy to misread: the dependency looks
   * overloaded, so the instinct is to add capacity, when the load is being
   * manufactured by the callers' own retry policies.
   */
  retryStormWarning: string | null;
}

/** One traversal of an edge by one request. Drives the packet animation. */
export interface TraceHop {
  requestId: number;
  edgeId: string;
  /** Simulated ms. */
  tStart: number;
  tEnd: number;
  delivered: boolean;
  /** False for the response leg. */
  forward: boolean;
}

/** One visit to a station by one request. Drives the node occupancy display. */
export interface TraceVisit {
  requestId: number;
  nodeId: string;
  tEnqueue: number;
  /** Null when the request was shed or abandoned before entering service. */
  tServiceStart: number | null;
  tExit: number;
  outcome: "served" | "shed" | "timeout" | "hit" | "miss" | "error";
}

export interface Trace {
  hops: TraceHop[];
  visits: TraceVisit[];
  /** 1 in `sampleEvery` requests were traced. */
  sampleEvery: number;
  truncated: boolean;
}

/**
 * Retry and failure-policy behaviour for one caller-to-dependency edge.
 *
 * Reported per edge because that is where the policies live, and because the
 * headline figure -- amplification -- is meaningless aggregated: one edge retrying
 * three times is a very different system from three edges retrying once.
 */
export interface EdgeResult {
  edgeId: string;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  /**
   * Attempts that actually crossed this edge, counted directly.
   *
   * Distinct from `attempts`, which only exists for edges carrying a policy. This is
   * counted for every edge because latency attribution needs it: inferring
   * traversals from the destination's visit count double-counts whenever several
   * edges share a target.
   */
  traversals: number;
  calls: number;
  attempts: number;
  retries: number;
  /** attempts / calls. The number this phase exists to surface. */
  amplification: number;
  successes: number;
  failures: number;
  budgetRejections: number;
  circuitRejections: number;
  bulkheadRejections: number;
  breakerTrips: number;
  breakerOpenFraction: number;
  breakerState: "closed" | "open" | "half-open";
  avgConcurrency: number;
  maxConcurrency: number;
  /** Bulkhead slots in use, time-weighted. Null when no bulkhead. */
  bulkheadUtilization: number | null;
  bulkheadMaxInUse: number | null;
  /** True when any policy is configured on this edge. */
  hasPolicy: boolean;
}

export interface RunResult {
  design: Design;
  /** Measurement window, simulated seconds (excludes warm-up). */
  observedSec: number;
  /**
   * False when any client varies its rate over time.
   *
   * When false, the aggregate percentiles below average across regimes that never
   * coexisted -- part of the sample taken at one load and part at another. They are
   * still computed, because they are the right thing for a spike (where most of the
   * run IS the base rate), but `aggregateCaveat` says what they do and do not mean,
   * and the time series is the figure to read instead.
   */
  steadyState: boolean;
  /** Set when the aggregate statistics need qualifying. */
  aggregateCaveat: string | null;
  /**
   * When the SLO was first breached, simulated seconds into the measurement window,
   * and the offered rate at that moment.
   *
   * The point of a ramp: a single run that finds the capacity limit. Null when the
   * SLO was never breached, or when there is no SLO.
   */
  firstBreach: { atSec: number; offeredRatePerSec: number; breach: "latency" | "errors" } | null;
  /** Offered rate over time. Only interesting when the load varies. */
  offeredRateSeries: SeriesData;
  /** Completed successful requests per second of simulated time. */
  throughputPerSec: number;
  /** Offered load, per second. Diverges from throughput once saturated. */
  offeredRatePerSec: number;
  /** End-to-end latency of SUCCESSFUL requests. What an SLO measures. */
  endToEnd: LatencySummary;
  errors: ErrorBreakdown;
  /** Time-average requests in the system. Little's Law's `L`. */
  avgInSystem: number;
  nodes: NodeResult[];
  edges: EdgeResult[];
  classes: ClassResult[];
  /**
   * System-wide retry amplification: total attempts issued over total calls
   * requested, across every edge.
   *
   * Above 1 the system is doing more work than the workload asks for. Because each
   * tier multiplies, three layers each retrying three times is 27x, and that
   * compounding is what turns a slow dependency into an outage.
   */
  retryAmplification: number;
  invariants: InvariantReport[];
  stability: StabilityReport;
  /**
   * Whether this run collected enough samples for its own numbers to be trusted.
   * Reported so the UI can state its precision rather than imply exactness.
   */
  confidence: ConfidenceReport;
  sloPassed: boolean | null;
  trace: Trace;
  throughputSeries: SeriesData;
  latencyP99Series: SeriesData;
  /** Wall-clock ms the simulation took. Not a simulated quantity. */
  wallMs: number;
}
