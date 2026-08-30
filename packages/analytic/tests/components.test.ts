import { describe, expect, it } from "vitest";
import { runSimulation, zipfTopMass, type RunResult } from "@sds/core";
import {
  DesignSchema,
  validateDesign,
  type Design,
  type SdsEdge,
  type SdsNode,
} from "@sds/schema";
import { EXAMPLES } from "@sds/models";
import { previewDesign } from "../src/preview";
import { solveMMc } from "../src/queueing";
import { meanOf, relError, SEEDS } from "./harness";

/**
 * PHASE 2 VALIDATION
 *
 * Same standard as Phase 1: every assertion checks a formula or a theorem, never a
 * recorded output. Where no closed form exists -- fork-join, power-of-two-choices,
 * LRU under skew -- the test pins the KNOWN QUALITATIVE RESULT and its direction,
 * which is still falsifiable. "Roughly matches what it did last time" is not.
 */

const MEAN_TOLERANCE = 0.03;

function design(parts: {
  nodes: unknown[];
  edges: unknown[];
  classes?: unknown[];
  durationSec?: number;
  warmupSec?: number;
}): Design {
  return DesignSchema.parse({
    version: 5,
    name: "validation",
    nodes: parts.nodes,
    edges: parts.edges,
    classes: parts.classes ?? [],
    scenario: {
      durationSec: parts.durationSec ?? 600,
      warmupSec: parts.warmupSec ?? 100,
      seed: 1,
      traceLimit: 0,
    },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

const client = (rate: number, timeoutMs: number | null = null): unknown => ({
  id: "client",
  kind: "client",
  label: "client",
  x: 0,
  y: 0,
  client: { arrival: { kind: "poisson", ratePerSec: rate }, timeoutMs },
});

const server = (
  id: string,
  o: { c: number; meanMs: number; blocks?: boolean; replicas?: number; fanout?: "parallel" | "sequential" }
): unknown => ({
  id,
  kind: "server",
  label: id,
  x: 0,
  y: 0,
  server: {
    concurrency: o.c,
    queueCapacity: null,
    serviceTime: { kind: "exponential", mean: o.meanMs },
    admissionPolicy: "block",
    queueDiscipline: "fifo",
    replicas: o.replicas ?? 1,
    fanout: o.fanout ?? "parallel",
    blocksOnDependencies: o.blocks ?? true,
  },
});

const edge = (id: string, from: string, to: string, extra: Partial<SdsEdge> = {}): unknown => ({
  id,
  from,
  to,
  latency: { kind: "deterministic", value: 0 },
  lossProbability: 0,
  ...extra,
});

const runs = (d: Design, seeds = SEEDS): RunResult[] =>
  seeds.map((seed) => runSimulation(d, { seed, collectTrace: false }));

const nodeOf = (r: RunResult, id: string) => r.nodes.find((n) => n.nodeId === id)!;
const statOf = (rs: RunResult[], id: string, pick: (n: ReturnType<typeof nodeOf>) => number) =>
  meanOf(rs.map((r) => pick(nodeOf(r, id))));

// ---------------------------------------------------------------------------

describe("load balancer: pooling beats partitioning", () => {
  /**
   * A single queue in front of c servers strictly outperforms c independent queues
   * each fed 1/c of the traffic. This is a theorem, not a heuristic: idle capacity
   * cannot be stranded behind an empty queue when there is only one queue.
   *
   * At high utilization the gap is dramatic, and it is the reason a load balancer
   * exists. A tool that could not show it would be missing the point of the
   * component.
   */
  const rho = 0.8;
  const meanMs = 40;
  const n = 4;
  const mu = 1000 / meanMs;
  const lambda = rho * n * mu;

  it("M/M/4 beats four M/M/1s at the same total load, by the Erlang-C margin", () => {
    const pooled = solveMMc({ lambda, mu, c: n });
    const partitioned = solveMMc({ lambda: lambda / n, mu, c: 1 });
    expect(pooled.wMs).toBeLessThan(partitioned.wMs);

    // Simulated: one balancer over four backends, versus one backend at 1/4 load.
    const balanced = design({
      nodes: [
        client(lambda),
        {
          id: "lb",
          kind: "loadbalancer",
          label: "lb",
          x: 0,
          y: 0,
          loadbalancer: {
            algorithm: "least-connections",
            serviceTime: { kind: "deterministic", value: 0 },
            concurrency: 100_000,
          },
        },
        ...[0, 1, 2, 3].map((i) => server(`b${i}`, { c: 1, meanMs })),
      ],
      edges: [
        edge("e-c", "client", "lb"),
        ...[0, 1, 2, 3].map((i) => edge(`e-${i}`, "lb", `b${i}`)),
      ],
      durationSec: 1500,
      warmupSec: 250,
    });

    const single = design({
      nodes: [client(lambda / n), server("b0", { c: 1, meanMs })],
      edges: [edge("e", "client", "b0")],
      durationSec: 1500,
      warmupSec: 250,
    });

    const balancedW = meanOf(runs(balanced).map((r) => r.endToEnd.mean));
    const singleW = meanOf(runs(single).map((r) => r.endToEnd.mean));

    /**
     * Least-connections approaches pooling but cannot equal it, and the reason is
     * worth stating: once the balancer assigns a request to a backend, that
     * assignment is irrevocable. When a backend frees up it takes the next NEW
     * arrival, not a request already waiting in a sibling's queue. A single shared
     * queue has no such stranding.
     *
     * So the correct claim is an ordering, not an equality: pooling is the floor,
     * static partitioning is the ceiling, and least-connections lands much nearer
     * the floor.
     */
    expect(pooled.wMs).toBeLessThan(balancedW);
    expect(balancedW).toBeLessThan(singleW);
    const position = (balancedW - pooled.wMs) / (singleW - pooled.wMs);
    expect(position).toBeLessThan(0.25);
    expect(relError(singleW, partitioned.wMs)).toBeLessThan(MEAN_TOLERANCE);
  });
});

describe("load balancer: the power of two choices", () => {
  /**
   * Sampling two backends at random and taking the shorter queue reduces maximum
   * load from ~log n / log log n above average (pure random) to ~log log n. An
   * exponential improvement from one extra probe.
   *
   * The mean is barely affected -- the whole effect is on the spread of queue
   * lengths -- which is exactly why the closed form cannot see it and the
   * simulation must. Round-robin and least-connections bracket the comparison:
   * round-robin is perfectly even in COUNT but blind to actual load, while
   * least-connections is the ideal that p2c approximates with far less
   * information.
   */
  const backends = 8;
  const meanMs = 40;
  const mu = 1000 / meanMs;
  const lambda = 0.85 * backends * mu;

  const build = (algorithm: string): Design =>
    design({
      nodes: [
        client(lambda),
        {
          id: "lb",
          kind: "loadbalancer",
          label: "lb",
          x: 0,
          y: 0,
          loadbalancer: {
            algorithm,
            serviceTime: { kind: "deterministic", value: 0 },
            concurrency: 100_000,
          },
        },
        ...Array.from({ length: backends }, (_, i) => server(`b${i}`, { c: 1, meanMs })),
      ],
      edges: [
        edge("e-c", "client", "lb"),
        ...Array.from({ length: backends }, (_, i) => edge(`e-${i}`, "lb", `b${i}`)),
      ],
      durationSec: 900,
      warmupSec: 150,
    });

  const latency = (algorithm: string) =>
    meanOf(runs(build(algorithm), [1, 2, 3, 4]).map((r) => r.endToEnd.p99));

  it("p2c beats random, and approaches least-connections", () => {
    const random = latency("random");
    const p2c = latency("power-of-two-choices");
    const leastConn = latency("least-connections");

    expect(p2c).toBeLessThan(random);
    expect(leastConn).toBeLessThanOrEqual(p2c * 1.05);
    // The gap between one probe and two is large, not marginal.
    expect(p2c).toBeLessThan(random * 0.85);
  });

  it("round-robin splits counts evenly but is still beaten on latency by p2c", () => {
    const rr = build("round-robin");
    const rsRr = runs(rr, [1, 2, 3, 4]);
    const lb = nodeOf(rsRr[0]!, "lb").loadbalancer!;
    // Perfectly even by construction: it rotates.
    expect(lb.worstImbalancePct).toBeLessThan(0.5);

    const rrP99 = meanOf(rsRr.map((r) => r.endToEnd.p99));
    expect(latency("power-of-two-choices")).toBeLessThan(rrP99);
  });

  it("every algorithm dispatches every request exactly once", () => {
    for (const algorithm of ["round-robin", "random", "least-connections", "power-of-two-choices"]) {
      const r = runSimulation(build(algorithm), { collectTrace: false });
      const lb = nodeOf(r, "lb").loadbalancer!;
      const summed = lb.perBackend.reduce((s, b) => s + b.dispatched, 0);
      expect(summed).toBe(lb.dispatched);
      expect(lb.perBackend.every((b) => b.dispatched > 0)).toBe(true);
    }
  });
});

describe("cache: the hit ratio is an output, and it matches Zipf theory", () => {
  /**
   * The cache samples a real key population and uses a real LRU map, so the hit
   * ratio is measured rather than assumed. Two checks with known answers:
   *
   *  - Uniform keys (skew 0): any capacity-C cache over N keys hits C/N. Exact.
   *  - Skewed keys: the perfect-cache bound is the Zipf mass of the top C keys.
   *    LRU must come in below it, because LRU wastes capacity on keys that will
   *    not be requested again soon -- but not far below.
   */
  const buildCache = (o: {
    keys: number;
    skew: number;
    capacity: number;
    ttlMs?: number | null;
  }): Design =>
    design({
      nodes: [
        client(200),
        {
          id: "cache",
          kind: "cache",
          label: "cache",
          x: 0,
          y: 0,
          cache: {
            capacity: o.capacity,
            keyspace: { kind: "zipf", keys: o.keys, skew: o.skew },
            serviceTime: { kind: "deterministic", value: 0.2 },
            concurrency: 64,
            ttlMs: o.ttlMs ?? null,
          },
        },
        server("origin", { c: 64, meanMs: 5 }),
      ],
      edges: [edge("e1", "client", "cache"), edge("e2", "cache", "origin")],
      durationSec: 900,
      warmupSec: 300,
    });

  it("uniform keys give a hit ratio of capacity/keys", () => {
    const keys = 1000;
    const capacity = 250;
    const r = runSimulation(buildCache({ keys, skew: 0, capacity }), { collectTrace: false });
    const measured = nodeOf(r, "cache").cache!.hitRatio;
    expect(relError(measured, capacity / keys)).toBeLessThan(0.05);
  });

  it("LRU under skew sits just below the perfect-cache bound", () => {
    const keys = 100_000;
    const skew = 1.0;
    const capacity = 10_000;
    const bound = zipfTopMass(keys, skew, capacity);
    const r = runSimulation(buildCache({ keys, skew, capacity }), { collectTrace: false });
    const measured = nodeOf(r, "cache").cache!.hitRatio;

    // Skew is the whole reason caching works: 10% of the keys carry most of the
    // traffic. A uniform model would predict 0.10 here.
    expect(bound).toBeGreaterThan(0.55);
    expect(measured).toBeLessThanOrEqual(bound);
    expect(measured).toBeGreaterThan(bound * 0.85);
  });

  it("more skew means a higher hit ratio at identical capacity", () => {
    const flat = runSimulation(buildCache({ keys: 50_000, skew: 0.6, capacity: 5000 }), {
      collectTrace: false,
    });
    const sharp = runSimulation(buildCache({ keys: 50_000, skew: 1.2, capacity: 5000 }), {
      collectTrace: false,
    });
    expect(nodeOf(sharp, "cache").cache!.hitRatio).toBeGreaterThan(
      nodeOf(flat, "cache").cache!.hitRatio
    );
  });

  it("only misses reach the origin", () => {
    // The defining property of read-through, and the thing the legacy engine got
    // wrong: its cache always "hit" and a miss never read anything.
    const d = buildCache({ keys: 20_000, skew: 1.0, capacity: 4000 });
    const r = runSimulation(d, { collectTrace: false });
    const cache = nodeOf(r, "cache");
    const origin = nodeOf(r, "origin");
    expect(cache.cache!.hitRatio).toBeGreaterThan(0.2);
    expect(cache.cache!.hitRatio).toBeLessThan(0.95);
    // Origin arrivals should equal cache misses, within end-of-run truncation.
    expect(relError(origin.arrivals, cache.cache!.misses)).toBeLessThan(0.02);
  });

  it("a TTL forces expiry and lowers the hit ratio", () => {
    const noTtl = runSimulation(buildCache({ keys: 20_000, skew: 1.0, capacity: 8000 }), {
      collectTrace: false,
    });
    const shortTtl = runSimulation(
      buildCache({ keys: 20_000, skew: 1.0, capacity: 8000, ttlMs: 200 }),
      { collectTrace: false }
    );
    const a = nodeOf(noTtl, "cache").cache!;
    const b = nodeOf(shortTtl, "cache").cache!;
    expect(b.hitRatio).toBeLessThan(a.hitRatio);
    expect(b.expirations).toBeGreaterThan(0);
    expect(a.expirations).toBe(0);
  });

  it("the analytic preview predicts the measured hit ratio", () => {
    const d = buildCache({ keys: 100_000, skew: 0.9, capacity: 20_000 });
    const predicted = previewDesign(d).nodes.find((n) => n.nodeId === "cache")!.hitRatio!;
    const measured = nodeOf(runSimulation(d, { collectTrace: false }), "cache").cache!.hitRatio;
    // The preview reports the perfect-cache bound, so it is expected to sit
    // slightly above LRU rather than to match it exactly.
    expect(predicted).toBeGreaterThanOrEqual(measured);
    expect(relError(measured, predicted)).toBeLessThan(0.2);
  });
});

describe("database: the pool is not the capacity", () => {
  /**
   * A database's throughput ceiling is `parallelism / E[S]`, whatever the pool
   * size. Raising the pool past parallelism converts pool-wait into
   * execution-wait and changes nothing else.
   *
   * This is the most common capacity mistake in practice, and a single-resource
   * model cannot express it -- which makes the wrong fix look right.
   */
  const buildDb = (poolSize: number, parallelism: number, lambda: number): Design =>
    design({
      nodes: [
        client(lambda),
        {
          id: "db",
          kind: "database",
          label: "db",
          x: 0,
          y: 0,
          database: {
            poolSize,
            parallelism,
            serviceTime: { kind: "exponential", mean: 20 },
            queueCapacity: null,
            admissionPolicy: "block",
          },
        },
      ],
      edges: [edge("e", "client", "db")],
      durationSec: 900,
      warmupSec: 150,
    });

  it("throughput ceiling is parallelism/E[S], independent of pool size", () => {
    // parallelism 4, 20ms service => 200/s maximum, offered 400/s.
    const ceiling = (4 * 1000) / 20;
    for (const poolSize of [4, 20, 100, 500]) {
      const r = runSimulation(buildDb(poolSize, 4, 400), { collectTrace: false });
      expect(r.throughputPerSec).toBeLessThanOrEqual(ceiling * 1.02);
      expect(r.throughputPerSec).toBeGreaterThan(ceiling * 0.95);
    }
  });

  it("a pool below parallelism is the binding constraint", () => {
    // pool 2 with parallelism 8 caps concurrency at 2, so the ceiling is 100/s.
    const r = runSimulation(buildDb(2, 8, 400), { collectTrace: false });
    expect(r.throughputPerSec).toBeLessThanOrEqual((2 * 1000) / 20 * 1.02);

    const preview = previewDesign(buildDb(2, 8, 400));
    const db = preview.nodes.find((n) => n.nodeId === "db")!;
    expect(db.database!.poolIsBinding).toBe(true);
    expect(db.database!.effectiveConcurrency).toBe(2);
    expect(preview.notes.join(" ")).toMatch(/connections are the constraint/);
  });

  it("raising the pool past parallelism moves the wait, it does not remove it", () => {
    // Below saturation so both configurations have a steady state to compare.
    const small = runSimulation(buildDb(4, 4, 150), { collectTrace: false });
    const large = runSimulation(buildDb(64, 4, 150), { collectTrace: false });

    const a = nodeOf(small, "db").database!;
    const b = nodeOf(large, "db").database!;

    // Total latency is essentially unchanged...
    expect(relError(large.endToEnd.mean, small.endToEnd.mean)).toBeLessThan(0.08);
    // ...but with a big pool the waiting has moved inside, from pool to execution.
    expect(a.avgPoolWaitMs).toBeGreaterThan(b.avgPoolWaitMs);
    expect(b.avgExecutionWaitMs).toBeGreaterThan(a.avgExecutionWaitMs);
  });

  it("execution utilization matches M/M/c with c = min(pool, parallelism)", () => {
    const parallelism = 6;
    const poolSize = 40;
    const meanMs = 20;
    const lambda = 0.8 * ((parallelism * 1000) / meanMs);
    const rs = runs(buildDb(poolSize, parallelism, lambda));
    const measured = statOf(rs, "db", (n) => n.database!.executionUtilization);
    expect(relError(measured, 0.8)).toBeLessThan(MEAN_TOLERANCE);
  });
});

describe("queue: an asynchronous boundary", () => {
  const buildQueue = (o: {
    lambda: number;
    consumers: number;
    consumerMs: number;
    maxDepth?: number | null;
  }): Design =>
    design({
      nodes: [
        client(o.lambda, 5000),
        server("api", { c: 256, meanMs: 2 }),
        {
          id: "q",
          kind: "queue",
          label: "q",
          x: 0,
          y: 0,
          queue: {
            maxDepth: o.maxDepth ?? null,
            consumers: o.consumers,
            consumerServiceTime: { kind: "exponential", mean: o.consumerMs },
            publishTime: { kind: "deterministic", value: 1 },
          },
        },
      ],
      edges: [edge("e1", "client", "api"), edge("e2", "api", "q")],
      durationSec: 600,
      warmupSec: 100,
    });

  it("publishing returns immediately: request latency excludes consumer work", () => {
    /**
     * THE DEFINING PROPERTY. Consumer work is 500ms; request latency must stay a
     * few milliseconds, because nobody waits for it.
     *
     * The legacy engine returned to the caller only after fanning out to consumers
     * and decremented the depth immediately (engine.jsx:169-178), so it modelled
     * neither the decoupling nor the backlog.
     */
    const r = runSimulation(buildQueue({ lambda: 50, consumers: 64, consumerMs: 500 }), {
      collectTrace: false,
    });
    expect(r.endToEnd.mean).toBeLessThan(20);
    const q = nodeOf(r, "q").queue!;
    expect(q.consumed).toBeGreaterThan(0);
    // Backlog age, not request latency, is where the consumer time shows up.
    expect(q.backlogAge.mean).toBeGreaterThanOrEqual(0);
  });

  it("consumers behave as an M/M/c station on backlog wait", () => {
    // 8 consumers at 50ms drain 160/s; offer 128/s for rho = 0.8. The backlog is
    // then an ordinary M/M/8 queue and Erlang-C applies to the waiting time.
    const consumers = 8;
    const consumerMs = 50;
    const drain = (consumers * 1000) / consumerMs;
    const lambda = 0.8 * drain;
    const exact = solveMMc({ lambda, mu: 1000 / consumerMs, c: consumers });

    const rs = runs(buildQueue({ lambda, consumers, consumerMs }), [1, 2, 3, 4]);
    const measuredAge = meanOf(rs.map((r) => nodeOf(r, "q").queue!.backlogAge.mean));
    expect(relError(measuredAge, exact.wqMs)).toBeLessThan(0.06);

    const util = meanOf(rs.map((r) => nodeOf(r, "q").queue!.consumerUtilization));
    expect(relError(util, 0.8)).toBeLessThan(MEAN_TOLERANCE);
  });

  it("an overloaded queue grows without bound while every percentile stays green", () => {
    /**
     * The failure mode a synchronous queue model cannot show, and the reason the
     * stability report calls it out separately. 4 consumers at 50ms drain 80/s
     * against 120/s arriving.
     */
    const r = runSimulation(buildQueue({ lambda: 120, consumers: 4, consumerMs: 50 }), {
      collectTrace: false,
    });
    const q = nodeOf(r, "q").queue!;

    expect(q.drainCapacityPerSec).toBeCloseTo(80, 6);
    expect(q.backlogGrowthPerSec).toBeGreaterThan(20);
    expect(q.maxBacklog).toBeGreaterThan(1000);

    // Requests look perfectly healthy.
    expect(r.endToEnd.p99).toBeLessThan(50);
    expect(r.errors.ratePct).toBeLessThan(1);
    // The synchronous verdict is "stable", because it is: the request path is fine.
    expect(r.stability.stable).toBe(true);
    // But the async warning fires and explains exactly what is wrong.
    expect(r.stability.asyncBacklogWarning).toMatch(/falling behind/);
    expect(r.stability.asyncBacklogWarning).toMatch(/publishing returns immediately/);
  });

  it("the preview predicts the backlog problem without simulating", () => {
    const preview = previewDesign(buildQueue({ lambda: 120, consumers: 4, consumerMs: 50 }));
    const q = preview.nodes.find((n) => n.nodeId === "q")!;
    expect(q.queue!.drainCapacityPerSec).toBeCloseTo(80, 6);
    expect(q.queue!.backlogStable).toBe(false);
    expect(preview.asyncBacklogWarning).toMatch(/cannot keep up/);
    // And it does NOT call the design unstable, because requests are fine.
    expect(preview.stable).toBe(true);
  });

  it("a bounded queue drops instead of growing", () => {
    const r = runSimulation(
      buildQueue({ lambda: 120, consumers: 4, consumerMs: 50, maxDepth: 100 }),
      { collectTrace: false }
    );
    const q = nodeOf(r, "q").queue!;
    expect(q.maxBacklog).toBeLessThanOrEqual(100);
    expect(q.dropped).toBeGreaterThan(0);
    // Now the failure IS visible in request results, which is the trade a bound buys.
    expect(r.errors.queueFull).toBeGreaterThan(0);
    expect(r.errors.ratePct).toBeGreaterThan(20);
  });
});

describe("blocking vs non-blocking dependency calls", () => {
  /**
   * A thread-per-request server holds its worker slot while waiting on a
   * dependency. That is the mechanism behind most cascading failures: the
   * dependency slows down, and the caller runs out of workers even though its own
   * CPU work is unchanged.
   *
   * A non-blocking server releases the slot, so its capacity depends only on its
   * own work. Modelling both makes the difference visible instead of assumed.
   */
  const buildChain = (blocks: boolean, depMeanMs: number): Design =>
    design({
      nodes: [
        client(100),
        server("api", { c: 16, meanMs: 2, blocks }),
        server("dep", { c: 64, meanMs: depMeanMs }),
      ],
      edges: [edge("e1", "client", "api"), edge("e2", "api", "dep")],
      durationSec: 600,
      warmupSec: 100,
    });

  it("a blocking caller's utilization tracks the dependency's latency", () => {
    // Own work 2ms, dependency 100ms, 100 req/s, 16 workers.
    // Blocking: demand = 102ms each => 100 * 0.102 = 10.2 busy workers of 16.
    const r = runSimulation(buildChain(true, 100), { collectTrace: false });
    const api = nodeOf(r, "api");
    expect(api.utilization).toBeGreaterThan(0.55);
    expect(relError(api.utilization, (100 * 0.102) / 16)).toBeLessThan(0.08);
  });

  it("a non-blocking caller's utilization depends only on its own work", () => {
    // Own work 2ms only => 100 * 0.002 = 0.2 busy workers of 16 = 1.25%.
    const r = runSimulation(buildChain(false, 100), { collectTrace: false });
    const api = nodeOf(r, "api");
    expect(api.utilization).toBeLessThan(0.05);
    expect(relError(api.utilization, (100 * 0.002) / 16)).toBeLessThan(0.15);
  });

  it("a dependency slowdown saturates a blocking caller but not a non-blocking one", () => {
    // The cascading-failure mechanism, isolated. Same dependency, same load; only
    // the caller's concurrency model differs.
    const blockingFast = runSimulation(buildChain(true, 50), { collectTrace: false });
    const blockingSlow = runSimulation(buildChain(true, 150), { collectTrace: false });
    const asyncSlow = runSimulation(buildChain(false, 150), { collectTrace: false });

    expect(nodeOf(blockingSlow, "api").utilization).toBeGreaterThan(
      nodeOf(blockingFast, "api").utilization * 2
    );
    expect(nodeOf(asyncSlow, "api").utilization).toBeLessThan(0.05);
  });

  it("the preview reflects the difference and flags the composite as approximate", () => {
    const blocking = previewDesign(buildChain(true, 100));
    const async = previewDesign(buildChain(false, 100));
    const bApi = blocking.nodes.find((n) => n.nodeId === "api")!;
    const aApi = async.nodes.find((n) => n.nodeId === "api")!;

    expect(bApi.effectiveServiceMeanMs).toBeGreaterThan(bApi.ownServiceMeanMs * 10);
    expect(aApi.effectiveServiceMeanMs).toBeCloseTo(aApi.ownServiceMeanMs, 6);
    expect(bApi.rho).toBeGreaterThan(aApi.rho * 10);
    expect(bApi.caveat).toMatch(/holds its slot/);
    expect(blocking.approximate).toBe(true);
  });
});

describe("fork-join: parallel costs the maximum, sequential costs the sum", () => {
  /**
   * No exact closed form exists for the response time of a fork-join, because the
   * distribution of a maximum of dependent queueing delays is intractable. What IS
   * known and testable:
   *
   *   max(E[X], E[Y]) <= E[max(X,Y)] <= E[X] + E[Y]
   *
   * The preview reports max(E) and labels it a LOWER BOUND rather than an estimate,
   * which this test verifies in both directions.
   */
  const buildFanout = (fanout: "parallel" | "sequential"): Design =>
    design({
      nodes: [
        client(50),
        server("api", { c: 256, meanMs: 1, fanout, blocks: true }),
        server("a", { c: 64, meanMs: 40 }),
        server("b", { c: 64, meanMs: 60 }),
      ],
      edges: [
        edge("e1", "client", "api"),
        edge("e2", "api", "a"),
        edge("e3", "api", "b"),
      ],
      durationSec: 600,
      warmupSec: 100,
    });

  it("parallel is slower than the slowest branch but faster than the sum", () => {
    const r = runSimulation(buildFanout("parallel"), { collectTrace: false });
    // Branches are lightly loaded, so their response times are near their service
    // means of 40ms and 60ms.
    expect(r.endToEnd.mean).toBeGreaterThan(60);
    expect(r.endToEnd.mean).toBeLessThan(101);
  });

  it("sequential costs the sum", () => {
    const r = runSimulation(buildFanout("sequential"), { collectTrace: false });
    expect(relError(r.endToEnd.mean, 1 + 40 + 60)).toBeLessThan(0.06);
  });

  it("parallel is strictly faster than sequential for the same work", () => {
    const parallel = runSimulation(buildFanout("parallel"), { collectTrace: false });
    const sequential = runSimulation(buildFanout("sequential"), { collectTrace: false });
    expect(parallel.endToEnd.mean).toBeLessThan(sequential.endToEnd.mean);
  });

  it("the preview reports the parallel mean as a lower bound and withholds the p99", () => {
    const preview = previewDesign(buildFanout("parallel"));
    expect(preview.meanIsLowerBound).toBe(true);
    expect(preview.endToEndMeanMs).not.toBeNull();
    // A genuine lower bound: the simulation must land at or above it.
    const measured = runSimulation(buildFanout("parallel"), { collectTrace: false }).endToEnd.mean;
    expect(measured).toBeGreaterThanOrEqual(preview.endToEndMeanMs! * 0.98);
    expect(preview.endToEndP99Ms).toBeNull();
    expect(preview.p99Reason).toMatch(/fork-join/);
  });
});

describe("request classes route independently", () => {
  /**
   * Per-class routing is what makes "3% of traffic hits the expensive endpoint"
   * expressible. The legacy engine sent every request down every outgoing edge, so
   * this whole dimension was missing.
   */
  const d = design({
    classes: [
      { id: "cheap", label: "cheap", weight: 9, serviceMultiplier: 1 },
      { id: "heavy", label: "heavy", weight: 1, serviceMultiplier: 1 },
    ],
    nodes: [
      client(100),
      server("api", { c: 256, meanMs: 1 }),
      server("fast", { c: 64, meanMs: 5 }),
      server("slow", { c: 64, meanMs: 200 }),
    ],
    edges: [
      edge("e1", "client", "api"),
      edge("e2", "api", "fast", { classes: ["cheap"] }),
      edge("e3", "api", "slow", { classes: ["heavy"] }),
    ],
    durationSec: 900,
    warmupSec: 150,
  });

  it("each class reaches only its own dependency", () => {
    const r = runSimulation(d, { collectTrace: false });
    const fast = nodeOf(r, "fast");
    const slow = nodeOf(r, "slow");
    // 90/10 split of 100/s over the measurement window.
    expect(relError(fast.arrivalRatePerSec, 90)).toBeLessThan(0.05);
    expect(relError(slow.arrivalRatePerSec, 10)).toBeLessThan(0.1);
  });

  it("per-class latency separates the fast path from the slow one", () => {
    const r = runSimulation(d, { collectTrace: false });
    const cheap = r.classes.find((c) => c.classId === "cheap")!;
    const heavy = r.classes.find((c) => c.classId === "heavy")!;

    expect(cheap.share).toBeCloseTo(0.9, 6);
    expect(heavy.share).toBeCloseTo(0.1, 6);
    expect(relError(cheap.latency.mean, 1 + 5)).toBeLessThan(0.15);
    expect(relError(heavy.latency.mean, 1 + 200)).toBeLessThan(0.05);
    // The blended mean hides both, which is why per-class reporting exists.
    expect(r.endToEnd.mean).toBeGreaterThan(cheap.latency.mean);
    expect(r.endToEnd.mean).toBeLessThan(heavy.latency.mean);
  });

  it("class attribution sums to the headline totals", () => {
    const r = runSimulation(d, { collectTrace: false });
    const attribution = r.invariants.find((i) => i.name === "class attribution")!;
    expect(attribution.passed).toBe(true);
    const summed = r.classes.reduce((s, c) => s + c.latency.count, 0);
    expect(summed).toBe(r.endToEnd.count);
  });

  it("a service multiplier scales demand at every station the class visits", () => {
    const scaled = design({
      classes: [
        { id: "normal", label: "normal", weight: 1, serviceMultiplier: 1 },
        { id: "triple", label: "triple", weight: 1, serviceMultiplier: 3 },
      ],
      nodes: [client(40), server("api", { c: 256, meanMs: 20 })],
      edges: [edge("e1", "client", "api")],
      durationSec: 900,
      warmupSec: 150,
    });
    const r = runSimulation(scaled, { collectTrace: false });
    const normal = r.classes.find((c) => c.classId === "normal")!;
    const triple = r.classes.find((c) => c.classId === "triple")!;
    expect(relError(triple.latency.mean / normal.latency.mean, 3)).toBeLessThan(0.1);
  });
});

describe("edge probability calls a dependency on only some requests", () => {
  it("arrival rate at the dependency matches the configured probability", () => {
    const d = design({
      nodes: [client(200), server("api", { c: 256, meanMs: 1 }), server("audit", { c: 64, meanMs: 10 })],
      edges: [edge("e1", "client", "api"), edge("e2", "api", "audit", { probability: 0.05 })],
      durationSec: 900,
      warmupSec: 150,
    });
    const r = runSimulation(d, { collectTrace: false });
    expect(relError(nodeOf(r, "audit").arrivalRatePerSec, 200 * 0.05)).toBeLessThan(0.08);

    const preview = previewDesign(d);
    expect(
      relError(preview.nodes.find((n) => n.nodeId === "audit")!.arrivalRatePerSec, 10)
    ).toBeLessThan(1e-9);
  });
});

describe("absurd sizes are rejected at the boundary, not deep inside a solver", () => {
  /**
   * Regression tests for a permanent UI freeze.
   *
   * A concurrency of 1e9 typed into the inspector locked the studio's main thread with
   * no console error and no recovery, because the Erlang recursion is O(c) and the live
   * preview evaluates it per station, per class, inside a fixed-point loop.
   *
   * The lesson these encode: the bound belongs where a value ENTERS the system, so the
   * failure is a legible message rather than an unresponsive tab.
   */
  it("refuses a concurrency past the schema bound", () => {
    expect(() =>
      design({
        nodes: [client(10), server("s", { c: 1e9, meanMs: 40 })],
        edges: [{ id: "e", from: "client", to: "s" }],
      })
    ).toThrow();
  });

  it("refuses an absurd replica count", () => {
    expect(() =>
      design({
        nodes: [client(10), server("s", { c: 4, meanMs: 40, replicas: 1e9 })],
        edges: [{ id: "e", from: "client", to: "s" }],
      })
    ).toThrow();
  });

  it("catches the PRODUCT, which neither field bound can catch alone", () => {
    // concurrency 1e6 and replicas 1e4 are each individually permitted; their product
    // is 1e10, which is what actually reaches the solver.
    const d = design({
      nodes: [client(10), server("s", { c: 1_000_000, meanMs: 40, replicas: 10_000 })],
      edges: [{ id: "e", from: "client", to: "s" }],
    });
    const errors = validateDesign(d).filter((i) => i.severity === "error");
    expect(errors.some((e) => e.code === "concurrency-intractable")).toBe(true);
    // Actionable: it must name the offending number and what to do.
    const msg = errors.find((e) => e.code === "concurrency-intractable")!.message;
    expect(msg).toMatch(/10,000,000,000/);
    expect(msg).toMatch(/Reduce/);
  });

  it("previews a large-but-tractable station without hanging", () => {
    // The bound is only defensible if everything under it still works.
    const d = design({
      nodes: [client(1000), server("s", { c: 100_000, meanMs: 40 })],
      edges: [{ id: "e", from: "client", to: "s" }],
    });
    expect(validateDesign(d).filter((i) => i.severity === "error")).toHaveLength(0);
    const started = performance.now();
    const p = previewDesign(d);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(p.stable).toBe(true);
  });

  it("leaves every shipped example within the bounds", () => {
    // If a real design tripped these limits they would be wrong limits.
    for (const ex of EXAMPLES) {
      const errors = validateDesign(ex.build()).filter((i) => i.severity === "error");
      expect(errors, ex.id).toHaveLength(0);
    }
  });
});
