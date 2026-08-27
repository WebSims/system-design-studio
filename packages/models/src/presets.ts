import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  NodeSchema,
  type Design,
  type NodeKind,
  type SdsNode,
} from "@sds/schema";
import { BY_ID, CAPACITY_BY_ID } from "./benchmarks";

/**
 * Droppable components, each assembled from cited benchmarks.
 *
 * A preset is a starting point with visible provenance, not a claim about the
 * user's system. Every field remains editable and the inspector shows where the
 * number came from.
 */
export interface ComponentPreset {
  id: string;
  label: string;
  kind: NodeKind;
  /** One line on what this component is for and when it is the wrong choice. */
  blurb: string;
  build: (id: string, x: number, y: number) => SdsNode;
}

/**
 * Presets are parsed through the schema rather than typed by hand.
 *
 * Two reasons: new fields pick up their defaults automatically, and a preset that
 * would not validate fails loudly here instead of producing a node the engine
 * later refuses to run.
 */
const node = (raw: unknown): SdsNode => NodeSchema.parse(raw);

const bench = (id: string) => {
  const b = BY_ID[id];
  if (!b) throw new Error(`unknown benchmark ${id}`);
  return b;
};
const capacity = (id: string) => {
  const c = CAPACITY_BY_ID[id];
  if (!c) throw new Error(`unknown capacity benchmark ${id}`);
  return c;
};

export const PRESETS: ComponentPreset[] = [
  {
    id: "gateway",
    label: "realtime gateway",
    kind: "gateway",
    blurb:
      "holds long-lived sockets. Connection capacity constrains how many users; the work pool constrains delivery.",
    build: (id, x, y) =>
      node({
        id,
        kind: "gateway",
        label: "gateway",
        x,
        y,
        gateway: {
          connectionCapacity: 10_000,
          replicas: 2,
          acceptTime: { kind: "lognormal", mean: 5, p99: 40 },
          pushTime: { kind: "deterministic", value: 0.2 },
          // Single digits, because push work is CPU-bound on an event loop.
          pushConcurrency: 2,
          memoryPerConnectionKb: 40,
          citation: {
            range: [10, 100],
            source:
              "per-connection memory for a WebSocket with modest buffers; varies with buffer sizing and TLS",
            asOf: "2026-08",
          },
        },
      }),
  },
  {
    id: "client",
    label: "client",
    kind: "client",
    blurb: "originates work. Poisson arrivals are burstier than a fixed rate at the same average.",
    build: (id, x, y) =>
      node({
        id,
        kind: "client",
        label: "users",
        x,
        y,
        client: { arrival: { kind: "poisson", ratePerSec: 100 }, timeoutMs: null },
      }),
  },
  {
    id: "loadbalancer",
    label: "load balancer",
    kind: "loadbalancer",
    blurb:
      "spreads work over backends. The algorithm matters: two random probes beat pure random by a lot.",
    build: (id, x, y) => {
      const b = bench("nginx-proxy");
      const c = capacity("proxy-concurrency");
      return node({
        id,
        kind: "loadbalancer",
        label: "load balancer",
        x,
        y,
        loadbalancer: {
          algorithm: "round-robin",
          serviceTime: b.distribution,
          concurrency: c.value,
          citation: b.citation,
        },
      });
    },
  },
  {
    id: "app-server",
    label: "application server",
    kind: "server",
    blurb:
      "own CPU work plus calls to dependencies. Service time here excludes those calls.",
    build: (id, x, y) => {
      const b = bench("app-json-endpoint");
      const c = capacity("app-worker-concurrency");
      return node({
        id,
        kind: "server",
        label: "api",
        x,
        y,
        server: {
          concurrency: c.value,
          queueCapacity: null,
          serviceTime: b.distribution,
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
          fanout: "parallel",
          blocksOnDependencies: true,
          citation: b.citation,
        },
      });
    },
  },
  {
    id: "redis-cache",
    label: "cache (Redis)",
    kind: "cache",
    blurb:
      "read-through. A miss costs a hit plus the origin call, so a low hit ratio makes things worse, not neutral.",
    build: (id, x, y) => {
      const b = bench("redis-get");
      const c = capacity("redis-concurrency");
      return node({
        id,
        kind: "cache",
        label: "cache",
        x,
        y,
        cache: {
          capacity: 10_000,
          keyspace: { kind: "zipf", keys: 100_000, skew: 0.9 },
          serviceTime: b.distribution,
          concurrency: c.value,
          ttlMs: null,
          citation: b.citation,
        },
      });
    },
  },
  {
    id: "postgres",
    label: "relational database",
    kind: "database",
    blurb:
      "pool size caps connections; parallelism caps real execution. Raising the pool past parallelism buys nothing.",
    build: (id, x, y) => {
      const b = bench("postgres-point-read");
      const pool = capacity("postgres-pool");
      const par = capacity("postgres-parallelism");
      return node({
        id,
        kind: "database",
        label: "database",
        x,
        y,
        database: {
          poolSize: pool.value,
          parallelism: par.value,
          serviceTime: b.distribution,
          queueCapacity: null,
          admissionPolicy: "block",
          citation: b.citation,
        },
      });
    },
  },
  {
    id: "queue",
    label: "queue / broker",
    kind: "queue",
    blurb:
      "asynchronous. Publishing returns immediately, so a growing backlog is invisible in request latency.",
    build: (id, x, y) => {
      const b = bench("queue-publish");
      return node({
        id,
        kind: "queue",
        label: "queue",
        x,
        y,
        queue: {
          maxDepth: null,
          consumers: 4,
          consumerServiceTime: { kind: "exponential", mean: 50 },
          publishTime: b.distribution,
          citation: b.citation,
        },
      });
    },
  },
  {
    id: "object-store",
    label: "object store",
    kind: "server",
    blurb: "high latency, very high concurrency. Almost never the bottleneck; often the tail.",
    build: (id, x, y) => {
      const b = bench("object-store-get");
      return node({
        id,
        kind: "server",
        label: "object store",
        x,
        y,
        server: {
          concurrency: 256,
          queueCapacity: null,
          serviceTime: b.distribution,
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
          fanout: "parallel",
          blocksOnDependencies: true,
          citation: b.citation,
        },
      });
    },
  },
  {
    id: "external-api",
    label: "third-party API",
    kind: "server",
    blurb:
      "someone else's system. Heavy tail by nature, which is what timeouts and retries exist for.",
    build: (id, x, y) => {
      const b = bench("external-http-call");
      return node({
        id,
        kind: "server",
        label: "third-party api",
        x,
        y,
        server: {
          concurrency: 64,
          queueCapacity: null,
          serviceTime: b.distribution,
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
          fanout: "parallel",
          blocksOnDependencies: true,
          citation: b.citation,
        },
      });
    },
  },
];

export const PRESET_BY_ID: Record<string, ComponentPreset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p])
);

// ---------------------------------------------------------------------------
// example designs
// ---------------------------------------------------------------------------

const CROSS_AZ = bench("cross-az").distribution;
const SAME_RACK = bench("same-rack").distribution;

/**
 * The Phase 1 slice: one Poisson client feeding one capacity-limited server.
 *
 * Numbers chosen so the default view opens in a legible regime: lambda = 80/s,
 * c = 4, service mean 40ms => mu_total = 100/s, rho = 0.8. Deliberately just past
 * the knee, so the first impression is "this is near saturation" rather than a
 * flat green dashboard.
 */
export function defaultDesign(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "single service",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "web client",
        x: 80,
        y: 220,
        client: { arrival: { kind: "poisson", ratePerSec: 80 }, timeoutMs: null },
      },
      {
        id: "api",
        kind: "server",
        label: "api server",
        x: 460,
        y: 220,
        server: {
          concurrency: 4,
          queueCapacity: null,
          serviceTime: { kind: "exponential", mean: 40 },
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
          fanout: "parallel",
          blocksOnDependencies: true,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        from: "client",
        to: "api",
        latency: { kind: "deterministic", value: 1 },
        lossProbability: 0,
      },
    ],
    classes: [],
    scenario: { durationSec: 1200, warmupSec: 200, seed: 1, traceLimit: 5000 },
    slo: { p99LatencyMs: 250, maxErrorRatePct: 1 },
  });
}

/**
 * A realistic read-path: balancer, three app replicas, cache, database.
 *
 * Exercises everything Phase 2 added -- load-balancer selection, a read-through
 * cache whose misses actually hit the database, a connection pool distinct from
 * execution parallelism, and two request classes with different costs.
 *
 * Sized so the database is the bottleneck and the cache is what saves it, because
 * that is the most common shape of a real capacity conversation.
 */
export function cachedReadPath(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "cached read path",
    classes: [
      { id: "read", label: "reads", weight: 9, serviceMultiplier: 1 },
      // Writes skip the cache and cost more at the database.
      { id: "write", label: "writes", weight: 1, serviceMultiplier: 3 },
    ],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "users",
        x: 40,
        y: 300,
        // Sized so the database sits near 85% and is unambiguously the
        // bottleneck, with the cache absorbing two thirds of the read traffic. An
        // example where everything idles teaches nothing.
        client: { arrival: { kind: "poisson", ratePerSec: 2200 }, timeoutMs: 1000 },
      },
      {
        id: "lb",
        kind: "loadbalancer",
        label: "load balancer",
        x: 320,
        y: 300,
        loadbalancer: {
          algorithm: "power-of-two-choices",
          serviceTime: bench("nginx-proxy").distribution,
          concurrency: 1024,
          citation: bench("nginx-proxy").citation,
        },
      },
      ...[0, 1, 2].map((i) => ({
        id: `api${i}`,
        kind: "server" as const,
        label: `api ${i + 1}`,
        x: 620,
        y: 120 + i * 180,
        server: {
          concurrency: 32,
          queueCapacity: null,
          serviceTime: bench("app-json-endpoint").distribution,
          admissionPolicy: "block" as const,
          queueDiscipline: "fifo" as const,
          replicas: 1,
          fanout: "parallel" as const,
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      })),
      {
        id: "cache",
        kind: "cache",
        label: "redis",
        x: 960,
        y: 180,
        cache: {
          capacity: 20_000,
          keyspace: { kind: "zipf", keys: 200_000, skew: 1.0 },
          serviceTime: bench("redis-get").distribution,
          concurrency: 1,
          ttlMs: 60_000,
          citation: bench("redis-get").citation,
        },
      },
      {
        id: "db",
        kind: "database",
        label: "postgres",
        x: 1300,
        y: 300,
        database: {
          poolSize: 20,
          parallelism: 8,
          // A range scan, not a point read: heavy enough that 8 cores are the
          // constraint, which is the situation worth modelling.
          serviceTime: bench("postgres-range-scan").distribution,
          queueCapacity: null,
          admissionPolicy: "block",
          citation: bench("postgres-range-scan").citation,
        },
      },
    ],
    edges: [
      { id: "e-c-lb", from: "client", to: "lb", latency: SAME_RACK, classes: [] },
      ...[0, 1, 2].map((i) => ({
        id: `e-lb-api${i}`,
        from: "lb",
        to: `api${i}`,
        latency: SAME_RACK,
        classes: [],
      })),
      // Reads go through the cache; writes go straight to the database.
      ...[0, 1, 2].map((i) => ({
        id: `e-api${i}-cache`,
        from: `api${i}`,
        to: "cache",
        latency: SAME_RACK,
        classes: ["read"],
      })),
      ...[0, 1, 2].map((i) => ({
        id: `e-api${i}-db`,
        from: `api${i}`,
        to: "db",
        latency: CROSS_AZ,
        classes: ["write"],
      })),
      { id: "e-cache-db", from: "cache", to: "db", latency: CROSS_AZ, classes: [] },
    ],
    scenario: { durationSec: 900, warmupSec: 150, seed: 1, traceLimit: 4000 },
    slo: { p99LatencyMs: 120, maxErrorRatePct: 0.5 },
  });
}

/**
 * A write path behind an asynchronous queue.
 *
 * Demonstrates the failure mode a synchronous queue model cannot show: request
 * latency stays flat and healthy while the backlog grows without bound, because
 * publishing returns immediately and the consumers cannot keep up.
 */
export function asyncWritePath(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "async write path",
    classes: [],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "uploads",
        x: 40,
        y: 200,
        client: { arrival: { kind: "poisson", ratePerSec: 120 }, timeoutMs: 2000 },
      },
      {
        id: "api",
        kind: "server",
        label: "ingest api",
        x: 360,
        y: 200,
        server: {
          concurrency: 64,
          queueCapacity: null,
          serviceTime: bench("app-json-endpoint").distribution,
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 2,
          fanout: "parallel",
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      },
      {
        id: "queue",
        kind: "queue",
        label: "job queue",
        x: 700,
        y: 200,
        queue: {
          maxDepth: null,
          // 4 consumers at 50ms each drain 80/s against 120/s offered: the
          // backlog grows forever while every request still looks fast.
          consumers: 4,
          consumerServiceTime: { kind: "exponential", mean: 50 },
          publishTime: bench("queue-publish").distribution,
          citation: bench("queue-publish").citation,
        },
      },
      {
        id: "worker",
        kind: "server",
        label: "worker",
        x: 1040,
        y: 200,
        server: {
          concurrency: 8,
          queueCapacity: null,
          serviceTime: { kind: "lognormal", mean: 30, p99: 200 },
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
          fanout: "parallel",
          blocksOnDependencies: true,
        },
      },
    ],
    edges: [
      { id: "e1", from: "client", to: "api", latency: SAME_RACK, classes: [] },
      { id: "e2", from: "api", to: "queue", latency: SAME_RACK, classes: [] },
      { id: "e3", from: "queue", to: "worker", latency: SAME_RACK, classes: [] },
    ],
    scenario: { durationSec: 600, warmupSec: 100, seed: 1, traceLimit: 3000 },
    slo: { p99LatencyMs: 200, maxErrorRatePct: 1 },
  });
}

/**
 * A retry storm, and the same design with the storm contained.
 *
 * The two share a topology and a workload and differ only in policy, so the
 * comparison isolates the effect of the policies rather than confounding it.
 *
 * The broken version is what almost every service does by default: retry on
 * failure, three attempts, no budget, no breaker, no bulkhead, and a blocking
 * caller. A database that fails 30% of the time then receives roughly double the
 * load it would otherwise see, which makes it fail more, which produces more
 * retries. The caller, holding a worker for every attempt plus backoff, runs out of
 * workers and starts failing requests that never needed the database at all.
 *
 * The fixed version changes no capacity anywhere. It adds a retry budget, a circuit
 * breaker and a bulkhead, and the failure stops spreading: the caller stays near
 * 12% utilization instead of pinned at 100%, and p99 lands around 140ms instead of
 * 2 seconds.
 *
 * THE TRADE IS REAL, AND WORTH SEEING RATHER THAN HIDING.
 *
 * The broken version delivers slightly MORE successful throughput (~400/s against
 * ~340/s) and reports a far lower error rate (~11% against ~24%), because
 * unbudgeted retries do genuinely recover more requests. It buys that by running
 * both stations at 100% with a 2-second p99, one perturbation away from collapse,
 * and by masking a 30% dependency failure rate that an operator ought to know
 * about. The contained version refuses to spend the caller's capacity hiding a
 * broken dependency. Which trade is right is a judgement; the tool's job is to
 * quantify both sides of it rather than to declare the fix free.
 */
function retryStormBase(fixed: boolean): Design {
  const dbFailure = 0.3;
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: fixed ? "retry storm, contained" : "retry storm",
    classes: [],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "users",
        x: 40,
        y: 240,
        // Sized so the database has headroom WITHOUT retries. Amplification eats
        // that margin, and then the caller's own pool goes with it.
        client: { arrival: { kind: "poisson", ratePerSec: 450 }, timeoutMs: 2000 },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 380,
        y: 240,
        server: {
          concurrency: 64,
          serviceTime: bench("app-json-endpoint").distribution,
          replicas: 2,
          // Thread-per-request: a worker is held for every attempt and every
          // backoff. This is what turns the dependency's problem into the caller's.
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      },
      {
        id: "db",
        kind: "database",
        label: "flaky database",
        x: 760,
        y: 240,
        database: {
          poolSize: 20,
          parallelism: 8,
          // 15ms queries over 8 execution slots is a ceiling of 533/s. At 380/s
          // offered the station is at 71%: comfortable, with no headroom for a
          // 1.4x retry multiplier.
          serviceTime: { kind: "lognormal", mean: 15, p99: 90 },
          // The injected fault everything else reacts to.
          failureProbability: dbFailure,
          citation: bench("postgres-range-scan").citation,
        },
      },
    ],
    edges: [
      { id: "e-c-api", from: "client", to: "api", latency: SAME_RACK, classes: [] },
      {
        id: "e-api-db",
        from: "api",
        to: "db",
        latency: SAME_RACK,
        classes: [],
        policy: fixed
          ? {
              timeoutMs: 200,
              retry: {
                maxAttempts: 3,
                backoff: { kind: "exponential", baseMs: 20, maxMs: 500, jitter: true },
                retryOn: ["error", "timeout"],
                // The whole fix, in one field: retries may add at most 10%.
                budgetRatio: 0.1,
              },
              // Return the caller's workers instead of parking them on a failing
              // dependency.
              circuitBreaker: {
                enabled: true,
                failureThreshold: 0.5,
                minimumRequests: 20,
                windowMs: 5000,
                openMs: 2000,
                halfOpenProbes: 2,
              },
              // Confine the damage to traffic that needs this dependency.
              bulkhead: { enabled: true, maxConcurrent: 24, queueCapacity: 8 },
            }
          : {
              timeoutMs: 200,
              retry: {
                maxAttempts: 3,
                backoff: { kind: "exponential", baseMs: 20, maxMs: 500, jitter: true },
                retryOn: ["error", "timeout"],
                // No budget. This is the default almost everywhere.
                budgetRatio: null,
              },
              circuitBreaker: { enabled: false },
              bulkhead: { enabled: false },
            },
      },
    ],
    scenario: { durationSec: 600, warmupSec: 100, seed: 1, traceLimit: 3000 },
    slo: { p99LatencyMs: 250, maxErrorRatePct: 5 },
  });
}

export const retryStorm = (): Design => retryStormBase(false);
export const retryStormContained = (): Design => retryStormBase(true);

/**
 * A load balancer over backends where one is broken.
 *
 * With health checking off, the bad backend keeps taking its full share and one
 * request in three fails. With it on, the backend is ejected and the failure rate
 * collapses -- which is the difference between a balancer and a splitter.
 */
export function outlierBackend(): Design {
  const backend = (i: number, failureProbability: number) => ({
    id: `api${i}`,
    kind: "server" as const,
    label: failureProbability > 0 ? `api ${i + 1} (broken)` : `api ${i + 1}`,
    x: 700,
    y: 100 + i * 160,
    server: {
      concurrency: 32,
      serviceTime: bench("app-json-endpoint").distribution,
      failureProbability,
      citation: bench("app-json-endpoint").citation,
    },
  });

  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "one broken backend",
    classes: [],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "users",
        x: 40,
        y: 260,
        client: { arrival: { kind: "poisson", ratePerSec: 600 }, timeoutMs: 1000 },
      },
      {
        id: "lb",
        kind: "loadbalancer",
        label: "load balancer",
        x: 340,
        y: 260,
        loadbalancer: {
          algorithm: "round-robin",
          serviceTime: bench("nginx-proxy").distribution,
          concurrency: 1024,
          healthCheck: {
            enabled: true,
            failureThreshold: 0.5,
            minimumRequests: 20,
            ejectionMs: 5000,
            maxEjectedFraction: 0.5,
          },
          citation: bench("nginx-proxy").citation,
        },
      },
      backend(0, 0),
      backend(1, 0),
      backend(2, 0.9),
    ],
    edges: [
      { id: "e-c-lb", from: "client", to: "lb", latency: SAME_RACK, classes: [] },
      ...[0, 1, 2].map((i) => ({
        id: `e-lb-api${i}`,
        from: "lb",
        to: `api${i}`,
        latency: SAME_RACK,
        classes: [],
      })),
    ],
    scenario: { durationSec: 600, warmupSec: 100, seed: 1, traceLimit: 3000 },
    slo: { p99LatencyMs: 150, maxErrorRatePct: 1 },
  });
}

/**
 * A ramp to failure: one run that finds the capacity limit.
 *
 * Offered load rises steadily from 50/s to 800/s over ten minutes of simulated time.
 * The database, with 8 execution slots at 15ms, tops out around 530/s, so the SLO
 * breaks partway up and the run records exactly where.
 *
 * The limit it reports runs slightly HIGH compared with a steady-state search,
 * because queues take time to fill and the system is always catching up with a load
 * that has already moved on. That bias is real, it is what a live load test also
 * does, and the tool names it rather than correcting it away.
 */
export function rampToFailure(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "ramp to failure",
    classes: [],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "users",
        x: 40,
        y: 220,
        client: {
          arrival: { kind: "ramp", fromRatePerSec: 50, toRatePerSec: 800 },
          timeoutMs: 2000,
        },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 380,
        y: 220,
        server: {
          concurrency: 64,
          serviceTime: bench("app-json-endpoint").distribution,
          replicas: 3,
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      },
      {
        id: "db",
        kind: "database",
        label: "postgres",
        x: 740,
        y: 220,
        database: {
          poolSize: 20,
          parallelism: 8,
          serviceTime: { kind: "lognormal", mean: 15, p99: 90 },
          citation: bench("postgres-range-scan").citation,
        },
      },
    ],
    edges: [
      { id: "e1", from: "client", to: "api", latency: SAME_RACK, classes: [] },
      { id: "e2", from: "api", to: "db", latency: SAME_RACK, classes: [] },
    ],
    // No warm-up: a ramp has no steady state to reach, and discarding the first slice
    // would delete the bottom of the ramp along with the baseline.
    scenario: { durationSec: 600, warmupSec: 0, seed: 1, traceLimit: 3000 },
    slo: { p99LatencyMs: 250, maxErrorRatePct: 2 },
  });
}

/**
 * A traffic spike, and the recovery afterwards.
 *
 * Four times normal load for thirty seconds, with calm on either side. Two questions
 * a steady-state run cannot ask: does the design survive the burst, and how long does
 * it take to work through the backlog once the burst has passed.
 *
 * Recovery is usually the more interesting answer. A queue built during a spike keeps
 * hurting requests that arrive after it, so a design can pass the spike itself and
 * still spend minutes catching up.
 */
export function trafficSpike(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "traffic spike",
    classes: [],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "users",
        x: 40,
        y: 220,
        client: {
          arrival: {
            kind: "spike",
            baseRatePerSec: 300,
            peakRatePerSec: 1200,
            atSec: 60,
            durationSec: 30,
          },
          timeoutMs: 3000,
        },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 380,
        y: 220,
        server: {
          concurrency: 64,
          serviceTime: bench("app-json-endpoint").distribution,
          replicas: 3,
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      },
      {
        id: "db",
        kind: "database",
        label: "postgres",
        x: 740,
        y: 220,
        database: {
          poolSize: 20,
          parallelism: 12,
          serviceTime: { kind: "lognormal", mean: 15, p99: 90 },
          citation: bench("postgres-range-scan").citation,
        },
      },
    ],
    edges: [
      { id: "e1", from: "client", to: "api", latency: SAME_RACK, classes: [] },
      { id: "e2", from: "api", to: "db", latency: SAME_RACK, classes: [] },
    ],
    scenario: { durationSec: 300, warmupSec: 0, seed: 1, traceLimit: 3000 },
    slo: { p99LatencyMs: 300, maxErrorRatePct: 2 },
  });
}

/**
 * A cascade driven by load-correlated failure.
 *
 * The database fails 2% of the time when idle and 40% when saturated. Combined with
 * unbudgeted retries that gives the feedback loop positive gain: load raises failures,
 * failures raise retries, retries raise load. With a CONSTANT failure rate the same
 * design merely slows down; the correlation is what makes it run away.
 *
 * This is the failure mode that no amount of steady-state analysis at the design's
 * nominal load would reveal, because at nominal load the database is not saturated and
 * so is not yet failing.
 */
export function correlatedCascade(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "load-correlated cascade",
    classes: [],
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "users",
        x: 40,
        y: 220,
        client: {
          // A spike is what tips it over: nominal load is comfortable.
          arrival: {
            kind: "spike",
            baseRatePerSec: 300,
            peakRatePerSec: 700,
            atSec: 60,
            durationSec: 60,
          },
          timeoutMs: 2000,
        },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 380,
        y: 220,
        server: {
          concurrency: 64,
          serviceTime: bench("app-json-endpoint").distribution,
          replicas: 3,
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      },
      {
        id: "db",
        kind: "database",
        label: "postgres",
        x: 740,
        y: 220,
        database: {
          poolSize: 20,
          parallelism: 10,
          serviceTime: { kind: "lognormal", mean: 15, p99: 90 },
          failureProbability: 0.02,
          // The term that gives the loop gain.
          failureAtSaturation: 0.4,
          citation: bench("postgres-range-scan").citation,
        },
      },
    ],
    edges: [
      { id: "e1", from: "client", to: "api", latency: SAME_RACK, classes: [] },
      {
        id: "e2",
        from: "api",
        to: "db",
        latency: SAME_RACK,
        classes: [],
        policy: {
          timeoutMs: 300,
          retry: {
            maxAttempts: 3,
            backoff: { kind: "exponential", baseMs: 20, maxMs: 500, jitter: true },
            retryOn: ["error", "timeout"],
            budgetRatio: null,
          },
          circuitBreaker: { enabled: false },
          bulkhead: { enabled: false },
        },
      },
    ],
    scenario: { durationSec: 300, warmupSec: 0, seed: 1, traceLimit: 3000 },
    slo: { p99LatencyMs: 300, maxErrorRatePct: 2 },
  });
}

/**
 * 20,000 concurrent chat users.
 *
 * The question this whole project started from, and one a request/response model cannot
 * express at all.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * 20,000 users hold open sockets. Each sends a message roughly every twenty seconds --
 * 1,000 messages a second in total, which is nothing. But each message goes to a room
 * of twenty, so the system does 20,000 DELIVERIES a second. The write path is amplified
 * twentyfold, and the amplification factor is a product decision (how big are rooms?)
 * that nobody thinks of as a capacity decision.
 *
 * THE ARCHITECTURE
 *
 *   users ---> gateways        hold the sockets, accept handshakes, push deliveries
 *                |
 *                v
 *              api             validate, persist
 *                |
 *                v
 *              bus (queue)     decouple send from deliver
 *                |
 *                v  x20 fan-out
 *              delivery        push work, back out through the gateways
 *
 * Delivery is modelled as its own station rather than looping back to the gateway,
 * because the graph is acyclic and a cycle would be rejected. That is a real
 * simplification: in a live deployment the same event loop does both, so accept work and
 * delivery work contend, whereas here they contend only within each station. The
 * `connectionCapacity` and memory figures still belong to the gateway, which is where
 * the "how many users" question actually lives.
 *
 * SIZING
 *
 * Four gateway instances at 10,000 sockets each gives 40,000 of capacity for 20,000
 * users -- deliberate headroom, because losing one instance must not refuse anyone.
 * The scenario is short: fan-out means a 120-second run simulates about 2.4 million
 * deliveries, which is the honest cost of modelling the effect rather than assuming it.
 */
export function chat20k(): Design {
  const ROOM_SIZE = 20;
  const USERS = 20_000;
  // One message per user every 20 seconds.
  const MESSAGES_PER_SEC = USERS / 20;

  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "chat: 20k concurrent users",
    classes: [],
    nodes: [
      {
        id: "users",
        kind: "client",
        label: "users",
        x: 40,
        y: 260,
        client: {
          arrival: { kind: "poisson", ratePerSec: MESSAGES_PER_SEC },
          timeoutMs: 5000,
          connections: {
            count: USERS,
            establishOverSec: 30,
            // Half-hour sessions: long enough that churn is modest, short enough that
            // it exists. Sessions that never end would understate accept work.
            sessionDuration: { kind: "exponential", mean: 1_800_000 },
            disruption: null,
          },
        },
      },
      {
        id: "gw",
        kind: "gateway",
        label: "gateways",
        x: 340,
        y: 260,
        gateway: {
          connectionCapacity: 10_000,
          replicas: 4,
          acceptTime: { kind: "lognormal", mean: 5, p99: 40 },
          pushTime: { kind: "deterministic", value: 0.2 },
          // Two slots per instance: push work is CPU-bound on an event loop, so this
          // is single digits however many sockets the instance holds. Getting this
          // wrong by two orders of magnitude is what makes fan-out look free.
          pushConcurrency: 2,
          memoryPerConnectionKb: 40,
          citation: {
            range: [10, 100],
            source:
              "per-connection memory for a WebSocket with modest buffers; varies with buffer sizing and TLS",
            asOf: "2026-08",
          },
        },
      },
      {
        id: "api",
        kind: "server",
        label: "message api",
        x: 640,
        y: 260,
        server: {
          concurrency: 64,
          replicas: 3,
          serviceTime: bench("app-json-endpoint").distribution,
          blocksOnDependencies: true,
          citation: bench("app-json-endpoint").citation,
        },
      },
      {
        id: "bus",
        kind: "queue",
        label: "fan-out bus",
        x: 940,
        y: 260,
        queue: {
          maxDepth: null,
          // Consumers here are the fan-out workers, sized for the DELIVERY rate rather
          // than the message rate -- which is the whole trap.
          consumers: 32,
          consumerServiceTime: { kind: "deterministic", value: 0.5 },
          publishTime: bench("queue-publish").distribution,
          citation: bench("queue-publish").citation,
        },
      },
      {
        id: "delivery",
        kind: "gateway",
        label: "delivery (gateway push)",
        x: 1260,
        y: 260,
        gateway: {
          // Holds no sockets: this station represents the gateways' push side only.
          connectionCapacity: 1,
          replicas: 1,
          acceptTime: { kind: "deterministic", value: 0 },
          pushTime: { kind: "deterministic", value: 0.2 },
          // Four instances at two slots each: the same event loops the accept side uses.
          pushConcurrency: 8,
          memoryPerConnectionKb: 0,
        },
      },
    ],
    edges: [
      { id: "e-users-gw", from: "users", to: "gw", latency: bench("consumer-internet").distribution, classes: [] },
      { id: "e-gw-api", from: "gw", to: "api", latency: SAME_RACK, classes: [] },
      { id: "e-api-bus", from: "api", to: "bus", latency: SAME_RACK, classes: [] },
      {
        id: "e-bus-delivery",
        from: "bus",
        to: "delivery",
        latency: SAME_RACK,
        classes: [],
        // One message becomes ROOM_SIZE deliveries. The single most important number
        // in the design, and the one least likely to appear in a capacity estimate.
        fanoutFactor: ROOM_SIZE,
      },
    ],
    scenario: { durationSec: 120, warmupSec: 40, seed: 1, traceLimit: 2000 },
    // 800ms rather than 500: two crossings of the consumer internet already cost
    // several hundred milliseconds at the tail, and an SLO that the last mile breaks on
    // its own would make every finding about someone else's network.
    slo: { p99LatencyMs: 800, maxErrorRatePct: 1 },
  });
}

/**
 * The same chat design, losing a gateway.
 *
 * A quarter of the connections drop at once and reconnect. Handshake work is far more
 * expensive than a message, and it competes with delivery for the same slots, so the
 * people who never disconnected see their messages stall because somebody else's
 * connection did.
 *
 * This is the failure realtime systems actually have. It is invisible to any
 * steady-state measurement, and it is why capacity headroom on connections is not the
 * same thing as resilience.
 */
export function chatReconnectStorm(): Design {
  const base = chat20k();
  return DesignSchema.parse({
    ...base,
    name: "chat: losing a gateway",
    nodes: base.nodes.map((n) =>
      n.client?.connections
        ? {
            ...n,
            client: {
              ...n.client,
              connections: {
                ...n.client.connections,
                disruption: { atSec: 70, fraction: 0.25, reconnectOverSec: 0 },
              },
            },
          }
        : n
    ),
    scenario: { ...base.scenario, durationSec: 140, warmupSec: 40 },
  });
}

export const EXAMPLES: Array<{ id: string; label: string; blurb: string; build: () => Design }> = [
  {
    id: "single-service",
    label: "single service",
    blurb: "one client, one capacity-limited server at 80% utilization",
    build: defaultDesign,
  },
  {
    id: "cached-read-path",
    label: "cached read path",
    blurb: "balancer, three replicas, read-through cache, connection-pooled database",
    build: cachedReadPath,
  },
  {
    id: "async-write-path",
    label: "async write path",
    blurb: "a queue whose backlog grows while every request still looks fast",
    build: asyncWritePath,
  },
  {
    id: "retry-storm",
    label: "retry storm",
    blurb: "a flaky database, unbudgeted retries, and a caller that runs out of workers",
    build: retryStorm,
  },
  {
    id: "retry-storm-contained",
    label: "retry storm, contained",
    blurb: "the same design with a budget, a breaker and a bulkhead — no extra capacity",
    build: retryStormContained,
  },
  {
    id: "outlier-backend",
    label: "one broken backend",
    blurb: "health checking ejects the outlier instead of routing a third of traffic into it",
    build: outlierBackend,
  },
  {
    id: "ramp-to-failure",
    label: "ramp to failure",
    blurb: "load rises 50→800/s in one run; the first SLO breach marks the limit",
    build: rampToFailure,
  },
  {
    id: "traffic-spike",
    label: "traffic spike",
    blurb: "4× load for 30s, then how long the backlog takes to drain",
    build: trafficSpike,
  },
  {
    id: "correlated-cascade",
    label: "load-correlated cascade",
    blurb: "a database that fails more when busy, plus unbudgeted retries — a loop with gain",
    build: correlatedCascade,
  },
  {
    id: "chat-20k",
    label: "chat: 20k concurrent users",
    blurb: "1,000 messages/s becomes 20,000 deliveries/s — fan-out is the whole cost",
    build: chat20k,
  },
  {
    id: "chat-reconnect-storm",
    label: "chat: losing a gateway",
    blurb: "a quarter of connections reconnect at once, and handshakes starve delivery",
    build: chatReconnectStorm,
  },
];
