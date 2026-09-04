import { create } from "zustand";
import { produce } from "immer";
import { previewDesign, type DesignPreview } from "@sds/analytic";
import type {
  RunResult,
  SimulationMode,
  SimulationSessionSnapshot,
  SimulationSessionUpdate,
} from "@sds/core";
import {
  blankDesign,
  contentHash,
  DesignSchema,
  migrateAndParse,
  performanceCalibration,
  validateDesign,
  type Design,
  type DesignIssue,
  type CanvasObject,
  type FailureEvent,
  type SdsNode,
} from "@sds/schema";
import { useStudyStore } from "./study/store";
import { syncAnalysisIssues } from "./study/issueSync";
import { executableDesignChanged } from "./engine/executableDesign";
import {
  analyzeInWorker,
  advanceSimulationEventsInWorker,
  advanceSimulationTimeInWorker,
  compareInWorker,
  createSimulationSessionInWorker,
  finalizeSimulationSessionInWorker,
  injectSimulationRequestInWorker,
  injectSimulationFailureInWorker,
  invalidateSimulationSessionInWorker,
  replicateInWorker,
  replaySimulationSessionInWorker,
  setSimulationPausedInWorker,
  setSimulationSourceInWorker,
  setSimulationSpeedInWorker,
  type ComparisonSummary,
  type FullAnalysis,
  type ReplicationSummary,
} from "./engine/client";
import {
  EMPTY_CANVAS_SELECTION,
  alignWorkspaceSelection,
  copyWorkspaceSelection,
  deleteWorkspaceSelection,
  distributeWorkspaceSelection,
  geometrySelectionCount,
  nudgeWorkspaceSelection,
  pasteWorkspaceSelection,
  selectionCount,
  selectionRemovalIds,
  type CanvasClipboard,
  type CanvasSelectionState,
  type CanvasWorkspace,
} from "./canvas/editing";

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

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "canvas"; id: string }
  | null;

interface WorkspaceSnapshot extends CanvasWorkspace {
  candidateId: string;
}

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
  canvasSelection: CanvasSelectionState;
  canvasObjects: CanvasObject[];
  historyPast: WorkspaceSnapshot[];
  historyFuture: WorkspaceSnapshot[];
  clipboard: CanvasClipboard | null;
  pasteCount: number;
  /** Visible and announced feedback for keyboard and batch canvas commands. */
  canvasAnnouncement: string;
  /** Incremental simulation state. The completed result is also copied into `run`. */
  sessionMode: SimulationMode;
  sessionId: string | null;
  session: SimulationSessionSnapshot | null;
  sessionBusy: boolean;
  enabledSourceIds: string[];

  select: (s: Selection) => void;
  selectMany: (selection: CanvasSelectionState, primary?: Selection) => void;
  edit: (fn: (d: Design) => void) => void;
  editWorkspace: (fn: (workspace: CanvasWorkspace) => void, announcement?: string) => void;
  editCanvas: (fn: (objects: CanvasObject[]) => void, announcement?: string) => void;
  moveNode: (id: string, x: number, y: number) => void;
  undo: () => void;
  redo: () => void;
  copySelection: () => void;
  pasteSelection: () => void;
  duplicateSelection: () => void;
  deleteSelection: () => void;
  alignSelection: (edge: "left" | "top") => void;
  distributeSelection: (axis: "horizontal" | "vertical") => void;
  nudgeSelection: (dx: number, dy: number) => void;
  selectAll: () => void;
  insertCanvasObject: (kind: CanvasObject["kind"], x: number, y: number) => void;
  loadDesign: (design: Design) => void;
  execute: () => Promise<void>;
  startSession: (mode?: SimulationMode) => Promise<void>;
  setSessionMode: (mode: SimulationMode) => void;
  setSourceEnabled: (sourceNodeId: string, enabled: boolean) => Promise<void>;
  injectRequest: (sourceNodeId: string) => Promise<void>;
  injectFailure: (event: FailureEvent) => Promise<void>;
  advanceSessionBy: (deltaMs: number) => Promise<void>;
  advanceSessionEvents: (count: number) => Promise<void>;
  setSessionPaused: (paused: boolean) => Promise<void>;
  setSessionSpeed: (speed: number) => Promise<void>;
  finishSession: () => Promise<void>;
  replaySession: () => Promise<void>;
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
function activeCandidate() {
  const study = useStudyStore.getState().study;
  return study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0];
}

function activeDesign(): Design {
  return activeCandidate()?.design ?? blankDesign();
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
let localWorkspaceMutation = 0;

function locally(mutator: () => void): void {
  localWorkspaceMutation += 1;
  try {
    mutator();
  } finally {
    localWorkspaceMutation -= 1;
  }
}

function forwardDesign(design: Design, objects: CanvasObject[]): void {
  locally(() => useStudyStore.getState().restoreActiveWorkspace(design, objects));
}

function forwardCanvas(objects: CanvasObject[]): void {
  locally(() => useStudyStore.getState().editActiveCanvas(() => objects));
}

const cloneWorkspace = <T>(value: T): T => structuredClone(value);

function currentWorkspaceSnapshot(): WorkspaceSnapshot | null {
  const state = useStudio.getState();
  const candidateId = useStudyStore.getState().study.activeCandidateId;
  if (!candidateId) return null;
  return {
    candidateId,
    design: cloneWorkspace(state.design),
    objects: cloneWorkspace(state.canvasObjects),
  };
}

function workspaceContent(snapshot: Pick<WorkspaceSnapshot, "design" | "objects">): string {
  return JSON.stringify([snapshot.design, snapshot.objects]);
}

const HISTORY_LIMIT = 100;

/** Commit one atomic canvas transaction and optionally put its previous state on history. */
function commitWorkspace(
  next: CanvasWorkspace,
  options: { record?: boolean; announcement?: string } = {}
): boolean {
  const before = currentWorkspaceSnapshot();
  if (!before || workspaceContent(before) === workspaceContent(next)) return false;
  const designChanged = JSON.stringify(before.design) !== JSON.stringify(next.design);
  const executableChanged = designChanged && executableDesignChanged(before.design, next.design);

  if (designChanged) forwardDesign(next.design, next.objects);
  else forwardCanvas(next.objects);

  const state = useStudio.getState();
  useStudio.setState({
    ...(options.record === false
      ? {}
      : {
          historyPast: [...state.historyPast, before].slice(-HISTORY_LIMIT),
          historyFuture: [],
        }),
    ...(executableChanged
      ? {
          runStale: state.run !== null,
          analysisStale: state.analysis !== null,
          replication: null,
          comparison: null,
        }
      : {}),
    ...(options.announcement ? { canvasAnnouncement: options.announcement } : {}),
  });
  return true;
}

function primaryFor(selection: CanvasSelectionState): Selection {
  const canvasId = selection.objectIds.at(-1);
  if (canvasId) return { kind: "canvas", id: canvasId };
  const nodeId = selection.nodeIds.at(-1);
  if (nodeId) return { kind: "node", id: nodeId };
  const edgeId = selection.edgeIds.at(-1);
  return edgeId ? { kind: "edge", id: edgeId } : null;
}

function sameCanvasSelection(
  first: CanvasSelectionState,
  second: CanvasSelectionState
): boolean {
  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index]);
  return (
    sameIds(first.nodeIds, second.nodeIds) &&
    sameIds(first.edgeIds, second.edgeIds) &&
    sameIds(first.objectIds, second.objectIds)
  );
}

function selectionIsIncluded(selection: CanvasSelectionState, primary: Selection): boolean {
  return (
    primary !== null &&
    ((primary.kind === "node" && selection.nodeIds.includes(primary.id)) ||
      (primary.kind === "edge" && selection.edgeIds.includes(primary.id)) ||
      (primary.kind === "canvas" && selection.objectIds.includes(primary.id)))
  );
}

function objectId(kind: CanvasObject["kind"], objects: readonly CanvasObject[]): string {
  const taken = new Set(objects.map((object) => object.id));
  for (let index = 1; ; index += 1) {
    const id = `${kind}-${index}`;
    if (!taken.has(id)) return id;
  }
}

function clientSourceIds(design: Design): string[] {
  return design.nodes
    .filter((node) => node.kind === "client" && node.client)
    .map((node) => node.id);
}

let sessionEpoch = 0;

function invalidateActiveSession(reason: string): void {
  const state = useStudio.getState();
  const active =
    state.sessionId &&
    state.session &&
    state.session.status !== "completed" &&
    state.session.status !== "invalidated";
  if (!active && !state.sessionBusy && !state.running) return;

  sessionEpoch++;
  if (active) {
    void invalidateSimulationSessionInWorker(state.sessionId!, reason).catch(() => undefined);
  }
  useStudio.setState({
    ...(active
      ? {
          session: {
            ...state.session!,
            status: "invalidated" as const,
            paused: true,
            invalidationReason: reason,
          },
        }
      : {}),
    sessionBusy: false,
    running: false,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const initial = activeDesign();
const initialCanvasObjects = activeCandidate()?.canvasObjects ?? [];

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
  canvasSelection: EMPTY_CANVAS_SELECTION,
  canvasObjects: initialCanvasObjects,
  historyPast: [],
  historyFuture: [],
  clipboard: null,
  pasteCount: 0,
  canvasAnnouncement: "Canvas ready.",
  sessionMode: "full",
  sessionId: null,
  session: null,
  sessionBusy: false,
  enabledSourceIds: clientSourceIds(initial),

  select: (selection) =>
    set({
      selection,
      canvasSelection:
        selection?.kind === "node"
          ? { nodeIds: [selection.id], edgeIds: [], objectIds: [] }
          : selection?.kind === "edge"
            ? { nodeIds: [], edgeIds: [selection.id], objectIds: [] }
            : selection?.kind === "canvas"
              ? { nodeIds: [], edgeIds: [], objectIds: [selection.id] }
              : EMPTY_CANVAS_SELECTION,
    }),

  selectMany: (canvasSelection, primary) =>
    set((state) => {
      const preferred = primary ?? state.selection;
      const selection = selectionIsIncluded(canvasSelection, preferred)
        ? preferred
        : primaryFor(canvasSelection);
      if (
        sameCanvasSelection(state.canvasSelection, canvasSelection) &&
        state.selection?.kind === selection?.kind &&
        state.selection?.id === selection?.id
      ) {
        return state;
      }
      const count = selectionCount(canvasSelection);
      return {
        canvasSelection,
        selection,
        canvasAnnouncement: `${count} element${count === 1 ? "" : "s"} selected.`,
      };
    }),

  edit: (fn) => get().editWorkspace((workspace) => fn(workspace.design)),

  editWorkspace: (fn, announcement) => {
    const next = produce(
      { design: get().design, objects: get().canvasObjects },
      fn
    ) as CanvasWorkspace;
    commitWorkspace(next, { announcement });
  },

  editCanvas: (fn, announcement) =>
    get().editWorkspace((workspace) => fn(workspace.objects), announcement),

  /**
   * Position changes are stored but deliberately do NOT mark the run stale or
   * recompute the preview: geometry has no effect on the model, and treating a
   * drag as a model change would flash "stale" over a perfectly valid result.
   */
  moveNode: (id, x, y) => {
    get().editWorkspace((workspace) => {
      const n = workspace.design.nodes.find((m: SdsNode) => m.id === id);
      if (n) {
        n.x = Math.round(x);
        n.y = Math.round(y);
      }
    });
  },

  undo: () => {
    const state = get();
    const target = state.historyPast.at(-1);
    const current = currentWorkspaceSnapshot();
    if (!target || !current) return;
    if (target.candidateId !== current.candidateId) {
      set({ historyPast: [], historyFuture: [], canvasAnnouncement: "History cleared after switching versions." });
      return;
    }
    commitWorkspace({ design: cloneWorkspace(target.design), objects: cloneWorkspace(target.objects) }, {
      record: false,
      announcement: "Undid the last canvas change.",
    });
    set({
      historyPast: state.historyPast.slice(0, -1),
      historyFuture: [current, ...state.historyFuture].slice(0, HISTORY_LIMIT),
    });
  },

  redo: () => {
    const state = get();
    const target = state.historyFuture[0];
    const current = currentWorkspaceSnapshot();
    if (!target || !current) return;
    if (target.candidateId !== current.candidateId) {
      set({ historyPast: [], historyFuture: [], canvasAnnouncement: "History cleared after switching versions." });
      return;
    }
    commitWorkspace({ design: cloneWorkspace(target.design), objects: cloneWorkspace(target.objects) }, {
      record: false,
      announcement: "Redid the canvas change.",
    });
    set({
      historyPast: [...state.historyPast, current].slice(-HISTORY_LIMIT),
      historyFuture: state.historyFuture.slice(1),
    });
  },

  copySelection: () => {
    const clipboard = copyWorkspaceSelection(
      { design: get().design, objects: get().canvasObjects },
      get().canvasSelection
    );
    set({
      clipboard,
      pasteCount: 0,
      canvasAnnouncement: clipboard
        ? `Copied ${clipboard.nodes.length + clipboard.objects.length} element${clipboard.nodes.length + clipboard.objects.length === 1 ? "" : "s"}. Repository evidence was not copied.`
        : "Select at least one component, frame, or text note to copy.",
    });
  },

  pasteSelection: () => {
    const { clipboard, pasteCount, design, canvasObjects } = get();
    if (!clipboard) {
      set({ canvasAnnouncement: "Nothing has been copied yet." });
      return;
    }
    const result = pasteWorkspaceSelection(
      { design, objects: canvasObjects },
      clipboard,
      32 * (pasteCount + 1)
    );
    if (!commitWorkspace(result.workspace, { announcement: "Pasted with fresh IDs and no evidence associations." })) return;
    set({
      canvasSelection: result.selection,
      selection: primaryFor(result.selection),
      pasteCount: pasteCount + 1,
    });
  },

  duplicateSelection: () => {
    const clipboard = copyWorkspaceSelection(
      { design: get().design, objects: get().canvasObjects },
      get().canvasSelection
    );
    if (!clipboard) {
      set({ canvasAnnouncement: "Select at least one component, frame, or text note to duplicate." });
      return;
    }
    const result = pasteWorkspaceSelection(
      { design: get().design, objects: get().canvasObjects },
      clipboard,
      32
    );
    if (!commitWorkspace(result.workspace, { announcement: "Duplicated with fresh IDs and no evidence associations." })) return;
    set({
      clipboard,
      pasteCount: 1,
      canvasSelection: result.selection,
      selection: primaryFor(result.selection),
    });
  },

  deleteSelection: () => {
    const workspace = { design: get().design, objects: get().canvasObjects };
    const selection = get().canvasSelection;
    if (selectionCount(selection) === 0) return;
    const removal = selectionRemovalIds(workspace, selection);
    const candidate = activeCandidate();
    const protectedEvidence = (candidate?.evidence ?? []).filter((evidence) => {
      const target = evidence.target;
      return (
        (target.kind === "node" && removal.nodeIds.has(target.nodeId)) ||
        (target.kind === "edge" && removal.edgeIds.has(target.edgeId))
      );
    });
    if (protectedEvidence.length > 0) {
      set({
        canvasAnnouncement:
          `Delete blocked: ${protectedEvidence.length} source evidence record${protectedEvidence.length === 1 ? "" : "s"} ` +
          "would be orphaned. Detach or revise that evidence first.",
      });
      return;
    }
    const next = deleteWorkspaceSelection(workspace, selection);
    if (!commitWorkspace(next, { announcement: `Deleted ${selectionCount(selection)} selected element${selectionCount(selection) === 1 ? "" : "s"}.` })) return;
    set({ selection: null, canvasSelection: EMPTY_CANVAS_SELECTION });
  },

  alignSelection: (edge) => {
    const selection = get().canvasSelection;
    if (geometrySelectionCount(selection) < 2) return;
    commitWorkspace(
      alignWorkspaceSelection({ design: get().design, objects: get().canvasObjects }, selection, edge),
      { announcement: edge === "left" ? "Aligned selection left." : "Aligned selection to the top." }
    );
  },

  distributeSelection: (axis) => {
    const selection = get().canvasSelection;
    if (geometrySelectionCount(selection) < 3) return;
    commitWorkspace(
      distributeWorkspaceSelection(
        { design: get().design, objects: get().canvasObjects },
        selection,
        axis
      ),
      { announcement: `Distributed selection ${axis === "horizontal" ? "horizontally" : "vertically"}.` }
    );
  },

  nudgeSelection: (dx, dy) => {
    const selection = get().canvasSelection;
    if (geometrySelectionCount(selection) === 0) return;
    commitWorkspace(
      nudgeWorkspaceSelection(
        { design: get().design, objects: get().canvasObjects },
        selection,
        dx,
        dy
      ),
      { announcement: `Moved selection ${Math.abs(dx || dy)} pixels.` }
    );
  },

  selectAll: () => {
    const canvasSelection = {
      nodeIds: get().design.nodes.map((node) => node.id),
      edgeIds: get().design.edges.map((edge) => edge.id),
      objectIds: get().canvasObjects.map((object) => object.id),
    };
    get().selectMany(canvasSelection);
  },

  insertCanvasObject: (kind, x, y) => {
    const id = objectId(kind, get().canvasObjects);
    const object: CanvasObject =
      kind === "frame"
        ? {
            id,
            kind,
            x: Math.round(x),
            y: Math.round(y),
            width: 600,
            height: 320,
            title: "System boundary",
            tone: "neutral",
          }
        : {
            id,
            kind,
            x: Math.round(x),
            y: Math.round(y),
            width: 260,
            height: 96,
            text: "Describe this part of the architecture",
            fontSize: 16,
            tone: "neutral",
          };
    get().editCanvas((objects) => void objects.push(object), `Added ${kind === "frame" ? "a frame" : "a text note"}.`);
    get().select({ kind: "canvas", id });
  },

  loadDesign: (d) => {
    commitWorkspace(
      { design: d, objects: get().canvasObjects },
      { announcement: "Applied the analyzed architecture as one undoable change." }
    );
    set({
      run: null,
      runStale: false,
      analysis: null,
      analysisStale: false,
      error: null,
      selection: null,
      canvasSelection: EMPTY_CANVAS_SELECTION,
      sessionId: null,
      session: null,
      sessionBusy: false,
      enabledSourceIds: clientSourceIds(d),
    });
  },

  execute: async () => {
    await get().startSession("full");
  },

  startSession: async (requestedMode) => {
    const { design } = get();
    const mode = requestedMode ?? get().sessionMode;
    const calibrationError = performanceCalibrationError();
    if (calibrationError) {
      set({ running: false, sessionBusy: false, run: null, error: calibrationError });
      return;
    }
    invalidateActiveSession("replaced by a new simulation session");
    const epoch = ++sessionEpoch;
    set({
      sessionMode: mode,
      sessionId: null,
      session: null,
      sessionBusy: true,
      running: true,
      run: null,
      runStale: false,
      error: null,
    });
    try {
      const created = await createSimulationSessionInWorker(design, {
        mode,
        enabledSourceIds: get().enabledSourceIds,
        paused: mode === "manual",
      });
      if (epoch !== sessionEpoch) return;
      set({
        sessionId: created.sessionId,
        session: created.snapshot,
        sessionBusy: false,
        running: false,
        error: null,
      });
    } catch (e) {
      if (epoch !== sessionEpoch) return;
      set({
        running: false,
        sessionBusy: false,
        sessionId: null,
        session: null,
        run: null,
        error: errorMessage(e),
      });
    }
  },

  setSessionMode: (mode) => {
    if (mode === get().sessionMode) return;
    invalidateActiveSession("simulation mode changed");
    set({ sessionMode: mode, sessionId: null, session: null, sessionBusy: false });
  },

  setSourceEnabled: async (sourceNodeId, enabled) => {
    const available = clientSourceIds(get().design);
    if (!available.includes(sourceNodeId)) return;
    const enabledSourceIds = enabled
      ? [...new Set([...get().enabledSourceIds, sourceNodeId])]
      : get().enabledSourceIds.filter((id) => id !== sourceNodeId);
    set({ enabledSourceIds, error: null });

    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || session.status !== "ready" || sessionBusy) return;
    const epoch = sessionEpoch;
    set({ sessionBusy: true });
    try {
      const update = await setSimulationSourceInWorker(sessionId, sourceNodeId, enabled);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ session: update.snapshot, sessionBusy: false, error: null });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  injectRequest: async (sourceNodeId) => {
    let state = get();
    const needsSession =
      state.sessionMode !== "manual" ||
      !state.sessionId ||
      !state.session ||
      state.session.status === "completed" ||
      state.session.status === "invalidated";
    if (needsSession) {
      await get().startSession("manual");
      state = get();
    }
    if (!state.sessionId || !state.session || state.sessionBusy) return;

    const sessionId = state.sessionId;
    const epoch = sessionEpoch;
    set({ sessionBusy: true, error: null });
    try {
      const update = await injectSimulationRequestInWorker(sessionId, sourceNodeId);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ session: update.snapshot, sessionBusy: false, error: null });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  injectFailure: async (event) => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || sessionBusy || session.status === "completed") return;
    const epoch = sessionEpoch;
    set({ sessionBusy: true, error: null });
    try {
      const update = await injectSimulationFailureInWorker(sessionId, event);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ session: update.snapshot, sessionBusy: false, error: null });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  advanceSessionBy: async (deltaMs) => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || sessionBusy || session.status === "completed") return;
    const epoch = sessionEpoch;
    set({ sessionBusy: true });
    try {
      const update = await advanceSimulationTimeInWorker(sessionId, deltaMs);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({
        session: update.snapshot,
        sessionBusy: false,
        ...(update.result ? { run: update.result, runStale: false } : {}),
      });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  advanceSessionEvents: async (count) => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || sessionBusy || session.status === "completed") return;
    const epoch = sessionEpoch;
    set({ sessionBusy: true });
    try {
      const update = await advanceSimulationEventsInWorker(sessionId, count);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({
        session: update.snapshot,
        sessionBusy: false,
        ...(update.result ? { run: update.result, runStale: false } : {}),
      });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  setSessionPaused: async (paused) => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || sessionBusy || session.status === "completed") return;
    const epoch = sessionEpoch;
    set({ sessionBusy: true });
    try {
      const update = await setSimulationPausedInWorker(sessionId, paused);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ session: update.snapshot, sessionBusy: false });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  setSessionSpeed: async (speed) => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || sessionBusy || session.status === "completed") return;
    const epoch = sessionEpoch;
    set({ sessionBusy: true });
    try {
      const update = await setSimulationSpeedInWorker(sessionId, speed);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ session: update.snapshot, sessionBusy: false });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
    }
  },

  finishSession: async () => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session || sessionBusy) return;
    if (session.status === "completed") {
      await get().replaySession();
      return;
    }
    const epoch = sessionEpoch;
    set({ sessionBusy: true, running: true });
    try {
      const update: SimulationSessionUpdate = await finalizeSimulationSessionInWorker(sessionId);
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({
        session: update.snapshot,
        sessionBusy: false,
        running: false,
        run: update.result ?? null,
        runStale: false,
        error: null,
      });
    } catch (e) {
      if (epoch !== sessionEpoch || get().sessionId !== sessionId) return;
      set({ sessionBusy: false, running: false, error: errorMessage(e) });
    }
  },

  replaySession: async () => {
    const { sessionId, session, sessionBusy } = get();
    if (!sessionId || !session?.replayAvailable || sessionBusy) return;
    set({ sessionBusy: true });
    try {
      const result = await replaySimulationSessionInWorker(sessionId);
      if (get().sessionId !== sessionId) return;
      set({ run: result, runStale: false, sessionBusy: false, error: null });
    } catch (e) {
      if (get().sessionId !== sessionId) return;
      set({ sessionBusy: false, error: errorMessage(e) });
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
      const studyStore = useStudyStore.getState();
      const candidateId = studyStore.study.activeCandidateId;
      if (candidateId) {
        studyStore.updateStudy((study) =>
          syncAnalysisIssues(study, candidateId, analysis.report.findings, contentHash(analysis))
        );
      }
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
    commitWorkspace(
      { design: d, objects: get().canvasObjects },
      { announcement: "Imported the design as one undoable change." }
    );
    set({
      run: null,
      runStale: false,
      analysis: null,
      analysisStale: false,
      error: null,
      selection: null,
      canvasSelection: EMPTY_CANVAS_SELECTION,
      sessionId: null,
      session: null,
      sessionBusy: false,
      enabledSourceIds: clientSourceIds(d),
    });
  },

  exportDesign: () => JSON.stringify(DesignSchema.parse(get().design), null, 2),
}));

/**
 * Mirror the active candidate's executable design and canvas presentation into this store.
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

  const switchedCandidate = previousActive?.id !== active.id;
  const designChanged = !previousActive || previousActive.design !== active.design;
  const canvasChanged = !previousActive || previousActive.canvasObjects !== active.canvasObjects;
  if (!switchedCandidate && !designChanged && !canvasChanged) return;

  const executableChanged =
    switchedCandidate ||
    !previousActive ||
    executableDesignChanged(previousActive.design, active.design);
  if (executableChanged) {
    invalidateActiveSession(
      switchedCandidate ? "active candidate changed" : "executable design changed"
    );
  }

  const availableSources = clientSourceIds(active.design);
  const previousSources = previousActive ? clientSourceIds(previousActive.design) : [];
  const currentlyEnabled = new Set(useStudio.getState().enabledSourceIds);
  const enabledSourceIds = switchedCandidate
    ? availableSources
    : availableSources.filter(
        (id) => currentlyEnabled.has(id) || !previousSources.includes(id)
      );
  const currentStudio = useStudio.getState();
  const nodeIds = new Set(active.design.nodes.map((node) => node.id));
  const edgeIds = new Set(active.design.edges.map((edge) => edge.id));
  const objectIds = new Set(active.canvasObjects.map((object) => object.id));
  const canvasSelection: CanvasSelectionState = switchedCandidate
    ? EMPTY_CANVAS_SELECTION
    : {
        nodeIds: currentStudio.canvasSelection.nodeIds.filter((id) => nodeIds.has(id)),
        edgeIds: currentStudio.canvasSelection.edgeIds.filter((id) => edgeIds.has(id)),
        objectIds: currentStudio.canvasSelection.objectIds.filter((id) => objectIds.has(id)),
      };
  const selection = switchedCandidate
    ? null
    : currentStudio.selection?.kind === "node" && nodeIds.has(currentStudio.selection.id)
      ? currentStudio.selection
      : currentStudio.selection?.kind === "edge" && edgeIds.has(currentStudio.selection.id)
        ? currentStudio.selection
        : currentStudio.selection?.kind === "canvas" && objectIds.has(currentStudio.selection.id)
          ? currentStudio.selection
          : primaryFor(canvasSelection);
  useStudio.setState({
    ...(designChanged ? { design: active.design, ...recompute(active.design) } : {}),
    canvasObjects: active.canvasObjects,
    canvasSelection,
    selection,
    enabledSourceIds,
    ...((switchedCandidate || localWorkspaceMutation === 0) && (designChanged || canvasChanged)
      ? { historyPast: [], historyFuture: [] }
      : {}),
    // Switching candidate is not an edit; it is a different subject. Carrying the previous
    // candidate's run forward and labelling it stale would be worse than clearing it, because a
    // greyed-out number still anchors a reader.
    ...(switchedCandidate
      ? {
          run: null,
          runStale: false,
          analysis: null,
          analysisStale: false,
          replication: null,
          comparison: null,
          sessionId: null,
          session: null,
          sessionBusy: false,
        }
      : {}),
  });
});
