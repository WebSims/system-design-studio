import type { FaultKind, FaultModel, Literal } from "@sds/schema";
import { canRedeliver, type Frame, type QueuedMessage, type StepEnv, type Timer, type WorldState } from "@sds/kernel";

/**
 * Enumerate the transitions available at a state, in a fixed order.
 *
 * ORDER IS PART OF THE CONTRACT
 *
 * Breadth-first search guarantees the first counterexample it finds is minimal in
 * transition count. It does not, on its own, guarantee that the SAME minimal
 * counterexample is reported on every run -- if two counterexamples share the minimal
 * length, which one surfaces depends on expansion order. A tool whose reported
 * counterexample changed between runs of an unchanged design would be untrustworthy in
 * exactly the way this project cares about, so the order here is total and
 * deterministic.
 *
 * It is also chosen, not arbitrary. Normal transitions come before fault transitions, so
 * among counterexamples of equal length the one needing fewer injected faults is found
 * first. A bug that needs no fault at all is a more damning finding than the same bug
 * behind a crash, and it should be the one the reader sees.
 */

export type Transition =
  /** Advance one actor by one transition. The ordinary case. */
  | { kind: "step"; actorId: string }
  /** Hand an available message to a consumer, creating its actor. */
  | { kind: "deliver"; messageId: number; handlerId: string; actorId: string }
  /** Fire an armed expiry timer, creating its actor. */
  | { kind: "fire-timer"; timerId: number; actorId: string; fault: FaultKind }
  /** Make an unacknowledged in-flight message available again. FAULT. */
  | { kind: "redeliver"; messageId: number; fault: FaultKind }
  /** Kill a running actor where it stands. FAULT. */
  | { kind: "crash"; actorId: string; fault: FaultKind }
  /** Force a held lease to expire. FAULT. */
  | { kind: "expire-lease"; leaseKey: string; fault: FaultKind }
  /** The caller gave up and retried. FAULT. */
  | { kind: "retry"; actorId: string; sameKey: boolean; fault: FaultKind };

export function isFault(t: Transition): FaultKind | null {
  return "fault" in t ? t.fault : null;
}

export interface EnabledInput {
  env: StepEnv;
  world: WorldState;
  frames: readonly Frame[];
  faults: FaultModel;
  /** Faults still affordable. */
  faultBudget: number;
  /** Actor ids already created, so a new lane gets a fresh one. */
  nextActorSeq: number;
}

export function enabledTransitions(input: EnabledInput): Transition[] {
  const { env, world, frames, faults, faultBudget } = input;
  const out: Transition[] = [];

  // ---- normal: actors with work left ----
  for (const f of frames) {
    if (f.status === "running") out.push({ kind: "step", actorId: f.id });
  }

  // ---- normal: delivery of an available message ----
  //
  // A message with no owner and no ack is waiting to be picked up. This is not a fault:
  // delivering a published message is what a queue is for.
  //
  // Note there is NO check that the message has never been delivered before. A message
  // becomes available again only by being redelivered, and redelivery is itself the
  // fault-charged transition below. Guarding on `deliveries === 0` here would have made
  // the redelivery fault unobservable -- it would return the message to the pool and
  // nothing would ever take it -- which is a bug that produces a false "no violation
  // found" for every at-least-once consumer.
  for (const m of sortedMessages(world.messages)) {
    if (m.acked || m.abandoned || m.inflightOwner !== null) continue;
    for (const handlerId of env.cw.consumers[m.queue] ?? []) {
      out.push({
        kind: "deliver",
        messageId: m.id,
        handlerId,
        actorId: `c${input.nextActorSeq + out.length}`,
      });
    }
  }

  // ---- normal: a timer firing ----
  //
  // Gated by the reservation-expiry flag rather than by a clock. Whether the timer's
  // deadline has "arrived" is not a question the explorer asks: it fires the timer at
  // every point in every interleaving, which is what reaches the case where a
  // reservation expires one operation before its owner confirms. A clock-driven model
  // reaches that case only if the arithmetic happens to line up.
  if (faultBudget > 0 && faults.reservationExpiry) {
    for (const t of sortedTimers(world.timers)) {
      if (t.fired) continue;
      out.push({
        kind: "fire-timer",
        timerId: t.id,
        actorId: `t${input.nextActorSeq + out.length}`,
        fault: "reservation-expiry",
      });
    }
  }

  if (faultBudget <= 0) return out;

  // ---- fault: redelivery before acknowledgement ----
  if (faults.queueRedelivery) {
    for (const m of sortedMessages(world.messages)) {
      if (m.acked || m.abandoned || m.inflightOwner === null) continue;
      const q = env.queues[m.queue];
      if (!q || !canRedeliver(q)) continue;
      if (m.deliveries > q.maxRedeliveries) continue;
      out.push({ kind: "redeliver", messageId: m.id, fault: "queue-redelivery" });
    }
  }

  // ---- fault: worker crash ----
  //
  // Only a frame that has already changed something is worth crashing. Crashing an
  // actor that has not yet touched state produces a state identical to that actor never
  // having existed, which the visited set would recognise anyway -- but generating it
  // still costs a transition of the depth budget, and depth is the scarcest resource in
  // the search.
  if (faults.workerCrash) {
    for (const f of frames) {
      if (f.status !== "running" || f.pc === 0) continue;
      out.push({ kind: "crash", actorId: f.id, fault: "worker-crash" });
    }
  }

  // ---- fault: lease expiry under a live holder ----
  if (faults.leaseExpiry) {
    for (const lk of Object.keys(world.leases).sort()) {
      out.push({ kind: "expire-lease", leaseKey: lk, fault: "lease-expiry" });
    }
  }

  // ---- fault: caller timeout and retry ----
  //
  // Two variants, and the difference between them is the single most commonly missed
  // detail in idempotency design. A retry carrying the SAME key is deduplicable. A
  // retry carrying a FRESH key is a second request that happens to want the same thing,
  // and no amount of idempotency machinery downstream will merge the two. A design can
  // be safe under one and broken under the other, so they are separate faults.
  for (const f of frames) {
    if (f.kind !== "request" || f.status !== "running" || f.pc === 0) continue;
    if (faults.retrySameKey) {
      out.push({ kind: "retry", actorId: f.id, sameKey: true, fault: "retry-same-key" });
    }
    if (faults.retryNewKey) {
      out.push({ kind: "retry", actorId: f.id, sameKey: false, fault: "retry-new-key" });
    }
  }

  return out;
}

/**
 * Whether anything at all can happen.
 *
 * A state with no enabled transition is QUIESCENT, and quiescence is the only point at
 * which postconditions may be evaluated. Checking them earlier would report a handler
 * halfway through its work as a violation -- "allocated plus remaining does not equal
 * the initial count" is true and meaningless while somebody is mid-decrement.
 *
 * Note that this asks for enablement under the REMAINING fault budget, not under the
 * configured one. A run that has spent its faults and finished its actors is genuinely
 * finished, and refusing to call it quiescent would mean postconditions were never
 * checked on any execution that used a fault.
 */
export function isQuiescent(input: EnabledInput): boolean {
  return enabledTransitions(input).length === 0;
}

function sortedMessages(messages: readonly QueuedMessage[]): QueuedMessage[] {
  return [...messages].sort((a, b) => a.id - b.id);
}

function sortedTimers(timers: readonly Timer[]): Timer[] {
  return [...timers].sort((a, b) => a.id - b.id);
}

/** Stable key for a transition, used to replay a counterexample path exactly. */
export function transitionKey(t: Transition): string {
  switch (t.kind) {
    case "step":
      return `s:${t.actorId}`;
    case "deliver":
      return `d:${t.messageId}:${t.handlerId}`;
    case "fire-timer":
      return `f:${t.timerId}`;
    case "redeliver":
      return `r:${t.messageId}`;
    case "crash":
      return `x:${t.actorId}`;
    case "expire-lease":
      return `e:${t.leaseKey}`;
    case "retry":
      return `y:${t.actorId}:${t.sameKey ? "same" : "new"}`;
  }
}

/** Human description of a transition, for the counterexample trace. */
export function describeTransition(t: Transition, identity: Record<string, Literal>): string {
  const who = Object.entries(identity)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  switch (t.kind) {
    case "step":
      return "";
    case "deliver":
      return `the queue delivers message ${t.messageId} to a consumer`;
    case "fire-timer":
      return `timer ${t.timerId} fires`;
    case "redeliver":
      return `the queue redelivers message ${t.messageId}, which was never acknowledged`;
    case "crash":
      return "the worker dies here, after its durable writes and before its response";
    case "expire-lease": {
      const sep = t.leaseKey.indexOf("\u0000");
      return `the lease on "${t.leaseKey.slice(sep + 1)}" expires while its holder is still working`;
    }
    case "retry":
      return t.sameKey
        ? `the caller times out and retries with the same idempotency key${who ? ` (${who})` : ""}`
        : `the caller times out and retries with a fresh idempotency key${who ? ` (${who})` : ""}`;
  }
}
