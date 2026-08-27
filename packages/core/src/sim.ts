import { EventQueue, type ScheduledEvent } from "./event-queue";

/**
 * Result handed back to a process when it resumes from a `delay`.
 * `timedOut` is true when the delay was cut short by a deadline.
 */
export interface DelayResult {
  timedOut: boolean;
}

export interface AcquireResult {
  granted: boolean;
  /** Why the acquire failed. */
  reason?: "shed" | "timeout";
  /** Simulated ms spent waiting in the queue before the outcome. */
  waitedMs: number;
}

/**
 * Anything a process can wait on.
 *
 * `deadlineAt` is an absolute simulated time. The kernel races the wait against
 * it and resumes with a timeout outcome if the deadline wins. Making this a
 * kernel primitive rather than a per-component hack is what will let Phase 3
 * add retries and circuit breakers without touching component internals: a
 * timeout is expressible against *any* wait, not just the ones someone
 * remembered to special-case.
 */
export type Wait =
  | { kind: "delay"; ms: number; deadlineAt?: number | null }
  | { kind: "acquire"; station: WaitStation; deadlineAt?: number | null }
  /**
   * Suspend until something else resumes us.
   *
   * Needed by anything asynchronous: a queue consumer parked waiting for a
   * message, and a fork-join parent waiting for its children. Both are cases
   * where the wait has no duration and no queue -- it ends when another process
   * says so.
   */
  | {
      kind: "suspend";
      register: (resume: () => void) => void;
      deadlineAt?: number | null;
    };

/**
 * The subset of a Resource the kernel needs. Kept as an interface so the kernel
 * has no dependency on the resource implementation (and vice versa).
 */
export interface WaitStation {
  /** Register a waiter. Returns a handle the kernel can abandon on timeout. */
  requestSlot(resume: (r: AcquireResult) => void): WaiterHandle;
  abandon(handle: WaiterHandle): void;
}

export interface WaiterHandle {
  readonly enqueuedAt: number;
  settled: boolean;
}

/** A simulation process: a generator that yields waits. */
export type Process<T = void> = Generator<Wait, T, unknown>;

/** Suspend for `ms` of simulated time. */
export function* delay(ms: number, deadlineAt?: number | null): Process<DelayResult> {
  const r = (yield { kind: "delay", ms, deadlineAt }) as DelayResult;
  return r;
}

/** Queue for a slot at a capacity-limited station. */
export function* acquire(
  station: WaitStation,
  deadlineAt?: number | null
): Process<AcquireResult> {
  const r = (yield { kind: "acquire", station, deadlineAt }) as AcquireResult;
  return r;
}

/** Park until `register`'s callback is invoked, or until the deadline. */
export function* suspend(
  register: (resume: () => void) => void,
  deadlineAt?: number | null
): Process<DelayResult> {
  const r = (yield { kind: "suspend", register, deadlineAt }) as DelayResult;
  return r;
}

/**
 * The simulation kernel: a virtual clock plus a process scheduler.
 *
 * Simulated time advances only by popping events. It has no relationship to wall
 * time at all, which is the whole point of the split — the legacy engine drove
 * its model from `requestAnimationFrame`, so it could never run faster than real
 * time and a 60-second experiment took 60 seconds. Here it takes milliseconds,
 * which is what makes automated capacity sweeps (Phase 4) possible.
 */
export class Sim {
  private readonly queue = new EventQueue();
  private _now = 0;
  private stopped = false;

  get now(): number {
    return this._now;
  }

  /** Schedule a bare callback. Prefer processes for anything stateful. */
  at(time: number, run: () => void): ScheduledEvent {
    return this.queue.push(time, run);
  }

  after(ms: number, run: () => void): ScheduledEvent {
    return this.queue.push(this._now + ms, run);
  }

  cancel(ev: ScheduledEvent): void {
    this.queue.cancel(ev);
  }

  /** Start a process. `onDone` fires when its generator returns. */
  spawn<T>(proc: Process<T>, onDone?: (value: T) => void): void {
    this.step(proc, undefined, onDone);
  }

  /**
   * Advance the clock to `untilMs`, executing every event in time order.
   *
   * The clock is set from the event, never incremented by a delta. This is what
   * makes the simulation exact: there is no accumulated floating-point drift and
   * no notion of a "tick" that could straddle two events.
   */
  run(untilMs: number): void {
    for (;;) {
      if (this.stopped) return;
      const next = this.queue.pop();
      if (!next) return;
      if (next.time > untilMs) {
        // Put it back; the run window ended before this event.
        this.queue.push(next.time, next.run);
        this._now = untilMs;
        return;
      }
      this._now = next.time;
      next.run();
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private step<T>(proc: Process<T>, sent: unknown, onDone?: (value: T) => void): void {
    const res = proc.next(sent as never);
    if (res.done) {
      onDone?.(res.value);
      return;
    }
    this.handle(proc, res.value, onDone);
  }

  private handle<T>(proc: Process<T>, wait: Wait, onDone?: (value: T) => void): void {
    if (wait.kind === "suspend") {
      let settled = false;
      let deadlineEvent: ScheduledEvent | null = null;

      const resume = () => {
        if (settled) return;
        settled = true;
        if (deadlineEvent) this.cancel(deadlineEvent);
        this.step(proc, { timedOut: false } satisfies DelayResult, onDone);
      };

      wait.register(resume);
      if (settled) return;

      if (wait.deadlineAt !== null && wait.deadlineAt !== undefined) {
        deadlineEvent = this.at(wait.deadlineAt, () => {
          if (settled) return;
          settled = true;
          this.step(proc, { timedOut: true } satisfies DelayResult, onDone);
        });
      }
      return;
    }

    if (wait.kind === "delay") {
      // Race the delay against the deadline. Whichever fires first cancels the
      // other, so a process can never be resumed twice.
      const fireAt = this._now + wait.ms;
      const deadline = wait.deadlineAt ?? null;

      if (deadline !== null && deadline < fireAt) {
        const ev = this.at(deadline, () => {
          this.step(proc, { timedOut: true } satisfies DelayResult, onDone);
        });
        void ev;
        return;
      }
      this.at(fireAt, () => {
        this.step(proc, { timedOut: false } satisfies DelayResult, onDone);
      });
      return;
    }

    // acquire
    let deadlineEvent: ScheduledEvent | null = null;
    let handle: WaiterHandle | null = null;
    let settled = false;

    const resume = (r: AcquireResult) => {
      if (settled) return;
      settled = true;
      if (deadlineEvent) this.cancel(deadlineEvent);
      this.step(proc, r, onDone);
    };

    handle = wait.station.requestSlot(resume);

    // If the station granted (or shed) synchronously, we are already settled and
    // must not arm a deadline for a process that is no longer waiting.
    if (settled) return;

    if (wait.deadlineAt !== null && wait.deadlineAt !== undefined) {
      const enqueuedAt = handle.enqueuedAt;
      deadlineEvent = this.at(wait.deadlineAt, () => {
        if (settled) return;
        wait.station.abandon(handle!);
        settled = true;
        this.step(
          proc,
          {
            granted: false,
            reason: "timeout",
            waitedMs: this._now - enqueuedAt,
          } satisfies AcquireResult,
          onDone
        );
      });
    }
  }

  /**
   * Run `procs` concurrently and resume the caller once all have finished.
   *
   * This is fork-join, and it is what makes a server's parallel dependency calls
   * cost `max(children)` rather than `sum(children)`. The distinction is large and
   * architectural, which is why `ServerConfig.fanout` is explicit rather than
   * assumed.
   *
   * The `remaining > 0` guard matters: a child that completes without ever
   * yielding finishes synchronously inside `spawn`, so all children may already be
   * done before we would suspend. Suspending then would park the parent forever.
   */
  joinAll<T>(procs: Process<T>[]): Process<T[]> {
    const sim = this;
    return (function* (): Process<T[]> {
      if (procs.length === 0) return [];
      const results: T[] = [];
      let remaining = procs.length;
      let resumeParent: (() => void) | null = null;

      for (const p of procs) {
        sim.spawn(p, (value) => {
          results.push(value);
          remaining--;
          if (remaining === 0 && resumeParent) resumeParent();
        });
      }

      if (remaining > 0) {
        yield {
          kind: "suspend",
          register: (resume) => {
            resumeParent = resume;
          },
        };
      }
      return results;
    })();
  }
}

