import { create } from "zustand";
import { produce } from "immer";
import { previewDesign, type DesignPreview } from "@sds/analytic";
import type { RunResult } from "@sds/core";
import {
  blankDesign,
  DesignSchema,
  migrateAndParse,
  performanceCalibration,
  validateDesign,
  type Design,
  type DesignIssue,
  type SdsNode,
} from "@sds/schema";
import { useStudyStore } from "./study/store";
import {
  analyzeInWorker,
  compareInWorker,
  replicateInWorker,
  runInWorker,
  type ComparisonSummary,
  type FullAnalysis,
  type ReplicationSummary,
} from "./engine/client";

/**
 * The DESIGN store: everything about editing and measuring one architecture.
 *
 * IT NO LONGER OWNS THE DESIGN.
 *
 * The study store does. This one holds a mirror of the ACTIVE candidate's design plus all the
 * per-design derived state -- validation, the closed-form preview, the last run, the analysis, the
 * baseline comparison -- and forwards every edit to the study store, which is the single writer.
 *
 * The alternative was two stores that each owned a design and synchronised, which is a two-way
 * binding, and a two-way binding between a canvas and a document is how a studio ends up with a
 * node the inspector shows and the engine does not. One writer, one subscription, one direction.
 *
 * The practical benefit is that the canvas, the inspector and the results rail are untouched:
 * they read `design`, call `edit`, and neither knows a study exists.
 */

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

/** The active candidate's design, or an empty one while a study is still loading. */
function activeDesign(): Design {
  const study = useStudyStore.getState().study;
  const active =
    study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0];
  return active ? active.design : blankDesign();
}

/** Refuse numeric results for a repository reconstruction whose timing inputs are still guesses. */
function performanceCalibrationError(): string | null {
  const study = useStudyStore.getState().study;
  const candidate =
    study.candidates.find((item) => item.id === study.activeCandidateId) ?? study.candidates[0];
  if (!candidate) return "Create a version before running performance analysis.";
  const calibration = performanceCalibration(study, candidate);
  return calibration.calibrated
    ? null
    : `${calibration.message} Load results stay unavailable until those inputs are measured.`;
}

/**
 * Forward an edit to the study store.
 *
 * Immer is applied here rather than there because `edit` takes a mutating recipe -- which is what
 * every call site in the inspector is written against -- while the study store takes a pure
 * function. Converting at the boundary keeps two thousand lines of inspector code unchanged.
 */
function forwardEdit(fn: (d: Design) => void): void {
  useStudyStore.getState().editActive((design) => produce(design, fn));
}

const initial = activeDesign();

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

  edit: (fn) => {
    forwardEdit(fn);
    // The subscription below writes `design` and the derived state. What is set here is only the
    // staleness, because that is knowledge this store has and the study store does not: it is the
    // one holding the run that just became a measurement of a system that no longer exists.
    set((state) => ({
      runStale: state.run !== null,
      analysisStale: state.analysis !== null,
      replication: null,
      comparison: null,
    }));
  },

  /**
   * Position changes are stored but deliberately do NOT mark the run stale or
   * recompute the preview: geometry has no effect on the model, and treating a
   * drag as a model change would flash "stale" over a perfectly valid result.
   */
  moveNode: (id, x, y) => {
    forwardEdit((d: Design) => {
      const n = d.nodes.find((m: SdsNode) => m.id === id);
      if (n) {
        n.x = Math.round(x);
        n.y = Math.round(y);
      }
    });
  },

  loadDesign: (d) => {
    useStudyStore.getState().editActive(() => d);
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
    const calibrationError = performanceCalibrationError();
    if (calibrationError) {
      set({ running: false, run: null, error: calibrationError });
      return;
    }
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
    const calibrationError = performanceCalibrationError();
    if (calibrationError) {
      set({ analysing: false, analysis: null, error: calibrationError });
      return;
    }
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
    const calibrationError = performanceCalibrationError();
    if (calibrationError) {
      set({ replicating: false, replication: null, error: calibrationError });
      return;
    }
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
    const calibrationError = performanceCalibrationError();
    if (calibrationError) {
      set({ comparing: false, comparison: null, error: calibrationError });
      return;
    }
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
    useStudyStore.getState().editActive(() => d);
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

/**
 * Mirror the active candidate's design into this store.
 *
 * A single subscription, running in one direction. `moveNode` deliberately reaches here too even
 * though geometry has no model effect: recomputing a preview on a drag costs microseconds, and the
 * alternative -- a second path that skips it -- is how a mirror drifts from its source.
 */
useStudyStore.subscribe((state, previous) => {
  const study = state.study;
  const active =
    study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0];
  if (!active) return;

  const previousActive =
    previous.study.candidates.find((c) => c.id === previous.study.activeCandidateId) ??
    previous.study.candidates[0];

  if (previousActive && previousActive.design === active.design) return;

  const switchedCandidate = previousActive?.id !== active.id;
  useStudio.setState({
    design: active.design,
    ...recompute(active.design),
    // Switching candidate is not an edit; it is a different subject. Carrying the previous
    // candidate's run forward and labelling it stale would be worse than clearing it, because a
    // greyed-out number still anchors a reader.
    ...(switchedCandidate
      ? { run: null, runStale: false, analysis: null, analysisStale: false, replication: null, comparison: null, selection: null }
      : {}),
  });
});
