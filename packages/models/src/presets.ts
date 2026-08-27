import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
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
    id: "client",
    label: "client",
    kind: "client",
    blurb: "originates work. Poisson arrivals are burstier than a fixed rate at the same average.",
    build: (id, x, y) => ({
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
      return {
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
      };
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
      return {
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
      };
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
      return {
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
      };
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
      return {
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
      };
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
      return {
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
      };
    },
  },
  {
    id: "object-store",
    label: "object store",
    kind: "server",
    blurb: "high latency, very high concurrency. Almost never the bottleneck; often the tail.",
    build: (id, x, y) => {
      const b = bench("object-store-get");
      return {
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
      };
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
      return {
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
      };
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
];
