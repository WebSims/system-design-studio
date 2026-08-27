import type { Citation, Distribution } from "@sds/schema";

/**
 * THE BENCHMARK LIBRARY
 *
 * Every default in this file carries a source and a plausible range, and the
 * inspector renders both.
 *
 * This exists because calibration, not queueing theory, is the hard part of
 * making a tool like this credible. The maths is textbook and testable -- the
 * validation suite proves the engine reproduces Erlang-C. Whether a Postgres
 * point-read takes 0.5ms or 5ms is unfalsifiable without data, and every number
 * the tool prints inherits that uncertainty.
 *
 * The legacy engine's constants were a bare table (`PROCMS.server = 34`) with no
 * provenance. A reader could not tell whether 34 was measured, remembered, or
 * invented, which makes the output impossible to argue with or to correct.
 *
 * THREE RULES THESE DEFAULTS FOLLOW
 *
 *  1. A range, not a point. Deployment dominates: the same query is 0.3ms warm on
 *     local NVMe and 30ms cold across a network. A single number implies a
 *     precision that does not exist.
 *
 *  2. Service time, not response time. Published latency figures usually include
 *     queueing at whatever load the benchmark ran at. What a queueing model needs
 *     is the *unloaded* service time, because it computes the queueing itself.
 *     Feeding it a loaded figure double-counts the wait.
 *
 *  3. Lognormal where reality has a tail. A cache lookup is nearly
 *     deterministic; a database query is not. Cs^2 drives queueing delay through
 *     the (1 + Cs^2) factor, so getting the *shape* roughly right matters as much
 *     as the mean.
 *
 * These are order-of-magnitude starting points for a design conversation. They are
 * not measurements of the user's system, and every one is editable -- a figure
 * pasted from the user's own dashboard beats anything here.
 */

export interface Benchmark {
  id: string;
  label: string;
  /** What the number describes, and what it deliberately excludes. */
  note: string;
  distribution: Distribution;
  citation: Citation;
}

const REFERENCE_DATE = "2026-08";

/**
 * Service times for common components, unloaded.
 *
 * Sourced from vendor documentation, published benchmark suites and widely
 * reproduced community measurements. Where sources disagree -- which is most of
 * the time -- the range spans them rather than picking a winner.
 */
export const SERVICE_TIMES: Benchmark[] = [
  {
    id: "nginx-proxy",
    label: "reverse proxy (nginx/envoy)",
    note: "per-request proxy overhead, excluding the upstream call it forwards to",
    distribution: { kind: "deterministic", value: 0.5 },
    citation: {
      range: [0.1, 2],
      source: "nginx and Envoy documented proxy overhead; sub-millisecond on modern hardware",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "redis-get",
    label: "Redis GET",
    note: "in-memory lookup on the same network segment; excludes client round trip",
    distribution: { kind: "deterministic", value: 0.2 },
    citation: {
      range: [0.05, 1],
      source: "redis-benchmark commonly reports >100k ops/s per core, i.e. well under 1ms",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "memcached-get",
    label: "Memcached GET",
    note: "in-memory lookup; comparable to Redis for simple key reads",
    distribution: { kind: "deterministic", value: 0.15 },
    citation: {
      range: [0.05, 1],
      source: "widely reproduced memcached benchmarks; sub-millisecond for small values",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "postgres-point-read",
    label: "Postgres indexed point read",
    note: "single row by primary key, working set in shared_buffers",
    distribution: { kind: "lognormal", mean: 0.6, p99: 5 },
    citation: {
      range: [0.2, 5],
      source: "pgbench select-only workloads on warm cache; the tail is buffer misses",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "postgres-range-scan",
    label: "Postgres small range scan / join",
    note: "a few hundred rows with an index; heavily dependent on schema",
    distribution: { kind: "lognormal", mean: 5, p99: 60 },
    citation: {
      range: [1, 50],
      source: "order-of-magnitude figure for indexed multi-row queries; varies enormously by schema",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "postgres-write",
    label: "Postgres single-row write (committed)",
    note: "includes WAL flush, so it is bounded below by storage fsync latency",
    distribution: { kind: "lognormal", mean: 2, p99: 20 },
    citation: {
      range: [0.5, 20],
      source: "dominated by fsync on the WAL device; NVMe at the low end, network storage at the high",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "mongo-point-read",
    label: "MongoDB indexed find",
    note: "single document by indexed field, working set in RAM",
    distribution: { kind: "lognormal", mean: 1, p99: 10 },
    citation: {
      range: [0.3, 10],
      source: "comparable to an indexed relational point read for in-memory working sets",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "app-json-endpoint",
    label: "application endpoint (own CPU work)",
    note: "serialization, validation and business logic ONLY; excludes downstream calls",
    distribution: { kind: "lognormal", mean: 3, p99: 25 },
    citation: {
      range: [0.5, 30],
      source: "typical managed-runtime request handling excluding I/O; language and framework dependent",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "object-store-get",
    label: "object store GET (S3/GCS)",
    note: "small object, first byte; dominated by the service, not by transfer",
    distribution: { kind: "lognormal", mean: 25, p99: 200 },
    citation: {
      range: [10, 300],
      source: "commonly reported first-byte latencies for small objects; long tail is normal",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "queue-publish",
    label: "broker publish (Kafka/Rabbit, acked)",
    note: "producer-side acknowledged publish; not consumer processing",
    distribution: { kind: "lognormal", mean: 1.5, p99: 15 },
    citation: {
      range: [0.5, 20],
      source: "acked publish to a local-network broker; replication factor moves this substantially",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "external-http-call",
    label: "third-party HTTPS API",
    note: "internet round trip plus a vendor's own processing; the tail is the point",
    distribution: { kind: "lognormal", mean: 120, p99: 1500 },
    citation: {
      range: [50, 3000],
      source: "wide by nature; the heavy tail is why timeouts and retries exist",
      asOf: REFERENCE_DATE,
    },
  },
];

/**
 * Network latencies, one way.
 *
 * One way, not round trip. The engine applies the edge latency per traversal and
 * a request/response pair crosses the edge twice, so a round-trip figure entered
 * here would be counted twice.
 */
export const NETWORK_LATENCIES: Benchmark[] = [
  {
    id: "same-host",
    label: "same host (loopback)",
    note: "process to process on one machine",
    distribution: { kind: "deterministic", value: 0.05 },
    citation: { range: [0.01, 0.2], source: "loopback TCP; effectively a memory copy", asOf: REFERENCE_DATE },
  },
  {
    id: "same-rack",
    label: "same rack / same AZ",
    note: "typical intra-availability-zone hop",
    distribution: { kind: "deterministic", value: 0.25 },
    citation: {
      range: [0.1, 0.5],
      source: "sub-millisecond within a zone is the usual assumption for cloud networks",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "cross-az",
    label: "cross availability zone",
    note: "the figure that makes multi-AZ replication cost something",
    distribution: { kind: "deterministic", value: 1 },
    citation: {
      range: [0.5, 2],
      source: "cloud providers generally document around 1ms between zones in a region",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "cross-region-continental",
    label: "cross region, same continent",
    note: "bounded below by the speed of light in fibre",
    distribution: { kind: "deterministic", value: 15 },
    citation: {
      range: [5, 40],
      source: "geography plus routing; fibre carries light at roughly 200,000 km/s",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "cross-region-intercontinental",
    label: "cross region, intercontinental",
    note: "no amount of engineering removes this",
    distribution: { kind: "deterministic", value: 80 },
    citation: {
      range: [60, 200],
      source: "physical distance dominates; ~80ms one way is typical trans-Atlantic",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "consumer-internet",
    label: "consumer internet (client to edge)",
    note: "highly variable; mobile networks are much worse than the mean suggests",
    distribution: { kind: "lognormal", mean: 30, p99: 300 },
    citation: {
      range: [10, 400],
      source: "last-mile latency varies by an order of magnitude across access technologies",
      asOf: REFERENCE_DATE,
    },
  },
];

/**
 * Capacity defaults.
 *
 * These are the numbers people most often get wrong by orders of magnitude, and
 * concurrency limits are exactly what decides where a bottleneck appears.
 */
export interface CapacityBenchmark {
  id: string;
  label: string;
  note: string;
  value: number;
  citation: Citation;
}

export const CAPACITIES: CapacityBenchmark[] = [
  {
    id: "postgres-pool",
    label: "Postgres connection pool size",
    note: "connections, not concurrent queries; see `parallelism` for the real execution limit",
    value: 20,
    citation: {
      range: [10, 100],
      source:
        "pool sizing guidance consistently recommends small pools, roughly (cores * 2) + spindles; " +
        "larger pools increase latency without increasing throughput",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "postgres-parallelism",
    label: "Postgres effective query parallelism",
    note: "queries genuinely executing at once; usually cores, or disk queue depth for I/O-bound work",
    value: 8,
    citation: {
      range: [2, 64],
      source: "bounded by CPU cores for cached workloads and by storage concurrency otherwise",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "app-worker-concurrency",
    label: "application worker concurrency per replica",
    note: "threads, goroutines or event-loop slots handling requests at once",
    value: 32,
    citation: {
      range: [1, 512],
      source:
        "spans models: a synchronous worker process is single-digit, an async runtime is hundreds",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "proxy-concurrency",
    label: "reverse proxy concurrency",
    note: "effectively unbounded relative to backends; rarely the constraint",
    value: 1024,
    citation: {
      range: [256, 65536],
      source: "event-driven proxies handle tens of thousands of connections per process",
      asOf: REFERENCE_DATE,
    },
  },
  {
    id: "redis-concurrency",
    label: "Redis effective concurrency",
    note: "Redis executes commands on one thread; concurrency here reflects pipelining, not parallel execution",
    value: 1,
    citation: {
      range: [1, 8],
      source:
        "the core command loop is single-threaded, which is why a Redis instance has a hard ops/s ceiling",
      asOf: REFERENCE_DATE,
    },
  },
];

export const BY_ID: Record<string, Benchmark> = Object.fromEntries(
  [...SERVICE_TIMES, ...NETWORK_LATENCIES].map((b) => [b.id, b])
);

export const CAPACITY_BY_ID: Record<string, CapacityBenchmark> = Object.fromEntries(
  CAPACITIES.map((c) => [c.id, c])
);

/** Human-readable provenance, for tooltips and the inspector. */
export function citationText(citation: Citation | undefined): string {
  if (!citation) return "no source recorded";
  const range = citation.range ? `typical ${citation.range[0]}\u2013${citation.range[1]}ms. ` : "";
  const asOf = citation.asOf ? ` (as of ${citation.asOf})` : "";
  return `${range}${citation.source}${asOf}`;
}
