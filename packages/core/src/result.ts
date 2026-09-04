import type { Design, FailureEvent, NodeKind } from "@sds/schema";
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
  /** Null for the single-authority datastore model. */
  replication: {
    groupId: string;
    replicas: number;
    readQuorum: number;
    writeQuorum: number;
    isolationLevel: string;
    /** Lowest reachable replica count observed during the measurement window. */
    minAvailableReplicas: number;
    /** Largest explicitly divergent replica set observed. */
    maxStaleReplicas: number;
    /** Largest configured or injected absolute clock-skew bound observed. */
    maxClockSkewMs: number;
  } | null;
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

/**
 * Connection behaviour at a gateway.
 *
 * Reported separately from throughput because it constrains a different thing. A
 * gateway can be holding its full complement of idle sockets while comfortably keeping
 * up with delivery, or keeping up with nothing while holding barely any -- and the fix
 * differs completely.
 */
export interface ConnectionMetrics {
  /** Sockets this gateway can hold: capacity x replicas. */
  capacity: number;
  /** Time-average connections held. */
  avgHeld: number;
  peakHeld: number;
  heldNow: number;
  /** avgHeld / capacity. The answer to "can it hold N users". */
  utilization: number;
  accepted: number;
  /**
   * Connections refused for want of a descriptor.
   *
   * A hard failure, not a slow response: the user does not get a slower chat, they get
   * no chat.
   */
  refused: number;
  closed: number;
  /** Connections closed by a simulated fault rather than by the client. */
  droppedByFault: number;
  acceptRatePerSec: number;
  /** Handshake latency, including any wait for a work slot. */
  acceptLatency: LatencySummary;
  pushes: number;
  pushRatePerSec: number;
  /** Delivery latency: the number a chat user actually experiences. */
  pushLatency: LatencySummary;
  memoryMb: number;
  peakMemoryMb: number;
  /** Utilization of the shared accept/push work pool. */
  workUtilization: number;
  connectionSeries: SeriesData;
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

/**
 * Lease behaviour at a lock service.
 *
 * Reported separately from station utilization because the interesting numbers are
 * not about capacity at all. A lock service can sit at 4% utilization and still be the
 * reason the design is broken, and the evidence for that is in `expired` and
 * `staleOwnerRejections`, not in how busy it was.
 *
 * `staleOwnerRejections` is the number that proves fencing is doing something. It
 * counts writes refused because the writer's token was older than the lease's current
 * generation -- that is, occasions on which a worker that believed it held the lease
 * tried to act and was stopped. A design with fencing enabled and zero stale-owner
 * rejections under a fault model that includes lease expiry has not demonstrated
 * safety; it has demonstrated that the race was never reached. A design WITHOUT
 * fencing has no mechanism to count, and the corruption happens silently, which is
 * precisely why the correctness explorer rather than the simulator is the right tool
 * for that question.
 */
export interface LockMetrics {
  acquireAttempts: number;
  acquired: number;
  /** Refused because someone else held an unexpired lease. Contention, not failure. */
  contended: number;
  released: number;
  /** Leases that reached their TTL while still held. Each one is a potential race. */
  expired: number;
  /** Writes refused because the writer's fencing token was stale. */
  staleOwnerRejections: number;
  fencingEnabled: boolean;
  /** Time spent waiting for the lock service itself, not for the lease to free up. */
  waitMs: LatencySummary;
  /** Time a lease was held, from grant to release or expiry. */
  heldMs: LatencySummary;
  /** Time-average leases held at once, across all keys. */
  avgHeld: number;
  peakHeld: number;
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
  connections?: ConnectionMetrics;
  lock?: LockMetrics;
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

/** Cost breakdown for one directional request-level network transfer. */
export interface TraceNetworkLeg {
  totalMs: number;
  propagationMs: number;
  serializationMs: number;
  transferMs: number;
  connectionMs: number;
  bytes: number;
  application: string;
  transport: string;
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
  /** Present since v7 traces; absent on imported historical run records. */
  network?: TraceNetworkLeg;
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

/**
 * What the workflow did, in business terms.
 *
 * WHY THESE AND NOT LATENCY
 *
 * Because a design can serve every request in forty milliseconds with a zero percent
 * error rate and sell three hundred pizzas it does not have. Every oversell in history
 * was a successful response, so a tool that ranked on latency and error rate alone would
 * hand the crown to the broken candidate -- and would be right about every number it
 * printed.
 *
 * `oversells` and `duplicateSuccesses` are the two that carry the weight, and both are
 * only computable because the study's product contract says which outcome labels mean
 * what. Without that mapping they are reported as raw label counts and interpreted not at
 * all, which is the honest degradation.
 */
export interface BusinessMetrics {
  validAllocations: number;
  /** Succeeded twice for one logical claim. A correctness failure that returned 200. */
  duplicateSuccesses: number;
  /** Allocated a unit that did not exist. */
  oversells: number;
  /** Counter values at the end of the run, per collection. */
  remainingInventory: Record<string, number>;
  expiredReservations: number;
  /**
   * Units taken by a handler that then died, and never given back.
   *
   * NOT a correctness failure: nobody was oversold, so no invariant is violated. It is
   * pure waste, and it is the cost of a design that decrements before it commits. Reported
   * separately so a reader can weigh "loses stock on crash" against "oversells on crash",
   * which are very different problems with very different fixes.
   */
  strandedReservations: number;
  /** Unique inserts that lost the race. In an idempotent design, the happy path. */
  idempotencyHits: number;
  transactionConflicts: number;
  redeliveries: number;
  abandonedMessages: number;
  /** Writes refused because the writer's fencing token was superseded. */
  staleOwnerRejections: number;
  leaseContentions: number;
  leaseExpiries: number;
  guardFailures: number;
  /** Handlers abandoned by a station failure mid-flight. */
  crashedHandlers: number;
  /** Handlers still running when their caller gave up waiting. */
  detachedAfterTimeout: number;
  /** Outcome label -> count, verbatim from `respond` operations. */
  outcomes: Record<string, number>;
  statuses: Record<string, number>;
  /** Measured seconds until a counter first hit zero. Null means it never did. */
  timeToExhaustSec: Record<string, number | null>;
  lockWaitMs: LatencySummary;
  /** Queue backlog age at consumption. The real "async latency". */
  messageAgeMs: LatencySummary;
  /**
   * The state the run finished in.
   *
   * Carried for two reasons. The first is that a reader wants it: "how many claims ended
   * up in the table, and for whom" is the question a business-metric count is a summary
   * of, and a summary that cannot be checked against its source is a number to be taken
   * on trust.
   *
   * The second is that it is what makes the two engines comparable. The conformance test
   * drives the same workflow through the breadth-first explorer and through this
   * simulator and asserts the final states are identical; without the state in the result
   * that test would have to reach inside the runtime, and a test that reaches inside is a
   * test that stops proving the public behaviour.
   *
   * Tables are omitted past `rowsIncluded` rows, and `truncated` says so. A long
   * production-scale run can fill a table with thousands of rows and shipping all of them
   * across the worker boundary on every run would be paid by every user for the benefit
   * of the few who look.
   */
  state: FinalState;
}

export interface FinalState {
  counters: Record<string, number>;
  /** collection id -> row key -> row. Absent when `truncated`. */
  tables: Record<string, Record<string, Record<string, string | number | boolean>>>;
  rowCounts: Record<string, number>;
  truncated: boolean;
  /** Messages never acknowledged, never abandoned. Work that silently did not happen. */
  unackedMessages: number;
  /** Leases still held when the run ended, including by handlers that died. */
  heldLeases: number;
}

export interface RunResult {
  design: Design;
  /** Configured and live-injected failures that shaped this exact run. */
  failureTimeline: FailureEvent[];
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
  /**
   * Edge traversals per message that entered the system, summed over every edge.
   *
   * A path of three hops with a twentyfold fan-out on the last one gives 23, not 20:
   * this counts total downstream work, not the fan-out factor. Both are worth knowing
   * and they are different numbers, so `largestFanout` reports the other one.
   *
   * It is the multiplier that makes a realtime system's cost bear little relation to
   * its request rate, and it is easy to leave out of a capacity estimate entirely.
   */
  callsPerMessage: number;
  /** The biggest single fan-out factor in the design. */
  largestFanout: number;
  /** Total connections held across every gateway, time-averaged. */
  connectionsHeld: number;
  /** Connections refused across every gateway. */
  connectionsRefused: number;
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
  /**
   * What the workflow did, or null for a design with no workflow.
   *
   * Null is a first-class answer. Every design that existed before state arrived has no
   * workflow, produces no business metrics, and remains a perfectly good capacity model --
   * what it cannot do is make a claim about correctness or about allocation, and a zeroed
   * metrics object would have let it appear to.
   */
  business: BusinessMetrics | null;
  trace: Trace;
  throughputSeries: SeriesData;
  latencyP99Series: SeriesData;
  /** Wall-clock ms the simulation took. Not a simulated quantity. */
  wallMs: number;
}
