import { describe, expect, it } from "vitest";
import { EventQueue } from "../src/event-queue";
import { LatencyHistogram } from "../src/histogram";
import { TimeSeries } from "../src/timeseries";
import { Rng, RngBundle } from "../src/rng";
import { lognormalFromMeanP99, mean, sample, scv, variance } from "../src/distribution";
import { Resource } from "../src/resource";
import { Sim, acquire, delay, type Process } from "../src/sim";

describe("EventQueue", () => {
  it("pops in time order", () => {
    const q = new EventQueue();
    const order: number[] = [];
    for (const t of [5, 1, 9, 3, 7, 2]) q.push(t, () => order.push(t));
    let ev = q.pop();
    while (ev) {
      ev.run();
      ev = q.pop();
    }
    expect(order).toEqual([1, 2, 3, 5, 7, 9]);
  });

  it("breaks ties on insertion order", () => {
    /**
     * Not cosmetic. Simultaneous events are common (any zero-delay scheduling),
     * and without a defined order among them the simulation is not reproducible.
     * Determinism tests would then fail intermittently, which is the worst
     * possible way to discover you needed this.
     */
    const q = new EventQueue();
    const order: string[] = [];
    for (const tag of ["a", "b", "c", "d"]) q.push(100, () => order.push(tag));
    let ev = q.pop();
    while (ev) {
      ev.run();
      ev = q.pop();
    }
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("skips cancelled events and tracks the live count", () => {
    const q = new EventQueue();
    const seen: number[] = [];
    q.push(1, () => seen.push(1));
    const doomed = q.push(2, () => seen.push(2));
    q.push(3, () => seen.push(3));
    expect(q.size).toBe(3);
    q.cancel(doomed);
    expect(q.size).toBe(2);
    // Cancelling twice must not double-decrement.
    q.cancel(doomed);
    expect(q.size).toBe(2);
    let ev = q.pop();
    while (ev) {
      ev.run();
      ev = q.pop();
    }
    expect(seen).toEqual([1, 3]);
  });

  it("stays ordered under randomised insertion", () => {
    const q = new EventQueue();
    const rng = new Rng(3);
    const times: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t = rng.next() * 1000;
      times.push(t);
      q.push(t, () => {});
    }
    times.sort((a, b) => a - b);
    const popped: number[] = [];
    let ev = q.pop();
    while (ev) {
      popped.push(ev.time);
      ev = q.pop();
    }
    expect(popped).toEqual(times);
  });
});

describe("LatencyHistogram", () => {
  it("reports quantiles within its stated relative error", () => {
    // Uniform 0..1000 has known quantiles, so the check is against a formula.
    const h = new LatencyHistogram();
    for (let i = 1; i <= 100_000; i++) h.record((i / 100_000) * 1000);
    for (const q of [0.5, 0.9, 0.99, 0.999]) {
      const expected = q * 1000;
      const err = Math.abs(h.quantile(q) - expected) / expected;
      expect(err).toBeLessThanOrEqual(h.relativeError * 1.5);
    }
  });

  it("never reports a value outside the observed range", () => {
    // A bucket's lower edge can otherwise fall below the true minimum and the
    // tool would print a latency that never occurred.
    const h = new LatencyHistogram();
    for (const v of [100, 101, 102, 103]) h.record(v);
    expect(h.quantile(0.01)).toBeGreaterThanOrEqual(100);
    expect(h.quantile(0.99)).toBeLessThanOrEqual(103);
  });

  it("is mergeable without loss", () => {
    const a = new LatencyHistogram();
    const b = new LatencyHistogram();
    const both = new LatencyHistogram();
    for (let i = 0; i < 1000; i++) {
      a.record(i);
      both.record(i);
    }
    for (let i = 1000; i < 2000; i++) {
      b.record(i);
      both.record(i);
    }
    a.merge(b);
    expect(a.count).toBe(both.count);
    expect(a.sum).toBeCloseTo(both.sum, 6);
    expect(a.quantile(0.99)).toBe(both.quantile(0.99));
  });

  it("rejects non-finite input rather than poisoning every metric", () => {
    const h = new LatencyHistogram();
    expect(() => h.record(Number.NaN)).toThrow();
    expect(() => h.record(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => h.record(-1)).toThrow();
  });

  it("handles zero and sub-millisecond values", () => {
    const h = new LatencyHistogram();
    h.record(0);
    h.record(0.3);
    h.record(0.7);
    expect(h.count).toBe(3);
    expect(h.quantile(0.5)).toBeGreaterThanOrEqual(0);
  });
});

describe("TimeSeries", () => {
  it("stays bounded and keeps covering the full window", () => {
    const ts = new TimeSeries("x", 100);
    for (let i = 0; i < 1000; i++) ts.push(i, i);
    expect(ts.values().length).toBeLessThanOrEqual(100);
    // Decimation must halve resolution rather than drop the beginning: losing the
    // early part of a run hides the transient that explains the steady state.
    expect(ts.values()[0]!.t).toBe(0);
    expect(ts.values().at(-1)!.t).toBeGreaterThan(900);
  });

  it("recovers a known slope", () => {
    const ts = new TimeSeries("x");
    for (let i = 0; i < 50; i++) ts.push(i, 3 * i + 10);
    expect(ts.slopePerSec()).toBeCloseTo(3, 6);
  });

  it("reports a flat series as zero slope", () => {
    const ts = new TimeSeries("x");
    for (let i = 0; i < 50; i++) ts.push(i, 7);
    expect(ts.slopePerSec()).toBeCloseTo(0, 9);
  });
});

describe("Rng", () => {
  it("is reproducible for a given seed", () => {
    const a = new Rng(99);
    const b = new Rng(99);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it("produces values in [0,1) with the right mean and variance", () => {
    const rng = new Rng(5);
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
      sumSq += u * u;
    }
    const m = sum / n;
    expect(m).toBeCloseTo(0.5, 2);
    expect(sumSq / n - m * m).toBeCloseTo(1 / 12, 2);
  });

  it("nextNonZero never returns zero", () => {
    // A zero here becomes log(0) = -Infinity, hence an infinite service time and
    // a silently wedged simulation. A one-in-four-billion bug is the worst kind.
    const rng = new Rng(1);
    for (let i = 0; i < 100_000; i++) expect(rng.nextNonZero()).toBeGreaterThan(0);
  });

  it("normal() has mean 0 and variance 1", () => {
    const rng = new Rng(7);
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const z = rng.normal();
      sum += z;
      sumSq += z * z;
    }
    const m = sum / n;
    expect(m).toBeCloseTo(0, 1);
    expect(sumSq / n - m * m).toBeCloseTo(1, 1);
  });

  it("streams are independent of one another", () => {
    /**
     * The property that makes A/B comparison honest: drawing from one stream must
     * not advance any other. Otherwise changing a configuration that consumes
     * service draws would shift the arrival sequence, and the observed difference
     * would not be attributable to the change.
     */
    const bundle = new RngBundle(1234);
    const arrivalsAlone: number[] = [];
    for (let i = 0; i < 100; i++) arrivalsAlone.push(bundle.stream("arrival").next());

    const bundle2 = new RngBundle(1234);
    const arrivalsInterleaved: number[] = [];
    for (let i = 0; i < 100; i++) {
      // Consume the service stream heavily in between.
      for (let k = 0; k < 13; k++) bundle2.stream("service").next();
      arrivalsInterleaved.push(bundle2.stream("arrival").next());
    }
    expect(arrivalsInterleaved).toEqual(arrivalsAlone);
  });

  it("different streams do not produce identical sequences", () => {
    const bundle = new RngBundle(1);
    const a = Array.from({ length: 20 }, () => bundle.stream("arrival").next());
    const b = Array.from({ length: 20 }, () => bundle.stream("service").next());
    expect(a).not.toEqual(b);
  });
});

describe("Distribution", () => {
  it("analytic mean and variance match sampled moments", () => {
    const cases = [
      { kind: "deterministic", value: 25 } as const,
      { kind: "exponential", mean: 25 } as const,
      { kind: "uniform", min: 10, max: 40 } as const,
      { kind: "lognormal", mean: 25, p99: 120 } as const,
      { kind: "pareto", scale: 10, alpha: 3.5 } as const,
    ];
    for (const d of cases) {
      const rng = new Rng(11);
      const n = 400_000;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const x = sample(d, rng);
        sum += x;
        sumSq += x * x;
      }
      const m = sum / n;
      const v = sumSq / n - m * m;
      expect(Math.abs(m - mean(d)) / mean(d)).toBeLessThan(0.02);
      if (variance(d) > 0) {
        expect(Math.abs(v - variance(d)) / variance(d)).toBeLessThan(0.08);
      }
    }
  });

  it("lognormal reproduces the requested mean and p99", () => {
    // The whole point of parameterising by (mean, p99) is that those are the two
    // numbers an engineer actually has. It has to actually hit them.
    const d = { kind: "lognormal", mean: 40, p99: 300 } as const;
    const rng = new Rng(2);
    const xs: number[] = [];
    for (let i = 0; i < 300_000; i++) xs.push(sample(d, rng));
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    xs.sort((a, b) => a - b);
    const p99 = xs[Math.floor(xs.length * 0.99)]!;
    expect(Math.abs(m - 40) / 40).toBeLessThan(0.02);
    expect(Math.abs(p99 - 300) / 300).toBeLessThan(0.05);
  });

  it("clamps an unrepresentable p99/mean ratio instead of returning NaN", () => {
    // No lognormal has a p99/mean ratio above exp(z99^2/2) ~= 15. Returning NaN
    // would propagate into every metric and be very hard to trace back.
    const p = lognormalFromMeanP99(10, 10_000);
    expect(Number.isFinite(p.mu)).toBe(true);
    expect(Number.isFinite(p.sigma)).toBe(true);
    const rng = new Rng(1);
    expect(Number.isFinite(sample({ kind: "lognormal", mean: 10, p99: 10_000 }, rng))).toBe(true);
  });

  it("scv is 0 for deterministic and 1 for exponential", () => {
    // These two anchor the Pollaczek-Khinchine (1 + Cs^2) factor.
    expect(scv({ kind: "deterministic", value: 30 })).toBe(0);
    expect(scv({ kind: "exponential", mean: 30 })).toBeCloseTo(1, 12);
  });

  it("reports infinite variance for a heavy-tailed Pareto", () => {
    expect(variance({ kind: "pareto", scale: 1, alpha: 1.5 })).toBe(Number.POSITIVE_INFINITY);
    expect(mean({ kind: "pareto", scale: 1, alpha: 0.5 })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Resource", () => {
  function harness(capacity: number, queueCapacity: number | null, policy: "shed" | "block" = "block") {
    const sim = new Sim();
    const r = new Resource(sim, {
      id: "r",
      capacity,
      queueCapacity,
      discipline: "fifo",
      admissionPolicy: policy,
    });
    return { sim, r };
  }

  it("serialises work beyond its capacity", () => {
    const { sim, r } = harness(1, null);
    const finished: number[] = [];
    const job = (id: number): Process<void> =>
      (function* () {
        const slot = yield* acquire(r);
        expect(slot.granted).toBe(true);
        yield* delay(10);
        r.release();
        finished.push(id);
      })();
    for (let i = 0; i < 3; i++) sim.spawn(job(i));
    sim.run(1000);
    // Three 10ms jobs through one server: strictly sequential.
    expect(finished).toEqual([0, 1, 2]);
    expect(sim.now).toBeGreaterThanOrEqual(30);
  });

  it("runs up to `capacity` jobs concurrently and no more", () => {
    const { sim, r } = harness(3, null);
    let peak = 0;
    const job = (): Process<void> =>
      (function* () {
        yield* acquire(r);
        peak = Math.max(peak, r.inServiceCount);
        yield* delay(10);
        r.release();
      })();
    for (let i = 0; i < 20; i++) sim.spawn(job());
    sim.run(1000);
    expect(peak).toBe(3);
  });

  it("sheds when the queue is full", () => {
    const { sim, r } = harness(1, 2, "shed");
    const outcomes: string[] = [];
    const job = (): Process<void> =>
      (function* () {
        const slot = yield* acquire(r);
        if (!slot.granted) {
          outcomes.push(slot.reason!);
          return;
        }
        outcomes.push("granted");
        yield* delay(10);
        r.release();
      })();
    for (let i = 0; i < 6; i++) sim.spawn(job());
    sim.run(1000);
    // 1 in service + 2 queued admitted; the other 3 rejected on arrival.
    expect(outcomes.filter((o) => o === "shed").length).toBe(3);
  });

  it("preserves FIFO order", () => {
    const { sim, r } = harness(1, null);
    const order: number[] = [];
    const job = (id: number): Process<void> =>
      (function* () {
        yield* acquire(r);
        order.push(id);
        yield* delay(5);
        r.release();
      })();
    for (let i = 0; i < 5; i++) sim.spawn(job(i));
    sim.run(1000);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("abandons a queued waiter when its deadline expires", () => {
    const sim = new Sim();
    const r = new Resource(sim, {
      id: "r",
      capacity: 1,
      queueCapacity: null,
      discipline: "fifo",
      admissionPolicy: "block",
    });
    const outcomes: string[] = [];
    // Occupy the server for a long time.
    sim.spawn(
      (function* (): Process<void> {
        yield* acquire(r);
        yield* delay(1000);
        r.release();
      })()
    );
    // This one cannot possibly be served before its 50ms deadline.
    sim.spawn(
      (function* (): Process<void> {
        const slot = yield* acquire(r, 50);
        outcomes.push(slot.granted ? "granted" : slot.reason!);
      })()
    );
    sim.run(2000);
    expect(outcomes).toEqual(["timeout"]);
    expect(r.stats().abandoned).toBe(1);
  });

  it("throws on a release without a matching acquire", () => {
    // Silent tolerance here would let a slot leak, inflating apparent capacity
    // and quietly understating utilization.
    const { r } = harness(1, null);
    expect(() => r.release()).toThrow(/release without matching acquire/);
  });

  it("utilization is time-weighted, not event-weighted", () => {
    const { sim, r } = harness(1, null);
    // Busy 20ms out of 100ms => 0.2, regardless of how many events occurred.
    sim.spawn(
      (function* (): Process<void> {
        yield* acquire(r);
        yield* delay(20);
        r.release();
        yield* delay(80);
      })()
    );
    sim.run(100);
    expect(r.stats().utilization).toBeCloseTo(0.2, 6);
  });
});

describe("Sim kernel", () => {
  it("advances the clock only by popping events", () => {
    const sim = new Sim();
    const times: number[] = [];
    sim.after(10, () => times.push(sim.now));
    sim.after(5, () => times.push(sim.now));
    sim.after(20, () => times.push(sim.now));
    sim.run(1000);
    expect(times).toEqual([5, 10, 20]);
    expect(sim.now).toBe(20);
  });

  it("does not execute events past the run window", () => {
    const sim = new Sim();
    let ran = false;
    sim.after(500, () => {
      ran = true;
    });
    sim.run(100);
    expect(ran).toBe(false);
    expect(sim.now).toBe(100);
  });

  it("resumes a delay with a timeout outcome when the deadline wins", () => {
    const sim = new Sim();
    const outcomes: boolean[] = [];
    sim.spawn(
      (function* (): Process<void> {
        const r = yield* delay(100, 30);
        outcomes.push(r.timedOut);
      })()
    );
    sim.run(1000);
    expect(outcomes).toEqual([true]);
    expect(sim.now).toBe(30);
  });

  it("does not resume a process twice when a wait races its deadline", () => {
    // Double resumption would corrupt every downstream counter, and the symptom
    // would appear far from the cause.
    const sim = new Sim();
    let resumed = 0;
    sim.spawn(
      (function* (): Process<void> {
        yield* delay(50, 50);
        resumed++;
      })()
    );
    sim.run(1000);
    expect(resumed).toBe(1);
  });

  it("floating-point delays accumulate without drift", () => {
    // The clock is assigned from each event's absolute time rather than
    // incremented by a delta, so there is no accumulated error.
    const sim = new Sim();
    let t = 0;
    for (let i = 1; i <= 1000; i++) {
      t += 0.1;
      sim.at(t, () => {});
    }
    sim.run(1e9);
    expect(sim.now).toBeCloseTo(t, 12);
  });
});
