import type { Trace, TraceVisit } from "@sds/core";
import type { Design, SdsNode } from "@sds/schema";
import {
  CubicPath,
  MAX_CHIPS,
  chipCenter,
  easeOut,
  edgeCurve,
  lerp,
  sourceMouth,
  targetMouth,
  type Point,
} from "./geometry";

/**
 * TURNING A RECORDED TRACE INTO CHOREOGRAPHY.
 *
 * The original build produced this motion as a side effect of running the model: the
 * engine knew which identicon was where because it was moving them. That coupling is
 * what capped the simulation at 60 frames per second and 150 concurrent packets.
 *
 * Everything here is instead DERIVED from a finished trace. The consequences are worth
 * stating, because they are the whole reason the rewrite was worth doing:
 *
 *   Playback cannot influence the simulation, so scrubbing, pausing and replaying are
 *   free, and the visuals can be sampled while the engine measures everything.
 *
 *   Slot assignment is computed once and is stable, so a request occupies the same chip
 *   for its whole visit and a sprite launches from and docks into exactly that chip.
 *   Assigning slots in arrival order at render time would make them jump around as the
 *   playhead moved, and scrubbing backwards would produce a different arrangement from
 *   scrubbing forwards.
 */

export type Anchor =
  | { kind: "chip"; nodeId: string; slot: number }
  | { kind: "mouth"; nodeId: string; side: "source" | "target" };

export interface RequestSpan {
  requestId: number;
  startMs: number;
  endMs: number;
  hops: number[];
  visits: number[];
  /** True when any hop was dropped or any visit failed. */
  failed: boolean;
}

export interface PreparedTrace {
  trace: Trace;
  /** Chip slot for each visit, by index into `trace.visits`. */
  visitSlots: number[];
  /** Visits grouped by node, each carrying its slot and index. */
  byNode: Map<string, Array<{ visit: TraceVisit; slot: number; index: number }>>;
  /** Launch and dock anchors for each hop, by index into `trace.hops`. */
  hopAnchors: Array<{ launch: Anchor; dock: Anchor }>;
  /** Sampleable curve per edge id. */
  paths: Map<string, CubicPath>;
  nodes: Map<string, SdsNode>;
  spanStartMs: number;
  spanEndMs: number;
  /** Every traced request, longest-lived first. */
  requests: RequestSpan[];
}

/**
 * Assign each visit a chip slot, and resolve where every hop starts and ends.
 *
 * Slots are assigned by interval colouring: a slot becomes free once its previous
 * occupant has left. That is deterministic given the trace, which is what makes the
 * arrangement stable under scrubbing.
 */
export function prepareTrace(design: Design, trace: Trace): PreparedTrace {
  const nodes = new Map(design.nodes.map((n) => [n.id, n]));

  // ---- chip slots ----
  const visitSlots = new Array<number>(trace.visits.length).fill(0);
  const byNode = new Map<string, Array<{ visit: TraceVisit; slot: number; index: number }>>();

  const indicesByNode = new Map<string, number[]>();
  trace.visits.forEach((v, i) => {
    const list = indicesByNode.get(v.nodeId) ?? [];
    list.push(i);
    indicesByNode.set(v.nodeId, list);
  });

  for (const [nodeId, indices] of indicesByNode) {
    indices.sort((a, b) => {
      const d = trace.visits[a]!.tEnqueue - trace.visits[b]!.tEnqueue;
      // Tie-break on index so the ordering is total and reproducible.
      return d !== 0 ? d : a - b;
    });
    /** When each slot next becomes free. */
    const freeAt = new Array<number>(MAX_CHIPS).fill(-Infinity);
    const rows: Array<{ visit: TraceVisit; slot: number; index: number }> = [];

    for (const i of indices) {
      const v = trace.visits[i]!;
      let slot = 0;
      let found = false;
      for (let s = 0; s < MAX_CHIPS; s++) {
        if (freeAt[s]! <= v.tEnqueue) {
          slot = s;
          found = true;
          break;
        }
      }
      if (!found) {
        // More concurrent visits than chips. Reuse the slot that frees soonest: the
        // strip is a sample of occupancy, not a complete list, and the node shows a
        // total alongside it.
        let best = 0;
        for (let s = 1; s < MAX_CHIPS; s++) if (freeAt[s]! < freeAt[best]!) best = s;
        slot = best;
      }
      freeAt[slot] = v.tExit;
      visitSlots[i] = slot;
      rows.push({ visit: v, slot, index: i });
    }
    byNode.set(nodeId, rows);
  }

  // ---- hop anchors ----
  //
  // A forward hop leaves the chip its request occupies at the source and docks into the
  // chip it will occupy at the destination. A response leg does the reverse. Where no
  // such visit exists -- a client has no chips -- the anchor falls back to the pipe
  // mouth, which is where the original also started sprites from.
  const visitsByRequestNode = new Map<string, Array<{ visit: TraceVisit; slot: number }>>();
  trace.visits.forEach((v, i) => {
    const key = `${v.requestId}|${v.nodeId}`;
    const list = visitsByRequestNode.get(key) ?? [];
    list.push({ visit: v, slot: visitSlots[i]! });
    visitsByRequestNode.set(key, list);
  });

  const edgeById = new Map(design.edges.map((e) => [e.id, e]));

  const anchorFor = (
    requestId: number,
    nodeId: string,
    atMs: number,
    prefer: "containing" | "starting-after"
  ): Anchor | null => {
    const list = visitsByRequestNode.get(`${requestId}|${nodeId}`);
    if (!list || list.length === 0) return null;
    if (prefer === "containing") {
      const open = list.find((x) => x.visit.tEnqueue <= atMs && atMs <= x.visit.tExit);
      if (open) return { kind: "chip", nodeId, slot: open.slot };
    }
    // Otherwise the visit this hop is about to cause: the earliest starting at or after.
    let best: { visit: TraceVisit; slot: number } | null = null;
    for (const x of list) {
      if (x.visit.tEnqueue + 1e-9 >= atMs && (!best || x.visit.tEnqueue < best.visit.tEnqueue)) {
        best = x;
      }
    }
    if (best) return { kind: "chip", nodeId, slot: best.slot };
    // Fall back to the nearest visit in time, so a sprite still has somewhere to go.
    const nearest = list.reduce((m, x) =>
      Math.abs(x.visit.tEnqueue - atMs) < Math.abs(m.visit.tEnqueue - atMs) ? x : m
    );
    return { kind: "chip", nodeId, slot: nearest.slot };
  };

  const hopAnchors = trace.hops.map((hop) => {
    const edge = edgeById.get(hop.edgeId);
    const fromId = edge?.from ?? "";
    const toId = edge?.to ?? "";
    const originId = hop.forward ? fromId : toId;
    const destId = hop.forward ? toId : fromId;

    const launch =
      anchorFor(hop.requestId, originId, hop.tStart, "containing") ??
      ({
        kind: "mouth",
        nodeId: originId,
        side: hop.forward ? "source" : "target",
      } as Anchor);

    const dock =
      anchorFor(hop.requestId, destId, hop.tEnd, hop.forward ? "starting-after" : "containing") ??
      ({
        kind: "mouth",
        nodeId: destId,
        side: hop.forward ? "target" : "source",
      } as Anchor);

    return { launch, dock };
  });

  // ---- paths ----
  const paths = new Map<string, CubicPath>();
  for (const e of design.edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;
    paths.set(e.id, edgeCurve(from, to));
  }

  // ---- spans ----
  let spanStartMs = Number.POSITIVE_INFINITY;
  let spanEndMs = 0;
  const perRequest = new Map<number, RequestSpan>();

  const touch = (requestId: number, from: number, to: number, failed: boolean) => {
    spanStartMs = Math.min(spanStartMs, from);
    spanEndMs = Math.max(spanEndMs, to);
    const existing = perRequest.get(requestId);
    if (existing) {
      existing.startMs = Math.min(existing.startMs, from);
      existing.endMs = Math.max(existing.endMs, to);
      existing.failed = existing.failed || failed;
    } else {
      perRequest.set(requestId, {
        requestId,
        startMs: from,
        endMs: to,
        hops: [],
        visits: [],
        failed,
      });
    }
  };

  trace.hops.forEach((h, i) => {
    touch(h.requestId, h.tStart, h.tEnd, !h.delivered);
    perRequest.get(h.requestId)!.hops.push(i);
  });
  trace.visits.forEach((v, i) => {
    touch(v.requestId, v.tEnqueue, v.tExit, v.outcome !== "served" && v.outcome !== "hit");
    perRequest.get(v.requestId)!.visits.push(i);
  });

  if (!Number.isFinite(spanStartMs)) spanStartMs = 0;

  const requests = [...perRequest.values()].sort(
    (a, b) => b.endMs - b.startMs - (a.endMs - a.startMs)
  );

  return {
    trace,
    visitSlots,
    byNode,
    hopAnchors,
    paths,
    nodes,
    spanStartMs,
    spanEndMs,
    requests,
  };
}

// ---------------------------------------------------------------------------
// sampling
// ---------------------------------------------------------------------------

export interface SpriteFrame {
  requestId: number;
  edgeId: string;
  position: Point;
  /** True on the request leg, false on the response. Selects the lane and the ring. */
  forward: boolean;
  failed: boolean;
  /** 0 while launching, 1 while travelling, 2 while docking. Affects opacity only. */
  phase: 0 | 1 | 2;
  /** Fades a dropped sprite out as it slides into the outer lane. */
  opacity: number;
}

export interface ChipFrame {
  requestId: number;
  slot: number;
  inService: boolean;
  failed: boolean;
}

export interface OccupancyFrame {
  /** Chips to draw, at most `MAX_CHIPS`. */
  chips: ChipFrame[];
  inService: number;
  queued: number;
  /** Total occupants, which can exceed the number of chips. */
  total: number;
}

/**
 * Fraction of a hop spent launching out of a slot and docking into one.
 *
 * The middle is spent travelling the pipe. Splitting it this way rather than adding
 * fixed launch and dock durations keeps the sprite's motion inside the hop's real
 * span, so the animation never shows a request somewhere it had already left.
 */
const LAUNCH_FRACTION = 0.22;
const DOCK_FRACTION = 0.22;

export function sampleSprites(
  prepared: PreparedTrace,
  tMs: number,
  filterRequestId: number | null
): SpriteFrame[] {
  const out: SpriteFrame[] = [];
  const { trace, hopAnchors } = prepared;

  for (let i = 0; i < trace.hops.length; i++) {
    const hop = trace.hops[i]!;
    if (filterRequestId !== null && hop.requestId !== filterRequestId) continue;
    if (tMs < hop.tStart || tMs > hop.tEnd) continue;

    const path = prepared.paths.get(hop.edgeId);
    if (!path) continue;

    const span = hop.tEnd - hop.tStart;
    const progress = span <= 0 ? 1 : (tMs - hop.tStart) / span;
    const anchors = hopAnchors[i]!;
    const side = hop.forward ? 1 : -1;

    let position: Point;
    let phase: 0 | 1 | 2 = 1;

    if (progress < LAUNCH_FRACTION) {
      phase = 0;
      const from = anchorPoint(prepared, anchors.launch);
      const to = path.pointAtFraction(hop.forward ? 0 : 1, side);
      position = lerp(from, to, easeOut(progress / LAUNCH_FRACTION));
    } else if (progress > 1 - DOCK_FRACTION) {
      phase = 2;
      const from = path.pointAtFraction(hop.forward ? 1 : 0, side);
      const to = anchorPoint(prepared, anchors.dock);
      position = lerp(from, to, easeOut((progress - (1 - DOCK_FRACTION)) / DOCK_FRACTION));
    } else {
      const travel = (progress - LAUNCH_FRACTION) / (1 - LAUNCH_FRACTION - DOCK_FRACTION);
      position = path.pointAtFraction(hop.forward ? travel : 1 - travel, side);
    }

    // A dropped hop slides out into the outer lane and fades, so loss is legible as an
    // event rather than as a sprite that simply stops existing.
    let opacity = 1;
    if (!hop.delivered) {
      const drift = Math.max(0, (progress - 0.45) / 0.55);
      opacity = 1 - drift * drift;
      position = { x: position.x, y: position.y + drift * 14 * side };
    }

    out.push({
      requestId: hop.requestId,
      edgeId: hop.edgeId,
      position,
      forward: hop.forward,
      failed: !hop.delivered,
      phase,
      opacity,
    });
  }
  return out;
}

export function sampleOccupancy(
  prepared: PreparedTrace,
  tMs: number,
  filterRequestId: number | null
): Record<string, OccupancyFrame> {
  const out: Record<string, OccupancyFrame> = {};

  for (const [nodeId, rows] of prepared.byNode) {
    const chips: ChipFrame[] = [];
    let inService = 0;
    let queued = 0;
    let total = 0;

    for (const { visit, slot } of rows) {
      if (tMs < visit.tEnqueue || tMs >= visit.tExit) continue;
      if (filterRequestId !== null && visit.requestId !== filterRequestId) continue;
      total++;
      const serving = visit.tServiceStart !== null && tMs >= visit.tServiceStart;
      if (serving) inService++;
      else queued++;
      if (chips.length < MAX_CHIPS) {
        chips.push({
          requestId: visit.requestId,
          slot,
          inService: serving,
          failed: visit.outcome !== "served" && visit.outcome !== "hit",
        });
      }
    }

    if (total > 0) {
      // Scale by the sampling rate so the count reflects the real system rather than
      // the sampled subset. The chips are a sample; the number is an estimate.
      const scale = filterRequestId === null ? prepared.trace.sampleEvery : 1;
      out[nodeId] = {
        chips,
        inService: Math.round(inService * scale),
        queued: Math.round(queued * scale),
        total: Math.round(total * scale),
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function anchorPoint(prepared: PreparedTrace, anchor: Anchor): Point {
  const node = prepared.nodes.get(anchor.nodeId);
  if (!node) return { x: 0, y: 0 };
  if (anchor.kind === "chip") return chipCenter(node, anchor.slot);
  return anchor.side === "source" ? sourceMouth(node) : targetMouth(node);
}

// ---------------------------------------------------------------------------
// time warping
// ---------------------------------------------------------------------------

/**
 * A monotone map from playback position to simulated time.
 *
 * WHY THIS IS NECESSARY, AND WHY IT IS NOT A LIE.
 *
 * A real request's journey is wildly unbalanced. A measured example from
 * `cached-read-path`: 380ms end to end, of which two network hops account for 0.6% and a
 * single database visit accounts for 99%. Played linearly, the sprite crossing the wire
 * is on screen for a thirtieth of the loop, and the browser check confirmed the result
 * empirically -- the canvas was blank in every sample taken.
 *
 * So linear playback of one request does not show the journey. The options were:
 *
 *   Leave it linear, and ship an animation that is blank almost always.
 *   Warp time, and be explicit that the timeline is non-linear.
 *
 * The second is honest ONLY under two conditions, both of which hold here:
 *
 *   1. Focus mode follows a single request, so the playback makes no claim about what
 *      else was happening at the same instant. There is no simultaneity left to break.
 *      This is exactly why ambient mode is never warped -- there, the claim is real.
 *
 *   2. The true durations remain on screen, to scale, in the waterfall next to it, and
 *      each bar is labelled with its real time. The animation shows the SHAPE of the
 *      journey; the waterfall remains the source of truth for its PROPORTIONS.
 *
 * The compression is a power law rather than a floor: every segment's share of wall time
 * is its true duration raised to `GAMMA`. That keeps the ordering intact and keeps
 * longer things longer -- a 99% visit still dominates -- while lifting a sub-millisecond
 * hop from invisible to perceptible.
 */
const GAMMA = 0.4;

export interface TimeWarp {
  /** Simulated ms at playback fraction `f` in [0,1]. */
  simAt(f: number): number;
  /** Playback fraction for a simulated time, the inverse. */
  fractionAt(simMs: number): number;
  /** False when playback is plain linear simulated time. */
  nonLinear: boolean;
  /** How much the most compressed segment was stretched, for disclosure. */
  maxStretch: number;
  /**
   * The segments the timeline was divided into, with each one's true duration and the
   * share of playback it receives. Exposed so the distortion can be inspected and
   * asserted on rather than taken on trust.
   */
  segments: Array<{ startMs: number; endMs: number; share: number }>;
}

export const linearWarp = (startMs: number, endMs: number): TimeWarp => ({
  simAt: (f) => startMs + (endMs - startMs) * Math.max(0, Math.min(1, f)),
  fractionAt: (t) => (endMs > startMs ? (t - startMs) / (endMs - startMs) : 0),
  nonLinear: false,
  maxStretch: 1,
  segments: [{ startMs, endMs, share: 1 }],
});

/**
 * Build a warp for one request, giving each phase of its journey visible time.
 *
 * Segment boundaries are every instant at which something about the request changes --
 * a hop starting or ending, a station taking it or releasing it -- so no segment
 * straddles an event, and nothing can be skipped over.
 */
export function buildFocusWarp(prepared: PreparedTrace, span: RequestSpan): TimeWarp {
  const marks = new Set<number>([span.startMs, span.endMs]);
  for (const i of span.hops) {
    marks.add(prepared.trace.hops[i]!.tStart);
    marks.add(prepared.trace.hops[i]!.tEnd);
  }
  for (const i of span.visits) {
    const v = prepared.trace.visits[i]!;
    marks.add(v.tEnqueue);
    marks.add(v.tExit);
    // Service start matters too: it is the boundary between queueing and work, and the
    // chip changes colour there.
    if (v.tServiceStart !== null) marks.add(v.tServiceStart);
  }

  const bounds = [...marks].filter((m) => m >= span.startMs && m <= span.endMs).sort((a, b) => a - b);
  if (bounds.length < 2) return linearWarp(span.startMs, span.endMs);

  const durations: number[] = [];
  const weights: number[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const d = bounds[i]! - bounds[i - 1]!;
    durations.push(d);
    weights.push(Math.pow(Math.max(d, 1e-6), GAMMA));
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalDuration = bounds[bounds.length - 1]! - bounds[0]!;
  if (totalWeight <= 0 || totalDuration <= 0) return linearWarp(span.startMs, span.endMs);

  // Cumulative playback fraction at each boundary.
  const cum = [0];
  for (const w of weights) cum.push(cum[cum.length - 1]! + w / totalWeight);

  let maxStretch = 1;
  for (let i = 0; i < durations.length; i++) {
    const trueShare = durations[i]! / totalDuration;
    const shownShare = weights[i]! / totalWeight;
    if (trueShare > 0) maxStretch = Math.max(maxStretch, shownShare / trueShare);
  }

  return {
    simAt(f) {
      const clamped = Math.max(0, Math.min(1, f));
      let i = 0;
      while (i < cum.length - 2 && cum[i + 1]! < clamped) i++;
      const lo = cum[i]!;
      const hi = cum[i + 1]!;
      const within = hi > lo ? (clamped - lo) / (hi - lo) : 0;
      return bounds[i]! + (bounds[i + 1]! - bounds[i]!) * within;
    },
    fractionAt(t) {
      const clamped = Math.max(bounds[0]!, Math.min(bounds[bounds.length - 1]!, t));
      let i = 0;
      while (i < bounds.length - 2 && bounds[i + 1]! < clamped) i++;
      const lo = bounds[i]!;
      const hi = bounds[i + 1]!;
      const within = hi > lo ? (clamped - lo) / (hi - lo) : 0;
      return cum[i]! + (cum[i + 1]! - cum[i]!) * within;
    },
    nonLinear: maxStretch > 1.5,
    maxStretch,
    segments: weights.map((w, i) => ({
      startMs: bounds[i]!,
      endMs: bounds[i + 1]!,
      share: w / totalWeight,
    })),
  };
}
