import type { CallPolicy, SdsEdge } from "@sds/schema";
import { Resource } from "./resource";
import type { Rng } from "./rng";
import type { Sim } from "./sim";
import type { ErrorReason, InvariantReport } from "./result";

/**
 * PER-EDGE FAILURE POLICY STATE.
 *
 * A CallSite is the caller's client for one dependency: its circuit breaker, its
 * bulkhead, its retry budget, and the counters that reveal what those policies
 * actually did. One object per edge, created once per run.
 *
 * Everything here exists to model a single phenomenon that the previous engine
 * could not express at all: a failure in one component consuming the capacity of
 * another. The legacy model had no retries (an `ancestors` set forbade revisiting a
 * node and a hard depth cap of 8 truncated the tree), so retry amplification --
 * the most common cause of a partial outage becoming a total one -- was
 * structurally impossible to simulate.
 */

export type BreakerState = "closed" | "open" | "half-open";

/**
 * A rolling failure-rate window, bucketed by time.
 *
 * Bucketed rather than a full event log so memory is bounded regardless of load,
 * and time-based rather than count-based so a quiet period lets the window drain.
 * A count-based window on a low-traffic edge can hold failures from ten minutes ago
 * and keep a circuit open long after the dependency recovered.
 */
class RollingWindow {
  private readonly successes: Float64Array;
  private readonly failures: Float64Array;
  private readonly bucketMs: number;
  private lastBucket = 0;

  constructor(
    private readonly windowMs: number,
    private readonly buckets = 10
  ) {
    this.successes = new Float64Array(buckets);
    this.failures = new Float64Array(buckets);
    this.bucketMs = windowMs / buckets;
  }

  private rotate(now: number): number {
    const bucket = Math.floor(now / this.bucketMs);
    if (bucket !== this.lastBucket) {
      const gap = Math.min(this.buckets, bucket - this.lastBucket);
      for (let i = 1; i <= gap; i++) {
        const idx = (bucket - this.buckets + i + this.buckets * 2) % this.buckets;
        this.successes[idx] = 0;
        this.failures[idx] = 0;
      }
      this.lastBucket = bucket;
    }
    return bucket % this.buckets;
  }

  record(now: number, ok: boolean): void {
    const idx = this.rotate(now);
    if (ok) this.successes[idx]!++;
    else this.failures[idx]!++;
  }

  /** Total observations and failure rate over the window. */
  stats(now: number): { total: number; failureRate: number } {
    this.rotate(now);
    let s = 0;
    let f = 0;
    for (let i = 0; i < this.buckets; i++) {
      s += this.successes[i]!;
      f += this.failures[i]!;
    }
    const total = s + f;
    return { total, failureRate: total > 0 ? f / total : 0 };
  }

  reset(): void {
    this.successes.fill(0);
    this.failures.fill(0);
  }

  /** Window length, exposed so the caller can size its own bookkeeping. */
  get lengthMs(): number {
    return this.windowMs;
  }
}

export interface CallSiteMetrics {
  edgeId: string;
  from: string;
  to: string;
  /** Calls the caller wanted to make. */
  calls: number;
  /** Attempts actually issued, including retries. */
  attempts: number;
  retries: number;
  /**
   * attempts / calls.
   *
   * The headline number of this phase. At 1.0 retries cost nothing. Above about
   * 1.5 the dependency is doing materially more work than the workload requires,
   * and every layer of the call graph multiplies this figure again.
   */
  amplification: number;
  successes: number;
  failures: number;
  /** Retries suppressed because the budget was exhausted. */
  budgetRejections: number;
  /** Calls failed fast because the circuit was open. */
  circuitRejections: number;
  /** Calls rejected because the bulkhead was full. */
  bulkheadRejections: number;
  /** Transitions into the open state. */
  breakerTrips: number;
  /** Fraction of the measurement window the circuit spent open or half-open. */
  breakerOpenFraction: number;
  breakerState: BreakerState;
  /**
   * Time-average concurrent outstanding calls on this edge.
   *
   * Counts a call from the moment the caller wants to make it, so it includes calls
   * waiting for -- or being rejected by -- a bulkhead slot. That makes it the right
   * measure of demand on the dependency, and a slightly different number from
   * bulkhead occupancy.
   */
  avgConcurrency: number;
  maxConcurrency: number;
  /** Bulkhead slots in use, time-weighted, [0,1]. Null when no bulkhead. */
  bulkheadUtilization: number | null;
  /** Peak bulkhead slots in use. Never exceeds the configured limit. */
  bulkheadMaxInUse: number | null;
}

export class CallSite {
  readonly bulkhead: Resource | null;
  private readonly policy: CallPolicy;
  private readonly window: RollingWindow;

  private state: BreakerState = "closed";
  private openedAt = 0;
  private halfOpenInFlight = 0;

  /** Rolling counters for the retry budget. */
  private budgetWindow: RollingWindow;

  private calls = 0;
  private attempts = 0;
  private retries = 0;
  private successes = 0;
  private failures = 0;
  private budgetRejections = 0;
  private circuitRejections = 0;
  private bulkheadRejections = 0;
  private breakerTrips = 0;

  private notClosedMs = 0;
  private lastStateChange = 0;
  private statsStart = 0;

  private concurrency = 0;
  private concurrencyIntegral = 0;
  private lastTouch = 0;
  private maxConcurrency = 0;

  constructor(
    readonly edge: SdsEdge,
    private readonly sim: Sim
  ) {
    this.policy = edge.policy;
    this.window = new RollingWindow(edge.policy.circuitBreaker.windowMs);
    this.budgetWindow = new RollingWindow(
      // Budget is judged over a window long enough to be stable but short enough
      // to recover: ten seconds matches typical retry-budget implementations.
      10_000
    );
    this.bulkhead = edge.policy.bulkhead.enabled
      ? new Resource(sim, {
          id: `${edge.id}:bulkhead`,
          capacity: edge.policy.bulkhead.maxConcurrent,
          queueCapacity: edge.policy.bulkhead.queueCapacity,
          discipline: "fifo",
          admissionPolicy: "shed",
        })
      : null;
    this.lastStateChange = sim.now;
    this.statsStart = sim.now;
    this.lastTouch = sim.now;
  }

  private touch(): void {
    const dt = this.sim.now - this.lastTouch;
    if (dt > 0) {
      this.concurrencyIntegral += this.concurrency * dt;
      if (this.state !== "closed") this.notClosedMs += dt;
      this.lastTouch = this.sim.now;
    }
  }

  resetStats(): void {
    this.touch();
    this.calls = 0;
    this.attempts = 0;
    this.retries = 0;
    this.successes = 0;
    this.failures = 0;
    this.budgetRejections = 0;
    this.circuitRejections = 0;
    this.bulkheadRejections = 0;
    this.breakerTrips = 0;
    this.notClosedMs = 0;
    this.concurrencyIntegral = 0;
    this.statsStart = this.sim.now;
    this.maxConcurrency = this.concurrency;
    this.bulkhead?.resetStats();
    // The breaker's own window is NOT reset: its state is part of the steady
    // condition the warm-up was spent reaching.
  }

  // ---- circuit breaker ----

  /**
   * Decide whether this call may proceed, and move the breaker's state machine on.
   *
   * closed     -> pass, and open if the failure rate crosses the threshold
   * open       -> fail fast until openMs elapses, then half-open
   * half-open  -> let a limited number of probes through; one success closes, one
   *               failure re-opens
   */
  admit(measuring: boolean): { allowed: boolean; probe: boolean } {
    if (!this.policy.circuitBreaker.enabled) return { allowed: true, probe: false };
    const cb = this.policy.circuitBreaker;
    const now = this.sim.now;

    if (this.state === "open") {
      if (now - this.openedAt >= cb.openMs) {
        this.transition("half-open");
      } else {
        if (measuring) this.circuitRejections++;
        return { allowed: false, probe: false };
      }
    }

    if (this.state === "half-open") {
      if (this.halfOpenInFlight >= cb.halfOpenProbes) {
        if (measuring) this.circuitRejections++;
        return { allowed: false, probe: false };
      }
      this.halfOpenInFlight++;
      return { allowed: true, probe: true };
    }

    return { allowed: true, probe: false };
  }

  /** Feed an attempt's outcome back into the breaker. */
  observe(ok: boolean, probe: boolean, measuring: boolean): void {
    const cb = this.policy.circuitBreaker;
    if (!cb.enabled) return;

    if (probe) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      // A half-open probe is decisive on its own: that is the point of probing.
      this.transition(ok ? "closed" : "open", measuring);
      if (ok) this.window.reset();
      return;
    }

    this.window.record(this.sim.now, ok);
    if (this.state !== "closed") return;

    const { total, failureRate } = this.window.stats(this.sim.now);
    if (total >= cb.minimumRequests && failureRate >= cb.failureThreshold) {
      this.transition("open", measuring);
    }
  }

  private transition(next: BreakerState, measuring = false): void {
    if (this.state === next) return;
    this.touch();
    if (next === "open") {
      this.openedAt = this.sim.now;
      if (measuring) this.breakerTrips++;
      this.halfOpenInFlight = 0;
    }
    this.state = next;
    this.lastStateChange = this.sim.now;
  }

  // ---- retry budget ----

  /**
   * Should this retry be allowed?
   *
   * The budget compares retries already spent against original calls over a
   * rolling window, so a healthy system retries freely while a broadly failing one
   * cannot amplify. This is the difference between retries costing a few percent
   * and retries multiplying load by the attempt count exactly when the dependency
   * can least afford it.
   */
  allowRetry(measuring: boolean): boolean {
    const retry = this.policy.retry;
    if (!retry || retry.budgetRatio === null) return true;

    // Originals are recorded as successes and retries as failures in this window,
    // purely so one bucketed structure serves both. Read them back apart.
    const { total, failureRate } = this.budgetWindow.stats(this.sim.now);
    const retriesSpent = total * failureRate;
    const originals = Math.max(1, total - retriesSpent);

    if (retriesSpent + 1 > originals * retry.budgetRatio) {
      if (measuring) this.budgetRejections++;
      return false;
    }
    return true;
  }

  /** Record an original call against the budget window. */
  noteCall(): void {
    this.budgetWindow.record(this.sim.now, true);
  }

  /** Record a retry spent from the budget. */
  noteRetry(): void {
    this.budgetWindow.record(this.sim.now, false);
  }

  // ---- backoff ----

  /** Delay before attempt number `attempt` (1-based; attempt 2 is the first retry). */
  backoffMs(attempt: number, rng: Rng): number {
    const retry = this.policy.retry;
    if (!retry) return 0;
    const b = retry.backoff;
    let delay: number;
    switch (b.kind) {
      case "none":
        delay = 0;
        break;
      case "fixed":
        delay = b.baseMs;
        break;
      case "exponential":
        delay = Math.min(b.maxMs, b.baseMs * Math.pow(2, attempt - 2));
        break;
    }
    // Full jitter: uniform over [0, delay]. Without it every client that failed
    // together retries together, and the recovering dependency is hit by a
    // synchronised wave.
    return b.jitter ? rng.next() * delay : delay;
  }

  isRetryable(reason: ErrorReason | undefined): boolean {
    const retry = this.policy.retry;
    if (!retry || reason === undefined) return false;
    // A circuit-open or bulkhead rejection is the caller's own protection firing.
    // Retrying past it would defeat the mechanism that just engaged.
    if (reason === "circuit-open" || reason === "bulkhead-full" || reason === "queue-full") {
      return false;
    }
    return (retry.retryOn as string[]).includes(reason);
  }

  get maxAttempts(): number {
    return this.policy.retry?.maxAttempts ?? 1;
  }

  get attemptTimeoutMs(): number | null {
    return this.policy.timeoutMs;
  }

  // ---- counters ----

  enter(measuring: boolean): void {
    this.touch();
    this.concurrency++;
    if (this.concurrency > this.maxConcurrency) this.maxConcurrency = this.concurrency;
    if (measuring) this.calls++;
  }

  exit(ok: boolean, measuring: boolean): void {
    this.touch();
    this.concurrency--;
    if (measuring) {
      if (ok) this.successes++;
      else this.failures++;
    }
  }

  noteAttempt(measuring: boolean, isRetry: boolean): void {
    if (!measuring) return;
    this.attempts++;
    if (isRetry) this.retries++;
  }

  noteBulkheadRejection(measuring: boolean): void {
    if (measuring) this.bulkheadRejections++;
  }

  metrics(): CallSiteMetrics {
    this.touch();
    const span = this.sim.now - this.statsStart;
    const denom = span > 0 ? span : 1;
    return {
      edgeId: this.edge.id,
      from: this.edge.from,
      to: this.edge.to,
      calls: this.calls,
      attempts: this.attempts,
      retries: this.retries,
      amplification: this.calls > 0 ? this.attempts / this.calls : 1,
      successes: this.successes,
      failures: this.failures,
      budgetRejections: this.budgetRejections,
      circuitRejections: this.circuitRejections,
      bulkheadRejections: this.bulkheadRejections,
      breakerTrips: this.breakerTrips,
      breakerOpenFraction: this.notClosedMs / denom,
      breakerState: this.state,
      avgConcurrency: this.concurrencyIntegral / denom,
      maxConcurrency: this.maxConcurrency,
      bulkheadUtilization: this.bulkhead ? this.bulkhead.stats().utilization : null,
      bulkheadMaxInUse: this.bulkhead
        ? Math.round(this.bulkhead.stats().utilization * this.bulkhead.capacity * 100) / 100
        : null,
    };
  }

  invariants(): InvariantReport[] {
    const m = this.metrics();
    const reports: InvariantReport[] = [];

    // Every call resolves exactly once, and attempts can never be fewer than calls
    // that were actually tried.
    const resolved = m.successes + m.failures;
    const balanced = resolved + Math.max(0, this.concurrency) >= m.calls && m.attempts >= m.calls - m.circuitRejections - m.bulkheadRejections;
    reports.push({
      name: `call "${this.edge.id}" bookkeeping`,
      passed: balanced,
      detail: balanced
        ? `${m.calls} calls, ${m.attempts} attempts (${m.retries} retries), ` +
          `${m.successes} ok, ${m.failures} failed, ${this.concurrency} in flight`
        : `${m.calls} calls but ${resolved} resolved and ${m.attempts} attempts issued`,
    });

    if (this.bulkhead) {
      const s = this.bulkhead.stats();
      const queueOk =
        s.arrivals + s.queuedAtStart === s.admitted + s.shed + s.abandoned + s.currentQueueLength;
      const serviceOk = s.admitted + s.inServiceAtStart === s.completed + s.currentInService;
      reports.push({
        name: `bulkhead "${this.edge.id}" bookkeeping`,
        passed: queueOk && serviceOk,
        detail:
          queueOk && serviceOk
            ? `${s.arrivals} offered, ${s.admitted} admitted, ${s.shed} rejected`
            : `queue ${s.arrivals + s.queuedAtStart} vs ${s.admitted + s.shed + s.abandoned + s.currentQueueLength}`,
      });
    }

    return reports;
  }
}
