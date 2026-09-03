import {
  allOperations,
  collectionsReferenced,
  operationTarget,
  type ActorLane,
  type Counterexample,
  type Design,
  type Invariant,
  type Operation,
  type StateDiff,
} from "@sds/schema"
import { layoutCounterexample, SYSTEM_LANE, type TimelineFrame } from "../correctness/layout"
import { CubicPath, chipCenter, edgeCurve, lerp, type Point } from "./geometry"

/**
 * TURNING A COUNTEREXAMPLE INTO CHOREOGRAPHY ON THE CANVAS.
 *
 * The race explorer produces a trace: actor lanes, an ordered list of operations, the state each
 * one changed. The swimlane shows that as text. This module maps the same trace onto the drawing
 * the person made, so "actor a1 read inventory = 1" becomes a sprite leaving the claim service,
 * arriving at the database, and the database's `inventory` chip staying at 1 while a second sprite
 * does the same.
 *
 * DOM-free, like the packet choreography and for the same reason: where a sprite is at step 3,
 * progress 0.4 is arithmetic over the trace and the node positions, and arithmetic should be
 * testable in node.
 *
 * A step is ONE transition. Its clock is a fraction in [0, 1] rather than simulated time, because
 * the explorer's logical clock ticks once per transition and carries no duration. Playback is
 * therefore step-driven: each step gets the same wall time, and scrubbing is by step index. That
 * is honest -- a counterexample makes no claim about how long anything took, only about order.
 */

export interface RaceStep {
  index: number
  laneId: string
  laneIndex: number
  label: string
  /** The node whose handler executes this step. Null for an environment event. */
  homeNodeId: string | null
  /** The datastore, lock or queue the step touches. Null for local work. */
  targetNodeId: string | null
  /** Link the sprite travels, when the design has one between home and target. */
  edgeId: string | null
  fault: string | null
  diffs: readonly StateDiff[]
  /** Collections whose value changed in this step. Chips flash on these. */
  changed: readonly string[]
  /** State after this step, collection id -> displayable value. */
  values: Record<string, string>
  observedSummary: string
  diffSummary: string
}

export interface RacePlan {
  lanes: ActorLane[]
  steps: RaceStep[]
  /** Collection ids the violated rule reads; chips on these turn red at the final step. */
  violatedCollections: string[]
  /** Where each lane's sprite rests between its own steps. */
  homeNodeByLane: Record<string, string | null>
  /** Node that executes the counterexample's final, violating step. */
  violatingNodeId: string | null
  /** Sampleable curve per edge id, for sprite travel. */
  paths: Map<string, CubicPath>
  /** Source node of each edge, so travel direction along a curve is known. */
  edgeFrom: Map<string, string>
  nodes: Map<string, Design["nodes"][number]>
}

/**
 * Where a lane's actor conceptually runs.
 *
 * The handler's `node` is the answer for request and consumer lanes. An expiry timer runs on the
 * handler's node too. The environment lane has no home: a lease expiring is not anywhere.
 */
const homeFor = (design: Design, lane: ActorLane): string | null => {
  if (lane.kind === "system") return null
  const handler = design.workflow?.handlers.find((h) => h.id === lane.handlerId)
  return handler?.node ?? null
}

export function planRace(design: Design, ce: Counterexample, invariant: Invariant | null): RacePlan {
  const layout = layoutCounterexample(ce)
  const laneIndex = new Map(layout.lanes.map((lane, index) => [lane.id, index]))
  const wf = design.workflow
  const opById = new Map<string, Operation>()
  if (wf) for (const { op } of allOperations(wf)) opById.set(op.id, op)

  const homeNodeByLane: Record<string, string | null> = {}
  for (const lane of layout.lanes) homeNodeByLane[lane.id] = homeFor(design, lane)

  const edgeBetween = (a: string | null, b: string | null): string | null => {
    if (!a || !b) return null
    const edge = design.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))
    return edge?.id ?? null
  }

  const steps: RaceStep[] = layout.steps.map((laid, i) => {
    const step = laid.step
    const op = opById.get(step.opId)
    const homeNodeId = homeNodeByLane[step.laneId] ?? null
    const target = op && wf ? operationTarget(wf, op) : null
    // An environment event that changes state (lease expiry) is shown at the node that holds it.
    const faultTarget =
      !op && step.diffs.length > 0 && wf
        ? (wf.collections.find((c) => c.id === step.diffs[0]!.collection)?.node ?? null)
        : null
    const targetNodeId = target?.nodeId ?? faultTarget
    return {
      index: step.index,
      laneId: step.laneId,
      laneIndex: laneIndex.get(step.laneId) ?? laneIndex.get(SYSTEM_LANE.id) ?? 0,
      label: step.label,
      homeNodeId,
      targetNodeId: targetNodeId === homeNodeId ? null : targetNodeId,
      edgeId: edgeBetween(homeNodeId, targetNodeId),
      fault: step.fault,
      diffs: step.diffs,
      changed: [...new Set(step.diffs.map((d) => d.collection))],
      values: layout.timeline[i]?.values ?? {},
      observedSummary: laid.observedSummary,
      diffSummary: laid.diffSummary,
    }
  })

  const paths = new Map<string, CubicPath>()
  const edgeFrom = new Map<string, string>()
  const nodes = new Map(design.nodes.map((n) => [n.id, n]))
  for (const e of design.edges) {
    const from = nodes.get(e.from)
    const to = nodes.get(e.to)
    if (!from || !to) continue
    paths.set(e.id, edgeCurve(from, to))
    edgeFrom.set(e.id, e.from)
  }

  const last = steps.at(-1)
  return {
    lanes: layout.lanes,
    steps,
    violatedCollections: invariant ? collectionsReferenced(invariant.expr) : [],
    homeNodeByLane,
    violatingNodeId: last ? (last.targetNodeId ?? last.homeNodeId) : null,
    paths,
    edgeFrom,
    nodes,
  }
}

/**
 * The state a data node shows before anything has run: declared initial values.
 *
 * Counters show their `initial`; tables show their seeded row count. This is what makes the chips
 * legible on a design that has never been evaluated: `inventory 200 · claims no rows`.
 */
export function initialStateValues(design: Design, overrides: Record<string, number> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of design.workflow?.collections ?? []) {
    if (c.kind === "counter") out[c.id] = String(overrides[c.id] ?? c.initial)
    else out[c.id] = c.seed.length === 0 ? "no rows" : `${c.seed.length} row${c.seed.length === 1 ? "" : "s"}`
  }
  return out
}

/** The frame of state to show at a step, falling back to the initial state before step 0. */
export function stateAt(plan: RacePlan | null, design: Design, cursor: number, overrides?: Record<string, number>): TimelineFrame["values"] {
  const initial = initialStateValues(design, overrides)
  if (!plan || cursor < 0) return initial
  const step = plan.steps[Math.min(cursor, plan.steps.length - 1)]
  // Merge so a collection nothing has touched still shows its starting value.
  return step ? { ...initial, ...step.values } : initial
}

// ---------------------------------------------------------------------------
// sampling
// ---------------------------------------------------------------------------

export interface RaceSprite {
  laneId: string
  laneIndex: number
  position: Point
  /** True for the lane executing the current step. */
  acting: boolean
  /** True for the environment lane, drawn differently because it is nobody. */
  environment: boolean
  /** 0 at rest, rising to 1 while the acting sprite is at its target. Drives the pulse. */
  emphasis: number
}

/** Travel out for the first part of a step, hold at the target, and come home before the next one. */
const OUT_END = 0.4
const HOLD_END = 0.7

const homePoint = (plan: RacePlan, laneId: string, laneIndex: number): Point | null => {
  const nodeId = plan.homeNodeByLane[laneId]
  const node = nodeId ? plan.nodes.get(nodeId) : null
  return node ? chipCenter(node, laneIndex) : null
}

const targetPoint = (plan: RacePlan, step: RaceStep): Point | null => {
  const node = step.targetNodeId ? plan.nodes.get(step.targetNodeId) : null
  return node ? chipCenter(node, step.laneIndex) : null
}

/**
 * Position of every lane's sprite at `cursor` with `progress` through that step.
 *
 * Lanes that are not acting rest at their home chip. The acting lane travels along the link to the
 * node its operation touches, or pulses in place when the operation is local.
 */
export function sampleRace(plan: RacePlan, cursor: number, progress: number): RaceSprite[] {
  const step = plan.steps[cursor]
  const t = Math.max(0, Math.min(1, progress))
  const out: RaceSprite[] = []

  plan.lanes.forEach((lane, laneIndex) => {
    const environment = lane.kind === "system"
    const acting = step?.laneId === lane.id
    const home = homePoint(plan, lane.id, laneIndex)

    if (!acting || !step) {
      if (home) out.push({ laneId: lane.id, laneIndex, position: home, acting: false, environment, emphasis: 0 })
      return
    }

    const target = targetPoint(plan, step)
    if (!home && !target) return

    if (!target || !home) {
      const at = (target ?? home)!
      out.push({ laneId: lane.id, laneIndex, position: at, acting: true, environment, emphasis: pulse(t) })
      return
    }

    const path = step.edgeId ? plan.paths.get(step.edgeId) : undefined
    // The curve runs from the edge's source to its target. A handler calling its datastore travels
    // it forwards; a consumer whose home is the edge's target travels it backwards.
    const forward = step.edgeId ? plan.edgeFrom.get(step.edgeId) === step.homeNodeId : true
    // `f` is the fraction of the way from home to target, whichever end of the curve that is.
    const along = (f: number): Point =>
      path ? path.pointAtFraction(forward ? f : 1 - f, forward ? 1 : -1) : lerp(home, target, f)

    let position: Point
    let emphasis = 0
    if (t < OUT_END) {
      const f = t / OUT_END
      // Leave the chip, join the pipe, travel. Blend the first tenth from the chip onto the curve.
      position = f < 0.1 ? lerp(home, along(0), f / 0.1) : along((f - 0.1) / 0.9)
      if (f > 0.9) position = lerp(along(1), target, (f - 0.9) / 0.1)
    } else if (t < HOLD_END) {
      position = target
      emphasis = pulse((t - OUT_END) / (HOLD_END - OUT_END))
    } else {
      const f = (t - HOLD_END) / (1 - HOLD_END)
      position = f < 0.1 ? lerp(target, along(1), f / 0.1) : along(1 - (f - 0.1) / 0.9)
      if (f > 0.9) position = lerp(along(0), home, (f - 0.9) / 0.1)
    }
    out.push({ laneId: lane.id, laneIndex, position, acting: true, environment, emphasis })
  })
  return out
}

const pulse = (f: number): number => Math.sin(Math.min(1, Math.max(0, f)) * Math.PI)

/** Lane colours, by lane index. Distinct, warm-palette friendly, and stable across scrubbing. */
export const LANE_COLOURS = ["#4ab4e6", "#ec6ca0", "#f5c518", "#2aa8a8", "#7b51a1", "#6cb33e"]

export const laneColour = (laneIndex: number): string => LANE_COLOURS[laneIndex % LANE_COLOURS.length]!
