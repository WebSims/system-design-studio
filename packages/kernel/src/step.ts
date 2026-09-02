import type { Expr, Literal, Operation, ResponseStatus } from "@sds/schema";
import { collectionById } from "@sds/schema";
import type { CompiledWorkflow, Instr } from "./compile";
import { evaluate, truthy, type EvalContext, type Value } from "./expr";
import {
  completeRow,
  leaseKey,
  pruneFinished,
  withCounter,
  withLease,
  withMessages,
  withOutcome,
  withRow,
  withTimers,
  type LeaseState,
  type QueuedMessage,
  type Row,
  type Timer,
  type WorldState,
} from "./state";

/**
 * The transition kernel.
 *
 * ONE FUNCTION, TWO ENGINES, NO SECOND OPINION.
 *
 * `step` advances one actor by exactly one transition. The breadth-first explorer calls
 * it for every enabled actor at every state; the discrete-event simulator calls it for
 * one actor when that actor's station finishes its work. Neither engine contains any
 * other code that changes state.
 *
 * That constraint is the reason this file is worth reading carefully, and it is also
 * the reason it is possible to test the claim. `conformance.test.ts` drives every
 * operation through both engines and compares the resulting worlds; the test can only
 * exist because there is one implementation to compare against itself.
 *
 * WHAT ONE TRANSITION IS
 *
 * Zero or more purely local instructions -- assignments, branches, jumps -- followed by
 * exactly one instruction that touches shared state, after which control returns to the
 * scheduler. Locals are bundled with the following state operation because they cannot
 * be observed: branching the search at an assignment would multiply states without
 * admitting a single behaviour that branching at the next read or write does not
 * already admit.
 *
 * The consequence, stated plainly because it is the entire point of the tool: a `read`
 * and the `write` that uses its result are TWO transitions, and any other actor may run
 * in between. A model in which they were one could not express the bug that they are
 * one.
 */

export type FrameKind = "request" | "queue-consumer" | "expiry-timer";

export type FrameStatus =
  /** Has more instructions to execute. */
  | "running"
  /** Ran to completion. */
  | "done"
  /**
   * Killed mid-execution by an injected fault.
   *
   * A crashed frame is TERMINAL BUT NOT COMPLETE, and the distinction carries the
   * whole weight of the worker-crash fault: everything it durably wrote is still
   * written, its lease is still held until it expires, and the message it was
   * consuming is still unacknowledged. That gap is where duplicate effects live.
   */
  | "crashed";

export interface Frame {
  id: string;
  kind: FrameKind;
  handlerId: string;
  pc: number;
  locals: Record<string, Literal>;
  /** Generated request fields, message body, or timer arguments. */
  request: Row;
  /** Message being consumed, for a queue handler. */
  messageId: number | null;
  /** Timer that fired, for an expiry handler. */
  timerId: number | null;
  /** Fencing tokens held: lease key -> token. */
  tokens: Record<string, number>;
  /** Grant time per held lease key, for held-duration measurement. */
  leaseHeldAt: Record<string, number>;
  status: FrameStatus;
  responseStatus: ResponseStatus | null;
  responseOutcome: string | null;
}

// ---------------------------------------------------------------------------
// events and diffs
// ---------------------------------------------------------------------------

/**
 * Something the scheduler or the metrics layer needs to know about.
 *
 * Kept separate from state diffs because they answer different questions. A diff says
 * what changed; an event says what happened. `lease-contended` changes nothing and
 * matters enormously.
 */
export type KernelEvent =
  | { kind: "published"; queue: string; messageId: number }
  | { kind: "acked"; messageId: number }
  | { kind: "timer-armed"; timerId: number; handler: string; afterMs: number }
  | { kind: "responded"; status: ResponseStatus; outcome: string | null }
  | { kind: "lease-acquired"; lock: string; key: string; token: number }
  | { kind: "lease-contended"; lock: string; key: string }
  | { kind: "lease-released"; lock: string; key: string; heldMs: number }
  /** A mutation refused because the writer's fencing token was superseded. */
  | { kind: "stale-owner-rejected"; lock: string; key: string; token: number; current: number }
  /** A unique insert lost the race. In an idempotent design this is the happy path. */
  | { kind: "unique-conflict"; collection: string; key: string }
  | { kind: "guard-failed"; collection: string }
  | { kind: "table-full"; collection: string };

export interface StateDiff {
  collection: string;
  key: string | null;
  field: string | null;
  before: Literal | null;
  after: Literal | null;
}

export interface OpCharge {
  nodeId: string;
  role: "datastore" | "lock" | "queue";
}

export interface StepResult {
  world: WorldState;
  frame: Frame;
  events: KernelEvent[];
  diffs: StateDiff[];
  /** Id of the state-touching operation this transition performed, if any. */
  opId: string | null;
  opKind: string | null;
  /** Plain-language description, assembled from the operation. Never AI-written. */
  label: string;
  charge: OpCharge | null;
  /** Locals bound by this transition, so a trace can show what the actor believed. */
  observed: Record<string, Literal>;
  terminal: boolean;
  /**
   * Collections read by this transition.
   *
   * Two uses, both load-bearing. The explorer uses it for independence reduction: two
   * transitions that touch disjoint collections commute, so only one of the two
   * orderings needs exploring. The simulator uses it to detect transaction conflicts.
   */
  reads: string[];
  writes: string[];
}

export interface QueueSettings {
  delivery: "at-least-once" | "at-most-once";
  requireAck: boolean;
  visibilityTimeoutMs: number;
  maxRedeliveries: number;
  maxDepth: number | null;
}

export interface LockSettings {
  defaultTtlMs: number;
  fencingTokens: boolean;
}

export interface StepEnv {
  cw: CompiledWorkflow;
  queues: Record<string, QueueSettings>;
  locks: Record<string, LockSettings>;
}

// ---------------------------------------------------------------------------
// frame construction
// ---------------------------------------------------------------------------

export function startRequestFrame(env: StepEnv, id: string, request: Row): Frame {
  return {
    id,
    kind: "request",
    handlerId: env.cw.rootHandlerId,
    pc: 0,
    locals: {},
    request,
    messageId: null,
    timerId: null,
    tokens: {},
    leaseHeldAt: {},
    status: "running",
    responseStatus: null,
    responseOutcome: null,
  };
}

export function startConsumerFrame(
  id: string,
  handlerId: string,
  message: QueuedMessage
): Frame {
  return {
    id,
    kind: "queue-consumer",
    handlerId,
    pc: 0,
    locals: {},
    // The message body IS the consumer's request. A consumer has no other input, which
    // is why `publish` has to carry every field the consumer will need -- and why a
    // consumer cannot read a local from the publisher, a mistake the schema makes
    // impossible rather than merely discouraged.
    request: { ...message.body },
    messageId: message.id,
    timerId: null,
    tokens: {},
    leaseHeldAt: {},
    status: "running",
    responseStatus: null,
    responseOutcome: null,
  };
}

export function startTimerFrame(id: string, timer: Timer): Frame {
  return {
    id,
    kind: "expiry-timer",
    handlerId: timer.handler,
    pc: 0,
    locals: {},
    request: { ...timer.args },
    messageId: null,
    timerId: timer.id,
    tokens: {},
    leaseHeldAt: {},
    status: "running",
    responseStatus: null,
    responseOutcome: null,
  };
}

// ---------------------------------------------------------------------------
// the step function
// ---------------------------------------------------------------------------

interface OpResult {
  kind: "ok" | "abort" | "terminate";
  world: WorldState;
  frame: Frame;
  /** Set when `kind` is `abort`. */
  reason?: string;
}

/**
 * Advance one actor by one transition.
 *
 * `nowMs` is supplied by the caller rather than tracked here, because the two engines
 * have genuinely different clocks: the simulator's is a discrete-event time in
 * milliseconds, the explorer's is a transition counter. The kernel needs a number to
 * stamp into `timestamp` fields and to compute lease deadlines; it never compares one
 * against another to decide whether something has expired. Expiry is a transition the
 * scheduler chooses to fire (see `expireLease`, `fireTimer`), which is what lets the
 * explorer reach the interleaving where a lease dies one operation before its holder
 * commits.
 */
export function step(env: StepEnv, world: WorldState, frame: Frame, nowMs: number): StepResult {
  const prog = env.cw.programs[frame.handlerId];
  const events: KernelEvent[] = [];
  const diffs: StateDiff[] = [];
  const reads = new Set<string>();
  const writes = new Set<string>();
  const observedBefore = frame.locals;

  let w: WorldState = world.nowMs === nowMs ? world : { ...world, nowMs };
  let f: Frame = frame;

  if (!prog || f.status !== "running") {
    return terminalResult(w, { ...f, status: f.status === "running" ? "done" : f.status });
  }

  // Bounded by the instruction count: every jump this compiler emits goes forward, so
  // the loop cannot spin. The guard is a belt-and-braces assertion, not a mechanism.
  const limit = prog.instrs.length + 1;
  for (let guard = 0; guard < limit; guard++) {
    const instr = prog.instrs[f.pc];
    if (!instr) return terminalResult(w, { ...f, status: "done" });

    switch (instr.k) {
      case "halt":
        return {
          ...terminalResult(w, { ...f, status: "done" }),
          events,
          diffs,
          reads: [...reads],
          writes: [...writes],
        };

      case "jump":
        f = { ...f, pc: instr.to };
        continue;

      case "endAtomic":
        // Only reached if a region was entered by falling through, which the compiler
        // does not emit. Treated as a no-op rather than an error so a hand-authored
        // program cannot wedge the executor.
        f = { ...f, pc: f.pc + 1 };
        continue;

      case "branch": {
        for (const c of collectionsOf(instr.op.cond)) reads.add(c);
        const take = truthy(evaluate(instr.op.cond, ctxOf(env, w, f)));
        f = { ...f, pc: take ? f.pc + 1 : instr.elseAt };
        continue;
      }

      case "beginAtomic": {
        const region = runRegion(env, w, f, f.pc + 1, instr.endAt, events, diffs, reads, writes);
        if (region.kind === "abort") {
          const aborted = abortFrame(region.frame, region.reason);
          return {
            world: region.world,
            frame: aborted,
            events,
            diffs,
            opId: instr.op.id,
            opKind: "atomic",
            label: `transaction "${instr.op.id}" rolled back: ${region.reason ?? "guard failed"}`,
            charge: chargeOf(env, instr.op),
            observed: newLocals(observedBefore, region.frame.locals),
            terminal: true,
            reads: [...reads],
            writes: [...writes],
          };
        }
        const done = region.kind === "terminate";
        const next = done ? region.frame : { ...region.frame, pc: instr.endAt + 1 };
        return {
          world: region.world,
          frame: next,
          events,
          diffs,
          opId: instr.op.id,
          opKind: "atomic",
          label: `transaction "${instr.op.id}" committed ${instr.op.body.length} operation${
            instr.op.body.length === 1 ? "" : "s"
          } indivisibly`,
          charge: chargeOf(env, instr.op),
          observed: newLocals(observedBefore, region.frame.locals),
          terminal: done || next.status !== "running",
          reads: [...reads],
          writes: [...writes],
        };
      }

      case "op": {
        const res = applyOp(env, w, f, instr.op, events, diffs, reads, writes);
        w = res.world;

        if (res.kind === "abort") {
          const aborted = abortFrame(res.frame, res.reason);
          return {
            world: w,
            frame: aborted,
            events,
            diffs,
            opId: instr.op.id,
            opKind: instr.op.op,
            label: `${describeOp(instr.op)} \u2014 refused: ${res.reason ?? "guard failed"}`,
            charge: chargeOf(env, instr.op),
            observed: newLocals(observedBefore, aborted.locals),
            terminal: true,
            reads: [...reads],
            writes: [...writes],
          };
        }

        if (res.kind === "terminate") {
          return {
            world: w,
            frame: res.frame,
            events,
            diffs,
            opId: instr.op.id,
            opKind: instr.op.op,
            label: describeOp(instr.op),
            charge: chargeOf(env, instr.op),
            observed: newLocals(observedBefore, res.frame.locals),
            terminal: true,
            reads: [...reads],
            writes: [...writes],
          };
        }

        f = { ...res.frame, pc: f.pc + 1 };

        if (instr.scheduling) {
          return {
            world: w,
            frame: f,
            events,
            diffs,
            opId: instr.op.id,
            opKind: instr.op.op,
            label: describeOp(instr.op),
            charge: chargeOf(env, instr.op),
            observed: newLocals(observedBefore, f.locals),
            terminal: false,
            reads: [...reads],
            writes: [...writes],
          };
        }
        continue;
      }
    }
  }

  // Unreachable given forward-only jumps. Reported rather than silently truncated,
  // because a workflow that could loop would invalidate the transition bound and
  // therefore every "no violation within bounds" claim made about it.
  return {
    ...terminalResult(w, { ...f, status: "crashed" }),
    events,
    diffs,
    label: "executor gave up: the handler did not terminate within its instruction count",
    reads: [...reads],
    writes: [...writes],
  };
}

/**
 * Execute an indivisible region: everything commits, or nothing does.
 *
 * Rollback is free because state is copy-on-write: discarding the region's result is
 * discarding a reference. Diffs and events produced inside a region that then aborts
 * ARE discarded too, by truncating both arrays back to their entry length -- otherwise a
 * counterexample would show writes that never happened, which is worse than showing
 * none.
 */
function runRegion(
  env: StepEnv,
  world: WorldState,
  frame: Frame,
  start: number,
  end: number,
  events: KernelEvent[],
  diffs: StateDiff[],
  reads: Set<string>,
  writes: Set<string>
): OpResult {
  const prog = env.cw.programs[frame.handlerId]!;
  const eventMark = events.length;
  const diffMark = diffs.length;

  let w = world;
  let f = frame;
  let pc = start;

  const limit = prog.instrs.length + 1;
  for (let guard = 0; guard < limit && pc < end; guard++) {
    const instr = prog.instrs[pc];
    if (!instr) break;

    switch (instr.k) {
      case "jump":
        pc = instr.to;
        continue;
      case "branch": {
        for (const c of collectionsOf(instr.op.cond)) reads.add(c);
        pc = truthy(evaluate(instr.op.cond, ctxOf(env, w, f))) ? pc + 1 : instr.elseAt;
        continue;
      }
      case "halt":
        pc = end;
        continue;
      case "endAtomic":
        pc = end;
        continue;
      case "beginAtomic":
        // Validation rejects nested transactions, so this is unreachable from a
        // validated workflow. Skipped rather than flattened, because flattening would
        // silently give a different meaning to an invalid document.
        pc = instr.endAt;
        continue;
      case "op": {
        const res = applyOp(env, w, f, instr.op, events, diffs, reads, writes);
        if (res.kind === "abort") {
          events.length = eventMark;
          diffs.length = diffMark;
          return { kind: "abort", world, frame, reason: res.reason };
        }
        w = res.world;
        f = res.frame;
        if (res.kind === "terminate") return { kind: "terminate", world: w, frame: f };
        pc++;
        continue;
      }
    }
  }

  return { kind: "ok", world: w, frame: f };
}

// ---------------------------------------------------------------------------
// individual operations
// ---------------------------------------------------------------------------

function applyOp(
  env: StepEnv,
  world: WorldState,
  frame: Frame,
  op: Operation,
  events: KernelEvent[],
  diffs: StateDiff[],
  reads: Set<string>,
  writes: Set<string>
): OpResult {
  const ok = (w: WorldState, f: Frame): OpResult => ({ kind: "ok", world: w, frame: f });
  const abort = (reason: string): OpResult => ({ kind: "abort", world, frame, reason });
  const ctx = ctxOf(env, world, frame);

  switch (op.op) {
    case "assign": {
      for (const c of collectionsOf(op.value)) reads.add(c);
      const v = evaluate(op.value, ctx);
      return ok(world, bindLocal(frame, op.name, v));
    }

    case "read": {
      for (const c of collectionsOf(op.value)) reads.add(c);
      const v = evaluate(op.value, ctx);
      return ok(world, bindLocal(frame, op.into, v));
    }

    case "write": {
      const fenced = checkFence(env, world, frame, events);
      if (fenced) return abort(fenced);
      writes.add(op.collection);
      const applied = applyMutation(env, world, frame, op.collection, op.key, op.mode, op.value, op.fields, diffs, events);
      if (!applied) return abort(`table "${op.collection}" is full`);
      return ok(applied, frame);
    }

    case "conditionalWrite": {
      const fenced = checkFence(env, world, frame, events);
      if (fenced) return abort(fenced);
      for (const c of collectionsOf(op.guard)) reads.add(c);
      const held = truthy(evaluate(op.guard, ctx));
      let f = frame;
      if (op.into) f = bindLocal(f, op.into, held);
      if (!held) {
        events.push({ kind: "guard-failed", collection: op.collection });
        if (op.onFail === "fail") return abort(`guard on "${op.collection}" did not hold`);
        return ok(world, f);
      }
      writes.add(op.collection);
      const applied = applyMutation(env, world, f, op.collection, op.key, op.mode, op.value, op.fields, diffs, events);
      if (!applied) return abort(`table "${op.collection}" is full`);
      return ok(applied, f);
    }

    case "insertUnique": {
      const fenced = checkFence(env, world, frame, events);
      if (fenced) return abort(fenced);
      const c = collectionById(env.cw.wf, op.collection);
      if (!c || c.kind !== "table") return abort(`"${op.collection}" is not a table`);
      reads.add(op.collection);
      writes.add(op.collection);
      const keyValue = evaluate(op.key, ctx);
      if (keyValue === null) return abort(`insert into "${op.collection}" with an absent key`);
      const key = String(keyValue);
      const table = world.tables[op.collection] ?? {};

      if (table[key] !== undefined) {
        events.push({ kind: "unique-conflict", collection: op.collection, key });
        let f = frame;
        if (op.into) f = bindLocal(f, op.into, false);
        if (op.onConflict === "fail") {
          return abort(`"${key}" already exists in "${op.collection}"`);
        }
        return ok(world, f);
      }

      if (Object.keys(table).length >= MAX_ROWS) {
        events.push({ kind: "table-full", collection: op.collection });
        return abort(`table "${op.collection}" is full`);
      }

      const row: Row = { [c.key]: keyValue };
      for (const [name, expr] of Object.entries(op.fields)) {
        const v = evaluate(expr, ctx);
        if (v !== null) row[name] = v;
      }
      const complete = completeRow(c, row);
      diffs.push({ collection: op.collection, key, field: null, before: null, after: keyValue });
      let f = frame;
      if (op.into) f = bindLocal(f, op.into, true);
      return ok(withRow(world, op.collection, key, complete), f);
    }

    case "acquireLease": {
      const settings = env.locks[op.lock] ?? { defaultTtlMs: op.ttlMs, fencingTokens: op.fencing };
      const keyValue = evaluate(op.key, ctx);
      if (keyValue === null) return abort("lease key is absent");
      const lk = leaseKey(op.lock, keyValue);
      const existing = world.leases[lk];

      if (existing) {
        events.push({ kind: "lease-contended", lock: op.lock, key: String(keyValue) });
        const f = bindLocal(frame, op.into, op.fencing ? null : false);
        if (op.onBusy === "fail") {
          return abort(`lease "${String(keyValue)}" is held by ${existing.owner}`);
        }
        // `continue` is the advisory-lock reading: we asked, we were told no, and we
        // proceed anyway. That is a real deployment pattern and a real bug, and the
        // explorer's job is to find out which.
        return ok(world, f);
      }

      const token = (world.leaseGeneration[lk] ?? 0) + 1;
      const lease: LeaseState = {
        owner: frame.id,
        token,
        grantedAt: world.nowMs,
        expiresAt: world.nowMs + (op.ttlMs || settings.defaultTtlMs),
      };
      const w: WorldState = {
        ...withLease(world, lk, lease),
        leaseGeneration: { ...world.leaseGeneration, [lk]: token },
      };
      events.push({ kind: "lease-acquired", lock: op.lock, key: String(keyValue), token });
      let f = bindLocal(frame, op.into, op.fencing ? token : true);
      f = {
        ...f,
        // Only a FENCED acquire records a token. An unfenced holder has nothing to
        // present to the datastore and therefore nothing that could be checked, which
        // is exactly the property that makes unfenced leases unsafe. Recording a token
        // anyway "just in case" would silently make every design safe.
        tokens: op.fencing ? { ...f.tokens, [lk]: token } : f.tokens,
        leaseHeldAt: { ...f.leaseHeldAt, [lk]: world.nowMs },
      };
      return ok(w, f);
    }

    case "releaseLease": {
      const keyValue = evaluate(op.key, ctx);
      if (keyValue === null) return abort("lease key is absent");
      const lk = leaseKey(op.lock, keyValue);
      const existing = world.leases[lk];
      const tokens = { ...frame.tokens };
      const heldAt = { ...frame.leaseHeldAt };
      const grantedAt = heldAt[lk];
      delete tokens[lk];
      delete heldAt[lk];
      const f: Frame = { ...frame, tokens, leaseHeldAt: heldAt };

      // Releasing a lease somebody else now holds is a no-op, not an error, and NOT
      // silently permitted either -- it is counted. A worker whose lease expired and
      // was reassigned will try to release it, and if release deleted the row the new
      // holder's mutual exclusion would evaporate at that instant. This is the second
      // half of the stale-owner hazard and it is easy to get wrong.
      if (!existing || existing.owner !== frame.id) {
        if (existing) {
          events.push({
            kind: "stale-owner-rejected",
            lock: op.lock,
            key: String(keyValue),
            token: frame.tokens[lk] ?? 0,
            current: existing.token,
          });
        }
        return ok(world, f);
      }

      events.push({
        kind: "lease-released",
        lock: op.lock,
        key: String(keyValue),
        heldMs: grantedAt === undefined ? 0 : world.nowMs - grantedAt,
      });
      return ok(withLease(world, lk, null), f);
    }

    case "publish": {
      const settings = env.queues[op.queue];
      const body: Row = {};
      for (const [name, expr] of Object.entries(op.message)) {
        const v = evaluate(expr, ctx);
        if (v !== null) body[name] = v;
      }
      let depth = 0;
      for (const m of world.messages) {
        if (m.queue === op.queue && !m.acked && !m.abandoned) depth++;
      }
      if (settings?.maxDepth !== null && settings?.maxDepth !== undefined && depth >= settings.maxDepth) {
        // A full queue drops. Modelled as a successful publish that produced no
        // message, because that is what a fire-and-forget publisher observes, and the
        // resulting lost work is exactly the failure a reader should see in the trace.
        return ok(world, frame);
      }
      const id = world.nextId;
      const message: QueuedMessage = {
        id,
        queue: op.queue,
        body,
        deliveries: 0,
        inflightOwner: null,
        acked: false,
        abandoned: false,
        enqueuedAt: world.nowMs,
      };
      events.push({ kind: "published", queue: op.queue, messageId: id });
      return ok({ ...withMessages(world, [...world.messages, message]), nextId: id + 1 }, frame);
    }

    case "ack": {
      if (frame.messageId === null) return ok(world, frame);
      const messages = world.messages.map((m) =>
        m.id === frame.messageId ? { ...m, acked: true, inflightOwner: null } : m
      );
      events.push({ kind: "acked", messageId: frame.messageId });
      // Pruned immediately. An acknowledged message can never be delivered, redelivered, read
      // or acked again, so retaining it splits states that are identical in the explorer and
      // makes publish quadratic in the simulator. See `pruneFinished`.
      return ok(pruneFinished(withMessages(world, messages)), frame);
    }

    case "scheduleExpiry": {
      const args: Row = {};
      for (const [name, expr] of Object.entries(op.args)) {
        const v = evaluate(expr, ctx);
        if (v !== null) args[name] = v;
      }
      const id = world.nextId;
      const timer: Timer = {
        id,
        handler: op.handler,
        args,
        dueAt: world.nowMs + op.afterMs,
        fired: false,
        armedBy: frame.id,
      };
      events.push({ kind: "timer-armed", timerId: id, handler: op.handler, afterMs: op.afterMs });
      return ok({ ...withTimers(world, [...world.timers, timer]), nextId: id + 1 }, frame);
    }

    case "respond": {
      const w = op.outcome ? withOutcome(world, op.outcome) : world;
      events.push({ kind: "responded", status: op.status, outcome: op.outcome });
      return {
        kind: "terminate",
        world: w,
        frame: {
          ...frame,
          status: "done",
          responseStatus: op.status,
          responseOutcome: op.outcome,
        },
      };
    }

    case "atomic":
    case "branch":
      // Handled by the compiler as control flow; never reached as a leaf.
      return ok(world, frame);
  }
}

/** Row ceiling, mirroring the schema's declared limit. */
const MAX_ROWS = 4096;

/**
 * Apply a counter or row mutation, recording a before/after diff.
 *
 * Returns null when the mutation cannot be applied because the table is at its row
 * ceiling. Carrying both `before` and `after` into the diff is what makes a lost-update
 * counterexample readable: the whole content of the bug is that `before` was not what
 * the writer believed it was when it read the value two transitions ago.
 */
function applyMutation(
  env: StepEnv,
  world: WorldState,
  frame: Frame,
  collection: string,
  keyExpr: Expr | null,
  mode: "set" | "delta",
  valueExpr: Expr | null,
  fields: Record<string, Expr>,
  diffs: StateDiff[],
  events: KernelEvent[]
): WorldState | null {
  const c = collectionById(env.cw.wf, collection);
  if (!c) return world;
  const ctx = ctxOf(env, world, frame);

  if (c.kind === "counter") {
    const before = world.counters[collection] ?? 0;
    const raw = valueExpr ? evaluate(valueExpr, ctx) : null;
    if (typeof raw !== "number") return world;
    const after = mode === "delta" ? before + raw : raw;
    diffs.push({ collection, key: null, field: null, before, after });
    return withCounter(world, collection, after);
  }

  const keyValue = keyExpr ? evaluate(keyExpr, ctx) : null;
  if (keyValue === null) return world;
  const key = String(keyValue);
  const table = world.tables[collection] ?? {};
  const existing = table[key];

  if (!existing && Object.keys(table).length >= MAX_ROWS) {
    events.push({ kind: "table-full", collection });
    return null;
  }

  const next: Row = existing ? { ...existing } : completeRow(c, { [c.key]: keyValue });
  if (!existing) {
    diffs.push({ collection, key, field: null, before: null, after: keyValue });
  }
  for (const [name, expr] of Object.entries(fields)) {
    const v = evaluate(expr, ctx);
    if (v === null) continue;
    const before = existing?.[name];
    if (mode === "delta" && typeof before === "number" && typeof v === "number") {
      next[name] = before + v;
    } else {
      next[name] = v;
    }
    diffs.push({
      collection,
      key,
      field: name,
      before: before === undefined ? null : before,
      after: next[name]!,
    });
  }
  return withRow(world, collection, key, next);
}

/**
 * Refuse a mutation from a writer whose lease has been superseded.
 *
 * THIS IS THE ENTIRE MECHANISM BY WHICH FENCING WORKS, AND IT IS FOUR LINES.
 *
 * A frame holds a token only if it acquired its lease with `fencing: true`. The
 * datastore compares that token against the highest generation ever issued for the key.
 * If somebody else has since been granted the lease, the generation has moved on, the
 * token is stale, and the write is rejected -- even though the holder still believes it
 * holds the lease, and even though the lease row itself may look perfectly healthy.
 *
 * An UNFENCED holder has no token, so this check finds nothing to compare and the write
 * proceeds. That is not an oversight in the model; it is the accurate description of
 * what an unfenced lock provides, and it is why candidate 3 in the shipped portfolio
 * corrupts state and candidate 5 does not.
 */
function checkFence(
  env: StepEnv,
  world: WorldState,
  frame: Frame,
  events: KernelEvent[]
): string | null {
  for (const [lk, token] of Object.entries(frame.tokens)) {
    const current = world.leaseGeneration[lk] ?? 0;
    if (current > token) {
      const sep = lk.indexOf("\u0000");
      events.push({
        kind: "stale-owner-rejected",
        lock: lk.slice(0, sep),
        key: lk.slice(sep + 1),
        token,
        current,
      });
      return `fencing token ${token} is stale; the lease is now at generation ${current}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// scheduler-driven transitions
// ---------------------------------------------------------------------------

/**
 * Force a lease to expire.
 *
 * A SCHEDULER DECISION, NOT A CLOCK COMPARISON.
 *
 * The simulator fires this when the deadline passes; the explorer fires it whenever it
 * chooses, subject to the fault budget. The second is strictly more thorough, and it is
 * the reason the explorer finds the stale-owner bug reliably while a simulation finds it
 * only if the timing happens to line up.
 *
 * The lease row is removed and the generation is LEFT ALONE. The next acquire will
 * increment it, which is what makes the previous holder's token stale. Resetting the
 * generation here would destroy fencing entirely, and it would look like a tidy-up.
 */
export function expireLease(
  world: WorldState,
  lk: string
): { world: WorldState; lease: LeaseState | null } {
  const lease = world.leases[lk];
  if (!lease) return { world, lease: null };
  return { world: withLease(world, lk, null), lease };
}

/**
 * Hand a message to a consumer.
 *
 * `inflightOwner` is set, and NOT cleared until an ack. That is the visibility timeout,
 * and the reason redelivery is possible at all: a message that has been taken but not
 * acknowledged is still, from the broker's point of view, outstanding.
 */
export function deliverMessage(
  world: WorldState,
  messageId: number,
  ownerId: string
): WorldState {
  return withMessages(
    world,
    world.messages.map((m) =>
      m.id === messageId
        ? { ...m, deliveries: m.deliveries + 1, inflightOwner: ownerId }
        : m
    )
  );
}

/**
 * Make an unacknowledged message available again, or abandon it.
 *
 * Abandonment is bounded and reported rather than infinite, because an unbounded
 * redelivery loop over a message that can never succeed is a poison pill, and a model
 * that never ends it would report every such design as merely "inconclusive".
 */
export function redeliverMessage(
  world: WorldState,
  messageId: number,
  maxRedeliveries: number
): { world: WorldState; abandoned: boolean } {
  let abandoned = false;
  const messages = world.messages.map((m) => {
    if (m.id !== messageId) return m;
    if (m.deliveries > maxRedeliveries) {
      abandoned = true;
      return { ...m, inflightOwner: null, abandoned: true };
    }
    return { ...m, inflightOwner: null };
  });
  return { world: pruneFinished(withMessages(world, messages)), abandoned };
}

/**
 * Mark a timer as fired and drop it.
 *
 * The Timer object is still returned to the caller (which needs its handler and args to build
 * the frame) BEFORE this is called, so pruning here loses nothing. A timer that has fired cannot
 * fire again, and a workflow cannot re-arm the same timer -- validation refuses a handler that
 * schedules itself, precisely so that this is bounded.
 */
export function markTimerFired(world: WorldState, timerId: number): WorldState {
  return pruneFinished(
    withTimers(
      world,
      world.timers.map((t) => (t.id === timerId ? { ...t, fired: true } : t))
    )
  );
}

/**
 * Kill a frame where it stands.
 *
 * Everything it wrote stays written. Its leases stay held until they expire. Its
 * message stays unacknowledged. THAT IS THE POINT: a crash that rolled back would be a
 * transaction, and transactions are not the failure being modelled.
 */
export function crashFrame(frame: Frame): Frame {
  return { ...frame, status: "crashed" };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ctxOf(env: StepEnv, world: WorldState, frame: Frame): EvalContext {
  return { wf: env.cw.wf, world, locals: frame.locals, request: frame.request, row: null };
}

function bindLocal(frame: Frame, name: string, v: Value): Frame {
  if (v === null) {
    // Absent unbinds rather than storing a null. Two frames, one that never read a
    // value and one that read an absent value, are in the same epistemic position, and
    // giving them distinct state keys would double the search for no behaviour.
    if (frame.locals[name] === undefined) return frame;
    const locals = { ...frame.locals };
    delete locals[name];
    return { ...frame, locals };
  }
  return { ...frame, locals: { ...frame.locals, [name]: v } };
}

function abortFrame(frame: Frame, reason: string | undefined): Frame {
  return {
    ...frame,
    status: "done",
    // A refused operation is a REJECTION, not an error. "Sold out" is the system
    // working. Reporting it as an error would put a correct design's rejections into
    // the error-rate SLO and fail it for behaving properly.
    responseStatus: frame.responseStatus ?? "rejected",
    responseOutcome: frame.responseOutcome,
    locals: reason === undefined ? frame.locals : frame.locals,
  };
}

function terminalResult(world: WorldState, frame: Frame): StepResult {
  return {
    world,
    frame,
    events: [],
    diffs: [],
    opId: null,
    opKind: null,
    label: "finished",
    charge: null,
    observed: {},
    terminal: true,
    reads: [],
    writes: [],
  };
}

function newLocals(
  before: Record<string, Literal>,
  after: Record<string, Literal>
): Record<string, Literal> {
  const out: Record<string, Literal> = {};
  for (const [k, v] of Object.entries(after)) {
    if (before[k] !== v) out[k] = v;
  }
  return out;
}

function chargeOf(env: StepEnv, op: Operation): OpCharge | null {
  switch (op.op) {
    case "write":
    case "conditionalWrite":
    case "insertUnique": {
      const c = collectionById(env.cw.wf, op.collection);
      return c ? { nodeId: c.node, role: "datastore" } : null;
    }
    case "read": {
      for (const id of collectionsOf(op.value)) {
        const c = collectionById(env.cw.wf, id);
        if (c) return { nodeId: c.node, role: "datastore" };
      }
      return null;
    }
    case "acquireLease":
    case "releaseLease":
      return { nodeId: op.lock, role: "lock" };
    case "publish":
      return { nodeId: op.queue, role: "queue" };
    case "atomic": {
      for (const inner of op.body) {
        const c = chargeOf(env, inner);
        if (c) return c;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Collections an expression reads. Cached per expression object. */
const collectionCache = new WeakMap<object, string[]>();

function collectionsOf(expr: Expr): string[] {
  const cached = collectionCache.get(expr as object);
  if (cached) return cached;
  const out: string[] = [];
  const seen = new Set<string>();
  const rec = (e: Expr): void => {
    switch (e.kind) {
      case "counter":
      case "exists":
      case "count":
      case "distinct":
      case "sum":
      case "row":
        if (!seen.has(e.collection)) {
          seen.add(e.collection);
          out.push(e.collection);
        }
        break;
      default:
        break;
    }
    switch (e.kind) {
      case "row":
      case "exists":
        rec(e.key);
        break;
      case "count":
      case "distinct":
      case "sum":
        if (e.where) rec(e.where);
        break;
      case "arith":
      case "compare":
        rec(e.left);
        rec(e.right);
        break;
      case "and":
      case "or":
        for (const a of e.args) rec(a);
        break;
      case "not":
      case "isNull":
        rec(e.arg);
        break;
      default:
        break;
    }
  };
  rec(expr);
  collectionCache.set(expr as object, out);
  return out;
}

/**
 * Plain-language description of an operation, for counterexample traces.
 *
 * GENERATED FROM THE STRUCTURE, NOT WRITTEN BY A MODEL.
 *
 * A counterexample is evidence, and evidence whose narration came from a language model
 * is evidence about the language model. Every sentence a reader sees in a trace is
 * assembled here from the operation's own fields, so it cannot say anything the
 * workflow does not.
 */
export function describeOp(op: Operation): string {
  switch (op.op) {
    case "read":
      return `read into "${op.into}"`;
    case "write":
      return op.mode === "delta"
        ? `add to "${op.collection}"`
        : `set "${op.collection}"`;
    case "conditionalWrite":
      return `conditional write to "${op.collection}" (indivisible check-and-set)`;
    case "insertUnique":
      return `insert unique row into "${op.collection}"`;
    case "atomic":
      return `transaction over ${op.body.length} operations`;
    case "acquireLease":
      return op.fencing ? `acquire fenced lease on "${op.lock}"` : `acquire lease on "${op.lock}"`;
    case "releaseLease":
      return `release lease on "${op.lock}"`;
    case "publish":
      return `publish to "${op.queue}"`;
    case "ack":
      return "acknowledge the message";
    case "branch":
      return "branch";
    case "assign":
      return `compute "${op.name}"`;
    case "scheduleExpiry":
      return `arm "${op.handler}" to fire in ${op.afterMs}ms`;
    case "respond":
      return op.outcome
        ? `respond ${op.status} (${op.outcome})`
        : `respond ${op.status}`;
  }
}

export type { Instr };
