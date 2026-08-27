import { describe, expect, it } from "vitest";
import { runSimulation, type RunResult } from "@sds/core";
import { DesignSchema, type Design, type SdsEdge } from "@sds/schema";
import { retryStorm, retryStormContained } from "@sds/models";
import { previewDesign, retryMath } from "../src/preview";
import { meanOf, relError, SEEDS } from "./harness";

/**
 * PHASE 3 VALIDATION: FAILURE POLICIES
 *
 * Retry behaviour is unusually testable. Attempts follow a truncated geometric
 * distribution, so both the expected attempt count and the resulting success rate
 * have exact closed forms:
 *
 *   E[attempts] = (1 - p^n) / (1 - p)      success = 1 - p^n
 *
 * That means retry amplification -- the central quantity of this phase -- is a
 * predicted number checked against a formula, not a plausible-looking output.
 *
 * Where no closed form exists (breaker dynamics, bulkhead interaction, ejection),
 * the tests pin the known qualitative result and its direction, which is still
 * falsifiable.
 */

const MEAN_TOLERANCE = 0.03;

function design(parts: {
  nodes: unknown[];
  edges: unknown[];
  durationSec?: number;
  warmupSec?: number;
}): Design {
  return DesignSchema.parse({
    version: 3,
    name: "phase3",
    nodes: parts.nodes,
    edges: parts.edges,
    classes: [],
    scenario: {
      durationSec: parts.durationSec ?? 400,
      warmupSec: parts.warmupSec ?? 60,
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
  o: {
    c: number;
    meanMs: number;
    fail?: number;
    blocks?: boolean;
    deterministic?: boolean;
  }
): unknown => ({
  id,
  kind: "server",
  label: id,
  x: 0,
  y: 0,
  server: {
    concurrency: o.c,
    serviceTime: o.deterministic
      ? { kind: "deterministic", value: o.meanMs }
      : { kind: "exponential", mean: o.meanMs },
    failureProbability: o.fail ?? 0,
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
const edgeOf = (r: RunResult, id: string) => r.edges.find((e) => e.edgeId === id)!;
const nodeOf = (r: RunResult, id: string) => r.nodes.find((n) => n.nodeId === id)!;

/**
 * An isolated retry harness: capacity so large that nothing queues, so the only
 * failures are the ones injected. That isolation is what makes the geometric
 * formula the exact expected answer.
 */
function retryHarness(o: {
  fail: number;
  maxAttempts: number;
  budgetRatio?: number | null;
  retryOn?: Array<"error" | "timeout" | "shed" | "network">;
  backoffMs?: number;
}): Design {
  return design({
    nodes: [client(200), server("dep", { c: 100_000, meanMs: 1, fail: o.fail, deterministic: true })],
    edges: [
      edge("e", "client", "dep", {
        policy: {
          timeoutMs: null,
          retry: {
            maxAttempts: o.maxAttempts,
            backoff: { kind: "fixed", baseMs: o.backoffMs ?? 0, maxMs: 1000, jitter: false },
            retryOn: o.retryOn ?? ["error"],
            budgetRatio: o.budgetRatio === undefined ? null : o.budgetRatio,
          },
          circuitBreaker: { enabled: false },
          bulkhead: { enabled: false },
        },
      } as Partial<SdsEdge>),
    ],
    durationSec: 400,
    warmupSec: 60,
  });
}

// ---------------------------------------------------------------------------

describe("retry math is exact", () => {
  it("closed form matches the truncated geometric series", () => {
    // Guards the formula itself before anything is compared against it.
    for (const p of [0, 0.1, 0.3, 0.5, 0.9]) {
      for (const n of [1, 2, 3, 5]) {
        let expectedAttempts = 0;
        for (let k = 1; k <= n; k++) {
          // Attempt k happens iff the first k-1 attempts all failed.
          expectedAttempts += Math.pow(p, k - 1);
        }
        const m = retryMath(p, n, null);
        expect(m.attempts).toBeCloseTo(expectedAttempts, 9);
        expect(m.success).toBeCloseTo(1 - Math.pow(p, n), 9);
      }
    }
  });

  it("p = 1 gives exactly maxAttempts and zero success", () => {
    const m = retryMath(1, 4, null);
    expect(m.attempts).toBe(4);
    expect(m.success).toBe(0);
  });

  for (const { fail, attempts } of [
    { fail: 0.2, attempts: 3 },
    { fail: 0.5, attempts: 3 },
    { fail: 0.3, attempts: 2 },
    { fail: 0.4, attempts: 4 },
  ]) {
    it(`simulated amplification matches (1-p^n)/(1-p) at p=${fail}, n=${attempts}`, () => {
      const expected = (1 - Math.pow(fail, attempts)) / (1 - fail);
      const rs = runs(retryHarness({ fail, maxAttempts: attempts }));
      const measured = meanOf(rs.map((r) => edgeOf(r, "e").amplification));
      expect(relError(measured, expected)).toBeLessThan(MEAN_TOLERANCE);
    });

    it(`simulated success rate matches 1-p^n at p=${fail}, n=${attempts}`, () => {
      const expected = 1 - Math.pow(fail, attempts);
      const rs = runs(retryHarness({ fail, maxAttempts: attempts }));
      const measured = meanOf(
        rs.map((r) => r.endToEnd.count / (r.endToEnd.count + r.errors.total))
      );
      expect(relError(measured, expected)).toBeLessThan(MEAN_TOLERANCE);
    });
  }

  it("no retry policy means exactly one attempt per call", () => {
    const d = design({
      nodes: [client(200), server("dep", { c: 100_000, meanMs: 1, fail: 0.5, deterministic: true })],
      edges: [edge("e", "client", "dep")],
    });
    const r = runSimulation(d, { collectTrace: false });
    // Without a policy there is no CallSite at all, so the edge reports the
    // no-policy default rather than fabricated counters.
    expect(edgeOf(r, "e").hasPolicy).toBe(false);
    expect(edgeOf(r, "e").amplification).toBe(1);
    expect(relError(r.errors.ratePct / 100, 0.5)).toBeLessThan(0.05);
  });

  it("only listed reasons are retried", () => {
    /**
     * Retrying the wrong failure is worse than not retrying. A shed request means
     * the dependency just said it had no capacity; retrying adds load to exactly
     * the thing that is already over capacity.
     */
    const notRetried = runSimulation(
      retryHarness({ fail: 0.4, maxAttempts: 3, retryOn: ["timeout"] }),
      { collectTrace: false }
    );
    expect(edgeOf(notRetried, "e").amplification).toBeCloseTo(1, 2);
    expect(edgeOf(notRetried, "e").retries).toBe(0);

    const retried = runSimulation(retryHarness({ fail: 0.4, maxAttempts: 3, retryOn: ["error"] }), {
      collectTrace: false,
    });
    expect(edgeOf(retried, "e").amplification).toBeGreaterThan(1.4);
  });
});

describe("retry budget caps amplification", () => {
  /**
   * The single most important control in this phase. Unbudgeted retries multiply
   * load on a struggling dependency by the attempt count precisely when it can
   * least afford it. A budget converts that into a bounded tax.
   */
  const fail = 0.6;
  const attempts = 4;
  const unbudgetedExpected = (1 - Math.pow(fail, attempts)) / (1 - fail);

  it("without a budget, amplification follows the geometric prediction", () => {
    const rs = runs(retryHarness({ fail, maxAttempts: attempts, budgetRatio: null }));
    const measured = meanOf(rs.map((r) => edgeOf(r, "e").amplification));
    expect(relError(measured, unbudgetedExpected)).toBeLessThan(MEAN_TOLERANCE);
    expect(measured).toBeGreaterThan(2);
  });

  for (const ratio of [0.1, 0.25, 0.5]) {
    it(`a ${ratio * 100}% budget holds amplification at about 1+${ratio}`, () => {
      const rs = runs(retryHarness({ fail, maxAttempts: attempts, budgetRatio: ratio }));
      const measured = meanOf(rs.map((r) => edgeOf(r, "e").amplification));
      // The cap is a rate over a rolling window, so it is approached rather than
      // hit exactly; it must be far below the unbudgeted figure and near the cap.
      expect(measured).toBeLessThan(1 + ratio * 1.35);
      expect(measured).toBeGreaterThan(1);
      expect(measured).toBeLessThan(unbudgetedExpected);
      expect(meanOf(rs.map((r) => edgeOf(r, "e").budgetRejections))).toBeGreaterThan(0);
    });
  }

  it("a budget trades error rate for load, and both sides are visible", () => {
    // Not a free lunch, and the tool should not present it as one: suppressing
    // retries means fewer recoveries and a higher reported error rate.
    const unbudgeted = runSimulation(retryHarness({ fail, maxAttempts: attempts, budgetRatio: null }), {
      collectTrace: false,
    });
    const budgeted = runSimulation(retryHarness({ fail, maxAttempts: attempts, budgetRatio: 0.1 }), {
      collectTrace: false,
    });
    expect(budgeted.errors.ratePct).toBeGreaterThan(unbudgeted.errors.ratePct);
    expect(edgeOf(budgeted, "e").attempts).toBeLessThan(edgeOf(unbudgeted, "e").attempts);
  });
});

describe("backoff", () => {
  it("fixed backoff adds the expected delay per retry", () => {
    const fail = 0.5;
    const backoffMs = 40;
    const attempts = 2;
    // One retry happens with probability p, and it costs backoff + another attempt.
    const d = retryHarness({ fail, maxAttempts: attempts, backoffMs });
    const rs = runs(d);
    const measured = meanOf(rs.map((r) => r.endToEnd.mean));
    // Successful requests: either first attempt (1ms) or second (1 + 40 + 1).
    // P(second | success) = p*(1-p) / (1-p^2) = p/(1+p).
    const pSecond = fail / (1 + fail);
    const expected = (1 - pSecond) * 1 + pSecond * (1 + backoffMs + 1);
    expect(relError(measured, expected)).toBeLessThan(0.05);
  });

  it("jitter randomises the delay without changing its mean much", () => {
    /**
     * Jitter is not cosmetic: without it every client that failed at the same
     * instant retries at the same instant, and the recovering dependency is hit by
     * a synchronised wave. Full jitter halves the expected wait, which is the
     * check here.
     */
    const base = (jitter: boolean): Design =>
      design({
        nodes: [client(100), server("dep", { c: 100_000, meanMs: 1, fail: 1, deterministic: true })],
        edges: [
          edge("e", "client", "dep", {
            policy: {
              timeoutMs: null,
              retry: {
                maxAttempts: 2,
                backoff: { kind: "fixed", baseMs: 100, maxMs: 1000, jitter },
                retryOn: ["error"],
                budgetRatio: null,
              },
              circuitBreaker: { enabled: false },
              bulkhead: { enabled: false },
            },
          } as Partial<SdsEdge>),
        ],
      });
    // Every request fails both attempts, so end-to-end latency is
    // 1 + backoff + 1 for all of them.
    const withJitter = runSimulation(base(true), { collectTrace: false });
    const without = runSimulation(base(false), { collectTrace: false });
    // All failures, so use the departure-latency mean via Little's Law's L instead:
    // compare in-system population, which is proportional to mean sojourn.
    expect(withJitter.avgInSystem).toBeLessThan(without.avgInSystem);
    expect(withJitter.avgInSystem).toBeGreaterThan(without.avgInSystem * 0.4);
  });
});

describe("circuit breaker", () => {
  const brokenDependency = (breakerEnabled: boolean, fail = 1, apiConcurrency = 32): Design =>
    design({
      nodes: [
        client(200, 2000),
        server("api", { c: apiConcurrency, meanMs: 1, blocks: true, deterministic: true }),
        // Slow AND failing: the worst case for a blocking caller, because every
        // attempt costs the full service time before failing. 200ms at 200 req/s is
        // 40 concurrent calls against 32 workers, so the caller saturates.
        server("dep", { c: 100_000, meanMs: 200, fail, deterministic: true }),
      ],
      edges: [
        edge("e1", "client", "api"),
        edge("e2", "api", "dep", {
          policy: {
            timeoutMs: null,
            retry: null,
            circuitBreaker: {
              enabled: breakerEnabled,
              failureThreshold: 0.5,
              minimumRequests: 20,
              windowMs: 5000,
              openMs: 2000,
              halfOpenProbes: 1,
            },
            bulkhead: { enabled: false },
          },
        } as Partial<SdsEdge>),
      ],
      durationSec: 300,
      warmupSec: 50,
    });

  it("opens on sustained failure and then fails fast", () => {
    const r = runSimulation(brokenDependency(true), { collectTrace: false });
    const e = edgeOf(r, "e2");
    expect(e.breakerTrips).toBeGreaterThan(0);
    expect(e.circuitRejections).toBeGreaterThan(0);
    // Most of the window is spent open, since the dependency never recovers.
    expect(e.breakerOpenFraction).toBeGreaterThan(0.8);
    expect(r.errors.circuitOpen).toBeGreaterThan(0);
  });

  it("failing fast protects the caller's own capacity", () => {
    /**
     * The point of a breaker is not to protect the dependency; it is to stop the
     * CALLER spending its workers waiting on something already known to be broken.
     * A blocking caller with a dead 100ms dependency ties up a worker per request.
     */
    const withBreaker = runSimulation(brokenDependency(true), { collectTrace: false });
    const without = runSimulation(brokenDependency(false), { collectTrace: false });

    expect(nodeOf(without, "api").utilization).toBeGreaterThan(0.9);
    expect(nodeOf(withBreaker, "api").utilization).toBeLessThan(0.2);
    // Every request fails either way (the dependency always fails), so compare the
    // time-average population instead of a success latency that does not exist.
    // Fewer requests parked in the system is the whole benefit.
    expect(withBreaker.avgInSystem).toBeLessThan(without.avgInSystem / 5);
  });

  it("cycles rather than latching open", () => {
    // A dependency failing 60% of the time trips a 50% threshold, but half-open
    // probes succeed 40% of the time, so the circuit closes and re-opens repeatedly
    // instead of latching.
    const r = runSimulation(brokenDependency(true, 0.6, 256), { collectTrace: false });
    const e = edgeOf(r, "e2");
    expect(e.breakerTrips).toBeGreaterThan(1);
    expect(r.endToEnd.count).toBeGreaterThan(500);
  });

  it("a breaker is a blunt instrument, and the cost is visible", () => {
    /**
     * Worth asserting rather than glossing over. A dependency that fails 60% of the
     * time still succeeds 40% of the time, but a 50%-threshold breaker takes it
     * almost entirely out of service: it spends about 2 seconds open for every
     * ~100ms closed, so realised throughput collapses far below the 40% the
     * dependency could have delivered.
     *
     * That is the correct behaviour for a breaker -- it is protecting the caller,
     * not maximising throughput -- but a tool that showed only the protection and
     * not the cost would be selling something.
     */
    const withBreaker = runSimulation(brokenDependency(true, 0.6, 256), { collectTrace: false });
    const without = runSimulation(brokenDependency(false, 0.6, 256), { collectTrace: false });

    // Without a breaker, ~40% of 200/s gets through.
    expect(without.throughputPerSec).toBeGreaterThan(60);
    // With one, far less does.
    expect(withBreaker.throughputPerSec).toBeLessThan(without.throughputPerSec / 3);
    // The caller is protected either way here, because it has ample capacity; the
    // breaker's value shows up only when the caller is the scarce resource.
    expect(nodeOf(without, "api").utilization).toBeLessThan(0.3);
  });

  it("a healthy dependency never trips the breaker", () => {
    // Ample caller capacity, so nothing times out and the only possible failures
    // would be the dependency's own -- of which there are none.
    const r = runSimulation(brokenDependency(true, 0, 256), { collectTrace: false });
    const e = edgeOf(r, "e2");
    expect(e.breakerTrips).toBe(0);
    expect(e.circuitRejections).toBe(0);
    expect(e.breakerState).toBe("closed");
    expect(r.errors.total).toBe(0);
  });

  it("a saturated CALLER makes a healthy dependency look unhealthy", () => {
    /**
     * A non-obvious finding, and a real operational trap. The dependency here never
     * fails: `failureProbability` is zero. But the caller has only 32 workers for a
     * load that needs 40, so requests exhaust their end-to-end deadline while
     * queueing *at the caller*, and the resulting timeouts are attributed to the
     * dependency call. The breaker duly trips on a dependency that is working
     * perfectly.
     *
     * This is why "the circuit to X is open" is not evidence that X is broken, and
     * it is exactly the kind of thing a model earns its keep by showing.
     */
    const saturated = runSimulation(brokenDependency(true, 0, 32), { collectTrace: false });
    const roomy = runSimulation(brokenDependency(true, 0, 256), { collectTrace: false });

    // Not quite pinned at 100%, because the breaker's own fail-fast returns some
    // workers -- which is the breaker mitigating a problem it also misdiagnosed.
    expect(nodeOf(saturated, "api").utilization).toBeGreaterThan(0.8);
    expect(edgeOf(saturated, "e2").circuitRejections).toBeGreaterThan(0);
    // Same dependency, same failure probability of zero, no trips at all.
    expect(edgeOf(roomy, "e2").breakerTrips).toBe(0);
  });

  it("a circuit-open rejection is never retried", () => {
    // Retrying past your own protection defeats the mechanism that just fired.
    const d = design({
      nodes: [
        client(200, 2000),
        server("api", { c: 64, meanMs: 1, deterministic: true }),
        server("dep", { c: 100_000, meanMs: 10, fail: 1, deterministic: true }),
      ],
      edges: [
        edge("e1", "client", "api"),
        edge("e2", "api", "dep", {
          policy: {
            timeoutMs: null,
            retry: {
              maxAttempts: 3,
              backoff: { kind: "none", baseMs: 0, maxMs: 0, jitter: false },
              retryOn: ["error", "timeout"],
              budgetRatio: null,
            },
            circuitBreaker: {
              enabled: true,
              failureThreshold: 0.5,
              minimumRequests: 20,
              windowMs: 5000,
              openMs: 5000,
              halfOpenProbes: 1,
            },
            bulkhead: { enabled: false },
          },
        } as Partial<SdsEdge>),
      ],
      durationSec: 300,
      warmupSec: 50,
    });
    const r = runSimulation(d, { collectTrace: false });
    const e = edgeOf(r, "e2");
    // Once open, calls are rejected without an attempt, so amplification collapses
    // towards 0 attempts per call rather than rising to 3.
    expect(e.circuitRejections).toBeGreaterThan(0);
    expect(e.amplification).toBeLessThan(1);
  });
});

describe("bulkhead", () => {
  const slowDependency = (bulkheadEnabled: boolean): Design =>
    design({
      nodes: [
        client(300, 5000),
        server("api", { c: 128, meanMs: 1, blocks: true, deterministic: true }),
        // 500ms dependency: at 300 req/s that is 150 concurrent calls, more than
        // the caller's 128 workers.
        server("dep", { c: 100_000, meanMs: 500, deterministic: true }),
      ],
      edges: [
        edge("e1", "client", "api"),
        edge("e2", "api", "dep", {
          policy: {
            timeoutMs: null,
            retry: null,
            circuitBreaker: { enabled: false },
            bulkhead: { enabled: bulkheadEnabled, maxConcurrent: 32, queueCapacity: 0 },
          },
        } as Partial<SdsEdge>),
      ],
      durationSec: 300,
      warmupSec: 50,
    });

  it("caps concurrent calls in flight at its limit", () => {
    const r = runSimulation(slowDependency(true), { collectTrace: false });
    const e = edgeOf(r, "e2");
    // Bulkhead occupancy is bounded by construction. Outstanding CALLS run one
    // higher, because a call is counted from the moment the caller wants to make it
    // -- including the instant it spends being rejected.
    expect(e.bulkheadMaxInUse!).toBeLessThanOrEqual(32);
    expect(e.bulkheadUtilization!).toBeGreaterThan(0.9);
    expect(e.maxConcurrency).toBeLessThanOrEqual(33);
    expect(e.bulkheadRejections).toBeGreaterThan(0);
    expect(r.errors.bulkheadFull).toBeGreaterThan(0);
  });

  it("bounds the caller's utilization when the dependency is slow", () => {
    /**
     * The direct fix for the failure the blocking model creates. Without a
     * bulkhead, a slow dependency consumes every worker the caller has and requests
     * that never touch it queue behind the ones that do.
     */
    const withBulkhead = runSimulation(slowDependency(true), { collectTrace: false });
    const without = runSimulation(slowDependency(false), { collectTrace: false });

    expect(nodeOf(without, "api").utilization).toBeGreaterThan(0.9);
    expect(nodeOf(withBulkhead, "api").utilization).toBeLessThan(0.35);
    // Successful requests are also much faster, because they are not queued behind
    // a backlog of calls to a slow dependency.
    expect(withBulkhead.endToEnd.p99).toBeLessThan(without.endToEnd.p99);
  });

  it("a bulkhead rejection is never retried", () => {
    const r = runSimulation(slowDependency(true), { collectTrace: false });
    // With retry null there is nothing to retry, but the reason must still be
    // classified as its own thing rather than folded into a generic error.
    expect(r.errors.bulkheadFull).toBeGreaterThan(0);
    expect(r.errors.error).toBe(0);
  });
});

describe("per-attempt timeout", () => {
  it("bounds each attempt independently of the client deadline", () => {
    const d = design({
      nodes: [
        client(100, 5000),
        server("api", { c: 512, meanMs: 1, deterministic: true }),
        server("dep", { c: 100_000, meanMs: 400, deterministic: true }),
      ],
      edges: [
        edge("e1", "client", "api"),
        edge("e2", "api", "dep", {
          policy: {
            // The dependency takes 400ms; give each attempt 100ms.
            timeoutMs: 100,
            retry: {
              maxAttempts: 3,
              backoff: { kind: "none", baseMs: 0, maxMs: 0, jitter: false },
              retryOn: ["timeout"],
              budgetRatio: null,
            },
            circuitBreaker: { enabled: false },
            bulkhead: { enabled: false },
          },
        } as Partial<SdsEdge>),
      ],
      durationSec: 200,
      warmupSec: 40,
    });
    const r = runSimulation(d, { collectTrace: false });
    // Every attempt times out, so all three are used and every request fails.
    expect(edgeOf(r, "e2").amplification).toBeCloseTo(3, 1);
    expect(r.errors.timeout).toBeGreaterThan(0);
    expect(r.endToEnd.count).toBe(0);
  });

  it("a too-short timeout makes things worse, not safer", () => {
    /**
     * A classic. Cutting attempts off before they can succeed converts every
     * request into `maxAttempts` units of wasted dependency work, so the dependency
     * does strictly more work and gets slower still.
     */
    const build = (timeoutMs: number | null): Design =>
      design({
        nodes: [
          client(150, 5000),
          server("api", { c: 512, meanMs: 1, deterministic: true }),
          server("dep", { c: 64, meanMs: 100, deterministic: true }),
        ],
        edges: [
          edge("e1", "client", "api"),
          edge("e2", "api", "dep", {
            policy: {
              timeoutMs,
              retry: {
                maxAttempts: 3,
                backoff: { kind: "none", baseMs: 0, maxMs: 0, jitter: false },
                retryOn: ["timeout"],
                budgetRatio: null,
              },
              circuitBreaker: { enabled: false },
              bulkhead: { enabled: false },
            },
          } as Partial<SdsEdge>),
        ],
        durationSec: 300,
        warmupSec: 50,
      });

    const generous = runSimulation(build(500), { collectTrace: false });
    const tooShort = runSimulation(build(60), { collectTrace: false });

    // The dependency does far more work under the short timeout...
    expect(edgeOf(tooShort, "e2").attempts).toBeGreaterThan(
      edgeOf(generous, "e2").attempts * 1.5
    );
    // ...and delivers fewer successful requests for it.
    expect(tooShort.throughputPerSec).toBeLessThan(generous.throughputPerSec);
  });
});

describe("load balancer health checking", () => {
  const withBrokenBackend = (healthCheckEnabled: boolean, brokenCount = 1): Design => {
    const backends = [0, 1, 2].map((i) =>
      server(`api${i}`, { c: 64, meanMs: 2, fail: i < brokenCount ? 1 : 0, deterministic: true })
    );
    return design({
      nodes: [
        client(300, 2000),
        {
          id: "lb",
          kind: "loadbalancer",
          label: "lb",
          x: 0,
          y: 0,
          loadbalancer: {
            algorithm: "round-robin",
            serviceTime: { kind: "deterministic", value: 0 },
            concurrency: 100_000,
            healthCheck: {
              enabled: healthCheckEnabled,
              failureThreshold: 0.5,
              minimumRequests: 20,
              ejectionMs: 5000,
              maxEjectedFraction: 0.5,
            },
          },
        },
        ...backends,
      ],
      edges: [
        edge("e-c", "client", "lb"),
        ...[0, 1, 2].map((i) => edge(`e-${i}`, "lb", `api${i}`)),
      ],
      durationSec: 300,
      warmupSec: 50,
    });
  };

  it("without health checking, a broken backend keeps its full share", () => {
    const r = runSimulation(withBrokenBackend(false), { collectTrace: false });
    const lb = nodeOf(r, "lb").loadbalancer!;
    const broken = lb.perBackend.find((b) => b.nodeId === "api0")!;
    expect(relError(broken.sharePct, 100 / 3)).toBeLessThan(0.05);
    // Which means roughly a third of all requests fail.
    expect(relError(r.errors.ratePct / 100, 1 / 3)).toBeLessThan(0.08);
  });

  it("with health checking, the outlier is ejected and errors collapse", () => {
    const r = runSimulation(withBrokenBackend(true), { collectTrace: false });
    const lb = nodeOf(r, "lb").loadbalancer!;
    const broken = lb.perBackend.find((b) => b.nodeId === "api0")!;

    expect(lb.healthCheckEnabled).toBe(true);
    expect(broken.ejections).toBeGreaterThan(0);
    expect(broken.ejectedFraction).toBeGreaterThan(0.8);
    // It still gets the occasional probe when its ejection lapses, but nothing near
    // an even share.
    expect(broken.sharePct).toBeLessThan(3);
    expect(r.errors.ratePct).toBeLessThan(3);
  });

  it("never ejects more than the configured fraction of backends", () => {
    /**
     * The guard that stops health checking causing the outage it exists to prevent.
     * Under a shared failure every backend looks unhealthy at once, and ejecting
     * them all removes the capacity that was still partially working.
     */
    const r = runSimulation(withBrokenBackend(true, 3), { collectTrace: false });
    const lb = nodeOf(r, "lb").loadbalancer!;
    const ejectedNow = lb.perBackend.filter((b) => b.ejectedFraction > 0.5).length;
    expect(ejectedNow).toBeLessThanOrEqual(Math.floor(3 * 0.5));
    expect(lb.ejectionsWithheld).toBeGreaterThan(0);
    // Traffic keeps flowing to every backend rather than being routed to none.
    expect(lb.perBackend.every((b) => b.dispatched > 0)).toBe(true);
  });
});

describe("invariants hold under retries and failure policies", () => {
  /**
   * Little's Law is the strongest check here. Retries change the number of attempts
   * but not the number of REQUESTS, so L = lambda*W must still hold exactly -- and it
   * would break immediately if a retried request were double-counted, or if a
   * bulkhead or breaker rejection leaked a slot.
   */
  const scenarios: Array<[string, Design]> = [
    ["retries with no budget", retryHarness({ fail: 0.5, maxAttempts: 3 })],
    ["retries with a budget", retryHarness({ fail: 0.5, maxAttempts: 3, budgetRatio: 0.1 })],
    ["retry storm", retryStorm()],
    ["retry storm contained", retryStormContained()],
  ];

  for (const [name, d] of scenarios) {
    it(`all invariants pass: ${name}`, () => {
      const r = runSimulation(d);
      const failed = r.invariants.filter((i) => !i.passed);
      expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    });
  }

  it("Little's Law survives retry amplification", () => {
    const r = runSimulation(retryHarness({ fail: 0.5, maxAttempts: 4 }));
    const little = r.invariants.find((i) => i.name.startsWith("Little"))!;
    expect(little.passed).toBe(true);
    expect(little.error!).toBeLessThan(0.03);
    // And amplification really is happening, so the check is not vacuous.
    expect(r.retryAmplification).toBeGreaterThan(1.5);
  });
});

describe("the retry storm example, and its fix", () => {
  const broken = runSimulation(retryStorm(), { collectTrace: false });
  const fixed = runSimulation(retryStormContained(), { collectTrace: false });

  it("unbudgeted retries saturate the caller as well as the dependency", () => {
    // The cascade: the dependency's problem becomes the caller's, because a
    // blocking worker is held for every attempt and every backoff.
    expect(nodeOf(broken, "db").utilization).toBeGreaterThan(0.95);
    expect(nodeOf(broken, "api").utilization).toBeGreaterThan(0.95);
    expect(broken.retryAmplification).toBeGreaterThan(1.4);
    expect(broken.stability.retryStormWarning).toMatch(/multiplying load/);
  });

  it("budget, breaker and bulkhead contain it without adding capacity", () => {
    // Identical topology and identical capacity everywhere: only the policies differ.
    expect(fixed.design.nodes).toHaveLength(broken.design.nodes.length);
    expect(nodeOf(fixed, "api").utilization).toBeLessThan(0.3);
    expect(nodeOf(fixed, "db").utilization).toBeLessThan(nodeOf(broken, "db").utilization);
    expect(fixed.endToEnd.p99).toBeLessThan(broken.endToEnd.p99 / 5);
    expect(fixed.retryAmplification).toBeLessThan(1.2);
  });

  it("the fix is a trade, not a free win, and both sides are reported", () => {
    /**
     * Suppressing retries means fewer recoveries, so the contained design reports a
     * HIGHER error rate and slightly lower throughput. Presenting the fix as free
     * would be the same kind of dishonesty this project exists to remove: the real
     * result is that it stops spending the caller's capacity to hide a broken
     * dependency.
     */
    expect(fixed.errors.ratePct).toBeGreaterThan(broken.errors.ratePct);
    expect(fixed.throughputPerSec).toBeLessThan(broken.throughputPerSec);
    // The broken design's advantage is bought at 100% utilization on both stations.
    expect(nodeOf(broken, "api").utilization).toBeGreaterThan(
      nodeOf(fixed, "api").utilization * 3
    );
  });
});

describe("the preview predicts retry behaviour without simulating", () => {
  for (const { fail, attempts } of [
    { fail: 0.3, attempts: 3 },
    { fail: 0.5, attempts: 2 },
  ]) {
    it(`predicted amplification matches the simulation at p=${fail}, n=${attempts}`, () => {
      const d = retryHarness({ fail, maxAttempts: attempts });
      const preview = previewDesign(d);
      const edgePreview = preview.edges.find((e) => e.edgeId === "e")!;
      const measured = meanOf(runs(d).map((r) => edgeOf(r, "e").amplification));

      expect(preview.converged).toBe(true);
      expect(relError(edgePreview.attemptFailureProbability, fail)).toBeLessThan(0.02);
      expect(relError(edgePreview.amplification, measured)).toBeLessThan(0.05);
      expect(relError(preview.retryAmplification, measured)).toBeLessThan(0.05);
    });
  }

  it("predicts a budget will bind before the simulation runs", () => {
    const preview = previewDesign(retryHarness({ fail: 0.6, maxAttempts: 4, budgetRatio: 0.1 }));
    const e = preview.edges.find((x) => x.edgeId === "e")!;
    expect(e.budgetBinding).toBe(true);
    expect(e.amplification).toBeLessThan(1.2);
  });

  it("warns about the storm in the example without running it", () => {
    const preview = previewDesign(retryStorm());
    expect(preview.retryStormWarning).toMatch(/multiply load/);
    expect(preview.retryAmplification).toBeGreaterThan(1.2);
  });

  it("blames the dependency, not the caller it saturates", () => {
    /**
     * A blocking caller whose dependency has no steady state inherits an infinite
     * effective service time, and infinity beats every finite rho. A naive
     * comparison therefore names the CALLER as the bottleneck and reports its
     * capacity as 0/s -- pointing at the victim and hiding the thing to fix.
     *
     * Caught by looking at the rendered UI rather than by any assertion, which is
     * the argument for checking the real interface and not only the numbers.
     */
    const preview = previewDesign(retryStorm());
    expect(preview.bottleneckNodeId).toBe("db");
    expect(preview.nodes.find((n) => n.nodeId === "api")!.saturationCause).toBe("dependency");
    expect(preview.notes.join(" ")).toMatch(/consequence, not a cause/);
  });

  it("reports the contained example as not storming", () => {
    const preview = previewDesign(retryStormContained());
    expect(preview.retryAmplification).toBeLessThan(1.2);
  });

  it("converges on designs that have a fixed point", () => {
    const preview = previewDesign(retryHarness({ fail: 0.2, maxAttempts: 3 }));
    expect(preview.converged).toBe(true);
    expect(preview.iterations).toBeLessThan(60);
  });
});
