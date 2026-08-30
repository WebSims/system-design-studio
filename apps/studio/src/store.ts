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
import {
  analyzeInWorker,
  compareInWorker,
  replicateInWorker,
  runInWorker,
  type ComparisonSummary,
  type FullAnalysis,
  type ReplicationSummary,
} from "./engine/client";

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
  /** Hundreds of simulations, so it runs on demand rather than on every edit. */
  analysis: FullAnalysis | null;
  analysing: boolean;
  analysisStale: boolean;
  /** Measured confidence intervals from independent seeds. */
  replication: ReplicationSummary | null;
  replicating: boolean;
  /**
   * A saved design to compare against.
   *
   * Held separately from the live design so a change can be evaluated against where
   * you started, which is the question anyone actually has.
   */
  baseline: Design | null;
  comparison: ComparisonSummary | null;
  comparing: boolean;
  selection: Selection;

  select: (s: Selection) => void;
  edit: (fn: (d: Design) => void) => void;
  moveNode: (id: string, x: number, y: number) => void;
  loadDesign: (design: Design) => void;
  execute: () => Promise<void>;
  analyze: () => Promise<void>;
  runReplications: (replications: number) => Promise<void>;
  saveBaseline: () => void;
  clearBaseline: () => void;
  compareToBaseline: (replications: number) => Promise<void>;
  importDesign: (json: string) => void;
  exportDesign: () => string;
}

function recompute(design: Design): { preview: DesignPreview; issues: DesignIssue[] } {
  const issues = validateDesign(design);
  let preview: DesignPreview;
  try {
    preview = previewDesign(design);
  } catch (err) {
    // A malformed intermediate state during editing must not crash the app. The reason
    // is carried through rather than swallowed: "design is incomplete" is right while a
    // node is half-built, but wrong and unhelpful when the real problem is a value the
    // solver refuses to evaluate, which the user can only fix if told.
    const reason =
      err instanceof Error && err.name === "IntractableError"
        ? err.message
        : "design is incomplete";
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
      p99Reason: reason,
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
  analysis: null,
  analysing: false,
  analysisStale: false,
  replication: null,
  replicating: false,
  baseline: null,
  comparison: null,
  comparing: false,
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
        analysisStale: state.analysis !== null,
        // Intervals and comparisons describe a design that no longer exists.
        replication: null,
        comparison: null,
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
    set({
      design: d,
      ...recompute(d),
      run: null,
      runStale: false,
      analysis: null,
      analysisStale: false,
      error: null,
      selection: null,
    });
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

  analyze: async () => {
    const { design } = get();
    set({ analysing: true, error: null });
    try {
      const analysis = await analyzeInWorker(design);
      set({ analysis, analysing: false, analysisStale: false });
    } catch (e) {
      set({
        analysing: false,
        analysis: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  runReplications: async (replications) => {
    const { design } = get();
    set({ replicating: true, error: null });
    try {
      const replication = await replicateInWorker(design, replications);
      set({ replication, replicating: false });
    } catch (e) {
      set({ replicating: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  saveBaseline: () => set({ baseline: get().design, comparison: null }),
  clearBaseline: () => set({ baseline: null, comparison: null }),

  compareToBaseline: async (replications) => {
    const { design, baseline } = get();
    if (!baseline) return;
    set({ comparing: true, error: null });
    try {
      const comparison = await compareInWorker(baseline, design, replications);
      set({ comparison, comparing: false });
    } catch (e) {
      set({ comparing: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  importDesign: (json) => {
    const d = migrateAndParse(JSON.parse(json));
    persist(d);
    set({
      design: d,
      ...recompute(d),
      run: null,
      runStale: false,
      analysis: null,
      analysisStale: false,
      error: null,
      selection: null,
    });
  },

  exportDesign: () => JSON.stringify(DesignSchema.parse(get().design), null, 2),
}));
