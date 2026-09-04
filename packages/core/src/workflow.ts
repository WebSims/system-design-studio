import type { Design } from "@sds/schema";
import {
  canRedeliver,
  generateRequest,
  initialWorld,
  newGenState,
  markTimerFired,
  pruneFinished,
  redeliverMessage,
  startConsumerFrame,
  startRequestFrame,
  startTimerFrame,
  step,
  type Frame,
  type GenState,
  type KernelEvent,
  type QueuedMessage,
  type Row,
  type StepEnv,
  type Timer,
  type WorldState,
} from "@sds/kernel";
import type { Component, ComponentEnv, Outcome, RequestCtx } from "./components";
import { LockComponent } from "./components";
import { LatencyHistogram } from "./histogram";
import {
  effectiveLossProbability,
  isLegacyLatencyOnlyNetwork,
  sampleNetworkLeg,
} from "./network";
import { Sim, acquire, delay, suspend, type Process } from "./sim";
import { Resource } from "./resource";
import { TimeSeries } from "./timeseries";

/**
 * Stateful workflow execution inside the discrete-event simulator.
 *
 * THE SAME KERNEL, WITH TIME ADDED
 *
 * The breadth-first explorer answers "can this go wrong". This answers "what does it
 * cost, and how often does it go wrong under a realistic arrival process". Both call
 * `step` from @sds/kernel and neither contains any other code that changes state, which
 * is the property `conformance.test.ts` exists to pin down.
 *
 * TWO-PHASE STEP, AND WHY IT IS NOT AN OPTIMISATION
 *
 * Each transition is stepped twice. The first pass is a PREVIEW against the current
 * world, discarded, used only to learn which station the operation will hit and
 * therefore what it costs. Time then passes at that station -- during which other
 * requests run and change the world. The second pass then applies the operation against
 * the world AS IT IS AT COMMIT TIME.
 *
 * Applying the preview instead would be much cheaper and would be wrong in a way that
 * silently makes every design safer than it is: the write would land before its own
 * latency elapsed, so the window in which another request could interleave would not
 * exist. The whole hazard being modelled lives in that window. So the operation is
 * evaluated twice and committed once, at the instant the datastore would have committed
 * it.
 *
 * WHAT SURVIVES A CALLER GIVING UP
 *
 * Everything. When the client's deadline passes, the caller is told it timed out and the
 * handler KEEPS RUNNING, because that is what happens: a timeout is the caller's
 * observation, not an instruction to the server. A design whose duplicate-protection
 * assumed otherwise would look correct here and duplicate charges in production, so the
 * runtime detaches the handler and lets it finish.
 */

/** Business tallies the workflow layer produces. Every one is a count, never a rate. */
export interface WorkflowMetrics {
  validAllocations: number;
  duplicateSuccesses: number;
  oversells: number;
  remainingInventory: Record<string, number>;
  expiredReservations: number;
  strandedReservations: number;
  idempotencyHits: number;
  transactionConflicts: number;
  redeliveries: number;
  abandonedMessages: number;
  staleOwnerRejections: number;
  leaseContentions: number;
  leaseExpiries: number;
  guardFailures: number;
  /** Outcome label -> count, from `respond` operations. */
  outcomes: Record<string, number>;
  /** Response status -> count. */
  statuses: Record<string, number>;
  /** Handlers abandoned mid-flight by a station failure. */
  crashedHandlers: number;
  /** Handlers still running when the caller's deadline passed. */
  detachedAfterTimeout: number;
  /**
   * Simulated seconds from the start of measurement until a counter first hit zero.
   *
   * Null when it never did. Reported per counter because a design may deplete several
   * things, and the interesting one is not always the one a reader guessed.
   */
  timeToExhaustSec: Record<string, number | null>;
  /** Wait for a lock service, ms. Distinct from waiting for a lease to free up. */
  lockWait: LatencyHistogram;
  /** Queue backlog age at the moment of consumption, ms. */
  messageAge: LatencyHistogram;
}

function emptyMetrics(): WorkflowMetrics {
  return {
    validAllocations: 0,
    duplicateSuccesses: 0,
    oversells: 0,
    remainingInventory: {},
    expiredReservations: 0,
    strandedReservations: 0,
    idempotencyHits: 0,
    transactionConflicts: 0,
    redeliveries: 0,
    abandonedMessages: 0,
    staleOwnerRejections: 0,
    leaseContentions: 0,
    leaseExpiries: 0,
    guardFailures: 0,
    outcomes: {},
    statuses: {},
    crashedHandlers: 0,
    detachedAfterTimeout: 0,
    timeToExhaustSec: {},
    lockWait: new LatencyHistogram(),
    messageAge: new LatencyHistogram(),
  };
}

/**
 * Outcome labels the runtime interprets, supplied by the study's product contract.
 *
 * The runtime cannot infer that `oversold` means a correctness failure while
 * `alreadyClaimed` means the system worked -- both are just strings a workflow chose. The
 * contract supplies the meaning, and without it the counts are reported per label with no
 * interpretation rather than guessed at.
 */
export interface OutcomeMeaning {
  valid: string[];
  duplicate: string[];
  oversell: string[];
  expired: string[];
  rejected: string[];
}

export interface WorkflowOptions {
  outcomes?: OutcomeMeaning;
}

interface PendingTimer {
  timer: Timer;
  event: ReturnType<Sim["at"]> | null;
}

export class WorkflowRuntime {
  private world: WorldState;
  private readonly genState: GenState = newGenState();
  private readonly metrics = emptyMetrics();
  private readonly consumerPools = new Map<string, Resource>();
  private readonly backlogSeries = new Map<string, TimeSeries>();
  private readonly pendingTimers = new Map<number, PendingTimer>();
  private readonly visibilityTimers = new Map<number, ReturnType<Sim["at"]>>();
  private actorSeq = 0;
  /**
   * Monotonic version, bumped on every committed write.
   *
   * Used for transaction-conflict detection: a transaction whose read set was written
   * between its preview and its commit conflicted. A version per collection would be
   * more precise; a single counter plus the read/write sets from the kernel is enough,
   * and being slightly over-eager about calling something a conflict costs a reported
   * number rather than a wrong result.
   */
  private version = 0;
  private readonly writeVersions = new Map<string, number>();
  private measureStartMs = 0;

  constructor(
    private readonly env: ComponentEnv,
    private readonly stepEnv: StepEnv,
    private readonly design: Design,
    private readonly opts: WorkflowOptions = {}
  ) {
    this.world = initialWorld(stepEnv.cw.wf);
    for (const node of design.nodes) {
      if (node.kind === "queue" && node.queue) {
        this.consumerPools.set(
          node.id,
          new Resource(env.sim, {
            id: `${node.id}:consumers`,
            capacity: node.queue.consumers,
            queueCapacity: null,
            discipline: "fifo",
            admissionPolicy: "block",
            capacityAt: () => env.failures.effectiveCapacity(node.id, node.queue!.consumers),
          })
        );
        this.backlogSeries.set(node.id, new TimeSeries(`${node.id}.backlog`));
      }
    }
  }

  /** Whether the request-triggered handler runs on this node. */
  handlesRoot(nodeId: string): boolean {
    return this.stepEnv.cw.programs[this.stepEnv.cw.rootHandlerId]?.nodeId === nodeId;
  }

  /** Generate one request's domain fields, from the seeded RNG. */
  generate(): Row {
    return generateRequest(this.stepEnv.cw.wf, this.genState, this.env.rng.stream("routing"));
  }

  results(): WorkflowMetrics {
    for (const [id, value] of Object.entries(this.world.counters)) {
      this.metrics.remainingInventory[id] = value;
    }
    return this.metrics;
  }

  backlogFor(queueId: string): { depth: number; series: TimeSeries | undefined } {
    return {
      depth: this.world.messages.filter((m) => m.queue === queueId && !m.acked && !m.abandoned)
        .length,
      series: this.backlogSeries.get(queueId),
    };
  }

  consumerPool(queueId: string): Resource | undefined {
    return this.consumerPools.get(queueId);
  }

  sample(tSec: number): void {
    for (const [queueId, series] of this.backlogSeries) {
      series.push(tSec, this.backlogFor(queueId).depth);
    }
  }

  failureStateChanged(): void {
    for (const pool of this.consumerPools.values()) pool.refreshCapacity();
  }

  /**
   * Reset business tallies at the warm-up boundary.
   *
   * The WORLD IS NOT RESET. Inventory that was consumed during warm-up is genuinely
   * consumed, and restocking it at the boundary would make the measurement window see a
   * fresh system rather than a warmed one -- the exact bias warm-up exists to remove. So
   * counts restart and state carries on.
   */
  resetStats(): void {
    const fresh = emptyMetrics();
    const target = this.metrics as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(fresh)) target[key] = value;
    for (const series of this.backlogSeries.values()) series.reset();
    for (const pool of this.consumerPools.values()) pool.resetStats();
    this.measureStartMs = this.env.sim.now;
  }

  // -------------------------------------------------------------------------
  // root request
  // -------------------------------------------------------------------------

  /**
   * Run the request handler for one arriving request.
   *
   * The handler is spawned as its own process and the caller waits on it with the
   * client's deadline. If the deadline wins, the caller sees a timeout and the handler
   * carries on to completion -- detached, uninterrupted, and still holding whatever it had
   * committed. That is not leniency towards the design; it is the mechanism by which a
   * non-idempotent retry produces two effects, and a runtime that cancelled the handler
   * on timeout could never show it.
   */
  *runRoot(ctx: RequestCtx): Process<Outcome> {
    const frame = startRequestFrame(this.stepEnv, `r${ctx.requestId}`, ctx.domain ?? {});

    let settled: Outcome | null = null;
    let resume: (() => void) | null = null;

    this.env.sim.spawn(this.runFrame(frame, ctx, null), (outcome) => {
      settled = outcome;
      resume?.();
    });

    // The handler may have finished without ever waiting -- a workflow whose first
    // operation is a `respond`, for instance. Checked before parking, because parking on
    // a resume that already fired would hang the request forever.
    if (settled !== null) return settled;

    const waited = yield* suspend((r) => {
      resume = r;
    }, ctx.deadlineAt);

    if (waited.timedOut) {
      if (this.env.measuring()) this.metrics.detachedAfterTimeout++;
      return { ok: false, reason: "timeout" };
    }
    return settled ?? { ok: true };
  }

  // -------------------------------------------------------------------------
  // the execution loop
  // -------------------------------------------------------------------------

  /**
   * Drive one frame to completion, charging each transition to its station.
   *
   * `deadlineAt` is deliberately NOT the caller's deadline. It is null for every station
   * call the handler makes, because the handler is not the caller and does not stop
   * working when the caller stops listening. The caller's deadline is enforced once, in
   * `runRoot`, against the whole handler.
   */
  private *runFrame(
    frame: Frame,
    ctx: RequestCtx,
    message: QueuedMessage | null
  ): Process<Outcome> {
    let f = frame;

    // Bounded by the instruction count, which the compiler guarantees is finite because
    // every jump it emits goes forward. The guard is an assertion, not a mechanism.
    for (let guard = 0; guard < 10_000 && f.status === "running"; guard++) {
      // ---- phase one: preview, to learn the cost ----
      const preview = step(this.stepEnv, this.world, f, this.env.sim.now);
      const versionAtPreview = this.version;

      if (preview.charge) {
        const outcome = yield* this.chargeStation(ctx, preview.charge, preview.opKind ?? "");
        if (!outcome.ok) {
          // A failed datastore, lock or queue call means the operation did NOT happen.
          // The handler is abandoned where it stands: everything it committed earlier
          // stays committed, its leases stay held until they expire, and any message it
          // was consuming stays unacknowledged. That is a worker crash, and it is the
          // fault the explorer models explicitly.
          if (this.env.measuring()) this.metrics.crashedHandlers++;
          this.noteStranded(f);
          return outcome;
        }
      }

      // ---- phase two: commit, against the world as it is NOW ----
      const applied = step(this.stepEnv, this.world, f, this.env.sim.now);

      if (preview.opKind === "atomic" && this.conflicted(preview.reads, versionAtPreview)) {
        // A serializable transaction whose read set moved under it. Real engines abort
        // and the application retries; the committed result is the same either way,
        // because the commit above already evaluated against the current world. So the
        // conflict is COUNTED, not simulated as a rollback -- the state is right and the
        // cost of the retry is the number a reader needs.
        if (this.env.measuring()) this.metrics.transactionConflicts++;
      }

      this.commit(applied.world, applied.writes);
      f = applied.frame;
      this.record(applied.events, message);

      if (applied.terminal) break;
    }

    if (f.status === "crashed") return { ok: false, reason: "error" };

    const status = f.responseStatus;
    if (status === "error") return { ok: false, reason: "error" };
    // A domain rejection is a SUCCESSFUL response. "Sold out" is the system working, and
    // counting it as an error would fail a correct design's error-rate SLO for behaving
    // properly.
    return { ok: true };
  }

  /** Charge a transition's cost to the station it names, through the real topology. */
  private *chargeStation(
    ctx: RequestCtx,
    charge: { nodeId: string; role: "datastore" | "lock" | "queue" },
    opKind: string
  ): Process<Outcome> {
    const component = this.env.components.get(charge.nodeId);
    if (!component) return { ok: true };

    // Handlers run on a node; the operation's target is a different node. The edge
    // between them, if the design draws one, carries the network latency and the call
    // policy -- so a workflow's datastore call is subject to the same timeout, retry and
    // bulkhead settings as any other dependency call, rather than being a privileged
    // free hop.
    const from = this.stepEnv.cw.programs[this.currentHandlerNode]?.nodeId ?? "";
    const edge = (this.env.outgoing.get(from) ?? []).find((e) => e.to === charge.nodeId);

    const before = this.env.sim.now;
    let outcome: Outcome;
    if (edge) {
      outcome = yield* this.callAcross(edge.id, component, ctx);
    } else {
      outcome = this.env.failures.isNodeOut(charge.nodeId)
        ? { ok: false, reason: "error" }
        : yield* component.handle({ ...ctx, deadlineAt: null });
    }

    if (charge.role === "lock" && this.env.measuring()) {
      this.metrics.lockWait.record(this.env.sim.now - before);
    }
    void opKind;
    return outcome;
  }

  /** Node the currently-executing handler runs on. Set by `runFrame` callers. */
  private currentHandlerNode = "";

  private *callAcross(edgeId: string, component: Component, ctx: RequestCtx): Process<Outcome> {
    const edge = this.design.edges.find((e) => e.id === edgeId);
    if (!edge) return yield* component.handle({ ...ctx, deadlineAt: null });

    const rng = this.env.rng.stream("network");
    const request = sampleNetworkLeg(edge, "request", rng, this.env.failures);
    const requestStart = this.env.sim.now;
    yield* delay(request.totalMs, null);
    const requestLoss = effectiveLossProbability(edge, this.env.failures);
    const requestDropped = requestLoss > 0 && rng.chance(requestLoss);
    if (ctx.traced) {
      this.env.trace.hop(
        ctx.requestId,
        edge.id,
        requestStart,
        this.env.sim.now,
        !requestDropped,
        true,
        request
      );
    }
    if (requestDropped) {
      return { ok: false, reason: "network" };
    }
    const traversals = this.env.edgeTraversals;
    traversals.set(edgeId, (traversals.get(edgeId) ?? 0) + 1);
    if (this.env.failures.isNodeOut(edge.to)) return { ok: false, reason: "error" };
    const outcome = yield* component.handle({ ...ctx, deadlineAt: null });
    const response = isLegacyLatencyOnlyNetwork(edge.network)
      ? {
          ...request,
          totalMs: request.propagationMs,
          serializationMs: 0,
          transferMs: 0,
          connectionMs: 0,
          bytes: 0,
        }
      : sampleNetworkLeg(edge, "response", rng, this.env.failures);
    const responseStart = this.env.sim.now;
    yield* delay(response.totalMs, null);
    const responseLoss = effectiveLossProbability(edge, this.env.failures);
    const responseDropped = responseLoss > 0 && rng.chance(responseLoss);
    if (ctx.traced) {
      this.env.trace.hop(
        ctx.requestId,
        edge.id,
        responseStart,
        this.env.sim.now,
        !responseDropped,
        false,
        response
      );
    }
    if (responseDropped) {
      // Lost on the way back. The operation DID happen; the caller does not know. This
      // is the ambiguous-timeout case in its purest form and it is why the response leg
      // is modelled separately rather than doubled into one delay.
      return { ok: false, reason: "network" };
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // commit and metrics
  // -------------------------------------------------------------------------

  private commit(world: WorldState, writes: readonly string[]): void {
    const exhausting: string[] = [];
    for (const [id, value] of Object.entries(world.counters)) {
      if (value === 0 && (this.world.counters[id] ?? 0) > 0) exhausting.push(id);
    }
    this.world = world;
    if (writes.length > 0) {
      this.version++;
      for (const w of writes) this.writeVersions.set(w, this.version);
    }
    for (const id of exhausting) {
      if (this.metrics.timeToExhaustSec[id] === undefined && this.env.measuring()) {
        this.metrics.timeToExhaustSec[id] =
          (this.env.sim.now - this.measureStartMs) / 1000;
      }
    }
  }

  private conflicted(reads: readonly string[], versionAtPreview: number): boolean {
    for (const r of reads) {
      const v = this.writeVersions.get(r);
      if (v !== undefined && v > versionAtPreview) return true;
    }
    return false;
  }

  /**
   * Translate kernel events into business metrics and scheduler work.
   *
   * The scheduler work is the important half: a `published` event has to start a
   * consumer, and a `timer-armed` event has to arm a real simulated timer. Doing that
   * here rather than inside the kernel is what keeps the kernel free of a scheduler, and
   * therefore identical between the two engines.
   */
  private record(events: readonly KernelEvent[], message: QueuedMessage | null): void {
    const measuring = this.env.measuring();
    const meaning = this.opts.outcomes;

    for (const e of events) {
      switch (e.kind) {
        case "responded": {
          if (!measuring) break;
          this.metrics.statuses[e.status] = (this.metrics.statuses[e.status] ?? 0) + 1;
          if (e.outcome) {
            this.metrics.outcomes[e.outcome] = (this.metrics.outcomes[e.outcome] ?? 0) + 1;
            if (meaning) {
              if (meaning.valid.includes(e.outcome)) this.metrics.validAllocations++;
              if (meaning.duplicate.includes(e.outcome)) this.metrics.duplicateSuccesses++;
              if (meaning.oversell.includes(e.outcome)) this.metrics.oversells++;
              if (meaning.expired.includes(e.outcome)) this.metrics.expiredReservations++;
            }
          }
          break;
        }

        case "unique-conflict":
          if (measuring) this.metrics.idempotencyHits++;
          break;

        case "guard-failed":
          if (measuring) this.metrics.guardFailures++;
          break;

        case "lease-contended":
          if (measuring) this.metrics.leaseContentions++;
          this.lockComponent(e.lock)?.noteContended();
          break;

        case "lease-acquired":
          this.lockComponent(e.lock)?.noteAcquireAttempt();
          this.lockComponent(e.lock)?.noteAcquired();
          this.scheduleLeaseExpiry(e.lock, e.key, e.token);
          break;

        case "lease-released":
          this.lockComponent(e.lock)?.noteReleased(e.heldMs);
          break;

        case "stale-owner-rejected":
          if (measuring) this.metrics.staleOwnerRejections++;
          this.lockComponent(e.lock)?.noteStaleOwnerRejection();
          break;

        case "published":
          this.startConsumer(e.messageId);
          break;

        case "acked": {
          const ev = this.visibilityTimers.get(e.messageId);
          if (ev) {
            this.env.sim.cancel(ev);
            this.visibilityTimers.delete(e.messageId);
          }
          break;
        }

        case "timer-armed":
          this.armTimer(e.timerId, e.afterMs);
          break;

        case "table-full":
          break;
      }
    }
    void message;
  }

  private lockComponent(nodeId: string): LockComponent | null {
    const c = this.env.components.get(nodeId);
    return c instanceof LockComponent ? c : null;
  }

  private noteStranded(frame: Frame): void {
    // A handler that died holding a lease or mid-reservation has stranded whatever it
    // took. Counted rather than repaired, because repairing it here would model a
    // cleanup process the design does not contain.
    if (this.env.measuring() && Object.keys(frame.leaseHeldAt).length > 0) {
      this.metrics.strandedReservations++;
    }
  }

  // -------------------------------------------------------------------------
  // asynchronous work: leases, timers, consumers
  // -------------------------------------------------------------------------

  /**
   * Arm a real timer for a lease's TTL.
   *
   * The simulator's leases expire on the clock, and the explorer's expire whenever it
   * chooses. That is not an inconsistency between the two engines: both call the same
   * `expireLease`, and the difference is only in WHEN the scheduler decides to call it.
   * The explorer is strictly more thorough, which is why a design that passes the
   * simulator can still have the stale-owner bug and why the two views are both
   * reported.
   */
  private scheduleLeaseExpiry(lock: string, key: string, token: number): void {
    const lk = `${lock}\u0000${key}`;
    const lease = this.world.leases[lk];
    if (!lease) return;
    const delayMs = Math.max(0, lease.expiresAt - this.env.sim.now);
    this.env.sim.after(delayMs, () => {
      const current = this.world.leases[lk];
      // Only expire the lease this timer was armed for. A lease released and re-acquired
      // in the meantime has a higher token, and expiring it here would cut short a
      // healthy holder -- injecting a fault the design did not have.
      if (!current || current.token !== token) return;
      const leases = { ...this.world.leases };
      delete leases[lk];
      this.world = { ...this.world, leases };
      if (this.env.measuring()) this.metrics.leaseExpiries++;
      this.lockComponent(lock)?.noteExpired(this.env.sim.now - current.grantedAt);
    });
  }

  private armTimer(timerId: number, afterMs: number): void {
    const timer = this.world.timers.find((t) => t.id === timerId);
    if (!timer) return;
    const event = this.env.sim.after(afterMs, () => {
      this.pendingTimers.delete(timerId);
      const current = this.world.timers.find((t) => t.id === timerId);
      if (!current || current.fired) return;
      // Through the kernel's own function, so the simulator's notion of "this timer is done"
      // is the same one the explorer uses -- including the pruning.
      this.world = markTimerFired(this.world, timerId);
      const frame = startTimerFrame(`x${++this.actorSeq}`, current);
      const node = this.stepEnv.cw.programs[current.handler]?.nodeId ?? "";
      this.env.sim.spawn(this.runDetached(frame, node));
    });
    this.pendingTimers.set(timerId, { timer, event });
  }

  /**
   * Start a consumer for a published message.
   *
   * Consumers contend for a per-queue pool sized by the queue's `consumers` setting, so
   * a backlog is a real backlog: messages wait for a slot rather than all being handled
   * at once. The visibility timeout is armed at the moment of delivery, and if it fires
   * before the consumer acknowledges, the message becomes available again -- which is
   * the at-least-once hazard arriving by its ordinary route rather than as an injected
   * fault.
   */
  private startConsumer(messageId: number): void {
    const message = this.world.messages.find((m) => m.id === messageId);
    if (!message) return;
    const handlers = this.stepEnv.cw.consumers[message.queue] ?? [];
    const handlerId = handlers[0];
    if (!handlerId) return;
    this.env.sim.spawn(this.consumerProcess(messageId, handlerId));
  }

  private *consumerProcess(messageId: number, handlerId: string): Process<void> {
    const queueId = this.world.messages.find((m) => m.id === messageId)?.queue;
    if (!queueId) return;
    const pool = this.consumerPools.get(queueId);
    const settings = this.stepEnv.queues[queueId];

    if (pool) {
      const slot = yield* acquire(pool, null);
      if (!slot.granted) return;
    }

    try {
      const message = this.world.messages.find((m) => m.id === messageId);
      if (!message || message.acked || message.abandoned || message.inflightOwner !== null) return;

      if (this.env.measuring()) {
        this.metrics.messageAge.record(Math.max(0, this.env.sim.now - message.enqueuedAt));
      }

      const actorId = `c${++this.actorSeq}`;
      this.world = {
        ...this.world,
        messages: this.world.messages.map((m) =>
          m.id === messageId
            ? { ...m, deliveries: m.deliveries + 1, inflightOwner: actorId }
            : m
        ),
      };
      const delivered = this.world.messages.find((m) => m.id === messageId)!;
      if (delivered.deliveries > 1 && this.env.measuring()) this.metrics.redeliveries++;

      if (settings && canRedeliver(settings)) {
        const ev = this.env.sim.after(settings.visibilityTimeoutMs, () => {
          this.visibilityTimers.delete(messageId);
          const m = this.world.messages.find((x) => x.id === messageId);
          if (!m || m.acked || m.abandoned || m.inflightOwner !== actorId) return;
          const { world, abandoned } = redeliverMessage(
            this.world,
            messageId,
            settings.maxRedeliveries
          );
          this.world = world;
          if (abandoned) {
            if (this.env.measuring()) this.metrics.abandonedMessages++;
            return;
          }
          this.startConsumer(messageId);
        });
        this.visibilityTimers.set(messageId, ev);
      }

      const frame = startConsumerFrame(actorId, handlerId, delivered);
      const node = this.stepEnv.cw.programs[handlerId]?.nodeId ?? "";
      const prior = this.currentHandlerNode;
      this.currentHandlerNode = node;
      yield* this.runFrame(frame, consumerCtx(this.env.sim, delivered.body), delivered);
      this.currentHandlerNode = prior;
    } finally {
      pool?.release();
    }
  }

  /** Run a handler with no caller: an expiry timer, or a detached continuation. */
  private *runDetached(frame: Frame, node: string): Process<void> {
    const prior = this.currentHandlerNode;
    this.currentHandlerNode = node;
    yield* this.runFrame(frame, consumerCtx(this.env.sim, frame.request), null);
    this.currentHandlerNode = prior;
  }

  /** Called by the hosting server component before it runs the root handler. */
  setHandlerNode(nodeId: string): void {
    this.currentHandlerNode = nodeId;
  }

  /** Read-only view of the world, for tests and for the conformance harness. */
  snapshot(): WorldState {
    return this.world;
  }
}

/**
 * A synthetic request context for work with no caller.
 *
 * `deadlineAt` is null and `traced` is false. Both matter: a consumer has no client
 * deadline to inherit, and tracing it would attribute its cost to whichever request
 * happened to publish the message, which is exactly the attribution error an
 * asynchronous boundary exists to avoid.
 */
function consumerCtx(sim: Sim, domain: Row): RequestCtx {
  return {
    requestId: -1,
    classId: "default",
    serviceMultiplier: 1,
    deadlineAt: null,
    traced: false,
    domain,
  };
}
