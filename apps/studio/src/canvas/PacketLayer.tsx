import { useStore } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import type { Trace } from "@sds/core";
import type { Design } from "@sds/schema";
import { NODE_HEIGHT, NODE_WIDTH } from "./nodes";
import { usePlayback } from "../playback";

/**
 * THE TRACE PLAYER.
 *
 * The animation is a pure observer of a recorded trace. It cannot influence the
 * simulation, because the simulation already finished -- in a worker, before this
 * component saw anything. That inversion is the point of the rewrite: in the
 * legacy design the animation *was* the model, so the model could not run faster
 * than 60fps, could not exceed 150 concurrent packets (engine.jsx:92), and could
 * not run at all without a DOM.
 *
 * Consequences worth naming:
 *  - Playback speed is decoupled from simulated time. Scrub, pause, replay.
 *  - The engine may simulate millions of requests while the player animates a
 *    sampled few thousand. Visual fidelity and statistical fidelity are no longer
 *    in competition.
 *  - Canvas2D, not one SVG element per packet. SVG sprites are what forced the
 *    legacy packet cap in the first place.
 */

interface Geometry {
  /** Detached path element per edge, for `getPointAtLength`. */
  paths: Map<string, SVGPathElement>;
  nodeCenters: Map<string, { x: number; y: number }>;
}

/**
 * Build edge geometry directly from the design.
 *
 * Derived from node positions and the fixed node box rather than measured from
 * rendered DOM. There is nothing to query, nothing to invert, and no dependence
 * on render timing -- the geometry is available before the first paint.
 */
function buildGeometry(design: Design): Geometry {
  const paths = new Map<string, SVGPathElement>();
  const nodeCenters = new Map<string, { x: number; y: number }>();
  const byId = new Map(design.nodes.map((n) => [n.id, n]));

  for (const n of design.nodes) {
    nodeCenters.set(n.id, { x: n.x + NODE_WIDTH / 2, y: n.y + NODE_HEIGHT / 2 });
  }

  for (const e of design.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    // Handles sit at the vertical centre of the left and right edges, matching
    // Position.Left / Position.Right in the node components.
    const sx = from.x + NODE_WIDTH;
    const sy = from.y + NODE_HEIGHT / 2;
    const tx = to.x;
    const ty = to.y + NODE_HEIGHT / 2;
    // Same cubic React Flow's getBezierPath produces for horizontal handles.
    const dx = Math.max(40, Math.abs(tx - sx) * 0.5);
    const d = `M ${sx},${sy} C ${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", d);
    paths.set(e.id, el);
  }
  return { paths, nodeCenters };
}

interface Extent {
  start: number;
  end: number;
}

function traceExtent(trace: Trace): Extent {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const h of trace.hops) {
    if (h.tStart < start) start = h.tStart;
    if (h.tEnd > end) end = h.tEnd;
  }
  for (const v of trace.visits) {
    if (v.tEnqueue < start) start = v.tEnqueue;
    if (v.tExit > end) end = v.tExit;
  }
  if (!isFinite(start)) return { start: 0, end: 0 };
  return { start, end };
}

/** Stable pleasant hue per request id, so a request keeps its colour across hops. */
function hueFor(requestId: number): number {
  // Golden-ratio stepping spreads consecutive ids far apart in hue.
  return (requestId * 137.508) % 360;
}

const PUBLISH_INTERVAL_MS = 100;

export function PacketLayer({ design, trace }: { design: Design; trace: Trace | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Subscribing to the transform is the only coupling to React Flow, and it is a
  // read of three numbers rather than a measurement of the DOM.
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  const geometry = useMemo(() => buildGeometry(design), [design]);
  const extent = useMemo(() => (trace ? traceExtent(trace) : { start: 0, end: 0 }), [trace]);

  // Refs, not state: these change every frame and must never trigger a render.
  const tRef = useRef(extent.start);
  const lastWallRef = useRef(0);
  const lastPublishRef = useRef(0);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  useEffect(() => {
    tRef.current = extent.start;
    usePlayback.getState().seek(extent.start);
  }, [extent.start, trace]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    lastWallRef.current = performance.now();

    const frame = (wall: number) => {
      raf = requestAnimationFrame(frame);
      const dtWall = Math.min(64, wall - lastWallRef.current);
      lastWallRef.current = wall;

      const { playing, speed } = usePlayback.getState();
      const span = extent.end - extent.start;

      if (playing && trace && span > 0) {
        tRef.current += dtWall * speed;
        if (tRef.current > extent.end) tRef.current = extent.start;
      } else if (!playing) {
        // Honour an external scrub while paused.
        tRef.current = usePlayback.getState().tMs;
      }

      draw(ctx, canvas, trace, geometry, tRef.current, transformRef.current, width, height);

      if (wall - lastPublishRef.current > PUBLISH_INTERVAL_MS) {
        lastPublishRef.current = wall;
        usePlayback
          .getState()
          .publish(tRef.current, trace ? occupancyAt(trace, tRef.current) : {});
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [trace, geometry, extent.start, extent.end, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="packet-layer"
      // Pointer events off: the animation is decoration over an interactive graph
      // and must never intercept a drag.
      style={{ pointerEvents: "none" }}
    />
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  trace: Trace | null,
  geometry: Geometry,
  tMs: number,
  transform: [number, number, number],
  width: number,
  height: number
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!trace) return;

  const [tx, ty, zoom] = transform;
  ctx.translate(tx, ty);
  ctx.scale(zoom, zoom);

  const r = 4.5 / Math.max(0.4, zoom) + 1.5;

  for (const hop of trace.hops) {
    if (tMs < hop.tStart || tMs > hop.tEnd) continue;
    const path = geometry.paths.get(hop.edgeId);
    if (!path) continue;
    const span = hop.tEnd - hop.tStart;
    const progress = span <= 0 ? 1 : (tMs - hop.tStart) / span;
    let point: DOMPoint;
    try {
      point = path.getPointAtLength(path.getTotalLength() * progress);
    } catch {
      continue;
    }
    const hue = hueFor(hop.requestId);
    // A hop that will be dropped fades out as it travels, so loss is legible
    // rather than an event that simply stops happening.
    const alpha = hop.delivered ? 1 : 1 - progress * 0.85;
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hop.delivered
      ? `hsla(${hue}, 70%, 62%, ${alpha})`
      : `hsla(4, 80%, 58%, ${alpha})`;
    ctx.fill();
  }
}

/**
 * Occupancy per station at time `t`, derived entirely from the trace.
 *
 * A linear scan over a bounded, sampled trace (a few thousand visits at most).
 * Deliberately not indexed: correctness and legibility matter more here than
 * constant factors, and the whole structure fits in cache.
 */
function occupancyAt(
  trace: Trace,
  t: number
): Record<string, { inService: number; queued: number }> {
  const out: Record<string, { inService: number; queued: number }> = {};
  const bump = (nodeId: string, key: "inService" | "queued") => {
    const entry = (out[nodeId] ??= { inService: 0, queued: 0 });
    entry[key]++;
  };
  for (const v of trace.visits) {
    if (t < v.tEnqueue || t >= v.tExit) continue;
    const serviceStart = v.tServiceStart;
    if (serviceStart !== null && t >= serviceStart) bump(v.nodeId, "inService");
    else bump(v.nodeId, "queued");
  }
  // Scale by the sampling rate so the badge reflects the real system rather than
  // the sampled subset. Stated as an estimate in the UI for exactly this reason.
  if (trace.sampleEvery > 1) {
    for (const k of Object.keys(out)) {
      out[k]!.inService = Math.round(out[k]!.inService * trace.sampleEvery);
      out[k]!.queued = Math.round(out[k]!.queued * trace.sampleEvery);
    }
  }
  return out;
}
