import type {
  ActorLane,
  Counterexample,
  CounterexampleStep,
  FaultKind,
  Invariant,
  Literal,
  StateDiff,
  Workflow,
} from "@sds/schema";
import {
  step,
  type Frame,
  type StepEnv,
  type WorldState,
} from "@sds/kernel";
import { applyTransition } from "./explore";
import { describeTransition, isFault, type Transition } from "./transitions";

/**
 * Turn a path of transitions into something a person can read in under a minute.
 *
 * WHY THE TRACE IS REPLAYED RATHER THAN RECORDED
 *
 * The search visits up to a hundred thousand states and reports at most one
 * counterexample. Recording diffs and labels for every transition it applied would cost
 * memory proportional to the whole search for information used by one path through it.
 * Replaying the winning path costs one pass of at most `bounds.transitions` steps, and it
 * is exact: the kernel is deterministic, so the replay produces the same states the
 * search did.
 *
 * WHY THE PROSE IS GENERATED FROM STRUCTURE
 *
 * A counterexample is evidence. Evidence narrated by a language model is evidence about
 * the language model. Every sentence in the returned object is assembled from the
 * operation's own fields and the observed state diff, so it cannot assert anything the
 * workflow does not contain. This is also why the explanation of WHY the trace is a bug
 * is left to the invariant's own `message`: that string was written by the study's author
 * and is the only opinion in the object.
 */

export interface BuildInput {
  env: StepEnv;
  wf: Workflow;
  initialWorld: WorldState;
  initialFrames: readonly Frame[];
  path: readonly Transition[];
  invariant: Invariant;
  scope: "safety" | "postcondition";
}

export function buildCounterexample(input: BuildInput): Counterexample {
  const { env } = input;
  let world = input.initialWorld;
  let frames: Frame[] = [...input.initialFrames];
  let faultsUsed = 0;
  let faultKinds: FaultKind[] = [];
  let actorSeq = frames.length + 1;

  const lanes = new Map<string, ActorLane>();
  for (const f of frames) lanes.set(f.id, laneFor(f, input.wf));

  const steps: CounterexampleStep[] = [];
  const faultsSeen: FaultKind[] = [];

  for (const t of input.path) {
    const before = world;
    const beforeFrames = frames;

    // Step transitions are the only ones that produce diffs and labels, because they are
    // the only ones that execute workflow operations. Everything else is the environment
    // acting on the system, and is described by `describeTransition`.
    if (t.kind === "step") {
      const frame = beforeFrames.find((f) => f.id === t.actorId);
      if (!frame || frame.status !== "running") continue;
      const result = step(env, before, frame, before.nowMs + 1);
      world = result.world;
      frames = beforeFrames.map((f) => (f.id === t.actorId ? result.frame : f));
      steps.push({
        index: steps.length,
        laneId: t.actorId,
        opId: result.opId ?? "end",
        opKind: result.opKind ?? "end",
        label: result.label,
        fault: null,
        diffs: result.diffs as StateDiff[],
        observed: result.observed,
      });
      continue;
    }

    const applied = applyTransition(
      env,
      { world, frames, faultsUsed, faultKinds, actorSeq },
      t
    );
    if (!applied) continue;
    world = applied.world;
    frames = applied.frames;
    faultsUsed = applied.faultsUsed;
    faultKinds = applied.faultKinds;
    actorSeq = applied.actorSeq;

    for (const f of frames) if (!lanes.has(f.id)) lanes.set(f.id, laneFor(f, input.wf));

    const fault = isFault(t);
    if (fault && !faultsSeen.includes(fault)) faultsSeen.push(fault);

    steps.push({
      index: steps.length,
      // A fault that creates an actor is attributed to the NEW lane, so the swimlane
      // where the retry appears is the swimlane the retry runs in. A fault that acts on
      // an existing actor stays in that actor's lane, so a crash appears where the crash
      // happened.
      laneId: laneIdFor(t, frames),
      opId: `fault:${t.kind}`,
      opKind: t.kind,
      label: describeTransition(t, identityOf(t, frames)),
      fault,
      diffs: diffWorlds(before, world),
      observed: {},
    });
  }

  return {
    invariantId: input.invariant.id,
    invariantLabel: input.invariant.label,
    message: input.invariant.message || defaultMessage(input.invariant, input.scope),
    scope: input.scope,
    lanes: [...lanes.values()],
    steps,
    // True because breadth-first search reached this state at minimal depth. Carried
    // explicitly rather than implied, so a future search order that cannot make the claim
    // is unable to make it by omission.
    minimal: true,
    faultsUsed: faultsSeen,
  };
}

function laneFor(frame: Frame, wf: Workflow): ActorLane {
  const handler = wf.handlers.find((h) => h.id === frame.handlerId);
  const kind =
    frame.kind === "request"
      ? ("request" as const)
      : frame.kind === "queue-consumer"
        ? ("queue-consumer" as const)
        : ("expiry-timer" as const);
  return {
    id: frame.id,
    label: laneLabel(frame, handler?.label || frame.handlerId),
    kind,
    handlerId: frame.handlerId,
    identity: { ...frame.request },
  };
}

/**
 * A lane's name.
 *
 * Includes the identity fields, because "actor a1" and "actor a3" tell a reader nothing
 * while "request (user=u1)" and "request (user=u1)" tell them the entire story: these are
 * the same user twice, which is why one of them should have been refused.
 */
function laneLabel(frame: Frame, handlerLabel: string): string {
  const identity = Object.entries(frame.request)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  const role =
    frame.kind === "request" ? "request" : frame.kind === "queue-consumer" ? "consumer" : "timer";
  return identity ? `${role} ${frame.id} (${identity})` : `${role} ${frame.id} \u2014 ${handlerLabel}`;
}

function laneIdFor(t: Transition, frames: readonly Frame[]): string {
  switch (t.kind) {
    case "step":
    case "crash":
      return t.actorId;
    case "deliver":
    case "fire-timer":
      return t.actorId;
    case "retry":
      return `${t.actorId}r`;
    case "redeliver":
    case "expire-lease":
      // Environment actions with no owning actor. Attributed to the system lane, which
      // is synthesised by the renderer rather than existing as a frame.
      return frames.length > 0 ? "system" : "system";
  }
}

function identityOf(t: Transition, frames: readonly Frame[]): Record<string, Literal> {
  const id = laneIdFor(t, frames);
  return frames.find((f) => f.id === id)?.request ?? {};
}

/**
 * Diff two worlds, for transitions that change state without executing an operation.
 *
 * Only lease expiry and redelivery reach here, and both matter to a reader: "the lease on
 * pizza-1 vanished" is the pivotal event in the stale-owner counterexample, and it belongs
 * in the timeline even though no workflow operation caused it.
 */
function diffWorlds(before: WorldState, after: WorldState): StateDiff[] {
  const out: StateDiff[] = [];

  for (const [id, value] of Object.entries(after.counters)) {
    const prior = before.counters[id];
    if (prior !== value) {
      out.push({ collection: id, key: null, field: null, before: prior ?? null, after: value });
    }
  }

  for (const [id, table] of Object.entries(after.tables)) {
    const priorTable = before.tables[id] ?? {};
    for (const key of Object.keys(table).sort()) {
      if (priorTable[key] === undefined) {
        out.push({ collection: id, key, field: null, before: null, after: key });
      }
    }
    for (const key of Object.keys(priorTable).sort()) {
      if (table[key] === undefined) {
        out.push({ collection: id, key, field: null, before: key, after: null });
      }
    }
  }

  for (const lk of Object.keys(before.leases).sort()) {
    if (after.leases[lk] === undefined) {
      const sep = lk.indexOf("\u0000");
      out.push({
        collection: `lease:${lk.slice(0, sep)}`,
        key: lk.slice(sep + 1),
        field: "owner",
        before: before.leases[lk]!.owner,
        after: null,
      });
    }
  }

  for (const m of after.messages) {
    const prior = before.messages.find((x) => x.id === m.id);
    if (prior && prior.inflightOwner !== m.inflightOwner) {
      out.push({
        collection: `queue:${m.queue}`,
        key: String(m.id),
        field: "inflight",
        before: prior.inflightOwner,
        after: m.inflightOwner,
      });
    }
  }

  return out;
}

/**
 * Fallback message when a study did not write one.
 *
 * Deliberately unhelpful about WHY, because only the study's author knows. Stating the
 * mechanical fact and prompting for the missing sentence is better than inventing a
 * plausible business justification the author never made.
 */
function defaultMessage(inv: Invariant, scope: "safety" | "postcondition"): string {
  return scope === "safety"
    ? `The invariant "${inv.label}" became false partway through this execution. No message was written for it, so what that costs the product is not recorded here.`
    : `The invariant "${inv.label}" is false once everything has finished. No message was written for it.`;
}
