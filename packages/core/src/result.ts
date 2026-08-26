import type { Design } from "@sds/schema";
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

export interface NodeResult {
  nodeId: string;
  label: string;
  kind: "client" | "server";
  /** Time-weighted fraction of capacity busy, [0,1]. The bottleneck signal. */
  utilization: number;
  /** `c` = replicas * concurrency. */
  capacity: number;
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
  queueLengthSeries: SeriesData;
  utilizationSeries: SeriesData;
}

export type ErrorReason = "shed" | "timeout" | "network";

export interface ErrorBreakdown {
  total: number;
  shed: number;
  timeout: number;
  network: number;
  ratePct: number;
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
}

/** One traversal of an edge by one request. Drives the packet animation. */
export interface TraceHop {
  requestId: number;
  edgeId: string;
  /** Simulated ms. */
  tStart: number;
  tEnd: number;
  delivered: boolean;
}

/** One visit to a station by one request. Drives the node occupancy display. */
export interface TraceVisit {
  requestId: number;
  nodeId: string;
  tEnqueue: number;
  /** Null when the request was shed or abandoned before entering service. */
  tServiceStart: number | null;
  tExit: number;
  outcome: "served" | "shed" | "timeout";
}

export interface Trace {
  hops: TraceHop[];
  visits: TraceVisit[];
  /** 1 in `sampleEvery` requests were traced. */
  sampleEvery: number;
  truncated: boolean;
}

export interface RunResult {
  design: Design;
  /** Measurement window, simulated seconds (excludes warm-up). */
  observedSec: number;
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
