import { describe, expect, it } from "vitest";
import {
  MAX_SERVERS,
  erlangB,
  erlangC,
  solveMMc,
  solveMMcK,
} from "../src/index";
import {
  durationForRho,
  meanOf,
  relError,
  runReplications,
  runStation,
  SEEDS,
  stationStat,
  tandem,
} from "./harness";

/**
 * THE VALIDATION GATE
 *
 * Nothing ships on an engine that does not pass this file.
 *
 * The reason is specific rather than general. The previous version of this tool
 * produced confident latency and throughput numbers that were arithmetic over
 * invented constants, and no artefact in the repository could have told you so.
 * Queueing theory supplies exact answers for a handful of models. The simulator
 * either reproduces them or it is wrong, and there is no arguing with Erlang-C.
 *
 * Every assertion here compares against a FORMULA, never against a previously
 * recorded output. A snapshot test would only prove the engine still does what it
 * did yesterday, which is worthless if yesterday was already wrong.
 *
 * Run lengths are derived from queueing theory (see `samplesFor`) rather than
 * tuned until green, and results are averaged over independent replications, so
 * the tolerances measure accuracy rather than luck.
 */

/**
 * 3% on means. With runs sized by `samplesFor(rho)`, measured error at the worst
 * case (rho = 0.9) is ~1%. The remaining headroom covers histogram
 * discretization and end-of-run truncation.
 */
const MEAN_TOLERANCE = 0.03;

/** 5% on tail quantiles: far fewer effective samples out in the tail. */
const TAIL_TOLERANCE = 0.05;

describe("M/M/1: simulator against the exact solution", () => {
  // rho = 0.9 is included deliberately. Queueing delay diverges as 1/(1-rho), so
  // an error invisible at rho=0.5 is glaring at 0.9 -- and low utilization is
  // precisely the regime nobody needs a capacity tool for.
  const cases = [0.3, 0.5, 0.7, 0.9];
  const serviceMeanMs = 20;
  const mu = 1000 / serviceMeanMs;

  for (const rho of cases) {
    const lambda = rho * mu;
    const exact = solveMMc({ lambda, mu, c: 1 });
    const results = () => runStation({ lambda, serviceMeanMs, c: 1 }, rho);

    it(`closed form reduces to the textbook M/M/1 expressions at rho=${rho}`, () => {
      expect(exact.wMs).toBeCloseTo(1000 / (mu - lambda), 6);
      expect(exact.l).toBeCloseTo(lambda / (mu - lambda), 6);
      expect(exact.lq).toBeCloseTo((rho * rho) / (1 - rho), 6);
      // Erlang-C collapses to rho when c = 1.
      expect(exact.probWait).toBeCloseTo(rho, 9);
    });

    it(`mean sojourn W = 1/(mu-lambda) at rho=${rho}`, () => {
      expect(relError(meanOf(results().map((r) => r.endToEnd.mean)), exact.wMs)).toBeLessThan(
        MEAN_TOLERANCE
      );
    });

    it(`time-average population L = lambda/(mu-lambda) at rho=${rho}`, () => {
      expect(relError(meanOf(results().map((r) => r.avgInSystem)), exact.l)).toBeLessThan(
        MEAN_TOLERANCE
      );
    });

    it(`utilization equals rho at rho=${rho}`, () => {
      expect(relError(stationStat(results(), "station", (n) => n.utilization), rho)).toBeLessThan(
        MEAN_TOLERANCE
      );
    });

    it(`sojourn distribution is Exp(mu-lambda) at rho=${rho}`, () => {
      // For M/M/1 the sojourn time is exactly exponential, so this checks the
      // SHAPE and not merely the mean. A simulator can get the mean right and the
      // tail badly wrong, and the tail is what breaks an SLO.
      const rs = results();
      for (const [q, key] of [
        [0.5, "p50"],
        [0.9, "p90"],
        [0.99, "p99"],
      ] as const) {
        const analytic = exact.quantileMs(q)!;
        const textbook = (-Math.log(1 - q) / (mu - lambda)) * 1000;
        expect(relError(analytic, textbook)).toBeLessThan(1e-6);
        expect(relError(meanOf(rs.map((r) => r.endToEnd[key])), analytic)).toBeLessThan(
          TAIL_TOLERANCE
        );
      }
    });
  }
});

describe("M/M/c: simulator against Erlang-C", () => {
  const cases = [
    { c: 2, rho: 0.6, serviceMeanMs: 40 },
    { c: 4, rho: 0.8, serviceMeanMs: 40 },
    { c: 8, rho: 0.85, serviceMeanMs: 25 },
    { c: 16, rho: 0.9, serviceMeanMs: 20 },
  ];

  for (const { c, rho, serviceMeanMs } of cases) {
    const mu = 1000 / serviceMeanMs;
    const lambda = rho * c * mu;
    const exact = solveMMc({ lambda, mu, c });
    const results = () => runStation({ lambda, serviceMeanMs, c }, rho);

    it(`Erlang-B/C recursion agrees with the factorial form for c=${c}`, () => {
      // Guards the numerically stable recursion against the definition it
      // replaces. The recursion exists because the factorial form overflows; if
      // the recursion were wrong, every downstream number would be too.
      const a = lambda / mu;
      let sum = 0;
      let term = 1;
      for (let k = 0; k < c; k++) {
        if (k > 0) term *= a / k;
        sum += term;
      }
      const lastTerm = (term * a) / c;
      const tail = lastTerm / (1 - rho);
      expect(exact.probWait).toBeCloseTo(tail / (sum + tail), 9);
    });

    it(`W matches Erlang-C for c=${c}, rho=${rho}`, () => {
      expect(relError(meanOf(results().map((r) => r.endToEnd.mean)), exact.wMs)).toBeLessThan(
        MEAN_TOLERANCE
      );
    });

    it(`mean queue wait Wq matches Erlang-C for c=${c}, rho=${rho}`, () => {
      expect(relError(stationStat(results(), "station", (n) => n.avgWaitMs), exact.wqMs)).toBeLessThan(
        MEAN_TOLERANCE
      );
    });

    it(`Lq matches Erlang-C for c=${c}, rho=${rho}`, () => {
      expect(relError(stationStat(results(), "station", (n) => n.avgQueueLength), exact.lq)).toBeLessThan(
        0.05
      );
    });

    it(`p99 matches the closed-form sojourn quantile for c=${c}, rho=${rho}`, () => {
      expect(
        relError(meanOf(results().map((r) => r.endToEnd.p99)), exact.quantileMs(0.99)!)
      ).toBeLessThan(TAIL_TOLERANCE);
    });
  }
});

describe("M/M/c/K: load shedding against the exact finite-queue solution", () => {
  // Offered load ABOVE capacity in every case. This is the regime that matters:
  // a shedding station has a bounded queue and therefore a genuine steady state,
  // so exact results exist precisely where the unbounded model has none.
  const cases = [
    { c: 2, k: 5, lambda: 60, serviceMeanMs: 40 },
    { c: 4, k: 10, lambda: 150, serviceMeanMs: 40 },
    { c: 1, k: 3, lambda: 40, serviceMeanMs: 40 },
  ];

  for (const { c, k, lambda, serviceMeanMs } of cases) {
    const mu = 1000 / serviceMeanMs;
    const exact = solveMMcK(lambda, mu, c, k);
    const results = () =>
      runStation(
        { lambda, serviceMeanMs, c, queueCapacity: k, admissionPolicy: "shed" },
        1.0
      );

    it(`state probabilities are normalised for c=${c}, K=${k}`, () => {
      expect(exact.blockingProbability).toBeGreaterThan(0);
      expect(exact.blockingProbability).toBeLessThan(1);
      // Utilization must equal effective throughput per server over service rate.
      expect(exact.utilization).toBeCloseTo(exact.effectiveLambda / (c * mu), 9);
    });

    it(`blocking probability matches for c=${c}, K=${k}`, () => {
      const measured = meanOf(
        results().map((r) => {
          const st = r.nodes.find((n) => n.nodeId === "station")!;
          return st.shed / st.arrivals;
        })
      );
      expect(relError(measured, exact.blockingProbability)).toBeLessThan(MEAN_TOLERANCE);
    });

    it(`throughput matches the effective arrival rate for c=${c}, K=${k}`, () => {
      expect(
        relError(meanOf(results().map((r) => r.throughputPerSec)), exact.effectiveLambda)
      ).toBeLessThan(MEAN_TOLERANCE);
    });

    it(`sojourn time of admitted requests matches for c=${c}, K=${k}`, () => {
      expect(relError(meanOf(results().map((r) => r.endToEnd.mean)), exact.wMs)).toBeLessThan(
        MEAN_TOLERANCE
      );
    });

    it(`a shedding station stays stable while overloaded (c=${c}, K=${k})`, () => {
      // The point of shedding: bounded latency and visible errors instead of
      // unbounded latency and none. The engine must report it as stable even
      // though offered load exceeds capacity.
      for (const r of results()) expect(r.stability.stable).toBe(true);
    });
  }
});

describe("tandem network: Burke's theorem", () => {
  /**
   * Burke's theorem: the departure process of a stationary M/M/c queue is Poisson
   * at the same rate. Each station in a chain therefore also sees Poisson
   * arrivals and can be solved independently, so the end-to-end mean is the sum
   * of per-station means. A theorem, not an approximation.
   *
   * Much stronger than a single-station test: it exercises multi-hop flow and
   * would fail if the engine distorted the departure process -- by batching
   * completions, say, or by coupling stations through a shared random stream.
   */
  const lambda = 20;
  const serviceMeanMs = [30, 20, 40];
  const c = [1, 1, 2];
  const perStation = serviceMeanMs.map((meanMs, i) =>
    solveMMc({ lambda, mu: 1000 / meanMs, c: c[i]! })
  );
  const maxRho = Math.max(...perStation.map((s) => s.rho));
  const { durationSec, warmupSec } = durationForRho(lambda, maxRho);
  const results = () =>
    runReplications(tandem({ lambda, serviceMeanMs, c, durationSec, warmupSec }), SEEDS);

  it("every station in the chain is stable", () => {
    for (const s of perStation) expect(s.stable).toBe(true);
  });

  it("end-to-end mean equals the sum of independent per-station means", () => {
    const expected = perStation.reduce((sum, s) => sum + s.wMs, 0);
    expect(relError(meanOf(results().map((r) => r.endToEnd.mean)), expected)).toBeLessThan(
      MEAN_TOLERANCE
    );
  });

  it("each station independently matches its own M/M/c solution", () => {
    const rs = results();
    serviceMeanMs.forEach((_, i) => {
      const exact = perStation[i]!;
      expect(relError(stationStat(rs, `s${i}`, (n) => n.utilization), exact.rho)).toBeLessThan(
        MEAN_TOLERANCE
      );
      // Absolute slack alongside relative: Lq approaches zero at low
      // utilization, where a purely relative tolerance is unreasonable.
      const measuredLq = stationStat(rs, `s${i}`, (n) => n.avgQueueLength);
      expect(Math.abs(measuredLq - exact.lq)).toBeLessThan(Math.max(0.02, exact.lq * 0.06));
    });
  });

  it("summing per-station p99s badly overstates the end-to-end tail", () => {
    // Encodes the reason `previewDesign` refuses to report a multi-station p99.
    // The sum of per-station p99s is not the p99 of the sum; presenting it as
    // such is a common and material error, so the tool declines instead.
    const naive = perStation.reduce((sum, s) => sum + s.quantileMs(0.99)!, 0);
    const measured = meanOf(results().map((r) => r.endToEnd.p99));
    expect(naive).toBeGreaterThan(measured * 1.2);
  });
});

describe("M/G/1: Pollaczek-Khinchine", () => {
  /**
   * P-K says mean queueing delay scales with (1 + Cs^2). This is the test that
   * would have caught the legacy model's central error: it represented service
   * time as a constant times a uniform jitter factor, pinning Cs^2 at a small
   * value regardless of the real service. Two services with equal means and
   * different variability queue very differently, and the gap is not subtle.
   */
  const serviceMeanMs = 20;
  const mu = 1000 / serviceMeanMs;

  it("deterministic service queues exactly half as badly as exponential", () => {
    const rho = 0.8;
    const lambda = rho * mu;
    const det = stationStat(
      runStation(
        { lambda, serviceMeanMs, c: 1, serviceTime: { kind: "deterministic", value: serviceMeanMs } },
        rho
      ),
      "station",
      (n) => n.avgWaitMs
    );
    const exp = stationStat(runStation({ lambda, serviceMeanMs, c: 1 }, rho), "station", (n) => n.avgWaitMs);
    // P-K gives the ratio (1+0)/(1+1) = 1/2, exactly.
    expect(relError(det / exp, 0.5)).toBeLessThan(0.05);
  });

  for (const rho of [0.5, 0.8]) {
    it(`matches P-K for deterministic service at rho=${rho}`, () => {
      const lambda = rho * mu;
      // Wq = rho/(1-rho) * (1 + 0)/2 * E[S]
      const expected = (rho / (1 - rho)) * 0.5 * serviceMeanMs;
      const measured = stationStat(
        runStation(
          {
            lambda,
            serviceMeanMs,
            c: 1,
            serviceTime: { kind: "deterministic", value: serviceMeanMs },
          },
          rho
        ),
        "station",
        (n) => n.avgWaitMs
      );
      expect(relError(measured, expected)).toBeLessThan(MEAN_TOLERANCE);
    });
  }

  it("higher service variability produces a longer queue at equal mean", () => {
    // A monotonicity check that holds for any distribution family: raising Cs^2
    // at fixed mean must raise Wq. Independent of the specific P-K constant.
    const rho = 0.7;
    const lambda = rho * mu;
    const wq = (serviceTime: Parameters<typeof runStation>[0]["serviceTime"]) =>
      stationStat(runStation({ lambda, serviceMeanMs, c: 1, serviceTime }, rho), "station", (n) => n.avgWaitMs);

    const deterministic = wq({ kind: "deterministic", value: serviceMeanMs });
    const exponential = wq({ kind: "exponential", mean: serviceMeanMs });
    const heavyTail = wq({ kind: "lognormal", mean: serviceMeanMs, p99: serviceMeanMs * 12 });

    expect(deterministic).toBeLessThan(exponential);
    expect(exponential).toBeLessThan(heavyTail);
  });
});

describe("intractable inputs are refused, not hung on", () => {
  /**
   * These are regression tests for a hang, which is a worse failure than a wrong
   * answer: a wrong number can be spotted, whereas the studio simply stopped
   * responding with no console error and no way back.
   *
   * The recursions are O(c), and the live preview evaluates them per station, per
   * request class, inside a fixed-point loop. Typing a concurrency of 1e9 into the
   * inspector therefore froze the main thread indefinitely.
   */
  it("refuses a server count beyond what it can evaluate exactly", () => {
    expect(() => erlangB(1e9, 8e8)).toThrow(/beyond/);
    expect(() => erlangC(1e9, 8e8)).toThrow(/beyond/);
  });

  it("refuses rather than truncating, because a truncated recursion looks like an answer", () => {
    let thrown: unknown;
    try {
      erlangB(MAX_SERVERS + 1, 1);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("IntractableError");
    // The message has to name the limit, or it is not actionable.
    expect((thrown as Error).message).toMatch(/1,000,000/);
  });

  it("still evaluates the largest tractable input, and quickly", () => {
    // The bound is only defensible if everything under it genuinely works.
    const started = performance.now();
    const b = erlangB(MAX_SERVERS, MAX_SERVERS * 0.8);
    const elapsed = performance.now() - started;
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
    // An "instant" estimate can absorb this; a hang it cannot.
    expect(elapsed).toBeLessThan(1000);
  });

  it("refuses a state space too large to enumerate", () => {
    // Reachable through queue capacity rather than server count, so it needs its own
    // guard: n = c + k.
    expect(() => solveMMcK(10, 1, 5, 2_000_000)).toThrow(/beyond/);
  });

  it("rejects nonsense server counts", () => {
    expect(() => erlangB(Number.NaN, 1)).toThrow();
    expect(() => erlangB(Number.POSITIVE_INFINITY, 1)).toThrow();
    expect(() => erlangB(-1, 1)).toThrow();
  });

  it("leaves ordinary sizes untouched", () => {
    // The guard must not perturb any result that mattered before it existed.
    for (const c of [1, 2, 4, 8, 64, 1024]) {
      const b = erlangB(c, c * 0.7);
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(1);
    }
  });
});
