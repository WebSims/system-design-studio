import { create } from "zustand"

/**
 * Playback state for a counterexample on the canvas.
 *
 * Separate from the trace playback store for the same structural reason that one is separate from
 * the design: React Flow re-renders when node data changes, and the per-frame progress of a sprite
 * must never pass through node data. What is published here changes at most once per STEP (the
 * cursor), which is what the state chips and the swimlane timeline subscribe to. Sub-step progress
 * lives in a ref inside the race layer and is never React state.
 *
 * The cursor is the single source of truth shared by the canvas, the bottom-dock timeline and the
 * scrubber: all three read it, any of them may write it, so they cannot disagree about which step
 * is "now".
 */
interface RacePlaybackState {
  /** Index of the current step, or -1 for "before anything happened". */
  cursor: number
  playing: boolean
  /** Wall milliseconds one step takes when playing. */
  stepMs: number
  /** Total steps of the counterexample being played, so the dock can clamp. */
  length: number

  play: () => void
  pause: () => void
  toggle: () => void
  seek: (cursor: number) => void
  stepForward: () => void
  stepBack: () => void
  setStepMs: (ms: number) => void
  /** Called when a different counterexample arrives, or none. */
  load: (length: number) => void
  /** Called by the race layer when playback runs off the end. */
  finished: () => void
}

export const useRacePlayback = create<RacePlaybackState>((set) => ({
  cursor: -1,
  playing: false,
  stepMs: 1400,
  length: 0,

  play: () =>
    set((s) => ({
      playing: true,
      // Pressing play at the end restarts from the beginning rather than doing nothing.
      cursor: s.cursor >= s.length - 1 ? -1 : s.cursor,
    })),
  pause: () => set({ playing: false }),
  toggle: () =>
    set((s) =>
      s.playing
        ? { playing: false }
        : { playing: true, cursor: s.cursor >= s.length - 1 ? -1 : s.cursor }
    ),
  seek: (cursor) => set((s) => ({ cursor: Math.max(-1, Math.min(s.length - 1, cursor)), playing: false })),
  stepForward: () => set((s) => ({ cursor: Math.min(s.length - 1, s.cursor + 1), playing: false })),
  stepBack: () => set((s) => ({ cursor: Math.max(-1, s.cursor - 1), playing: false })),
  setStepMs: (stepMs) => set({ stepMs }),
  // Opens on the final state: the violation is the headline, and a person who wants the story
  // presses play.
  load: (length) => set({ length, cursor: length > 0 ? length - 1 : -1, playing: false }),
  finished: () => set((s) => ({ playing: false, cursor: s.length - 1 })),
}))
