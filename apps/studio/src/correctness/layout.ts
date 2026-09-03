import type { ActorLane, Counterexample, CounterexampleStep, StateDiff } from "@sds/schema";

/**
 * Counterexample layout, and the prose that goes with it.
 *
 * DOM-FREE, ON PURPOSE
 *
 * Same rule the packet choreography follows: no `document`, no React, no measurement. The
 * layout of a counterexample is arithmetic over a list of transitions, and arithmetic belongs
 * somewhere it can be unit-tested in node. The React component that renders swimlanes should be
 * a function of this module's output and nothing else.
 *
 * THE PROSE IS GENERATED FROM STRUCTURE
 *
 * Every sentence a reader sees here is assembled from the operation's own fields and the state
 * diff it produced. None of it comes from a language model, and that is not a limitation to be
 * lifted later -- a counterexample is evidence, and evidence narrated by a model is evidence
 * about the model. The one opinion in the output is the invariant's own `message`, which was
 * written by whoever wrote the study.
 */

/** A synthetic lane for events with no owning actor: redelivery, lease expiry. */
export const SYSTEM_LANE: ActorLane = {
  id: "system",
  label: "the environment",
  kind: "system",
  handlerId: "",
  identity: {},
};

export interface LaidOutStep {
  step: CounterexampleStep;
  /** Column index into `lanes`. */
  column: number;
  /** One-line summary of what changed, for the timeline gutter. */
  diffSummary: string;
  /** What the actor believed at this point, for the gutter. */
  observedSummary: string;
  /** True when this transition is the environment acting rather than an actor running. */
  isEnvironment: boolean;
}

export interface CounterexampleLayout {
  lanes: ActorLane[];
  steps: LaidOutStep[];
  /**
   * Cumulative state after each transition, so a scrubber can show the world at step N without
   * re-running anything.
   *
   * Built by folding the diffs forward. That is only correct because a diff carries `before` as
   * well as `after` -- the fold is checked against `before` and any mismatch is reported rather
   * than papered over, because a timeline that silently disagreed with the trace it was built
   * from would be worse than no timeline.
   */
  timeline: TimelineFrame[];
  /** Plain-language narration, one paragraph per phase of the story. */
  explanation: string[];
  inconsistencies: string[];
}

export interface TimelineFrame {
  index: number;
  /** collection -> displayable value. Counters are numbers; tables are row-key lists. */
  values: Record<string, string>;
}

/**
 * Lay out a counterexample as swimlanes plus a state timeline.
 *
 * Lane order is: request actors first in the order they appear, then consumers, then timers,
 * then the environment. That is the order a reader needs rather than the order the trace
 * produced: the two contending requests belong side by side at the left, and the redelivery that
 * interfered with them belongs at the edge.
 */
export function layoutCounterexample(ce: Counterexample): CounterexampleLayout {
  const lanes = orderLanes(ce);
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));

  const steps: LaidOutStep[] = ce.steps.map((step) => ({
    step,
    column: laneIndex.get(step.laneId) ?? laneIndex.get(SYSTEM_LANE.id) ?? 0,
    diffSummary: summariseDiffs(step.diffs),
    observedSummary: summariseObserved(step.observed),
    isEnvironment: step.fault !== null && !laneIndex.has(step.laneId),
  }));

  const { timeline, inconsistencies } = buildTimeline(ce.steps);

  return {
    lanes,
    steps,
    timeline,
    explanation: explain(ce, lanes),
    inconsistencies,
  };
}

function orderLanes(ce: Counterexample): ActorLane[] {
  const rank = (kind: ActorLane["kind"]): number =>
    kind === "request" ? 0 : kind === "queue-consumer" ? 1 : kind === "expiry-timer" ? 2 : 3;

  const declared = [...ce.lanes];
  // Any lane a step refers to but the trace did not declare -- the environment lane, in
  // practice. Added rather than dropped, because a step with no column would silently vanish
  // from the swimlanes and the trace would no longer add up.
  const known = new Set(declared.map((l) => l.id));
  for (const step of ce.steps) {
    if (!known.has(step.laneId)) {
      known.add(step.laneId);
      declared.push(step.laneId === SYSTEM_LANE.id ? SYSTEM_LANE : { ...SYSTEM_LANE, id: step.laneId });
    }
  }

  const firstSeen = new Map<string, number>();
  ce.steps.forEach((s, i) => {
    if (!firstSeen.has(s.laneId)) firstSeen.set(s.laneId, i);
  });

  return declared.sort((a, b) => {
    const byKind = rank(a.kind) - rank(b.kind);
    if (byKind !== 0) return byKind;
    return (firstSeen.get(a.id) ?? 1e9) - (firstSeen.get(b.id) ?? 1e9);
  });
}

function summariseDiffs(diffs: readonly StateDiff[]): string {
  if (diffs.length === 0) return "";
  return diffs
    .map((d) => {
      const where = d.key === null ? d.collection : `${d.collection}[${d.key}]${d.field ? `.${d.field}` : ""}`;
      if (d.before === null && d.after !== null) return `${where} appears as ${show(d.after)}`;
      if (d.before !== null && d.after === null) return `${where} is gone`;
      return `${where}: ${show(d.before)} \u2192 ${show(d.after)}`;
    })
    .join(", ");
}

function summariseObserved(observed: Record<string, string | number | boolean>): string {
  const entries = Object.entries(observed);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k} = ${show(v)}`).join(", ");
}

function show(v: string | number | boolean | null): string {
  if (v === null) return "absent";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

/**
 * Fold the diffs forward into a state at each step.
 *
 * The consistency check is the point of carrying `before`. If the fold's current value for a
 * cell disagrees with the `before` the trace recorded, then either the trace or the fold is
 * wrong, and a scrubber built on a wrong fold would show a reader a state the system was never
 * in. Reported rather than corrected.
 */
function buildTimeline(steps: readonly CounterexampleStep[]): {
  timeline: TimelineFrame[];
  inconsistencies: string[];
} {
  const counters = new Map<string, string | number | boolean>();
  const rows = new Map<string, Set<string>>();
  const inconsistencies: string[] = [];
  const timeline: TimelineFrame[] = [];

  for (const step of steps) {
    for (const d of step.diffs) {
      if (d.key === null) {
        const current = counters.get(d.collection);
        if (current !== undefined && d.before !== null && current !== d.before) {
          inconsistencies.push(
            `at transition ${step.index}, ${d.collection} was recorded as ${show(d.before)} but the ` +
              `timeline had reached ${show(current)}`
          );
        }
        if (d.after !== null) counters.set(d.collection, d.after);
        continue;
      }
      const set = rows.get(d.collection) ?? new Set<string>();
      if (d.field === null) {
        if (d.after === null) set.delete(d.key);
        else set.add(d.key);
      } else {
        set.add(d.key);
      }
      rows.set(d.collection, set);
    }

    const values: Record<string, string> = {};
    for (const [id, v] of [...counters].sort()) values[id] = show(v);
    for (const [id, set] of [...rows].sort()) {
      const keys = [...set].sort();
      values[id] =
        keys.length === 0
          ? "no rows"
          : `${keys.length} row${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", \u2026" : ""}`;
    }
    timeline.push({ index: step.index, values });
  }

  return { timeline, inconsistencies };
}

/**
 * The story, in three or four sentences.
 *
 * Structured as: what broke, who was involved, what the environment did, and what it costs. The
 * last one is the invariant's own message, quoted rather than paraphrased.
 *
 * The hardest part of this function to get right is what NOT to say. It does not say which line
 * of the workflow to change, because it does not know -- several fixes exist for every one of
 * these traces and choosing between them is a design decision. It reports what happened and
 * stops.
 */
export function explain(ce: Counterexample, lanes: readonly ActorLane[]): string[] {
  const out: string[] = [];

  const scope =
    ce.scope === "safety"
      ? "partway through this execution"
      : "once every actor had finished and every timer had fired";
  out.push(
    `The invariant "${ce.invariantLabel}" became false ${scope}. ` +
      `The trace below is ${ce.steps.length} transition${ce.steps.length === 1 ? "" : "s"} long and no shorter one exists ` +
      `within these bounds \u2014 breadth-first search found this before anything longer. This establishes a minimal ` +
      `counterexample to the authored contract, not by itself a production bug.`
  );

  const actors = lanes.filter((l) => l.kind === "request");
  if (actors.length >= 2) {
    const sharedFields = sharedIdentity(actors);
    out.push(
      sharedFields.length > 0
        ? `${actors.length} requests are involved, and ${sharedFields.map((f) => `they share the same ${f}`).join(" and ")}. ` +
          `That is not a coincidence in the workload: two requests from one person is the ordinary case that the ` +
          `one-per-person rule exists to handle.`
        : `${actors.length} requests are involved, from different people. No duplicate submission is needed for this: ` +
          `ordinary concurrency between two distinct requests is enough.`
    );
  }

  if (ce.faultsUsed.length === 0) {
    out.push(
      `NO FAULT WAS INJECTED. Nothing crashed, nothing timed out, nothing was redelivered. ` +
        `This happens on a completely healthy system as soon as two requests overlap, which means it will happen ` +
        `in production at a rate set by the traffic rather than by the failure rate.`
    );
  } else {
    out.push(
      `It takes ${ce.faultsUsed.length === 1 ? "one injected fault" : `${ce.faultsUsed.length} injected faults`}: ` +
        `${ce.faultsUsed.map(describeFault).join(", and ")}. ` +
        `Every one of those is an ordinary event rather than an exotic one \u2014 they are what a healthy distributed ` +
        `system does to itself on a normal day.`
    );
  }

  if (ce.message) out.push(`What it costs: ${ce.message}`);

  return out;
}

function sharedIdentity(actors: readonly ActorLane[]): string[] {
  const first = actors[0];
  if (!first) return [];
  const shared: string[] = [];
  for (const field of Object.keys(first.identity)) {
    const value = first.identity[field];
    if (actors.every((a) => a.identity[field] === value)) shared.push(field);
  }
  return shared;
}

export function describeFault(kind: string): string {
  switch (kind) {
    case "duplicate-request":
      return "the same person submits twice";
    case "retry-same-key":
      return "a caller times out and retries with the same idempotency key";
    case "retry-new-key":
      return "a caller times out and retries with a fresh idempotency key";
    case "worker-crash":
      return "a worker dies after writing and before answering";
    case "queue-redelivery":
      return "the queue delivers a message a second time";
    case "lease-expiry":
      return "a lease expires while its holder is still working";
    case "reservation-expiry":
      return "a reservation expires";
    case "caller-timeout":
      return "the caller stops waiting";
    default:
      return kind;
  }
}

/**
 * The claim a verdict supports, in one sentence, for a heading.
 *
 * Deliberately blunt about the inconclusive case. "Inconclusive" is the word people skim past,
 * so the sentence says what it means instead of naming it.
 */
export function verdictHeadline(
  status: string,
  stats: { statesVisited: number; capHit: string }
): { tone: "bad" | "ok" | "warn" | "crit"; text: string } {
  switch (status) {
    case "VIOLATED":
      return { tone: "crit", text: "An invariant is violated. A minimal counterexample is below." };
    case "NO_VIOLATION_WITHIN_BOUNDS":
      return {
        tone: "ok",
        text: `No violation found in ${stats.statesVisited.toLocaleString()} states. This is not a proof of safety.`,
      };
    case "INCONCLUSIVE_BOUND_REACHED":
      return {
        tone: "warn",
        text: `The search ran out of ${stats.capHit === "time" ? "time" : "budget"} before finishing. Nothing was established, in either direction.`,
      };
    default:
      return { tone: "bad", text: "The model could not be evaluated, so there is no verdict." };
  }
}
