import { describe, expect, it } from "vitest";
import { runSimulation } from "@sds/core";
import { cachedReadPath } from "@sds/models";
import type { Design } from "@sds/schema";
import {
  buildFocusWarp,
  latestRenderableRequest,
  linearWarp,
  prepareTrace,
  sampleOccupancy,
  sampleSprites,
} from "../src/canvas/choreography";
import {
  CubicPath,
  MAX_CHIPS,
  chipCenter,
  edgeCurve,
  easeOut,
} from "../src/canvas/geometry";
import { errIcon, hopIcon, mutateIcon, rootIcon, visitIcon } from "../src/canvas/identicon";

/**
 * Tests for the visual layer.
 *
 * The point of testing an animation is not that it looks right -- only a browser can
 * say that, and the browser check is a separate step. It is that the animation cannot
 * assert anything the trace does not support. A sprite in the wrong place is a false
 * claim about where a request was, and these are the invariants that catch it.
 */

const design = cachedReadPath();

function traceOf(d: Design = design, seed = 7) {
  return runSimulation(d, { durationSec: 20, seed }).trace;
}

describe("cubic path arc-length sampling", () => {
  const path = new CubicPath({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 });

  it("measures a length at least the straight-line distance", () => {
    expect(path.length).toBeGreaterThan(Math.hypot(100, 100) - 1e-9);
  });

  it("samples at constant speed along arc length", () => {
    // The reason for the lookup table: uniform parameter would bunch samples at the
    // ends of a curve, making a sprite visibly surge through the middle of a pipe.
    const steps = 40;
    const gaps: number[] = [];
    let prev = path.pointAtFraction(0, 0);
    for (let i = 1; i <= steps; i++) {
      const pt = path.pointAtFraction(i / steps, 0);
      gaps.push(Math.hypot(pt.x - prev.x, pt.y - prev.y));
      prev = pt;
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const worst = Math.max(...gaps.map((g) => Math.abs(g - mean) / mean));
    // Uniform-t sampling on this curve is off by more than 40%; arc length holds
    // within a few percent.
    expect(worst).toBeLessThan(0.08);
  });

  it("offsets the two lanes to opposite sides", () => {
    const centre = path.pointAtFraction(0.5, 0);
    const request = path.pointAtFraction(0.5, 1);
    const response = path.pointAtFraction(0.5, -1);
    expect(Math.hypot(request.x - centre.x, request.y - centre.y)).toBeGreaterThan(5);
    // Symmetric about the centreline, so the pipe reads as two streams.
    expect(request.x + response.x).toBeCloseTo(2 * centre.x, 6);
    expect(request.y + response.y).toBeCloseTo(2 * centre.y, 6);
  });

  it("stays on the endpoints", () => {
    const start = path.pointAtFraction(0, 0);
    const end = path.pointAtFraction(1, 0);
    expect(start.x).toBeCloseTo(0, 6);
    expect(end.x).toBeCloseTo(100, 6);
    // A tangent taken past the end of the curve would produce NaN; the last point has
    // to fall back to the direction from behind it.
    expect(Number.isFinite(end.y)).toBe(true);
  });

  it("reproduces the edge the user sees", () => {
    const from = { id: "a", kind: "server", label: "A", x: 0, y: 0 } as never;
    const to = { id: "b", kind: "server", label: "B", x: 400, y: 120 } as never;
    const curve = edgeCurve(from, to);
    // Leaves the right-hand handle, arrives at the left-hand handle.
    expect(curve.pointAtFraction(0, 0).x).toBeCloseTo(216, 6);
    expect(curve.pointAtFraction(1, 0).x).toBeCloseTo(400, 6);
  });
});

describe("chip slots", () => {
  it("places slots inside the node box and in order", () => {
    const node = { x: 100, y: 200 } as never;
    const first = chipCenter(node, 0);
    const last = chipCenter(node, MAX_CHIPS - 1);
    expect(first.x).toBeGreaterThan(100);
    // Must not overflow the node, or a chip would sit outside the box it belongs to.
    expect(last.x).toBeLessThan(100 + 216);
    expect(last.x).toBeGreaterThan(first.x);
    expect(first.y).toBeCloseTo(last.y, 6);
  });

  it("clamps out-of-range indices rather than drawing off-node", () => {
    const node = { x: 0, y: 0 } as never;
    expect(chipCenter(node, 99)).toEqual(chipCenter(node, MAX_CHIPS - 1));
    expect(chipCenter(node, -3)).toEqual(chipCenter(node, 0));
  });
});

describe("slot assignment", () => {
  it("never gives one slot to two requests at the same instant", () => {
    // The invariant that makes the strip readable at all. If two visits shared a slot
    // while both were open, one identicon would be drawn over another and two sprites
    // would dock into the same chip.
    //
    // Checked per slot as a sweep rather than pairwise: within one slot the visits are
    // already in time order, so only neighbours can overlap.
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    let checkedSlots = 0;

    for (const [, rows] of prepared.byNode) {
      // Concurrency at each visit's start, to identify the documented overflow case.
      const starts = rows.map((r) => r.visit.tEnqueue).sort((a, b) => a - b);
      const exits = rows.map((r) => r.visit.tExit).sort((a, b) => a - b);
      const concurrencyAt = (t: number): number => {
        let began = 0;
        while (began < starts.length && starts[began]! <= t) began++;
        let ended = 0;
        while (ended < exits.length && exits[ended]! <= t) ended++;
        return began - ended;
      };

      for (let slot = 0; slot < MAX_CHIPS; slot++) {
        const inSlot = rows
          .filter((r) => r.slot === slot)
          .sort((a, b) => a.visit.tEnqueue - b.visit.tEnqueue);
        for (let i = 1; i < inSlot.length; i++) {
          const prev = inSlot[i - 1]!.visit;
          const next = inSlot[i]!.visit;
          if (next.tEnqueue >= prev.tExit) continue;
          // Overlap is permitted only once every slot was already taken.
          expect(concurrencyAt(next.tEnqueue)).toBeGreaterThan(MAX_CHIPS);
        }
        checkedSlots++;
      }
    }
    expect(checkedSlots).toBeGreaterThan(0);
  });

  it("assigns the same slots regardless of when it is asked", () => {
    // Scrubbing backwards must not rearrange the strip. Assigning slots in arrival
    // order at render time would; deriving them from the trace does not.
    const trace = traceOf();
    const a = prepareTrace(design, trace);
    const b = prepareTrace(design, trace);
    expect(a.visitSlots).toEqual(b.visitSlots);
  });

  it("keeps a request in one slot for the whole visit", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    const visit = trace.visits.find((v) => v.tExit - v.tEnqueue > 1);
    expect(visit).toBeDefined();
    const index = trace.visits.indexOf(visit!);
    const slot = prepared.visitSlots[index]!;

    // Sample across the visit; the chip must not move.
    for (let f = 0.05; f < 1; f += 0.1) {
      const t = visit!.tEnqueue + (visit!.tExit - visit!.tEnqueue) * f;
      const occ = sampleOccupancy(prepared, t, visit!.requestId);
      const chip = occ[visit!.nodeId]?.chips.find((c) => c.requestId === visit!.requestId);
      expect(chip?.slot).toBe(slot);
    }
  });
});

describe("live trace selection", () => {
  it("follows the newest renderable request instead of the longest historical one", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    const latest = latestRenderableRequest(prepared);
    const renderable = prepared.requests.filter(
      (request) => request.hops.length > 0 || request.visits.length > 0
    );
    const expected = renderable.reduce((current, request) =>
      request.endMs > current.endMs ||
      (request.endMs === current.endMs && request.requestId > current.requestId)
        ? request
        : current
    );

    expect(latest?.requestId).toBe(expected.requestId);
  });
});

describe("occupancy sampling", () => {
  it("reports no more chips than slots, and counts the overflow", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    for (let t = prepared.spanStartMs; t < prepared.spanEndMs; t += 37) {
      for (const frame of Object.values(sampleOccupancy(prepared, t, null))) {
        expect(frame.chips.length).toBeLessThanOrEqual(MAX_CHIPS);
        expect(frame.total).toBeGreaterThanOrEqual(frame.chips.length);
      }
    }
  });

  it("splits occupancy into service and queueing", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    let sawServing = false;
    for (let t = prepared.spanStartMs; t < prepared.spanEndMs; t += 13) {
      for (const frame of Object.values(sampleOccupancy(prepared, t, null))) {
        // The two together are the occupancy, scaled by the sampling rate.
        expect(frame.inService + frame.queued).toBe(frame.total);
        if (frame.inService > 0) sawServing = true;
      }
    }
    expect(sawServing).toBe(true);
  });

  it("scales sampled occupancy up to the real system", () => {
    // The trace is a sample. Reporting raw sampled counts would understate occupancy
    // by the sampling factor, which is the kind of quiet lie the whole project exists
    // to avoid. Focus mode shows one real request, so it must not be scaled.
    const trace = runSimulation(design, { durationSec: 20, seed: 3 }).trace;
    const prepared = prepareTrace(design, trace);
    if (trace.sampleEvery <= 1) return;

    const anyVisit = trace.visits.find((v) => v.tExit > v.tEnqueue)!;
    const t = (anyVisit.tEnqueue + anyVisit.tExit) / 2;
    const ambient = sampleOccupancy(prepared, t, null)[anyVisit.nodeId];
    const focused = sampleOccupancy(prepared, t, anyVisit.requestId)[anyVisit.nodeId];
    expect(ambient!.total).toBeGreaterThanOrEqual(focused!.total);
    expect(focused!.total).toBe(1);
  });

  it("shows a station as occupied exactly while the trace says it was", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    const visit = trace.visits.find((v) => v.tExit - v.tEnqueue > 2)!;

    const before = sampleOccupancy(prepared, visit.tEnqueue - 0.001, visit.requestId);
    const during = sampleOccupancy(prepared, (visit.tEnqueue + visit.tExit) / 2, visit.requestId);
    const after = sampleOccupancy(prepared, visit.tExit + 0.001, visit.requestId);

    expect(before[visit.nodeId]?.chips ?? []).toHaveLength(0);
    expect(during[visit.nodeId]!.chips.length).toBeGreaterThan(0);
    expect(after[visit.nodeId]?.chips ?? []).toHaveLength(0);
  });
});

describe("sprite sampling", () => {
  it("only draws a sprite while its hop is in flight", () => {
    // A sprite outside its hop's span is a claim that a request was on a wire when it
    // was not.
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    const hop = trace.hops[0]!;

    const before = sampleSprites(prepared, hop.tStart - 0.001, hop.requestId);
    const after = sampleSprites(prepared, hop.tEnd + 0.001, hop.requestId);
    expect(before.some((s) => s.edgeId === hop.edgeId)).toBe(false);
    expect(after.some((s) => s.edgeId === hop.edgeId)).toBe(false);

    const during = sampleSprites(prepared, (hop.tStart + hop.tEnd) / 2, hop.requestId);
    expect(during.some((s) => s.edgeId === hop.edgeId)).toBe(true);
  });

  it("produces finite positions across the whole trace", () => {
    // Stepped finely, because hops are sub-millisecond while the trace spans seconds.
    // That ratio is exactly why ambient playback at 1x looks empty and why focus mode
    // exists -- there is genuinely almost nothing on a wire at any given instant.
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    let seen = 0;
    const step = (prepared.spanEndMs - prepared.spanStartMs) / 20000;
    for (let t = prepared.spanStartMs; t < prepared.spanEndMs; t += step) {
      for (const s of sampleSprites(prepared, t, null)) {
        expect(Number.isFinite(s.position.x)).toBe(true);
        expect(Number.isFinite(s.position.y)).toBe(true);
        expect(s.opacity).toBeGreaterThanOrEqual(0);
        expect(s.opacity).toBeLessThanOrEqual(1);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it("launches from and docks into the slots the request occupies", () => {
    // The choreography claim: the sprite that leaves a chip is the request that was in
    // it, and it arrives in the chip held for it. Verified geometrically -- at the
    // start of a hop the sprite must be near the source's chip, and at the end near
    // the destination's.
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);

    let checked = 0;
    for (let i = 0; i < trace.hops.length && checked < 25; i++) {
      const hop = trace.hops[i]!;
      const anchors = prepared.hopAnchors[i]!;
      if (anchors.launch.kind !== "chip" || anchors.dock.kind !== "chip") continue;
      if (hop.tEnd - hop.tStart < 0.05) continue;

      const launchNode = prepared.nodes.get(anchors.launch.nodeId)!;
      const dockNode = prepared.nodes.get(anchors.dock.nodeId)!;
      const launchPoint = chipCenter(launchNode, anchors.launch.slot);
      const dockPoint = chipCenter(dockNode, anchors.dock.slot);

      const first = sampleSprites(prepared, hop.tStart + (hop.tEnd - hop.tStart) * 0.001, hop.requestId)
        .find((s) => s.edgeId === hop.edgeId)!;
      const last = sampleSprites(prepared, hop.tEnd - (hop.tEnd - hop.tStart) * 0.001, hop.requestId)
        .find((s) => s.edgeId === hop.edgeId)!;

      expect(Math.hypot(first.position.x - launchPoint.x, first.position.y - launchPoint.y))
        .toBeLessThan(4);
      expect(Math.hypot(last.position.x - dockPoint.x, last.position.y - dockPoint.y))
        .toBeLessThan(4);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("moves monotonically along the pipe while travelling", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    const hop = trace.hops.find((h) => h.forward && h.tEnd - h.tStart > 0.2 && h.delivered)!;
    const anchors = prepared.hopAnchors[trace.hops.indexOf(hop)]!;
    if (anchors.launch.kind !== "chip") return;

    // Sampled through the travel phase only, where the direction is unambiguous.
    let prev = -Infinity;
    for (let f = 0.3; f < 0.75; f += 0.05) {
      const t = hop.tStart + (hop.tEnd - hop.tStart) * f;
      const s = sampleSprites(prepared, t, hop.requestId).find((x) => x.edgeId === hop.edgeId)!;
      expect(s.position.x).toBeGreaterThan(prev - 1e-6);
      prev = s.position.x;
    }
  });

  it("puts requests and responses in different lanes", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    const forward = trace.hops.find((h) => h.forward && h.delivered)!;
    const back = trace.hops.find(
      (h) => !h.forward && h.edgeId === forward.edgeId && h.requestId === forward.requestId
    );
    if (!back) return;

    const mid = (h: typeof forward) =>
      sampleSprites(prepared, (h.tStart + h.tEnd) / 2, h.requestId).find(
        (s) => s.edgeId === h.edgeId
      )!;
    expect(mid(forward).forward).toBe(true);
    expect(mid(back).forward).toBe(false);
  });

  it("fades a dropped hop instead of letting it vanish", () => {
    // Loss has to be legible as an event. A sprite that simply stops existing reads as
    // a rendering glitch rather than a timeout.
    const dropped = {
      ...design,
      edges: design.edges.map((e, i) => (i === 0 ? { ...e, lossProbability: 0.9 } : e)),
    } as Design;
    const trace = runSimulation(dropped, { durationSec: 20, seed: 11 }).trace;
    const prepared = prepareTrace(dropped, trace);
    const lost = trace.hops.find((h) => !h.delivered);
    if (!lost) return;

    const early = sampleSprites(prepared, lost.tStart + (lost.tEnd - lost.tStart) * 0.1, lost.requestId)
      .find((s) => s.edgeId === lost.edgeId)!;
    const late = sampleSprites(prepared, lost.tEnd - (lost.tEnd - lost.tStart) * 0.02, lost.requestId)
      .find((s) => s.edgeId === lost.edgeId)!;
    expect(early.failed).toBe(true);
    expect(late.opacity).toBeLessThan(early.opacity);
  });
});

describe("request spans", () => {
  it("covers every hop and visit of a request", () => {
    const trace = traceOf();
    const prepared = prepareTrace(design, trace);
    for (const span of prepared.requests.slice(0, 20)) {
      for (const i of span.hops) {
        expect(trace.hops[i]!.tStart).toBeGreaterThanOrEqual(span.startMs);
        expect(trace.hops[i]!.tEnd).toBeLessThanOrEqual(span.endMs);
      }
      for (const i of span.visits) {
        expect(trace.visits[i]!.tEnqueue).toBeGreaterThanOrEqual(span.startMs);
        expect(trace.visits[i]!.tExit).toBeLessThanOrEqual(span.endMs);
      }
    }
  });

  it("orders candidates by how much they have to show", () => {
    const prepared = prepareTrace(design, traceOf());
    const spans = prepared.requests.map((r) => r.endMs - r.startMs);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!).toBeLessThanOrEqual(spans[i - 1]! + 1e-9);
    }
  });

  it("flags a request that failed", () => {
    const flaky = {
      ...design,
      nodes: design.nodes.map((n) =>
        n.kind === "database" ? { ...n, failureProbability: 0.5 } : n
      ),
    } as Design;
    const trace = runSimulation(flaky, { durationSec: 20, seed: 5 }).trace;
    const prepared = prepareTrace(flaky, trace);
    expect(prepared.requests.some((r) => r.failed)).toBe(true);
  });
});

describe("identicons", () => {
  it("is deterministic in the request id", () => {
    expect(rootIcon(42).key).toBe(rootIcon(42).key);
    expect(rootIcon(42).key).not.toBe(rootIcon(43).key);
  });

  it("keeps lineage: a mutation is related but distinguishable", () => {
    const parent = rootIcon(9);
    const child = mutateIcon(parent, "edge-1");
    expect(child.key).not.toBe(parent.key);
    // Same request, so most of the pattern survives -- that is what makes a fan-out
    // readable as one call rather than several unrelated ones.
    const same = parent.grid.flat().filter((v, i) => v === child.grid.flat()[i]).length;
    expect(same).toBeGreaterThan(parent.grid.flat().length * 0.5);
  });

  it("gives the same icon to both legs of one call on one edge", () => {
    // A response is the same call coming back, not a new one; the ring conveys the
    // direction instead.
    expect(hopIcon(3, "e1", false).key).toBe(hopIcon(3, "e1", false).key);
    expect(hopIcon(3, "e1", false).key).not.toBe(hopIcon(3, "e2", false).key);
  });

  it("marks failure without losing identity", () => {
    const ok = hopIcon(3, "e1", false);
    const bad = hopIcon(3, "e1", true);
    expect(bad.error).toBe(true);
    expect(ok.error).toBe(false);
    expect(bad.key).not.toBe(ok.key);
  });

  it("derives a station icon distinctly from an edge icon", () => {
    expect(visitIcon(3, "node-a", false).key).not.toBe(hopIcon(3, "node-a", false).key);
  });

  it("marks an error icon idempotently", () => {
    const once = errIcon(rootIcon(1));
    expect(errIcon(once).key).toBe(once.key);
  });
});

describe("easing", () => {
  it("is clamped and monotone", () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    // Decelerating: more than half the distance is covered in the first half of time.
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

describe("focus-mode time warp", () => {
  const trace = traceOf();
  const prepared = prepareTrace(design, trace);
  const span = prepared.requests[0]!;
  const warp = buildFocusWarp(prepared, span);

  it("covers exactly the request's span", () => {
    expect(warp.simAt(0)).toBeCloseTo(span.startMs, 6);
    expect(warp.simAt(1)).toBeCloseTo(span.endMs, 6);
  });

  it("is monotone, so playback never runs backwards", () => {
    // A non-monotone warp would show a request at a station it had already left.
    let prev = -Infinity;
    for (let f = 0; f <= 1; f += 0.002) {
      const t = warp.simAt(f);
      expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = t;
    }
  });

  it("inverts itself", () => {
    for (let f = 0; f <= 1; f += 0.05) {
      expect(warp.fractionAt(warp.simAt(f))).toBeCloseTo(f, 5);
    }
  });

  it("clamps outside its range rather than extrapolating", () => {
    expect(warp.simAt(-5)).toBeCloseTo(span.startMs, 6);
    expect(warp.simAt(9)).toBeCloseTo(span.endMs, 6);
  });

  it("preserves ordering of durations: longer phases still get more time", () => {
    // The compression must not invert the ranking, or the animation would imply a
    // network hop cost more than a database query.
    const byTrue = [...warp.segments].sort((a, b) => a.endMs - a.startMs - (b.endMs - b.startMs));
    for (let i = 1; i < byTrue.length; i++) {
      expect(byTrue[i]!.share).toBeGreaterThanOrEqual(byTrue[i - 1]!.share - 1e-9);
    }
  });

  it("keeps the shares a partition of playback", () => {
    const total = warp.segments.reduce((a, s) => a + s.share, 0);
    expect(total).toBeCloseTo(1, 9);
    // Segments must tile the span with no gaps, or playback would jump over an event.
    expect(warp.segments[0]!.startMs).toBeCloseTo(span.startMs, 6);
    expect(warp.segments[warp.segments.length - 1]!.endMs).toBeCloseTo(span.endMs, 6);
    for (let i = 1; i < warp.segments.length; i++) {
      expect(warp.segments[i]!.startMs).toBeCloseTo(warp.segments[i - 1]!.endMs, 9);
    }
  });

  it("still gives the dominant phase the largest share", () => {
    // Compression must not flatten the journey into uniform segments; the station where
    // the time actually goes has to remain visibly dominant.
    const longest = warp.segments.reduce((m, s) =>
      s.endMs - s.startMs > m.endMs - m.startMs ? s : m
    );
    const biggestShare = warp.segments.reduce((m, s) => (s.share > m.share ? s : m));
    expect(biggestShare.startMs).toBeCloseTo(longest.startMs, 9);
  });

  it("makes every phase of the journey perceptible", () => {
    // The problem it exists to solve, stated as a test: a hop that is 0.6% of a request
    // is on screen for under a frame at 6s of playback. Each phase must clear a frame.
    const frameShare = 1 / 360;
    let worst = 1;
    for (const i of span.hops) {
      const h = trace.hops[i]!;
      const shown = warp.fractionAt(h.tEnd) - warp.fractionAt(h.tStart);
      worst = Math.min(worst, shown);
    }
    expect(worst).toBeGreaterThan(frameShare);
  });

  it("declares itself non-linear when it has stretched anything", () => {
    // The disclosure the UI depends on. A warp that quietly distorted without saying so
    // would be the exact failure this project refuses.
    if (warp.maxStretch > 1.5) expect(warp.nonLinear).toBe(true);
    else expect(warp.nonLinear).toBe(false);
  });

  it("never warps ambient playback", () => {
    // Ambient shows many requests at once, so its simultaneity claim is real.
    const linear = linearWarp(100, 200);
    expect(linear.nonLinear).toBe(false);
    expect(linear.maxStretch).toBe(1);
    expect(linear.simAt(0.25)).toBeCloseTo(125, 9);
  });

  it("degenerates safely on a request with no duration", () => {
    const instant = { ...span, startMs: 5, endMs: 5, hops: [], visits: [] };
    const w = buildFocusWarp(prepared, instant);
    expect(Number.isFinite(w.simAt(0.5))).toBe(true);
    expect(Number.isFinite(w.fractionAt(5))).toBe(true);
  });
});
