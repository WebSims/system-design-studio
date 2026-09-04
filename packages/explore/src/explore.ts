import type {
  CorrectnessResult,
  Design,
  ExplorationBounds,
  FaultKind,
  FaultModel,
  Invariant,
  Literal,
} from "@sds/schema";
import {
  ExplorationBoundsSchema,
  FaultModelSchema,
  validateDesign,
  validateWorkflow,
} from "@sds/schema";
import {
  canonicalKey,
  crashFrame,
  deliverMessage,
  enumerateRequests,
  expireLease,
  initialWorld,
  invariantHolds,
  markTimerFired,
  redeliverMessage,
  startConsumerFrame,
  startRequestFrame,
  startTimerFrame,
  step,
  stepEnvFor,
  type Frame,
  type Row,
  type StepEnv,
  type WorldState,
} from "@sds/kernel";
import { enabledTransitions, isFault, type Transition } from "./transitions";
import { buildCounterexample } from "./counterexample";

/**
 * The bounded race explorer.
 *
 * WHAT IT DOES
 *
 * Breadth-first search over the reachable states of a workflow under concurrency and a
 * declared fault model, checking safety invariants after every transition and
 * postconditions at every quiescent state.
 *
 * WHY BREADTH-FIRST, WHEN DEPTH-FIRST IS CHEAPER
 *
 * Because the first counterexample breadth-first search reaches is minimal in transition
 * count, and minimality is most of a counterexample's value. A twelve-step trace and a
 * three-step trace can demonstrate the same bug; only one of them gets read. Depth-first
 * search with iterative deepening would give the same guarantee at lower memory cost,
 * and would re-explore the shallow states on every iteration -- a poor trade at the state
 * counts this tool works at, where the frontier fits in memory comfortably.
 *
 * WHAT IT WILL NEVER SAY
 *
 * "Safe". "Proved". "Verified". The strongest verdict available is
 * NO_VIOLATION_WITHIN_BOUNDS, and it means exactly what it says: the search exhausted
 * the configured actor count, fault budget and transition limit without falsifying an
 * invariant. Raise any bound and the answer may change. Every result carries the bounds
 * it ran under so that a reader can see the size of the claim, and a run that hit a state
 * or time cap reports INCONCLUSIVE_BOUND_REACHED rather than the good news -- an
 * asymmetry that is the single most important behaviour in this file.
 *
 * ON PARTIAL-ORDER REDUCTION, AND WHY THERE IS NONE
 *
 * The obvious optimisation is to notice that two independent transitions commute and
 * explore only one ordering. For checking invariants at every state -- not merely at
 * terminal states -- soundness requires the full ample-set conditions including the
 * cycle-closing rule, and an implementation that gets those subtly wrong prunes reachable
 * states and reports NO_VIOLATION_WITHIN_BOUNDS for a design that has a violation. That
 * is the one failure mode this tool cannot have, because unlike every other error it
 * does not announce itself: the output looks exactly like good news.
 *
 * So the reductions here are the ones that are sound by construction rather than by
 * argument:
 *
 *   - Canonical state deduplication on the FULL state string, not a digest, so there is
 *     no collision to reason about.
 *   - Actor symmetry: two states differing only in which actor is doing which of two
 *     identical jobs are one state. This is where the factorial goes.
 *   - Message and timer symmetry: allocation order is an artefact of the interleaving,
 *     not a property of the state.
 *   - Terminal-frame compression: a finished actor's program counter and locals are
 *     unreadable, so they do not distinguish states.
 *
 * Together these are worth far more than partial-order reduction would be on workflows
 * of this shape, and each of them is a two-line argument rather than a twenty-line one.
 */

export interface ExploreInput {
  design: Design;
  invariants: readonly Invariant[];
  faults?: FaultModel;
  bounds?: ExplorationBounds;
  /** Study-level identity domains, overriding each field's own explore domain. */
  identityDomains?: Record<string, readonly Literal[]>;
  /**
   * Counter values substituted into the initial state.
   *
   * Part of the bounds, not a convenience. See `CorrectnessContract.stateOverrides`: an
   * oversell invariant is unfalsifiable against a realistic inventory at three actors,
   * so the search would report good news about a design that oversells in production.
   */
  stateOverrides?: Record<string, number>;
  /** Injected for tests; defaults to `Date.now`. */
  clock?: () => number;
}

/** Engine version, part of every evaluation cache key. Bump on any semantic change. */
export const EXPLORER_VERSION = "explore-2";

interface SearchNode {
  id: number;
  parent: number;
  /** The transition that produced this node from its parent. */
  via: Transition | null;
  depth: number;
  faultsUsed: number;
}

interface Frontier {
  id: number;
  world: WorldState;
  frames: Frame[];
  faultsUsed: number;
  faultKinds: FaultKind[];
  depth: number;
  actorSeq: number;
}

export function explore(input: ExploreInput): CorrectnessResult {
  const bounds = ExplorationBoundsSchema.parse(input.bounds ?? {});
  const faults = FaultModelSchema.parse(input.faults ?? {});
  const clock = input.clock ?? (() => Date.now());
  const startedAt = clock();

  const invalid = validateModel(input);
  if (invalid.length > 0) {
    return invalidResult(invalid, bounds, faults, clock() - startedAt);
  }

  const env = stepEnvFor(input.design)!;
  const wf = input.design.workflow!;
  const safety = input.invariants.filter((i) => i.scope === "safety");
  const postconditions = input.invariants.filter((i) => i.scope === "postcondition");

  // ---- initial state -------------------------------------------------------
  //
  // Every actor exists from the start, at its first instruction. Spawning them as
  // transitions instead would spend depth budget on arrivals rather than on the
  // interleaving being hunted, and the interleaving is the whole content of the search.
  //
  // Identities cycle through the enumerated request domain, so with two users and three
  // actors the third actor duplicates the first. That is not a convenience: it is how a
  // duplicate submission becomes reachable with no fault charged at all, and a bug that
  // needs no fault is the finding a reader most needs to see.
  const requests = enumerateRequests(wf, input.identityDomains ?? {}, Math.max(1, bounds.actors));
  const initialFrames: Frame[] = [];
  for (let i = 0; i < bounds.actors; i++) {
    const identity = requests[i % Math.max(1, requests.length)] ?? {};
    if (i > 0 && !faults.duplicateRequest && i >= requests.length) break;
    initialFrames.push(startRequestFrame(env, `a${i + 1}`, { ...identity }));
  }

  let world0 = initialWorld(wf);
  const overrides = input.stateOverrides ?? {};
  const unknownOverrides: string[] = [];
  for (const [id, value] of Object.entries(overrides)) {
    if (world0.counters[id] === undefined) {
      // Refused rather than ignored. A typo in an override silently leaves the realistic
      // inventory in place, the oversell invariant becomes unfalsifiable, and the run
      // reports NO_VIOLATION_WITHIN_BOUNDS. A study whose safety verdict turns on a
      // misspelling is worse than one that will not run.
      unknownOverrides.push(id);
      continue;
    }
    world0 = { ...world0, counters: { ...world0.counters, [id]: value } };
  }
  if (unknownOverrides.length > 0) {
    return invalidResult(
      unknownOverrides.map(
        (id) =>
          `exploration override names counter "${id}", which this candidate does not declare; the override would be silently ignored and the search would be weaker than it looks`
      ),
      bounds,
      faults,
      clock() - startedAt
    );
  }

  // A violation present before anything runs is a broken study, not a broken design, and
  // it is worth catching here rather than reporting it as a zero-step counterexample that
  // blames the candidate.
  const seedViolation = checkInvariants(safety, env, world0, initialFrames);
  if (seedViolation) {
    return {
      status: "INVALID_MODEL",
      counterexample: null,
      invariantsChecked: input.invariants.map((i) => i.id),
      bounds,
      faults,
      stats: emptyStats(clock() - startedAt),
      modelErrors: [
        `safety invariant "${seedViolation.label}" is already false in the initial state, before any request runs; the invariant or the seeded state is wrong`,
      ],
      claim: "",
      assumptions: assumptionsFor(input.design, faults),
    };
  }

  // ---- search --------------------------------------------------------------
  const visited = new Set<string>();
  const nodes: SearchNode[] = [{ id: 0, parent: -1, via: null, depth: 0, faultsUsed: 0 }];
  const queue: Frontier[] = [
    {
      id: 0,
      world: world0,
      frames: initialFrames,
      faultsUsed: 0,
      faultKinds: [],
      depth: 0,
      actorSeq: initialFrames.length + 1,
    },
  ];
  visited.add(canonicalKey(world0, initialFrames));

  let head = 0;
  let statesVisited = 0;
  let statesEnqueued = 1;
  let transitionsApplied = 0;
  let duplicatesPruned = 0;
  let independencePruned = 0;
  let depthTruncated = 0;
  let quiescentTerminals = 0;
  let maxDepthReached = 0;
  let capHit: "states" | "time" | "none" = "none";

  // The time cap is checked every `TIME_CHECK_EVERY` expansions rather than every one.
  // `Date.now()` is not free, and at a hundred thousand states a per-expansion call is a
  // measurable share of the budget it is supposed to be protecting.
  const TIME_CHECK_EVERY = 256;

  let violation: {
    node: number;
    invariant: Invariant;
    scope: "safety" | "postcondition";
  } | null = null;

  search: while (head < queue.length) {
    const current = queue[head++]!;
    statesVisited++;

    if (statesVisited > bounds.states) {
      capHit = "states";
      break;
    }
    if (statesVisited % TIME_CHECK_EVERY === 0 && clock() - startedAt > bounds.timeMs) {
      capHit = "time";
      break;
    }

    if (current.depth > maxDepthReached) maxDepthReached = current.depth;

    const enabled = enabledTransitions({
      env,
      world: current.world,
      frames: current.frames,
      faults,
      faultBudget: bounds.faults - current.faultsUsed,
      nextActorSeq: current.actorSeq,
    });

    if (enabled.length === 0) {
      // Quiescent: nothing can move. Postconditions are checked here and only here.
      quiescentTerminals++;
      const failed = checkInvariants(postconditions, env, current.world, current.frames);
      if (failed) {
        violation = { node: current.id, invariant: failed, scope: "postcondition" };
        break search;
      }
      continue;
    }

    if (current.depth >= bounds.transitions) {
      // Truncated rather than abandoned quietly. Every truncation is a place the search
      // did not finish looking, and the count is reported so a reader can decide whether
      // to raise the bound.
      depthTruncated++;
      continue;
    }

    for (const t of enabled) {
      const applied = applyTransition(env, current, t);
      if (!applied) continue;
      transitionsApplied++;

      const key = canonicalKey(applied.world, applied.frames);
      if (visited.has(key)) {
        duplicatesPruned++;
        // Counted separately from plain duplicates when the transition commuted with
        // something already applied: the state was reachable by an independent
        // reordering that the search had already taken. This is the reduction that
        // stands in for partial-order reduction, and unlike POR it is sound by
        // construction rather than by argument.
        if (commutes(t, applied)) independencePruned++;
        continue;
      }
      visited.add(key);

      const id = nodes.length;
      nodes.push({
        id,
        parent: current.id,
        via: t,
        depth: current.depth + 1,
        faultsUsed: applied.faultsUsed,
      });
      queue.push({ ...applied, id, depth: current.depth + 1 });
      statesEnqueued++;

      // Safety is checked on the SUCCESSOR, immediately, before anything else is
      // expanded. Breadth-first order plus check-on-discovery is what makes the first
      // violation found minimal in transition count.
      const failed = checkInvariants(safety, env, applied.world, applied.frames);
      if (failed) {
        violation = { node: id, invariant: failed, scope: "safety" };
        break search;
      }

      if (statesEnqueued > bounds.states * 4) {
        // The frontier is allowed to run ahead of the visit count, but not without
        // limit: a design that fans out enormously would otherwise exhaust memory
        // before the state cap noticed.
        capHit = "states";
        break search;
      }
    }
  }

  const wallMs = clock() - startedAt;
  const exhausted = capHit === "none" && head >= queue.length && !violation;

  const stats = {
    statesVisited,
    statesEnqueued,
    transitionsApplied,
    maxDepthReached,
    duplicatesPruned,
    independencePruned,
    depthTruncated,
    quiescentTerminals,
    wallMs,
    exhausted,
    capHit,
  };

  const assumptions = assumptionsFor(input.design, faults);
  const invariantsChecked = input.invariants.map((i) => i.id);

  if (violation) {
    const path = pathTo(nodes, violation.node);
    const counterexample = buildCounterexample({
      env,
      wf,
      initialFrames,
      initialWorld: world0,
      path,
      invariant: violation.invariant,
      scope: violation.scope,
    });
    return {
      status: "VIOLATED",
      counterexample,
      invariantsChecked,
      bounds,
      faults,
      stats,
      modelErrors: [],
      claim: violatedClaim(violation.invariant, counterexample.steps.length, bounds),
      assumptions,
    };
  }

  if (capHit !== "none") {
    return {
      status: "INCONCLUSIVE_BOUND_REACHED",
      counterexample: null,
      invariantsChecked,
      bounds,
      faults,
      stats,
      modelErrors: [],
      claim: inconclusiveClaim(capHit, stats, bounds),
      assumptions,
    };
  }

  // Reaching here means the queue drained with no cap hit. Even so, a search in which
  // every execution was truncated by the transition bound has not exhausted anything
  // meaningful, and reporting the good verdict would be the most misleading thing this
  // function could do.
  if (quiescentTerminals === 0 && depthTruncated > 0) {
    return {
      status: "INCONCLUSIVE_BOUND_REACHED",
      counterexample: null,
      invariantsChecked,
      bounds,
      faults,
      stats,
      modelErrors: [],
      claim:
        `no execution reached quiescence within ${bounds.transitions} transitions, so no postcondition was ever checked. ` +
        `Raise the transition bound.`,
      assumptions,
    };
  }

  return {
    status: "NO_VIOLATION_WITHIN_BOUNDS",
    counterexample: null,
    invariantsChecked,
    bounds,
    faults,
    stats,
    modelErrors: [],
    claim: exhaustedClaim(stats, bounds, faults, invariantsChecked.length, overrides),
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// transition application
// ---------------------------------------------------------------------------

interface Applied {
  world: WorldState;
  frames: Frame[];
  faultsUsed: number;
  faultKinds: FaultKind[];
  actorSeq: number;
  /** Collections the transition read and wrote, for the commutation test. */
  reads: string[];
  writes: string[];
}

/**
 * Apply one transition, returning the successor state.
 *
 * Returns null when the transition turns out not to be applicable after all -- a message
 * already acked by the time it was chosen, for instance. Enumeration and application are
 * separated because enumeration must be cheap (it runs at every state) while application
 * is the expensive part, so a small amount of re-checking here is the right trade.
 *
 * The clock advances by ONE per transition. It is a logical counter, not a duration:
 * nothing in the explorer compares two clock values to decide whether something has
 * expired. See `WorldState.nowMs`.
 */
export function applyTransition(
  env: StepEnv,
  from: { world: WorldState; frames: Frame[]; faultsUsed: number; faultKinds: FaultKind[]; actorSeq: number },
  t: Transition
): Applied | null {
  const nowMs = from.world.nowMs + 1;
  const fault = isFault(t);
  const charge = fault ? 1 : 0;

  switch (t.kind) {
    case "step": {
      const frame = from.frames.find((f) => f.id === t.actorId);
      if (!frame || frame.status !== "running") return null;
      const result = step(env, from.world, frame, nowMs);
      return {
        world: result.world,
        frames: from.frames.map((f) => (f.id === t.actorId ? result.frame : f)),
        faultsUsed: from.faultsUsed,
        faultKinds: from.faultKinds,
        actorSeq: from.actorSeq,
        reads: result.reads,
        writes: result.writes,
      };
    }

    case "deliver": {
      const message = from.world.messages.find((m) => m.id === t.messageId);
      if (!message || message.acked || message.abandoned || message.inflightOwner !== null) return null;
      const world = deliverMessage({ ...from.world, nowMs }, t.messageId, t.actorId);
      const delivered = world.messages.find((m) => m.id === t.messageId)!;
      return {
        world,
        frames: [...from.frames, startConsumerFrame(t.actorId, t.handlerId, delivered)],
        faultsUsed: from.faultsUsed,
        faultKinds: from.faultKinds,
        actorSeq: from.actorSeq + 1,
        reads: [],
        writes: [],
      };
    }

    case "redeliver": {
      const message = from.world.messages.find((m) => m.id === t.messageId);
      if (!message || message.acked || message.abandoned || message.inflightOwner === null) return null;
      const q = env.queues[message.queue];
      const { world } = redeliverMessage({ ...from.world, nowMs }, t.messageId, q?.maxRedeliveries ?? 0);
      return {
        world,
        frames: from.frames,
        faultsUsed: from.faultsUsed + charge,
        faultKinds: [...from.faultKinds, "queue-redelivery"],
        actorSeq: from.actorSeq,
        reads: [],
        writes: [],
      };
    }

    case "fire-timer": {
      const timer = from.world.timers.find((x) => x.id === t.timerId);
      if (!timer || timer.fired) return null;
      const world = markTimerFired({ ...from.world, nowMs }, t.timerId);
      return {
        world,
        frames: [...from.frames, startTimerFrame(t.actorId, timer)],
        faultsUsed: from.faultsUsed + charge,
        faultKinds: [...from.faultKinds, "reservation-expiry"],
        actorSeq: from.actorSeq + 1,
        reads: [],
        writes: [],
      };
    }

    case "crash": {
      const frame = from.frames.find((f) => f.id === t.actorId);
      if (!frame || frame.status !== "running") return null;
      return {
        // Nothing is rolled back. Everything the actor durably wrote stays written, its
        // lease stays held, its message stays unacknowledged. That gap IS the fault.
        world: { ...from.world, nowMs },
        frames: from.frames.map((f) => (f.id === t.actorId ? crashFrame(f) : f)),
        faultsUsed: from.faultsUsed + charge,
        faultKinds: [...from.faultKinds, "worker-crash"],
        actorSeq: from.actorSeq,
        reads: [],
        writes: [],
      };
    }

    case "expire-lease": {
      const { world, lease } = expireLease({ ...from.world, nowMs }, t.leaseKey);
      if (!lease) return null;
      return {
        // The generation is NOT reset. The next acquire increments it, which is what
        // makes the previous holder's fencing token stale -- and the absence of a token
        // is what makes an unfenced holder able to corrupt state here.
        world,
        frames: from.frames,
        faultsUsed: from.faultsUsed + charge,
        faultKinds: [...from.faultKinds, "lease-expiry"],
        actorSeq: from.actorSeq,
        reads: [],
        writes: [],
      };
    }

    case "retry": {
      const frame = from.frames.find((f) => f.id === t.actorId);
      if (!frame || frame.status !== "running") return null;
      const wf = env.cw.wf;
      // A retry with the same key is the original request again, byte for byte. A retry
      // with a fresh key differs in exactly the fields declared as derived from request
      // content, which is what a client that regenerates its key per attempt does.
      const identity: Row = t.sameKey
        ? { ...frame.request }
        : freshKeys(wf, frame.request, `${t.actorId}r`);
      const actorId = `${t.actorId}r`;
      if (from.frames.some((f) => f.id === actorId)) return null;
      return {
        world: { ...from.world, nowMs },
        // The original actor keeps running. That is the point: the caller gave up
        // waiting, the work did not stop, and now there are two of them.
        frames: [...from.frames, startRequestFrame(env, actorId, identity)],
        faultsUsed: from.faultsUsed + charge,
        faultKinds: [...from.faultKinds, t.sameKey ? "retry-same-key" : "retry-new-key"],
        actorSeq: from.actorSeq + 1,
        reads: [],
        writes: [],
      };
    }
  }
}

/** Replace derived identity fields with fresh values, modelling a per-attempt key. */
function freshKeys(wf: StepEnv["cw"]["wf"], request: Row, salt: string): Row {
  const out: Row = { ...request };
  for (const field of wf.requestFields) {
    if (field.strategy.kind !== "idempotencyKey") continue;
    out[field.name] = `${field.strategy.prefix}${salt}`;
  }
  return out;
}

/**
 * Whether the transition commuted with work already done.
 *
 * Used only to attribute a pruned duplicate to independence rather than to a plain
 * revisit. It affects no decision -- the state was pruned either way -- so a
 * conservative answer costs nothing but a slightly pessimistic statistic.
 */
function commutes(t: Transition, applied: Applied): boolean {
  if (t.kind !== "step") return false;
  return applied.writes.length === 0 || applied.reads.length === 0;
}

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

/**
 * The first invariant that does not hold, or null.
 *
 * ORDER IS DECLARATION ORDER, and that is a deliberate affordance: a study should put
 * its most fundamental invariant first, because when several fail at once that is the one
 * the counterexample will be about. "Never allocate more than exists" is a better
 * headline than a derived accounting identity that failed as a consequence of it.
 */
function checkInvariants(
  invariants: readonly Invariant[],
  env: StepEnv,
  world: WorldState,
  frames: readonly Frame[]
): Invariant | null {
  for (const inv of invariants) {
    const holds = invariantHolds(inv.expr, {
      wf: env.cw.wf,
      world,
      // Invariants are GLOBAL: they see the world and no actor's private state. An
      // invariant that could read one actor's locals would be a statement about an
      // implementation's variables rather than about the system, and it would evaluate
      // differently depending on which actor happened to be asking.
      locals: {},
      request: {},
      row: null,
    });
    if (!holds) return inv;
  }
  return null;
}

// ---------------------------------------------------------------------------
// path reconstruction
// ---------------------------------------------------------------------------

/**
 * The transitions from the root to a node.
 *
 * Parent pointers rather than stored states: keeping a world and its frames for every one
 * of a hundred thousand visited states would cost hundreds of megabytes, and the frontier
 * already holds everything the search needs. Reconstructing a path costs one replay of at
 * most `bounds.transitions` transitions, and happens at most once per run.
 */
function pathTo(nodes: readonly SearchNode[], id: number): Transition[] {
  const out: Transition[] = [];
  let cursor = id;
  while (cursor > 0) {
    const node = nodes[cursor]!;
    if (node.via) out.push(node.via);
    cursor = node.parent;
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// model validation and claims
// ---------------------------------------------------------------------------

function validateModel(input: ExploreInput): string[] {
  const errors: string[] = [];

  for (const issue of validateDesign(input.design)) {
    if (issue.severity === "error") errors.push(issue.message);
  }
  for (const issue of validateWorkflow(input.design)) {
    if (issue.severity === "error") errors.push(issue.message);
  }

  if (!input.design.workflow) {
    errors.push(
      "this design has no workflow, so it has no state and no correctness contract; a verdict here would be vacuous"
    );
  }

  if (input.invariants.length === 0) {
    // Refused rather than reported as a pass. A search over a design with nothing to
    // check trivially finds nothing, and "no violation found" would be technically true
    // and completely misleading -- the single cheapest way to game a correctness tool is
    // to give it nothing to verify.
    errors.push(
      "no invariants were supplied, so there is nothing to falsify; a verdict would be vacuous rather than reassuring"
    );
  }

  return errors;
}

function invalidResult(
  errors: string[],
  bounds: ExplorationBounds,
  faults: FaultModel,
  wallMs: number
): CorrectnessResult {
  return {
    status: "INVALID_MODEL",
    counterexample: null,
    invariantsChecked: [],
    bounds,
    faults,
    stats: emptyStats(wallMs),
    modelErrors: errors,
    claim: "no correctness claim: the model could not be evaluated",
    assumptions: [],
  };
}

function emptyStats(wallMs: number): CorrectnessResult["stats"] {
  return {
    statesVisited: 0,
    statesEnqueued: 0,
    transitionsApplied: 0,
    maxDepthReached: 0,
    duplicatesPruned: 0,
    independencePruned: 0,
    depthTruncated: 0,
    quiescentTerminals: 0,
    wallMs,
    exhausted: false,
    capHit: "none",
  };
}

/**
 * The modelling assumptions in force, stated on every result.
 *
 * Attached to the result rather than rendered by the UI so that the CLI, the studio and
 * the WebMCP tool cannot disagree about the scope of a claim. An agent reading these over
 * the tool surface sees the same caveats a human reads on screen, which is the only way
 * to stop an agent from confidently reporting a stronger conclusion than the engine
 * supports.
 */
export function assumptionsFor(design: Design, faults: FaultModel): string[] {
  const groups = design.nodes.flatMap((node) =>
    node.database?.replicaGroup
      ? [{ node, group: node.database.replicaGroup, isolation: node.database.isolationLevel }]
      : []
  );
  const out: string[] = groups.length === 0
    ? [
        "one logical region with a linearizable authoritative datastore",
        "no network partitions, no replica divergence, no quorum or consensus behaviour",
        "no clock skew between components; expiry is modelled as a chosen transition rather than a clock reading",
        "vendor-neutral semantics; no vendor's specific SQL isolation behaviour is reproduced",
      ]
    : [
        "workflow interleavings execute against one logical state per database; replica protocol steps are not added to the state search",
        "quorum intersection, impossible quorums, configured partition availability, divergence counts and clock-skew bounds are checked arithmetically by the design validator",
        "replica propagation, leader election, consensus progress and general liveness are out of scope; NO_VIOLATION_WITHIN_BOUNDS applies only to the logical workflow explored",
        "vendor-neutral semantics; no vendor's specific transaction or replication protocol is reproduced",
        ...groups.map(
          ({ node, group, isolation }) =>
            `"${node.label}" requests ${isolation} isolation from replica group "${group.id}" ` +
            `(N=${group.replicas}, R=${group.readQuorum}, W=${group.writeQuorum}, ` +
            `clock skew ≤ ${group.maxClockSkewMs}ms)`
        ),
      ];

  const off: string[] = [];
  if (!faults.duplicateRequest) off.push("duplicate submissions");
  if (!faults.retrySameKey) off.push("retries with the same idempotency key");
  if (!faults.retryNewKey) off.push("retries with a fresh idempotency key");
  if (!faults.workerCrash) off.push("worker crashes");
  if (!faults.queueRedelivery) off.push("queue redelivery");
  if (!faults.leaseExpiry) off.push("lease expiry");
  if (!faults.reservationExpiry) off.push("reservation expiry");
  if (off.length > 0) {
    out.push(`these faults were NOT injected: ${off.join(", ")}`);
  }

  const atMostOnce = design.nodes.filter(
    (n) => n.kind === "queue" && n.queue?.delivery === "at-most-once"
  );
  for (const q of atMostOnce) {
    out.push(
      `queue "${q.label}" is configured at-most-once, so it was not tested under redelivery; it can instead lose messages, which no invariant here checks`
    );
  }

  return out;
}

function violatedClaim(inv: Invariant, steps: number, bounds: ExplorationBounds): string {
  return (
    `Invariant "${inv.label}" is violated. The counterexample below is ${steps} transition${steps === 1 ? "" : "s"} long ` +
    `and is minimal in transition count: breadth-first search found no shorter trace that violates this authored contract ` +
    `within ${bounds.actors} initial requests. A contract violation is evidence about the model; whether it represents a production bug depends on the contract and modeled faults.`
  );
}

function inconclusiveClaim(
  capHit: "states" | "time",
  stats: CorrectnessResult["stats"],
  bounds: ExplorationBounds
): string {
  const what =
    capHit === "states"
      ? `the state cap of ${bounds.states.toLocaleString()} states`
      : `the time cap of ${bounds.timeMs}ms`;
  return (
    `INCONCLUSIVE. The search stopped at ${what} after visiting ${stats.statesVisited.toLocaleString()} states, ` +
    `so part of the state space within these bounds was never examined. This says nothing about whether a violation exists. ` +
    `Raise the cap, reduce the actor count or narrow the fault model, and run it again.`
  );
}

function exhaustedClaim(
  stats: CorrectnessResult["stats"],
  bounds: ExplorationBounds,
  faults: FaultModel,
  invariantCount: number,
  overrides: Record<string, number>
): string {
  const enabled = Object.entries(faults)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const seeded = Object.entries(overrides)
    .map(([id, v]) => `${id}=${v}`)
    .join(", ");
  return (
    `No violation of ${invariantCount} invariant${invariantCount === 1 ? "" : "s"} was found within these bounds: ` +
    `${bounds.actors} initial concurrent requests, at most ${bounds.faults} injected fault${bounds.faults === 1 ? "" : "s"} per execution, ` +
    `${bounds.transitions} transitions per execution. ${stats.statesVisited.toLocaleString()} distinct states were examined and the search ran to exhaustion. ` +
    `Faults in scope: ${enabled.length > 0 ? enabled.join(", ") : "none"}. ` +
    (seeded ? `Initial state was seeded for exploration: ${seeded}. ` : "") +
    `THIS IS NOT A PROOF OF SAFETY. It is the absence of a counterexample inside a bounded search, and raising any bound may change the answer.`
  );
}
