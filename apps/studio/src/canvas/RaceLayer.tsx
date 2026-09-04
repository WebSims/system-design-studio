import { useStore } from "@xyflow/react"
import { useEffect, useRef } from "react"
import { useRaceModel } from "../raceModel"
import { useRacePlayback } from "../racePlayback"
import { usePrefersReducedMotion } from "../reducedMotion"
import { laneColour, sampleRace, type RacePlan } from "./race"

/**
 * THE RACE PLAYER.
 *
 * Sibling of `PacketLayer`, and the same shape: a Canvas2D overlay that observes a finished result
 * and draws where things are. The result here is a counterexample rather than a trace, so the clock
 * is a step index plus a fraction through the step, and "where things are" is which actor is at
 * which node doing what.
 *
 * Sub-step progress is a ref. It changes every frame and must never become React state: the only
 * thing published is the step cursor, once per step, which is what the state chips and the timeline
 * subscribe to.
 */

const SPRITE = 18
/** Midway through the hold phase of a step; see `sampleRace`. */
const PAUSED_PROGRESS = 0.55

export function RaceLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transform = useStore((s) => s.transform)
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const plan = useRaceModel((s) => s.plan)
  const cursor = useRacePlayback((s) => s.cursor)
  const playing = useRacePlayback((s) => s.playing)
  const reducedMotion = usePrefersReducedMotion()

  const progressRef = useRef(0)
  const lastWallRef = useRef(0)
  const transformRef = useRef(transform)
  transformRef.current = transform
  const planRef = useRef<RacePlan | null>(plan)
  planRef.current = plan
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

  // A scrub, step, or newly loaded counterexample starts at a stable phase instead of
  // inheriting a fraction from the previously viewed step.
  useEffect(() => {
    progressRef.current = 0
  }, [cursor, plan])

  useEffect(() => {
    if (reducedMotion && playing) useRacePlayback.getState().pause()
  }, [playing, reducedMotion])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    lastWallRef.current = performance.now()

    const frame = (wall: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(64, wall - lastWallRef.current)
      lastWallRef.current = wall

      const playback = useRacePlayback.getState()
      const current = planRef.current

      if (current && playback.playing && !reducedMotionRef.current) {
        progressRef.current += dt / playback.stepMs
        if (progressRef.current >= 1) {
          progressRef.current = 0
          if (playback.cursor >= current.steps.length - 1) {
            playback.finished()
            progressRef.current = 1
          } else {
            useRacePlayback.setState({ cursor: playback.cursor + 1 })
          }
        }
      }

      // Paused, the acting sprite is shown AT its target: a scrubbed step reads as "a1 is at the
      // database doing this", which is the frame a reader stopped to look at.
      const progress = playback.playing ? progressRef.current : PAUSED_PROGRESS
      draw(ctx, canvas, current, playback.cursor, progress, transformRef.current, width, height)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [width, height])

  return (
    <canvas
      ref={canvasRef}
      className="packet-layer race-layer"
      style={{ pointerEvents: "none" }}
      role="img"
      aria-label="Counterexample request flow on the architecture canvas"
    />
  )
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  plan: RacePlan | null,
  cursor: number,
  progress: number,
  transform: [number, number, number],
  width: number,
  height: number
): void {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!plan || plan.steps.length === 0) return

  const [tx, ty, zoom] = transform
  ctx.translate(tx, ty)
  ctx.scale(zoom, zoom)

  // Before step 0 every actor rests at home; sample step 0 at progress 0 for that.
  const at = Math.max(0, cursor)
  const sprites = sampleRace(plan, at, cursor < 0 ? 0 : progress)
  const step = plan.steps[at]
  const half = SPRITE / 2

  for (const s of sprites) {
    if (s.environment) continue
    const colour = laneColour(s.laneIndex)
    const x = s.position.x - half
    const y = s.position.y - half

    if (s.acting && s.emphasis > 0) {
      ctx.globalAlpha = 0.35 * s.emphasis
      ctx.fillStyle = colour
      ctx.beginPath()
      ctx.arc(s.position.x, s.position.y, half + 6 + 6 * s.emphasis, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }

    ctx.fillStyle = colour
    roundRect(ctx, x, y, SPRITE, SPRITE, 5)
    ctx.fill()
    ctx.strokeStyle = s.acting ? "#f4f0e8" : "rgba(18,17,15,0.85)"
    ctx.lineWidth = s.acting ? 1.8 : 1.2
    ctx.stroke()

    ctx.fillStyle = "#12110f"
    ctx.font = `700 ${zoom > 0.6 ? 9.5 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(s.laneId.slice(0, 3), s.position.x, s.position.y + 0.5)
  }

  // A caption under the acting sprite: what this step is. The timeline has the full text; this is
  // enough to follow the story without looking away from the drawing.
  if (step && cursor >= 0 && zoom > 0.45) {
    const actor = sprites.find((s) => s.acting && !s.environment)
    const anchor = actor?.position ?? null
    if (anchor) {
      const text = step.fault ? `\u26a0 ${step.label}` : step.label
      ctx.font = `500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
      const shown = text.length > 56 ? `${text.slice(0, 55)}\u2026` : text
      const tw = ctx.measureText(shown).width
      const px = anchor.x - tw / 2 - 7
      const py = anchor.y + half + 8
      ctx.fillStyle = step.fault ? "rgba(245,197,24,0.95)" : "rgba(35,32,27,0.96)"
      roundRect(ctx, px, py, tw + 14, 20, 5)
      ctx.fill()
      ctx.strokeStyle = step.fault ? "rgba(245,197,24,1)" : laneColour(step.laneIndex)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = step.fault ? "#12110f" : "#f4f0e8"
      ctx.textAlign = "left"
      ctx.textBaseline = "middle"
      ctx.fillText(shown, px + 7, py + 10.5)
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
