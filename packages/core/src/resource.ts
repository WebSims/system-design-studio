import type { AdmissionPolicy, QueueDiscipline } from "@sds/schema";
import type { AcquireResult, Sim, WaiterHandle, WaitStation } from "./sim";

export interface ResourceOptions {
  id: string;
  /** The `c` in M/M/c: how many requests can be in service simultaneously. */
  capacity: number;
  /** Null = unbounded queue (the M/M/c assumption). */
  queueCapacity: number | null;
  discipline: QueueDiscipline;
  admissionPolicy: AdmissionPolicy;
  /** Optional virtual-time capacity, used by failure timelines. */
  capacityAt?: () => number;
}

interface Waiter extends WaiterHandle {
  resume: (r: AcquireResult) => void;
}

export interface ResourceStats {
  /** Fraction of total capacity busy, time-weighted, in [0,1]. */
  utilization: number;
  /** Time-average number waiting in queue (Lq). */
  avgQueueLength: number;
  /** Time-average number in the station, waiting or in service (L). */
  avgInStation: number;
  maxQueueLength: number;
  currentQueueLength: number;
  currentInService: number;
  arrivals: number;
  admitted: number;
  shed: number;
  abandoned: number;
  completed: number;
  /**
   * Occupancy at the moment statistics were last reset (the warm-up boundary).
   *
   * Required to state the conservation identities correctly. Requests already
   * queued or in service when measurement began will be admitted or completed
   * inside the window without having arrived inside it, so a naive
   * `arrivals == admitted + shed` check is simply false at any non-empty
   * boundary. Carrying the boundary occupancy makes the identity exact.
   */
  queuedAtStart: number;
  inServiceAtStart: number;
  /** Sum of queue wait times over admitted requests, ms. */
  totalWaitMs: number;
  /** Time-weighted window the stats cover, ms. */
  observedMs: number;
}

/**
 * A capacity-limited service station with a queue.
 *
 * THIS IS THE OBJECT THE LEGACY ENGINE DID NOT HAVE.
 *
 * Its absence is the single root cause of the old tool being unable to find a
 * bottleneck. `handleCall` scheduled processing the instant a request arrived
 * (engine.jsx:157-224), so every node had unbounded concurrency. With unbounded
 * concurrency there is no contention; with no contention there is no queueing;
 * and with no queueing latency is *independent of load*. You could raise the
 * load slider forever and the reported latency would not move, because it was
 * computed as a static sum of constants down the call tree (engine.jsx:336).
 *
 * A bottleneck is by definition a queueing phenomenon. Everything the analyzer
 * will do in Phase 4 -- utilization ranking, instability detection, knee finding
 * -- is downstream of this class existing.
 *
 * All averages here are TIME-WEIGHTED, not per-event. The time-average queue
 * length is what Little's Law relates to throughput and latency; an average over
 * arrival events would weight a quiet second the same as a saturated one.
 */
export class Resource implements WaitStation {
  readonly id: string;
  readonly capacity: number;
  readonly queueCapacity: number | null;
  readonly discipline: QueueDiscipline;
  readonly admissionPolicy: AdmissionPolicy;
  private readonly capacityAt: () => number;

  private inService = 0;

  /**
   * Queue held as an array with a head index rather than using `shift()`.
   * Under overload the queue grows without bound, and `Array.shift()` is O(n);
   * an unstable system is exactly when the tool must stay fast enough to prove
   * it is unstable.
   */
  private queue: (Waiter | null)[] = [];
  private head = 0;
  /**
   * Live waiters, excluding tombstones.
   *
   * Abandoned waiters are tombstoned in place rather than spliced out, because
   * splicing from the middle is O(n) and abandonment is common once timeouts exist.
   * But a tombstone is NOT a waiter, so the length of the backing array
   * overstates the queue. Tracking the live count separately matters more than it
   * looks: `queueLength` feeds Lq, the queue-length time series, and the
   * instability verdict, so counting tombstones would inflate all three exactly in
   * the runs where timeouts are firing.
   */
  private liveInQueue = 0;

  // Time-weighted accumulators.
  private lastTouch = 0;
  private busyIntegral = 0;
  private queueIntegral = 0;
  private statsStart = 0;

  private maxQueueLength = 0;
  private arrivals = 0;
  private admitted = 0;
  private shedCount = 0;
  private abandonedCount = 0;
  private completedCount = 0;
  private totalWaitMs = 0;
  private queuedAtStart = 0;
  private inServiceAtStart = 0;

  constructor(private readonly sim: Sim, opts: ResourceOptions) {
    this.id = opts.id;
    this.capacity = opts.capacity;
    this.queueCapacity = opts.queueCapacity;
    this.discipline = opts.discipline;
    this.admissionPolicy = opts.admissionPolicy;
    this.capacityAt = opts.capacityAt ?? (() => this.capacity);
    this.lastTouch = sim.now;
    this.statsStart = sim.now;
  }

  get queueLength(): number {
    return this.liveInQueue;
  }

  get inServiceCount(): number {
    return this.inService;
  }

  get effectiveCapacity(): number {
    return Math.max(0, Math.min(this.capacity, Math.floor(this.capacityAt())));
  }

  /**
   * Fold elapsed time into the integrals. Must be called before every state
   * change, and before reading any statistic.
   */
  private touch(): void {
    const now = this.sim.now;
    const dt = now - this.lastTouch;
    if (dt > 0) {
      this.busyIntegral += this.inService * dt;
      this.queueIntegral += this.queueLength * dt;
      this.lastTouch = now;
    } else if (dt < 0) {
      // Time never moves backwards; if it does, the kernel is broken.
      throw new Error(`resource ${this.id}: clock moved backwards`);
    }
  }

  /**
   * Discard everything measured so far and start again from now.
   *
   * Called at the end of warm-up. A queueing system starts empty, which is not
   * its steady state; measuring from t=0 biases every latency and utilization
   * figure downward. Discarding the transient is not optional for numbers the
   * tool is willing to print.
   */
  resetStats(): void {
    this.touch();
    this.busyIntegral = 0;
    this.queueIntegral = 0;
    this.statsStart = this.sim.now;
    this.maxQueueLength = this.queueLength;
    this.arrivals = 0;
    this.admitted = 0;
    this.shedCount = 0;
    this.abandonedCount = 0;
    this.completedCount = 0;
    this.totalWaitMs = 0;
    this.queuedAtStart = this.queueLength;
    this.inServiceAtStart = this.inService;
  }

  requestSlot(resume: (r: AcquireResult) => void): WaiterHandle {
    this.touch();
    this.arrivals++;

    if (this.inService < this.effectiveCapacity) {
      this.inService++;
      this.admitted++;
      const handle: WaiterHandle = { enqueuedAt: this.sim.now, settled: true };
      resume({ granted: true, waitedMs: 0 });
      return handle;
    }

    const full =
      this.queueCapacity !== null && this.queueLength >= this.queueCapacity;

    // `shed` is the analytically tractable case (M/M/c/K with loss). `block`
    // makes the bound advisory: in an open-loop arrival process there is no
    // upstream buffer to apply back-pressure to, so "blocking" can only mean
    // waiting anyway. Modelled honestly rather than pretending back-pressure
    // exists where the topology provides none.
    if (full && this.admissionPolicy === "shed") {
      this.shedCount++;
      const handle: WaiterHandle = { enqueuedAt: this.sim.now, settled: true };
      resume({ granted: false, reason: "shed", waitedMs: 0 });
      return handle;
    }

    const waiter: Waiter = {
      enqueuedAt: this.sim.now,
      settled: false,
      resume,
    };
    this.queue.push(waiter);
    this.liveInQueue++;
    const len = this.queueLength;
    if (len > this.maxQueueLength) this.maxQueueLength = len;
    return waiter;
  }

  abandon(handle: WaiterHandle): void {
    if (handle.settled) return;
    this.touch();
    handle.settled = true;
    this.abandonedCount++;
    // Tombstone in place; compacted lazily by `dequeue`.
    for (let i = this.head; i < this.queue.length; i++) {
      if (this.queue[i] === handle) {
        this.queue[i] = null;
        this.liveInQueue--;
        break;
      }
    }
  }

  /** Release a slot held by a completed request and admit the next waiter. */
  release(): void {
    this.touch();
    if (this.inService <= 0) {
      throw new Error(`resource ${this.id}: release without matching acquire`);
    }
    this.inService--;
    this.completedCount++;
    this.admitAvailable();
  }

  /** Re-evaluate queued work at a failure start/recovery boundary. */
  refreshCapacity(): void {
    this.touch();
    this.admitAvailable();
  }

  private admitAvailable(): void {
    while (this.inService < this.effectiveCapacity && this.admitNext()) {
      // Admit every slot exposed by a recovery or capacity increase.
    }
  }

  private admitNext(): boolean {
    for (;;) {
      const waiter = this.dequeue();
      if (!waiter) return false;
      if (waiter.settled) continue; // abandoned while queued
      this.inService++;
      this.admitted++;
      const waited = this.sim.now - waiter.enqueuedAt;
      this.totalWaitMs += waited;
      waiter.settled = true;
      waiter.resume({ granted: true, waitedMs: waited });
      return true;
    }
  }

  private dequeue(): Waiter | null {
    if (this.discipline === "lifo") {
      while (this.queue.length > this.head) {
        const w = this.queue.pop();
        if (w) {
          this.liveInQueue--;
          return w;
        }
      }
      return null;
    }
    while (this.head < this.queue.length) {
      const w = this.queue[this.head];
      this.queue[this.head] = null;
      this.head++;
      if (w) this.liveInQueue--;
      // Compact once the dead prefix dominates, so memory does not grow without
      // bound during a long run.
      if (this.head > 4096 && this.head * 2 > this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      if (w) return w;
    }
    return null;
  }

  stats(): ResourceStats {
    this.touch();
    const observedMs = this.sim.now - this.statsStart;
    const denom = observedMs > 0 ? observedMs : 1;
    return {
      utilization: this.busyIntegral / (denom * this.capacity),
      avgQueueLength: this.queueIntegral / denom,
      avgInStation: (this.queueIntegral + this.busyIntegral) / denom,
      maxQueueLength: this.maxQueueLength,
      currentQueueLength: this.queueLength,
      currentInService: this.inService,
      arrivals: this.arrivals,
      admitted: this.admitted,
      shed: this.shedCount,
      abandoned: this.abandonedCount,
      completed: this.completedCount,
      queuedAtStart: this.queuedAtStart,
      inServiceAtStart: this.inServiceAtStart,
      totalWaitMs: this.totalWaitMs,
      observedMs,
    };
  }
}
