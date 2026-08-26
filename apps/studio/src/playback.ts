import { create } from "zustand";

/**
 * Trace playback state, kept in a SEPARATE store from the design.
 *
 * THIS SEPARATION IS LOAD-BEARING.
 *
 * React Flow re-renders its nodes when the `nodes` array changes identity. If
 * per-frame animation state (which requests are currently at which station) were
 * pushed through node data, every frame would re-render the entire graph. The
 * legacy code was reaching for this with its `_dirty` batching flag
 * (engine.jsx:116); here the boundary is structural instead of manual.
 *
 * The packet canvas owns the clock and draws at 60fps without React involvement
 * at all. It publishes to this store at a low rate (~10Hz) purely so the small
 * transport readout and the per-node occupancy badges can subscribe with narrow
 * selectors. Nothing that re-renders here touches the flow graph.
 */
interface PlaybackState {
  playing: boolean;
  /** Simulated ms into the trace. */
  tMs: number;
  /** Playback rate relative to simulated time. */
  speed: number;
  /** Requests currently in service or queued, by node id. Derived from the trace. */
  occupancy: Record<string, { inService: number; queued: number }>;

  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  seek: (tMs: number) => void;
  /** Called by the canvas, throttled. Not a per-frame React update. */
  publish: (tMs: number, occupancy: PlaybackState["occupancy"]) => void;
  reset: () => void;
}

export const usePlayback = create<PlaybackState>((set) => ({
  playing: false,
  tMs: 0,
  speed: 1,
  occupancy: {},

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),
  seek: (tMs) => set({ tMs }),
  publish: (tMs, occupancy) => set({ tMs, occupancy }),
  reset: () => set({ playing: false, tMs: 0, occupancy: {} }),
}));
