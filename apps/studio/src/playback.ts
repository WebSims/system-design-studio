import { create } from "zustand";
import type { OccupancyFrame } from "./canvas/choreography";

/**
 * Trace playback state, kept in a SEPARATE store from the design.
 *
 * THIS SEPARATION IS LOAD-BEARING.
 *
 * React Flow re-renders its nodes when the `nodes` array changes identity. If per-frame
 * animation state -- which requests are currently at which station -- were pushed
 * through node data, every frame would re-render the entire graph. The original build
 * was reaching for this with its `_dirty` batching flag; here the boundary is
 * structural instead of manual.
 *
 * The sprite canvas owns the clock and draws at 60fps without React involvement at all.
 * It publishes here at a low rate purely so the transport readout and the per-node
 * occupancy chips can subscribe with narrow selectors. Nothing that re-renders here
 * touches the flow graph.
 */

/**
 * How playback maps simulated time onto wall time.
 *
 * A real design spans four orders of magnitude of duration -- a quarter-millisecond
 * network hop next to a two-second timeout -- and no single linear timescale shows
 * both. Rather than quietly stretching short events, which would put two sprites on
 * screen at different simulated instants, the two honest options are offered
 * separately:
 *
 *   `ambient` plays simulated time linearly. Everything on screen is at the same
 *   instant. On a design whose durations differ wildly, the fast hops are a blur.
 *
 *   `focus` follows ONE request and stretches its whole span to a few seconds. It
 *   claims nothing about simultaneity across requests, which is exactly why it can be
 *   stretched without lying -- and following one request end to end is what the
 *   identicon lineage was always for.
 */
export type PlaybackMode = "ambient" | "focus";

interface PlaybackState {
  playing: boolean;
  /** Simulated ms into the trace. */
  tMs: number;
  /** Playback rate relative to simulated time, used in ambient mode. */
  speed: number;
  mode: PlaybackMode;
  /** The request being followed in focus mode. */
  focusRequestId: number | null;
  /** Wall seconds a focused request's span is stretched to fill. */
  focusDurationSec: number;
  /** Occupancy per node, derived from the trace. Published at ~10Hz. */
  occupancy: Record<string, OccupancyFrame>;
  /** Sprites currently on a wire. Surfaced because "nothing in flight" is a real state
   *  a viewer needs to distinguish from a broken animation. */
  inFlight: number;

  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  setMode: (mode: PlaybackMode) => void;
  setFocus: (requestId: number | null) => void;
  setFocusDuration: (seconds: number) => void;
  seek: (tMs: number) => void;
  /** Called by the canvas, throttled. Not a per-frame React update. */
  publish: (tMs: number, occupancy: Record<string, OccupancyFrame>, inFlight: number) => void;
  reset: () => void;
}

export const usePlayback = create<PlaybackState>((set) => ({
  playing: false,
  tMs: 0,
  // 1x is unwatchable on a real design: a network hop is a few hundred microseconds
  // inside a run that lasts minutes, so at 1x the canvas is empty essentially all the
  // time. The default slows simulated time by 1000x rather than stretching events,
  // which would break simultaneity.
  speed: 0.01,
  // Focus mode by default, for the same reason. Ambient playback of a heavily sampled
  // trace shows a sprite a fraction of a percent of the time -- accurate, but it reads
  // as a broken animation. Following one request shows the design working immediately.
  mode: "focus",
  focusRequestId: null,
  focusDurationSec: 6,
  occupancy: {},
  inFlight: 0,

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),
  setMode: (mode) => set({ mode, playing: true }),
  setFocus: (focusRequestId) => set({ focusRequestId, mode: "focus", playing: true }),
  setFocusDuration: (focusDurationSec) => set({ focusDurationSec }),
  seek: (tMs) => set({ tMs }),
  publish: (tMs, occupancy, inFlight) => set({ tMs, occupancy, inFlight }),
  reset: () =>
    set({
      playing: false,
      tMs: 0,
      occupancy: {},
      inFlight: 0,
      mode: "focus",
      focusRequestId: null,
    }),
}));
