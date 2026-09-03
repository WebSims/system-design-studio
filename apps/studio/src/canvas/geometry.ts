import type { SdsNode } from "@sds/schema";

/**
 * Canvas geometry, shared by the node components and the sprite layer.
 *
 * Both need to agree on exactly where a request's occupancy chip sits, because the
 * choreography depends on it: a sprite launches out of a specific slot, travels the
 * pipe, and docks into a specific slot at the other end. If the two disagreed by a
 * few pixels the motion would visibly jump at each handoff.
 *
 * Everything here is computed from the design, never measured from rendered DOM. The
 * original build recovered these positions with `querySelector` plus a
 * `getScreenCTM().inverse()` per sprite per frame, which was both expensive and
 * dependent on render timing -- a sprite could animate from the wrong place on its
 * first frame because the element it wanted to measure did not exist yet. Deriving
 * them means the geometry is available before the first paint.
 */

export const NODE_WIDTH = 216;
/**
 * Tall enough for a head, a summary line, a utilisation bar, a row of state chips and the occupancy
 * strip. Fixed so React Flow never re-measures during playback; see `nodes.tsx`.
 */
export const NODE_HEIGHT = 150;

/** Occupancy chips: how many fit, and where they sit inside the node box. */
export const MAX_CHIPS = 7;
export const CHIP_SIZE = 16;
export const CHIP_GAP = 4;
export const STRIP_LEFT = 10;
/** Distance from the node's top edge to the top of the chip strip. */
export const STRIP_TOP = NODE_HEIGHT - CHIP_SIZE - 10;

/**
 * Lateral offset of the two lanes, in world units.
 *
 * Requests travel one side of the pipe and responses the other, so a busy edge reads
 * as two streams rather than one confused one. Carried over from the original, where
 * it was one of the details that made a dense graph legible.
 */
export const LANE = 7;

export interface Point {
  x: number;
  y: number;
}

/** Centre of occupancy chip `index` at a node, in world coordinates. */
export function chipCenter(node: { x: number; y: number }, index: number): Point {
  const i = Math.max(0, Math.min(MAX_CHIPS - 1, index));
  return {
    x: node.x + STRIP_LEFT + CHIP_SIZE / 2 + i * (CHIP_SIZE + CHIP_GAP),
    y: node.y + STRIP_TOP + CHIP_SIZE / 2,
  };
}

/** Where an outgoing edge leaves a node: the right-hand handle. */
export function sourceMouth(node: { x: number; y: number }): Point {
  return { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 };
}

/** Where an incoming edge arrives: the left-hand handle. */
export function targetMouth(node: { x: number; y: number }): Point {
  return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
}

/**
 * The cubic React Flow draws between two horizontal handles.
 *
 * Reproduced rather than read back from the rendered path, so the sprite layer needs no
 * DOM access at all. The control-point offset matches `getBezierPath`'s behaviour for
 * left/right handles, so sprites sit on the line the user actually sees.
 */
export function edgeCurve(from: SdsNode, to: SdsNode): CubicPath {
  const s = sourceMouth(from);
  const t = targetMouth(to);
  const dx = Math.max(40, Math.abs(t.x - s.x) * 0.5);
  return new CubicPath(s, { x: s.x + dx, y: s.y }, { x: t.x - dx, y: t.y }, t);
}

/**
 * A cubic Bezier that can be sampled by arc length.
 *
 * Evaluated analytically rather than by asking an SVG path element for
 * `getPointAtLength`. That matters for three reasons: it needs no DOM, so the
 * choreography is testable and can be computed before the first paint; it needs no
 * detached element per edge; and it is exact rather than dependent on a browser's path
 * implementation.
 *
 * Sampling at uniform `t` would NOT do -- a cubic's parameter is not proportional to
 * distance, so a sprite would visibly speed up through the middle of a curved pipe and
 * crawl at the ends. The lookup table inverts arc length to parameter, which is the
 * same correction `getPointAtLength` performs internally.
 */
const LUT_STEPS = 24;

export class CubicPath {
  private readonly lut: number[];
  readonly length: number;

  constructor(
    private readonly p0: Point,
    private readonly p1: Point,
    private readonly p2: Point,
    private readonly p3: Point
  ) {
    // Cumulative chord length at each of LUT_STEPS + 1 uniform parameter values.
    this.lut = [0];
    let total = 0;
    let prev = p0;
    for (let i = 1; i <= LUT_STEPS; i++) {
      const pt = this.at(i / LUT_STEPS);
      total += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      this.lut.push(total);
      prev = pt;
    }
    this.length = total;
  }

  /** The point at parameter `t`, which is not proportional to distance. */
  at(t: number): Point {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * this.p0.x + b * this.p1.x + c * this.p2.x + d * this.p3.x,
      y: a * this.p0.y + b * this.p1.y + c * this.p2.y + d * this.p3.y,
    };
  }

  /** The parameter at fractional arc length `f`, by inverting the table. */
  paramAtFraction(f: number): number {
    const target = Math.max(0, Math.min(1, f)) * this.length;
    if (this.length === 0) return 0;
    let lo = 0;
    while (lo < LUT_STEPS && this.lut[lo + 1]! < target) lo++;
    const spanStart = this.lut[lo]!;
    const spanEnd = this.lut[lo + 1] ?? spanStart;
    const within = spanEnd > spanStart ? (target - spanStart) / (spanEnd - spanStart) : 0;
    return (lo + within) / LUT_STEPS;
  }

  /** The point at fractional arc length `f`, offset into lane `side`. */
  pointAtFraction(f: number, side: number): Point {
    const t = this.paramAtFraction(f);
    const here = this.at(t);
    const ahead = this.at(Math.min(1, t + 0.01));
    // At the very end there is nothing ahead, so take the direction from behind.
    const behind = this.at(Math.max(0, t - 0.01));
    return t >= 1 ? laneOffset(here, { x: 2 * here.x - behind.x, y: 2 * here.y - behind.y }, side) : laneOffset(here, ahead, side);
  }
}

/**
 * Offset a point perpendicular to the local direction of travel.
 *
 * `side` is +1 for the request lane and -1 for the response lane.
 */
export function laneOffset(at: Point, ahead: Point, side: number, amount = LANE): Point {
  let tx = ahead.x - at.x;
  let ty = ahead.y - at.y;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  // Perpendicular, rotated a quarter turn.
  return { x: at.x + -ty * amount * side, y: at.y + tx * amount * side };
}

export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Ease-out, so a sprite decelerates into its slot rather than arriving abruptly. */
export function easeOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) * (1 - clamped);
}
