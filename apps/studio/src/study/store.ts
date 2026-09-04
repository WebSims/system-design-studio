import { create } from "zustand";
import {
  contentHash,
  evaluationKey,
  syncCandidateToStudy,
  studyBoundsHash,
  validateDesign,
  validateStudy,
  validateWorkflow,
  applyStudyContract,
  blankStudy,
  clearStudyResults,
  performanceCalibration,
  studyContractLock,
  type Candidate,
  type CandidateEvaluation,
  type Design,
  type DesignIssue,
  type PortfolioResult,
  type Study,
  type StudyContractPatch,
  type StudyIssue,
  type StudyLock,
} from "@sds/schema";
import { STUDY_ENGINE_VERSION } from "@sds/study";
import { previewDesign, type DesignPreview } from "@sds/analytic";
import { IntractableError } from "@sds/analytic";
import {
  evaluateInWorker,
  cancelWorker,
  portfolioInWorker,
} from "../engine/client";
import {
  deleteStudy,
  loadStudy,
  listStudies,
  isRetiredDevelopmentStudyId,
  readActiveStudyId,
  removeRetiredDevelopmentStudies,
  saveStudy,
  writeActiveStudyId,
  importStudy,
  exportStudy,
  type StoredStudy,
} from "../persist";
import {
  MutationRefused,
  manualCandidate,
  applyArchitecturePatch,
  attachArchitectureEvidence,
  createCandidate,
  deleteCandidate,
  editActiveDesign,
  importRepositoryArchitecture,
  promoteCandidate,
  releaseApproval,
  replaceCandidateDraft,
  setActiveCandidate,
  upsertSourceInventory,
  type ApplyArchitecturePatchInput,
  type AttachArchitectureEvidenceInput,
  type ImportRepositoryArchitectureInput,
  type UpsertSourceInventoryInput,
} from "./mutations";
import type { ActivityEntry, CreateStudyInput } from "../webmcp/tools";

/**
 * The study store.
 *
 * ONE DOCUMENT, ONE CANVAS, TWO LENSES
 *
 * The Behaviour lens (race explorer) and the Load lens (simulator) are views over the same study on
 * the same canvas, and the review drawer is a third view over the same document. Not modes with
 * their own state. That is the entire architectural content of "both learner and expert": there is
 * one canonical model and the views differ in what they show of it, so a guided rule builder and a
 * raw JSON editor cannot produce documents that disagree.
 *
 * WHY EVALUATIONS ARE CACHED IN THE DOCUMENT
 *
 * Because the alternative is losing them. A correctness search over seven candidates is seconds
 * and a replicated performance run is minutes, and a store that dropped them on navigation would
 * make the compare view useless. They are keyed by content, so a cached number can only ever be
 * shown next to the design that produced it -- see `evaluationKey`.
 */

/**
 * The two lenses on the one canvas.
 *
 * `behaviour` is the race explorer: a handful of actors, step-driven, state on the data nodes.
 * `load` is the simulator: rates, queues, latency. Same design, same canvas; the lens decides what
 * the rails and the bottom dock show of it.
 */
export type LensId = "behaviour" | "load";

/**
 * A note an agent (or a person) pinned to something on the canvas.
 *
 * Session state, not document state: it is narration about the model, not part of it, so it is
 * neither saved nor exported and cannot leak into a handoff.
 */
export interface Annotation {
  id: string;
  candidateId: string | null;
  targetKind: "node" | "edge" | "step" | "candidate";
  targetId: string;
  text: string;
  tone: "info" | "warn" | "bad";
  by: "agent" | "human";
  at: number;
}

/**
 * Something the agent (or the review drawer) asked the canvas to look at. Consumed by the canvas,
 * which pans to it, selects it and, for a step, scrubs the counterexample there.
 */
export type FocusRequest =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "step"; index: number }
  /**
   * Fit the camera around a set of elements (every node when `nodeIds` is empty), then select
   * `select`. What a mutating agent call asks for, so the person sees what just changed.
   */
  | { kind: "reveal"; nodeIds: string[]; edgeIds: string[]; select: { kind: "node" | "edge"; id: string } | null };

/**
 * What the agent just touched, for the two-and-a-half seconds it takes a person to notice.
 *
 * Session state, and short-lived on purpose: it drives a pulse on the canvas, a strip in the
 * inspector naming the fields that were filled, and a flash on the rail whose section changed.
 * `scope` says which of those applies; `changedPaths` are dotted leaf paths (or `new` for a
 * freshly added element).
 */
export interface AgentAttention {
  at: number;
  candidateId: string | null;
  scope: "element" | "design" | "study";
  nodeIds: string[];
  edgeIds: string[];
  primary: { kind: "node" | "edge"; id: string } | null;
  changedPaths: string[];
}

export const AGENT_ATTENTION_MS = 2500;

export interface StudioState {
  study: Study;
  lens: LensId;
  /** The review drawer (versions, gates, trade-offs, hand off) over the canvas. */
  reviewOpen: boolean;
  /** The agent stream panel. */
  agentOpen: boolean;
  /**
   * The projects home shown OVER an open project. Transient: it is how a person reaches "new",
   * "open", "rename" and "delete" once a project has versions, and it closes itself when a
   * document loads or a version is added.
   */
  homeOpen: boolean;
  /** The Workload row's inline arrival editor is open. Set from the client inspector's "set it" jump too. */
  workloadEditOpen: boolean;
  annotations: Annotation[];
  focusRequest: FocusRequest | null;
  agentAttention: AgentAttention | null;
  /** Agent tool calls in flight right now. Zero means idle. */
  agentBusy: number;
  /**
   * Version the canvas is being diffed against, or null for no diff.
   *
   * When set, the active version is drawn with its additions and changes marked and the
   * other version's removed components drawn as ghosts. This is how "did the code change
   * land as approved" is answered: re-import the codebase, diff it against the approved
   * version, look.
   */
  diffBaseId: string | null;
  /**
   * The approved version a re-import should be checked against, remembered when a person
   * releases an approval to let the agent import the new commit.
   */
  verifyAgainstId: string | null;

  /** Validation of the whole study, recomputed on every edit. */
  issues: StudyIssue[];
  /** Validation and closed-form preview of the ACTIVE candidate only. */
  designIssues: DesignIssue[];
  workflowIssues: DesignIssue[];
  preview: DesignPreview | null;
  previewError: string | null;

  portfolio: PortfolioResult | null;
  /** Candidate ids currently being evaluated. */
  running: Set<string>;
  error: string | null;
  /** Local log of every agent call, newest last. */
  activity: ActivityEntry[];
  webmcp: { status: string; detail: string };
  persistence: { status: "idle" | "saving" | "saved" | "failed"; detail: string };

  // ---- navigation ----
  setLens(lens: LensId): void;
  setReviewOpen(open: boolean): void;
  setAgentOpen(open: boolean): void;
  setHomeOpen(open: boolean): void;
  setWorkloadEditOpen(open: boolean): void;
  selectCandidate(id: string): void;
  addAnnotation(annotation: Omit<Annotation, "id" | "at">): Annotation;
  dismissAnnotation(id: string): void;
  requestFocus(request: StudioState["focusRequest"]): void;
  /** Mark what the agent just touched; clears itself after `AGENT_ATTENTION_MS`. */
  setAgentAttention(attention: Omit<AgentAttention, "at">): void;
  setAgentBusy(delta: 1 | -1): void;
  setDiffBase(candidateId: string | null): void;
  /**
   * Release the approval so a new source snapshot can become the current system.
   *
   * A human action, and the only way an agent's re-import is allowed into an approved
   * project. Results are kept; only the decision is withdrawn, and the approved version
   * is remembered so the re-import can be diffed against it.
   */
  releaseApprovalForReimport(): void;

  // ---- document ----
  loadStudyDocument(study: Study): void;
  /** Start a new, empty study and open it. The workload, when given, replaces the placeholder. */
  createStudy(input: Partial<CreateStudyInput>): Study;
  /** Rename the open project. Prose, so allowed while the contract is locked. */
  renameStudy(input: { name?: string; problem?: string }): void;
  /** Copy the open project under a new id, results cleared so the copy's yardstick is unlocked. */
  duplicateStudy(): Study;
  /** Rename a saved project without opening it (the open one goes through `renameStudy`). */
  renameStoredStudy(id: string, input: { name?: string; problem?: string }): Promise<void>;
  /** Duplicate a saved project and open the copy. */
  duplicateStoredStudy(id: string): Promise<void>;
  /** Remove a saved project. Refused for the open one: switch first, so nothing open can vanish. */
  deleteStoredStudy(id: string): Promise<void>;
  /** Remove the open project after switching to the most recent other one, or a fresh blank project. */
  deleteOpenStudy(): Promise<void>;
  /** Edit the executable contract. Refused, with a reason, once results exist. */
  updateContract(patch: StudyContractPatch): void;
  /** Discard every result, which is the only way to unfreeze the contract. */
  clearResults(): void;
  /** Open a saved study by id. */
  openStudy(id: string): Promise<void>;
  /** Saved studies, for the switcher. */
  storedStudies(): Promise<StoredStudy[]>;
  /** Whether the yardstick is frozen, and why. */
  contractLock(): StudyLock;
  importStudyJson(json: string): void;
  exportStudyJson(): string;
  updateStudy(mutate: (study: Study) => Study): void;
  editActive(mutate: (design: Design) => Design): void;

  // ---- candidates ----
  addCandidate(input: { label: string; intent?: string; copyFrom?: string; design?: unknown; origin: "human" | "agent" }): Candidate;
  replaceDraft(input: { candidateId: string; expectedRevision: number; design: unknown; by: "human" | "agent" }): Candidate;
  importArchitecture(input: ImportRepositoryArchitectureInput): Candidate;
  patchArchitecture(input: ApplyArchitecturePatchInput): { candidate: Candidate; changed: string[] };
  attachEvidence(input: AttachArchitectureEvidenceInput): Candidate;
  upsertInventory(input: UpsertSourceInventoryInput): Candidate;
  removeCandidate(id: string): void;
  promote(id: string): void;

  // ---- evaluation ----
  evaluate(candidateId: string, opts?: { correctness?: boolean; performance?: boolean; scenarios?: boolean }): Promise<CandidateEvaluation | null>;
  evaluateAll(opts?: { correctness?: boolean; performance?: boolean; scenarios?: boolean }): Promise<void>;
  checkOnly(candidateId: string): Promise<void>;
  refreshPortfolio(): Promise<void>;
  cancel(): void;

  // ---- reads ----
  activeCandidate(): Candidate | null;
  evaluationFor(candidateId: string): CandidateEvaluation | null;

  logActivity(entry: ActivityEntry): void;
  setWebmcp(status: string, detail: string): void;
}

/**
 * Recompute everything cheap on every edit.
 *
 * Validation and the closed-form preview are microseconds and are recomputed synchronously, which
 * is what makes the inspector feel like a form rather than like a build step. Anything expensive
 * -- a simulation, a correctness search -- is explicit and goes to the worker.
 *
 * `previewDesign` can throw `IntractableError` on absurd inputs. Caught rather than allowed to
 * propagate, because the design being edited is by definition mid-edit and a store that threw on
 * an in-progress value would leave the UI unrecoverable. That bug shipped once.
 */
function derive(study: Study): Pick<
  StudioState,
  "issues" | "designIssues" | "workflowIssues" | "preview" | "previewError"
> {
  const active = study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0];
  if (!active) {
    return { issues: validateStudy(study), designIssues: [], workflowIssues: [], preview: null, previewError: null };
  }

  let preview: DesignPreview | null = null;
  let previewError: string | null = null;
  try {
    preview = previewDesign(active.design);
  } catch (err) {
    preview = null;
    previewError =
      err instanceof IntractableError
        ? err.message
        : `the closed-form estimate could not be computed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    issues: validateStudy(study),
    designIssues: validateDesign(active.design),
    workflowIssues: validateWorkflow(active.design),
    preview,
    previewError,
  };
}

function mergeEvaluation(
  previous: CandidateEvaluation | undefined,
  next: CandidateEvaluation,
  phases: { correctness: boolean; performance: boolean; scenarios: boolean }
): CandidateEvaluation {
  if (!previous) return next;
  return {
    ...next,
    correctness: phases.correctness ? next.correctness : previous.correctness,
    performance: phases.performance ? next.performance : previous.performance,
    business: phases.performance ? next.business : previous.business,
    resources: phases.performance ? next.resources : previous.resources,
    // `?? []` also makes hot-reloaded v2 evaluations safe before IndexedDB has reparsed them with
    // the new schema default.
    scenarios: phases.scenarios ? next.scenarios : (previous.scenarios ?? []),
    assumptions: [...new Set([...previous.assumptions, ...next.assumptions])],
    warnings: [...new Set([...previous.warnings, ...next.warnings])],
    wallMs: previous.wallMs + next.wallMs,
  };
}

/**
 * Persistence, debounced for typing and immediate for decisions.
 *
 * WHY BOTH, AND WHY THIS DISTINCTION IS NOT A MICRO-OPTIMISATION
 *
 * Dragging a node fires an edit per animation frame, and a study with cached evaluations is megabytes,
 * so writing on every edit would write megabytes per frame. Hence the debounce.
 *
 * But a debounce is a window in which work exists only in memory, and a browser test caught exactly
 * that: promote a candidate, reload within the window, and the promotion is gone. A user who clicks
 * promote and then closes the tab has made a decision the product then forgets, which is worse than
 * anything the debounce was saving.
 *
 * So high-frequency edits debounce and DECISIONS do not: promotion, adding or removing a candidate,
 * loading a study, and merging an evaluation all write immediately. There is also a flush on
 * `pagehide`, which is best-effort by nature -- a browser is not obliged to finish an IndexedDB write
 * during teardown -- and the reason it is only best-effort is precisely why the immediate path exists
 * rather than relying on it.
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStudy: Study | null = null;
/** One timer for the attention marker: a newer touch restarts the clock rather than racing it. */
let attentionTimer: ReturnType<typeof setTimeout> | null = null;

export const useStudyStore = create<StudioState>((set, get) => {
  const write = (study: Study) =>
    saveStudy(study)
      .then(() => {
        writeActiveStudyId(study.id);
        set({ persistence: { status: "saved", detail: `saved ${new Date().toLocaleTimeString()}` } });
      })
      .catch((err: unknown) => {
        // Surfaced, not swallowed. A study that is silently failing to save is an afternoon of work
        // about to be lost, and the user is the only one who can do anything about it.
        set({
          persistence: {
            status: "failed",
            detail: `could not save: ${err instanceof Error ? err.message : String(err)}. Export the project to keep it.`,
          },
        });
      });

  const persist = (study: Study, immediate: boolean) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingStudy = study;
    set({ persistence: { status: "saving", detail: "" } });
    if (immediate) {
      pendingStudy = null;
      void write(study);
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const target = pendingStudy;
      pendingStudy = null;
      if (target) void write(target);
    }, 600);
  };

  const commit = (study: Study, immediate = false) => {
    set({ study, ...derive(study), error: null });
    persist(study, immediate);
  };

  /**
   * An empty study, not an example.
   *
   * The tool is for the user's problem. Booting into a pizza giveaway would teach that the
   * problem ships with the product. The MVP starts either from repository reconstruction or a
   * manual empty canvas.
   */
  const initial = blankStudy({ id: `study-${Date.now().toString(36)}` });

  return {
    study: initial,
    lens: "behaviour",
    reviewOpen: false,
    agentOpen: false,
    homeOpen: false,
    workloadEditOpen: false,
    annotations: [],
    focusRequest: null,
    agentAttention: null,
    agentBusy: 0,
    diffBaseId: null,
    verifyAgainstId: null,
    ...derive(initial),
    portfolio: null,
    running: new Set<string>(),
    error: null,
    activity: [],
    webmcp: { status: "unknown", detail: "" },
    persistence: { status: "idle", detail: "" },

    setLens: (lens) => set({ lens }),
    setReviewOpen: (reviewOpen) => set({ reviewOpen }),
    setAgentOpen: (agentOpen) => set({ agentOpen }),
    setHomeOpen: (homeOpen) => set({ homeOpen }),
    setWorkloadEditOpen: (workloadEditOpen) => set({ workloadEditOpen, ...(workloadEditOpen ? { lens: "behaviour" as LensId } : {}) }),
    addAnnotation: (input) => {
      const annotation: Annotation = {
        ...input,
        id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
      };
      set((s) => ({ annotations: [...s.annotations.slice(-199), annotation] }));
      return annotation;
    },
    dismissAnnotation: (id) =>
      set((s) => ({ annotations: s.annotations.filter((note) => note.id !== id) })),
    requestFocus: (focusRequest) => set({ focusRequest }),
    setAgentAttention: (attention) => {
      if (attentionTimer) clearTimeout(attentionTimer);
      set({ agentAttention: { ...attention, at: Date.now() } });
      attentionTimer = setTimeout(() => {
        attentionTimer = null;
        set({ agentAttention: null });
      }, AGENT_ATTENTION_MS);
    },
    setAgentBusy: (delta) => set((s) => ({ agentBusy: Math.max(0, s.agentBusy + delta) })),
    setDiffBase: (diffBaseId) => set({ diffBaseId }),
    releaseApprovalForReimport: () => {
      const study = get().study;
      const approved = study.promotedCandidateId;
      if (!approved) return;
      try {
        commit(releaseApproval(study), true);
        set({ verifyAgainstId: approved, diffBaseId: null });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    selectCandidate: (id) => {
      try {
        commit(setActiveCandidate(get().study, id));
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    loadStudyDocument: (study) => {
      commit(study, true);
      // Annotations narrate one document; carrying them into another would pin notes to elements
      // that happen to share an id.
      set({
        portfolio: null,
        reviewOpen: false,
        homeOpen: false,
        annotations: [],
        focusRequest: null,
        agentAttention: null,
        diffBaseId: null,
        verifyAgainstId: null,
      });
      void get().refreshPortfolio();
    },

    importStudyJson: (json) => {
      try {
        get().loadStudyDocument(importStudy(json));
      } catch (err) {
        set({ error: `that file could not be read as a project or design: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    exportStudyJson: () => exportStudy(get().study),

    createStudy: (input) => {
      const study = blankStudy({
        id: freshStudyId(),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.problem !== undefined ? { problem: input.problem } : {}),
        ...(input.workload !== undefined ? { workload: input.workload } : {}),
      });
      get().loadStudyDocument(study);
      return study;
    },

    renameStudy: (input) => {
      const name = input.name?.trim();
      get().updateStudy((study) => ({
        ...study,
        ...(name ? { name } : {}),
        ...(input.problem !== undefined ? { problem: input.problem } : {}),
      }));
    },

    duplicateStudy: () => {
      const copy = duplicateOf(get().study);
      get().loadStudyDocument(copy);
      return copy;
    },

    renameStoredStudy: async (id, input) => {
      if (id === get().study.id) {
        get().renameStudy(input);
        return;
      }
      const result = await loadStudy(id);
      if (result.status !== "ok") {
        set({ error: `the project "${id}" could not be read${result.status === "unreadable" ? `: ${result.reason}` : ""}.` });
        return;
      }
      const name = input.name?.trim();
      await saveStudy({
        ...result.study,
        ...(name ? { name } : {}),
        ...(input.problem !== undefined ? { problem: input.problem } : {}),
      });
    },

    duplicateStoredStudy: async (id) => {
      if (id === get().study.id) {
        get().duplicateStudy();
        return;
      }
      const result = await loadStudy(id);
      if (result.status !== "ok") {
        set({ error: `the project "${id}" could not be read${result.status === "unreadable" ? `: ${result.reason}` : ""}.` });
        return;
      }
      get().loadStudyDocument(duplicateOf(result.study));
    },

    deleteStoredStudy: async (id) => {
      if (id === get().study.id) {
        set({ error: "the open project cannot be deleted. Open another project first." });
        return;
      }
      try {
        await deleteStudy(id);
      } catch (err) {
        set({ error: `could not delete the project: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    deleteOpenStudy: async () => {
      const id = get().study.id;
      const other = (await listStudies()).find((stored) => stored.id !== id);
      if (other) {
        await get().openStudy(other.id);
      } else {
        get().createStudy({});
        get().addCandidate(manualCandidate());
      }
      if (get().study.id === id) return;
      await get().deleteStoredStudy(id);
    },

    updateContract: (patch) => {
      try {
        // The project's workload and targets are what every version RUNS with; pushing them into
        // the drawings now means the canvas shows what the next run will use rather than a stale
        // local copy. Revisions do not move: nothing an editor owns has changed.
        const next = applyStudyContract(get().study, patch);
        commit(
          { ...next, candidates: next.candidates.map((candidate) => syncCandidateToStudy(next, candidate)) },
          true
        );
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    clearResults: () => {
      commit(clearStudyResults(get().study), true);
      set({ portfolio: null });
    },

    openStudy: async (id) => {
      const result = await loadStudy(id);
      if (result.status === "ok") {
        get().loadStudyDocument(result.study);
      } else {
        set({
          error:
            result.status === "missing"
              ? `there is no saved project "${id}".`
              : `the project "${id}" could not be read: ${result.reason}. It has not been overwritten.`,
        });
      }
    },

    storedStudies: () => listStudies(),

    contractLock: () => studyContractLock(get().study),

    updateStudy: (mutate) => {
      try {
        commit(mutate(get().study));
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    editActive: (mutate) => {
      const study = get().study;
      // Synced on every edit so a client dropped from the palette shows the project's arrival at
      // once, not the preset's; the canvas then reads what the runner will use.
      commit(
        editActiveDesign(study, (candidate) =>
          syncCandidateToStudy(study, { ...candidate, design: mutate(candidate.design) })
        )
      );
      // A topology edit invalidates every portfolio claim derived from the previous revision.
      // Do not recompute here: node drags and inspector inputs can produce dozens of edits per
      // second. The compare view keeps an explicit refresh action for that boundary.
      set({ portfolio: null });
    },

    addCandidate: (input) => {
      const { study, candidate } = createCandidate(get().study, input);
      commit(study, true);
      set({ portfolio: null, homeOpen: false });
      void get().refreshPortfolio();
      return candidate;
    },

    replaceDraft: (input) => {
      const { study, candidate } = replaceCandidateDraft(get().study, input);
      commit(study, true);
      set({ portfolio: null });
      void get().refreshPortfolio();
      return candidate;
    },

    importArchitecture: (input) => {
      const { study, candidate } = importRepositoryArchitecture(get().study, input);
      commit(study, true);
      set({ portfolio: null, reviewOpen: false });
      void get().refreshPortfolio();
      return candidate;
    },

    patchArchitecture: (input) => {
      const { study, candidate, changed } = applyArchitecturePatch(get().study, input);
      commit(study, true);
      set({ portfolio: null });
      void get().refreshPortfolio();
      return { candidate, changed };
    },

    attachEvidence: (input) => {
      const { study, candidate } = attachArchitectureEvidence(get().study, input);
      commit(study, true);
      return candidate;
    },

    upsertInventory: (input) => {
      const { study, candidate } = upsertSourceInventory(get().study, input);
      commit(study, true);
      return candidate;
    },

    removeCandidate: (id) => {
      try {
        commit(deleteCandidate(get().study, id), true);
        void get().refreshPortfolio();
      } catch (err) {
        set({ error: err instanceof MutationRefused ? err.message : String(err) });
      }
    },

    promote: (id) => {
      try {
        // Immediate. Promotion is THE decision in the product, and a debounce window in which it
        // exists only in memory is a window in which closing the tab undoes it.
        commit(promoteCandidate(get().study, id), true);
        set({ portfolio: null });
        void get().refreshPortfolio();
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    evaluate: async (candidateId, opts) => {
      const correctness = opts?.correctness ?? true;
      const performance = opts?.performance ?? true;
      const scenarios = opts?.scenarios ?? false;
      const candidate = get().study.candidates.find((item) => item.id === candidateId);
      if (!candidate) {
        set({ error: `no candidate "${candidateId}"` });
        return null;
      }
      if (performance || scenarios) {
        const calibration = performanceCalibration(get().study, candidate);
        if (!calibration.calibrated) {
          set({
            error:
              `${calibration.message} Load simulation and production scenarios stay unavailable until those inputs are measured. ` +
              "Correctness search remains available.",
          });
          return null;
        }
      }
      set((s) => ({ running: new Set(s.running).add(candidateId), error: null }));
      try {
        const evaluation = await evaluateInWorker(get().study, candidateId, {
          correctness,
          performance,
          scenarios,
        });
        const study = get().study;
        const candidate = study.candidates.find((c) => c.id === candidateId);
        if (!candidate) return null;
        const key = evaluationKey({
          candidateHash: evaluation.candidateHash,
          engineVersion: STUDY_ENGINE_VERSION,
          seeds: study.workload.seeds,
          boundsHash: studyBoundsHash(study),
        });
        const merged = mergeEvaluation(study.evaluations[key], evaluation, {
          correctness,
          performance,
          scenarios,
        });
        // Immediate: an evaluation is minutes of work, and losing it to a reload would send the
        // user back to the beginning of the slowest thing the product does.
        commit({ ...study, evaluations: { ...study.evaluations, [key]: merged } }, true);
        await get().refreshPortfolio();
        return merged;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      } finally {
        set((s) => {
          const running = new Set(s.running);
          running.delete(candidateId);
          return { running };
        });
      }
    },

    evaluateAll: async (opts) => {
      // Sequential, not parallel, and for the same reason `checkStudy` is: the bounds include a
      // wall-clock budget, and running several searches at once would make each one's budget mean
      // something different. A verdict that depends on how many other candidates happened to be
      // running is not a verdict.
      for (const candidate of get().study.candidates) {
        await get().evaluate(candidate.id, opts);
      }
    },

    checkOnly: async (candidateId) => {
      await get().evaluate(candidateId, { correctness: true, performance: false, scenarios: false });
    },

    refreshPortfolio: async () => {
      try {
        const source = get().study;
        const portfolio = await portfolioInWorker(source);
        // A worker response can arrive after an agent or the UI has moved the document to a new
        // revision. Object identity is sufficient because every mutation creates a new Study.
        if (get().study === source) set({ portfolio });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    cancel: () => {
      cancelWorker();
      set({ running: new Set<string>(), error: "cancelled" });
    },

    activeCandidate: () => {
      const study = get().study;
      return study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0] ?? null;
    },

    evaluationFor: (candidateId) => {
      const study = get().study;
      const candidate = study.candidates.find((c) => c.id === candidateId);
      if (!candidate) return null;
      // The hash is recomputed from the CURRENT design, so an evaluation is only returned if it
      // was produced by exactly this design at exactly these settings. That is the mechanism by
      // which a stale number cannot reach the screen.
      const key = evaluationKey({
        candidateHash: contentHash(syncedDesignHashInput(study, candidate)),
        engineVersion: STUDY_ENGINE_VERSION,
        seeds: study.workload.seeds,
        boundsHash: studyBoundsHash(study),
      });
      return study.evaluations[key] ?? null;
    },

    logActivity: (entry) => set((s) => ({ activity: [...s.activity.slice(-199), entry] })),
    setWebmcp: (status, detail) => set({ webmcp: { status, detail } }),
  };
});

/**
 * A new project id. Time-ordered so the list reads chronologically, with a random tail so two
 * projects made in the same millisecond (create, then duplicate) cannot share one.
 */
const freshStudyId = (): string => `study-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * A copy under a new id, results cleared so the copy's yardstick is unlocked. The reason to copy a
 * project is almost always "same problem, different rules or workload", and a copy that inherited
 * the lock could not be edited.
 */
function duplicateOf(source: Study): Study {
  return clearStudyResults({
    ...source,
    id: freshStudyId(),
    name: `copy of ${source.name}`,
    createdAt: Date.now(),
  });
}

/**
 * The design a candidate is evaluated as, for hashing.
 *
 * Must go through the SAME synchronisation the worker applies, or the store would look up a key
 * the worker never wrote and every result would appear stale the instant it was produced. Shared
 * from @sds/schema rather than reimplemented for exactly that reason.
 */
function syncedDesignHashInput(study: Study, candidate: Candidate): Design {
  return syncCandidateToStudy(study, candidate).design;
}

/**
 * Best-effort flush when the page goes away.
 *
 * `pagehide` rather than `beforeunload`, because the latter does not fire on mobile and is
 * increasingly ignored. Neither guarantees an IndexedDB write completes during teardown, which is
 * exactly why every decision writes immediately rather than relying on this.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    const study = pendingStudy;
    if (!study) return;
    pendingStudy = null;
    if (saveTimer) clearTimeout(saveTimer);
    void saveStudy(study).catch(() => {
      // Nothing useful can be done during teardown, and throwing here would surface as an unhandled
      // rejection in the console of the page the user has already left.
    });
  });
}

/**
 * Restore whichever real study was open. With nothing saved, the empty study stands.
 *
 * Old builds persisted their bundled demo as if it were the user's project. Retire that exact id
 * before restore so upgrading cannot bring the demo back into the repository-first experience.
 */
export async function restoreStudy(): Promise<void> {
  const id = readActiveStudyId();
  const retiredActive = id !== null && isRetiredDevelopmentStudyId(id);
  if (retiredActive) writeActiveStudyId(null);
  try {
    await removeRetiredDevelopmentStudies();
  } catch {
    // Listing and loading also filter retired ids. Cleanup failure must not prevent the app from
    // opening when IndexedDB is unavailable; it can be retried on the next launch.
  }
  if (!id || retiredActive) return;
  const result = await loadStudy(id);
  if (result.status === "ok") {
    useStudyStore.getState().loadStudyDocument(result.study);
  } else if (result.status === "unreadable") {
    // Named rather than silently replaced. "Your study could not be read" needs a different
    // reaction from the user than "no study found", and conflating them loses work quietly.
    useStudyStore.setState({
      error: `the project "${id}" could not be read: ${result.reason}. An empty project is open instead; your saved project has not been overwritten.`,
    });
  }
}
