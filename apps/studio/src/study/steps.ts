import { isPlaceholderWorkload, type Candidate, type Study } from "@sds/schema"
import type { ActivityEntry } from "../webmcp/tools"

/**
 * The one order in which a project gets built by an agent, as data.
 *
 * WHY THIS IS A MODULE AND NOT A PARAGRAPH
 *
 * The same sequence used to live in four places -- the codebase prompt, the tool descriptions, the
 * `next` hints returned by tools, and the start screen's copy -- and they had drifted: the prompt
 * said "define the yardstick" before "draw", the GUI disabled "add a rule" until a collection
 * existed, and an agent following the prompt spent six calls guessing an invariant schema for
 * collections it had not drawn yet. One list, read by the tools for their hints and by the agent
 * panel for its tracker, cannot drift.
 *
 * Every step is decided from DOCUMENT STATE, not from which tools were called. A person who drew
 * the components by hand has done the drawing step; an agent that skipped the catalog and drew a
 * valid design has, for every practical purpose, read enough of it.
 */

export type StepId = "project" | "repository" | "inventory" | "catalog" | "draw" | "workflow" | "yardstick" | "seal" | "evaluate"

export type StepStatus = "done" | "current" | "todo"

export interface StepContext {
  study: Study
  /** The architecture being built: the baseline if one exists, else the active experiment. */
  drawing: Candidate | null
  /** Tools that have succeeded against this document, from the activity log. */
  succeeded: ReadonlySet<string>
}

export interface AgentStep {
  id: StepId
  label: string
  /** What has to be true for this step to count as done. */
  unblocks: string
  done(ctx: StepContext): boolean
  /** The next call, with ids and revisions filled in, so nothing has to be re-read. */
  hint(ctx: StepContext): string
}

const patchCall = (drawing: Candidate | null): string =>
  drawing
    ? `studio_apply_architecture_patch { candidateId: "${drawing.id}", expectedRevision: ${drawing.revision} }`
    : "studio_apply_architecture_patch"

const collectionsOf = (drawing: Candidate | null): string[] =>
  drawing?.design.workflow?.collections.map((collection) => collection.id) ?? []

export const AGENT_STEPS: readonly AgentStep[] = [
  {
    id: "project",
    label: "open a project",
    unblocks: "a project with an empty version exists, so the canvas is showing",
    done: ({ study }) => study.candidates.length > 0,
    hint: () =>
      "studio_create_study { name, problem, workload? } creates the project and opens a blank canvas to draw on. " +
      "Pass the arrival you observed as workload when you already know it.",
  },
  {
    id: "catalog",
    label: "read the catalog",
    unblocks: "studio_get_catalog was read, or something valid is already drawn",
    done: ({ succeeded, drawing }) => (drawing?.design.nodes.length ?? 0) > 0 || succeeded.has("studio_get_catalog"),
    hint: () =>
      "studio_get_catalog: component kinds, the closed set of workflow operations, layout rules, latency placeholders " +
      "and invariantTemplates. Read it once before drawing.",
  },
  {
    id: "draw",
    label: "draw components and links",
    unblocks: "at least one component and one link on the canvas",
    done: ({ drawing }) => (drawing?.design.nodes.length ?? 0) > 0 && (drawing?.design.edges.length ?? 0) > 0,
    hint: ({ drawing }) =>
      `${patchCall(drawing)}: one add-node per component with x/y from studio_get_catalog.layoutGuide (or include an ` +
      "auto-layout operation and omit them); set fanout and positive timing fields explicitly; then add-edge once both " +
      "ends exist, with a positive one-way latency and fanoutFactor (1 for one-to-one). Each accepted patch is drawn at once.",
  },
  {
    id: "workflow",
    label: "trace one flow into a workflow",
    unblocks: "the drawing has a workflow with collections and at least one handler",
    done: ({ drawing }) => (drawing?.design.workflow?.handlers.length ?? 0) > 0,
    hint: ({ drawing }) =>
      `${patchCall(drawing)} with { op: "set-workflow", workflow }: the collections (counters and tables on the database) ` +
      "and one handler on the component that serves the highest-risk state-changing flow, with a citation per step.",
  },
  {
    id: "yardstick",
    label: "set the yardstick",
    unblocks: "the workload is no longer the placeholder and at least one rule names a collection you drew",
    done: ({ study }) => !isPlaceholderWorkload(study.workload) && study.correctness.invariants.length > 0,
    hint: ({ study, drawing }) => {
      const collections = collectionsOf(drawing)
      const workload = isPlaceholderWorkload(study.workload)
        ? "workload: the arrival you observed or the assumption you are making (the placeholder 50 req/s is refused by the runners); "
        : ""
      const rules =
        study.correctness.invariants.length === 0
          ? `correctness.invariants as { template, args } from studio_get_catalog.invariantTemplates, naming the collections you drew` +
            (collections.length > 0 ? ` (${collections.join(", ")})` : "") +
            "; "
          : ""
      return `studio_update_study { contract: { ... } }: ${workload}${rules}plus targets and faults where the source supports them.`
    },
  },
  {
    id: "repository",
    label: "capture repository state",
    unblocks: "the source revision, scope and dirty-tree identity are ready to seal",
    done: ({ study }) => study.repositorySnapshots.length > 0,
    hint: () =>
      "Inspect the repository branch, base revision, included and excluded paths. If it is dirty, also collect changedPaths and a deterministic workingTreeFingerprint for studio_import_architecture.",
  },
  {
    id: "inventory",
    label: "inventory runtime boundaries",
    unblocks: "entrypoints, work sources, runtimes, dependencies, queues and stores are accounted for",
    done: ({ drawing }) => (drawing?.grounding?.sourceInventory.length ?? 0) > 0,
    hint: ({ drawing }) =>
      drawing?.role === "baseline"
        ? `studio_upsert_source_inventory { candidateId: "${drawing.id}", expectedRevision: ${drawing.revision}, items }`
        : "Build sourceInventory while inspecting code, then include it in studio_import_architecture. Every item is modeled, excluded with a reason, or unresolved.",
  },
  {
    id: "seal",
    label: "seal the as-is baseline",
    unblocks: "the drawing is the immutable baseline, linked to a repository revision",
    done: ({ study }) => study.activeRepositorySnapshotId !== null && study.candidates.some((candidate) => candidate.role === "baseline"),
    hint: ({ drawing }) =>
      drawing
        ? `studio_import_architecture { fromCandidateId: "${drawing.id}", expectedRevision: ${drawing.revision}, repository, evidence } ` +
          "with the repository state, sourceInventory, and hashed code/config evidence for every architecture and behavior target. Incomplete work seals as PROVISIONAL."
        : "studio_import_architecture { fromCandidateId, expectedRevision, repository, evidence }.",
  },
  {
    id: "evaluate",
    label: "evaluate and show the gaps",
    unblocks: "at least one evaluation exists",
    done: ({ study }) => Object.keys(study.evaluations).length > 0,
    hint: ({ drawing }) =>
      `studio_run_evaluation { candidateId: "${drawing?.id ?? "<candidateId>"}", correctness: true } (performance only once ` +
      "calibrated), then studio_annotate the components involved and studio_focus the step where it goes wrong.",
  },
]

export interface StepProgress {
  id: StepId
  label: string
  status: StepStatus
  unblocks: string
  hint: string
}

export interface AgentProgress {
  steps: StepProgress[]
  current: StepId | null
  /** The last call, when it failed; shown under the current step so the fix sits next to the block. */
  failure: ActivityEntry | null
  /** Everything is done. */
  complete: boolean
}

export function drawingCandidate(study: Study): Candidate | null {
  return (
    study.candidates.find((candidate) => candidate.role === "baseline") ??
    study.candidates.find((candidate) => candidate.id === study.activeCandidateId) ??
    study.candidates[0] ??
    null
  )
}

export function deriveAgentProgress(study: Study, activity: readonly ActivityEntry[] = []): AgentProgress {
  const ctx: StepContext = {
    study,
    drawing: drawingCandidate(study),
    succeeded: new Set(activity.filter((entry) => entry.ok).map((entry) => entry.tool)),
  }
  const done = AGENT_STEPS.map((step) => step.done(ctx))
  const currentIndex = done.findIndex((isDone) => !isDone)
  const last = activity[activity.length - 1]
  return {
    steps: AGENT_STEPS.map((step, index) => ({
      id: step.id,
      label: step.label,
      status: done[index] ? "done" : index === currentIndex ? "current" : "todo",
      unblocks: step.unblocks,
      hint: step.hint(ctx),
    })),
    current: currentIndex >= 0 ? AGENT_STEPS[currentIndex]!.id : null,
    failure: last && !last.ok ? last : null,
    complete: currentIndex < 0,
  }
}

/** The one line a tool result should end with: the current step's hint, or nothing once complete. */
export function nextStepHint(study: Study): string | null {
  const progress = deriveAgentProgress(study)
  const current = progress.steps.find((step) => step.status === "current")
  return current ? current.hint : null
}
