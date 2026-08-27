import { useStore } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import type { Trace } from "@sds/core";
import type { Design } from "@sds/schema";
import { hopIcon, iconSprite } from "./identicon";
import { CHIP_SIZE } from "./geometry";
import {
  buildFocusWarp,
  linearWarp,
  prepareTrace,
  sampleOccupancy,
  sampleSprites,
  type PreparedTrace,
  type TimeWarp,
} from "./choreography";
import { usePlayback } from "../playback";

/**
 * THE TRACE PLAYER.
 *
 * The animation is a pure observer of a recorded trace. It cannot influence the
 * simulation, because the simulation already finished -- in a worker, before this
 * component saw anything. That inversion is the point of the rewrite: in the original
 * design the animation *was* the model, so the model could not run faster than 60fps,
 * could not exceed 150 concurrent packets, and could not run at all without a DOM.
 *
 * Consequences worth naming:
 *  - Playback speed and position are free. Scrub, pause, replay, follow one request.
 *  - The engine may simulate millions of requests while the player animates a sampled
 *    few thousand. Visual fidelity and statistical fidelity are no longer in
 *    competition, which is what lets the identicon choreography come back at all.
 *  - Canvas2D with a cached sprite per identicon, not one SVG element per packet. SVG
 *    sprites are precisely what forced the original's packet cap.
 */

const SPRITE_PX = 22;
const PUBLISH_INTERVAL_MS = 90;

export function PacketLayer({ design, trace }: { design: Design; trace: Trace | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The only coupling to React Flow, and it is a read of three numbers rather than a
  // measurement of the DOM.
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  const prepared = useMemo(
    () => (trace ? prepareTrace(design, trace) : null),
    [design, trace]
  );

  // Refs, not state: these change every frame and must never trigger a render.
  const tRef = useRef(0);
  /** Position through the warped timeline, in [0,1]. */
  const fRef = useRef(0);
  const lastWallRef = useRef(0);
  const lastPublishRef = useRef(0);
  const inFlightRef = useRef(0);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const preparedRef = useRef(prepared);
  preparedRef.current = prepared;

  // Reset the playhead whenever a new trace arrives.
  useEffect(() => {
    if (!prepared) return;
    tRef.current = prepared.spanStartMs;
    usePlayback.getState().seek(prepared.spanStartMs);
  }, [prepared]);

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

      const state = usePlayback.getState();
      const p = preparedRef.current;

      if (p) {
        const warp = warpFor(p, state.mode, state.focusRequestId);

        if (state.playing) {
          if (state.mode === "focus") {
            /**
             * Focus mode advances through the WARPED timeline at a constant rate, so the
             * whole journey fills `focusDurationSec` of wall time and each phase of it
             * gets a visible share. See `buildFocusWarp` for why this is defensible:
             * following one request makes no claim about simultaneity, and the true
             * durations stay on screen in the waterfall.
             */
            fRef.current += dtWall / (state.focusDurationSec * 1000);
            if (fRef.current > 1) fRef.current = 0;
            tRef.current = warp.simAt(fRef.current);
          } else {
            // Ambient mode is never warped: it shows many requests at once, so its
            // claim about simultaneity is real and must not be distorted.
            tRef.current += dtWall * state.speed;
            if (tRef.current > p.spanEndMs) tRef.current = p.spanStartMs;
            fRef.current = warp.fractionAt(tRef.current);
          }
        } else {
          // Honour an external scrub while paused.
          tRef.current = state.tMs;
          fRef.current = warp.fractionAt(state.tMs);
        }
      }

      const drawn = draw(
        ctx,
        canvas,
        p,
        tRef.current,
        state.mode === "focus" ? state.focusRequestId : null,
        transformRef.current,
        width,
        height
      );
      inFlightRef.current = drawn;

      if (wall - lastPublishRef.current > PUBLISH_INTERVAL_MS) {
        lastPublishRef.current = wall;
        usePlayback
          .getState()
          .publish(
            tRef.current,
            p
              ? sampleOccupancy(
                  p,
                  tRef.current,
                  state.mode === "focus" ? state.focusRequestId : null
                )
              : {},
            inFlightRef.current
          );
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [prepared, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="packet-layer"
      // Pointer events off: the animation is decoration over an interactive graph and
      // must never intercept a drag.
      style={{ pointerEvents: "none" }}
    />
  );
}

/** The timeline playback runs along: warped for one request, linear for the whole trace. */
export function warpFor(
  prepared: PreparedTrace,
  mode: "ambient" | "focus",
  focusRequestId: number | null
): TimeWarp {
  if (mode === "focus" && focusRequestId !== null) {
    const span = prepared.requests.find((r) => r.requestId === focusRequestId);
    if (span) return buildFocusWarp(prepared, span);
  }
  return linearWarp(prepared.spanStartMs, prepared.spanEndMs);
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  prepared: PreparedTrace | null,
  tMs: number,
  filterRequestId: number | null,
  transform: [number, number, number],
  width: number,
  height: number
): number {
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
  if (!prepared) return 0;

  const [tx, ty, zoom] = transform;
  ctx.translate(tx, ty);
  ctx.scale(zoom, zoom);

  const sprites = sampleSprites(prepared, tMs, filterRequestId);
  // Below this zoom an identicon is a smudge, so fall back to a dot. Drawing a 5x5
  // pattern into four pixels costs the same as drawing it into forty and communicates
  // nothing.
  const detailed = zoom > 0.45;
  const size = CHIP_SIZE + 4;

  for (const s of sprites) {
    ctx.globalAlpha = s.opacity;

    if (!detailed) {
      ctx.beginPath();
      ctx.arc(s.position.x, s.position.y, 4 / Math.max(0.4, zoom) + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = s.failed ? "#ed2923" : s.forward ? "#f0ede6" : "#6cb33e";
      ctx.fill();
      continue;
    }

    const icon = hopIcon(s.requestId, s.edgeId, s.failed);
    const sprite = iconSprite(icon, SPRITE_PX * 2);

    const x = s.position.x - size / 2;
    const y = s.position.y - size / 2;

    // The ring conveys direction and outcome, which the pattern cannot: a response is
    // the same call coming back, so it carries the same icon and a different ring.
    ctx.strokeStyle = s.failed ? "#ed2923" : s.forward ? "rgba(240,237,230,0.34)" : "#6cb33e";
    ctx.lineWidth = 1.6;
    roundRect(ctx, x - 2.5, y - 2.5, size + 5, size + 5, 5);
    ctx.stroke();

    ctx.drawImage(sprite, x, y, size, size);
  }

  ctx.globalAlpha = 1;
  return sprites.length;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
