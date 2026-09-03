import { create } from "zustand"
import type { Counterexample, Design } from "@sds/schema"
import { planRace, stateAt, type RacePlan } from "./canvas/race"
import { useRacePlayback } from "./racePlayback"
import { useStudyStore } from "./study/store"

/**
 * The active version's counterexample, planned onto its design.
 *
 * Derived once per change of (design, counterexample) and shared by the race layer, the state chips
 * on every data node and the bottom-dock timeline. Computing it inside each node would do the same
 * layout work once per node per render; holding it here does it once and lets nodes subscribe with
 * a narrow selector.
 */
interface RaceModelState {
  candidateId: string | null
  design: Design | null
  counterexample: Counterexample | null
  plan: RacePlan | null
  /** Counter overrides the explorer ran with, so the "before" state matches the search. */
  overrides: Record<string, number>
}

export const useRaceModel = create<RaceModelState>(() => ({
  candidateId: null,
  design: null,
  counterexample: null,
  plan: null,
  overrides: {},
}))

const sync = () => {
  const state = useStudyStore.getState()
  const active = state.activeCandidate()
  const evaluation = active ? state.evaluationFor(active.id) : null
  const counterexample = evaluation?.correctness?.counterexample ?? null
  const design = active?.design ?? null
  const current = useRaceModel.getState()
  const overrides = state.study.correctness.stateOverrides

  if (
    current.design === design &&
    current.counterexample === counterexample &&
    current.candidateId === (active?.id ?? null) &&
    current.overrides === overrides
  ) {
    return
  }

  const invariant = counterexample
    ? (state.study.correctness.invariants.find((i) => i.id === counterexample.invariantId) ?? null)
    : null
  const plan = design && counterexample ? planRace(design, counterexample, invariant) : null

  useRaceModel.setState({ candidateId: active?.id ?? null, design, counterexample, plan, overrides })
  if (current.counterexample !== counterexample) useRacePlayback.getState().load(plan?.steps.length ?? 0)
}

useStudyStore.subscribe(sync)
sync()

/** State chip values for the collections stored on one node, at the current cursor. */
export const useNodeState = (nodeId: string): Array<{ id: string; label: string; value: string; changed: boolean; violated: boolean }> => {
  const design = useRaceModel((s) => s.design)
  const plan = useRaceModel((s) => s.plan)
  const overrides = useRaceModel((s) => s.overrides)
  const cursor = useRacePlayback((s) => s.cursor)
  if (!design?.workflow) return []
  const owned = design.workflow.collections.filter((c) => c.node === nodeId)
  if (owned.length === 0) return []
  const values = stateAt(plan, design, cursor, overrides)
  const step = plan && cursor >= 0 ? plan.steps[Math.min(cursor, plan.steps.length - 1)] : null
  const atEnd = plan !== null && cursor >= plan.steps.length - 1
  return owned.map((c) => ({
    id: c.id,
    label: c.label || c.id,
    value: values[c.id] ?? "",
    changed: step?.changed.includes(c.id) ?? false,
    violated: atEnd && (plan?.violatedCollections.includes(c.id) ?? false),
  }))
}
