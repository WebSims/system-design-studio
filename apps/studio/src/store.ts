import { create } from "zustand";
import { produce } from "immer";
import { previewDesign, type DesignPreview } from "@sds/analytic";
import type { RunResult } from "@sds/core";
import {
  DesignSchema,
  migrateAndParse,
  validateDesign,
  type Design,
  type DesignIssue,
  type SdsNode,
} from "@sds/schema";
import { defaultDesign } from "@sds/models";
import { runInWorker } from "./engine/client";

const LS_KEY = "sds.design.v1";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

interface StudioState {
  design: Design;
  issues: DesignIssue[];
  /**
   * Closed-form estimate, recomputed synchronously on every edit.
   *
   * It costs microseconds, so there is no reason to debounce it or push it to the
   * worker. This is the live half of the hybrid: instant feedback while dragging,
   * with the full simulation reserved for Run.
   */
  preview: DesignPreview;
  run: RunResult | null;
  running: boolean;
  /** Set when the last Run threw, e.g. an unsupported topology. */
  error: string | null;
  /** True when the design changed after the displayed run, so it is now stale. */
  runStale: boolean;
  selection: Selection;

  select: (s: Selection) => void;
  edit: (fn: (d: Design) => void) => void;
  moveNode: (id: string, x: number, y: number) => void;
  loadDesign: (design: Design) => void;
  execute: () => Promise<void>;
  importDesign: (json: string) => void;
  exportDesign: () => string;
}

function recompute(design: Design): { preview: DesignPreview; issues: DesignIssue[] } {
  const issues = validateDesign(design);
  let preview: DesignPreview;
  try {
    preview = previewDesign(design);
  } catch {
    // A malformed intermediate state during editing must not crash the app.
    preview = {
      stable: true,
      bottleneckNodeId: null,
      bottleneckUtilization: 0,
      offeredRatePerSec: 0,
      throughputPerSec: 0,
      nodes: [],
      classes: [],
      endToEndMeanMs: null,
      endToEndP99Ms: null,
      meanIsLowerBound: false,
      p99Reason: "design is incomplete",
      approximate: false,
      asyncBacklogWarning: null,
      edges: [],
      retryAmplification: 1,
      retryStormWarning: null,
      converged: true,
      iterations: 0,
      notes: [],
    };
  }
  return { preview, issues };
}

function load(): Design {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return migrateAndParse(JSON.parse(raw));
  } catch {
    // A saved design from an incompatible build must not brick the app. The
    // migration path exists precisely so this is recoverable; falling back to the
    // default is the safe outcome when it is not.
  }
  return defaultDesign();
}

function persist(design: Design): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(design));
  } catch {
    // Storage full or blocked; not worth interrupting the user over.
  }
}

const initial = load();

export const useStudio = create<StudioState>((set, get) => ({
  design: initial,
  ...recompute(initial),
  run: null,
  running: false,
  error: null,
  runStale: false,
  selection: null,

  select: (selection) => set({ selection }),

  edit: (fn) =>
    set((state) => {
      const next = produce(state.design, fn);
      persist(next);
      return {
        design: next,
        ...recompute(next),
        // Any edit invalidates the displayed run. Saying so is better than
        // silently showing measurements of a system that no longer exists.
        runStale: state.run !== null,
      };
    }),

  /**
   * Position changes are stored but deliberately do NOT mark the run stale or
   * recompute the preview: geometry has no effect on the model, and treating a
   * drag as a model change would flash "stale" over a perfectly valid result.
   */
  moveNode: (id, x, y) =>
    set((state) => {
      const next = produce(state.design, (d: Design) => {
        const n = d.nodes.find((m: SdsNode) => m.id === id);
        if (n) {
          n.x = Math.round(x);
          n.y = Math.round(y);
        }
      });
      persist(next);
      return { design: next };
    }),

  loadDesign: (d) => {
    persist(d);
    set({ design: d, ...recompute(d), run: null, runStale: false, error: null, selection: null });
  },

  execute: async () => {
    const { design } = get();
    set({ running: true, error: null });
    try {
      const result = await runInWorker(design);
      set({ run: result, running: false, runStale: false, error: null });
    } catch (e) {
      set({
        running: false,
        run: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  importDesign: (json) => {
    const d = migrateAndParse(JSON.parse(json));
    persist(d);
    set({ design: d, ...recompute(d), run: null, runStale: false, error: null, selection: null });
  },

  exportDesign: () => JSON.stringify(DesignSchema.parse(get().design), null, 2),
}));
