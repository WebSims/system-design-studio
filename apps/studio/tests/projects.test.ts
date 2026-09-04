import { beforeEach, describe, expect, it } from "vitest"
import { isPlaceholderWorkload } from "@sds/schema"
import { useStudio } from "../src/store"
import { manualCandidate } from "../src/study/mutations"
import { useStudyStore } from "../src/study/store"

/**
 * Projects and versions as a person reaches them: the store flows behind "New project", the
 * breadcrumb popover and the Workload row. Persistence is IndexedDB and absent in node, so these
 * exercise the in-memory document; `persist.test.ts` covers the list rows.
 */

const store = () => useStudyStore.getState()

const newProject = (name?: string) => {
  store().createStudy(name ? { name } : {})
  store().addCandidate(manualCandidate())
  return store().study
}

beforeEach(() => {
  useStudyStore.setState({ homeOpen: false, workloadEditOpen: false, error: null })
})

describe("New project", () => {
  it("lands on a blank canvas in a fresh project, leaving the open one behind", () => {
    const first = newProject("first")
    expect(first.candidates).toHaveLength(1)
    expect(first.candidates[0]).toMatchObject({ origin: "human", role: "experiment" })
    expect(first.candidates[0]!.design.nodes).toEqual([])

    store().setHomeOpen(true)
    const second = newProject()
    expect(second.id).not.toBe(first.id)
    expect(second.name).toBe("untitled project")
    expect(second.candidates).toHaveLength(1)
    // Opening a project closes the home; the canvas is what shows next.
    expect(store().homeOpen).toBe(false)
  })

  it("has the same shape the agent's studio_create_study produces: one project, one empty version", () => {
    const project = newProject("shape")
    const only = project.candidates[0]!
    expect(project.activeCandidateId).toBe(only.id)
    expect(only.design.edges).toEqual([])
    expect(only.design.workflow).toBeNull()
    expect(isPlaceholderWorkload(project.workload)).toBe(true)
  })
})

describe("the project popover", () => {
  it("renames the project and its problem without touching the yardstick", () => {
    const before = newProject("old name")
    store().renameStudy({ name: "  new name  ", problem: "each seat once" })
    const after = store().study
    expect(after.name).toBe("new name")
    expect(after.problem).toBe("each seat once")
    expect(after.id).toBe(before.id)
    expect(after.workload).toEqual(before.workload)
    expect(after.correctness).toEqual(before.correctness)
  })

  it("keeps the name when the rename is blank", () => {
    newProject("keep me")
    store().renameStudy({ name: "   " })
    expect(store().study.name).toBe("keep me")
  })

  it("duplicates under a new id with results cleared, so the copy's yardstick is unlocked", () => {
    const source = newProject("source")
    const copy = store().duplicateStudy()
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe("copy of source")
    expect(copy.candidates).toHaveLength(1)
    expect(copy.evaluations).toEqual({})
    expect(copy.promotedCandidateId).toBeNull()
    expect(store().study.id).toBe(copy.id)
  })

  it("refuses to delete the open project from the list, so nothing open can vanish", async () => {
    const open = newProject("open")
    // Let the portfolio refresh that addCandidate kicked off settle (it has no worker in node).
    await new Promise((resolve) => setTimeout(resolve, 0))
    useStudyStore.setState({ error: null })
    const refused = store().deleteStoredStudy(open.id)
    expect(store().error).toMatch(/open project cannot be deleted/)
    await refused
    expect(store().study.id).toBe(open.id)
  })
})

describe("the Workload row", () => {
  it("starts as the placeholder and stops being one after the rate is set", () => {
    newProject("workload")
    expect(isPlaceholderWorkload(store().study.workload)).toBe(true)
    store().updateContract({ workload: { arrival: { kind: "poisson", ratePerSec: 120 } } })
    expect(isPlaceholderWorkload(store().study.workload)).toBe(false)
    expect(store().study.workload.arrival).toEqual({ kind: "poisson", ratePerSec: 120 })
  })

  it("re-syncs the active version at once, so the client on the canvas shows what will run", () => {
    newProject("sync")
    useStudio.getState().edit((d) => {
      d.nodes.push({
        id: "users",
        kind: "client",
        label: "users",
        x: 0,
        y: 0,
        client: { arrival: { kind: "poisson", ratePerSec: 7 }, timeoutMs: null },
      } as never)
    })
    // The edit itself is synced: the preset's 7 req/s never reaches the canvas.
    const drawn = useStudio.getState().design.nodes.find((n) => n.id === "users")!
    expect(drawn.client?.arrival).toEqual(store().study.workload.arrival)

    store().updateContract({ workload: { arrival: { kind: "deterministic", ratePerSec: 300 } } })
    const synced = useStudio.getState().design.nodes.find((n) => n.id === "users")!
    expect(synced.client?.arrival).toEqual({ kind: "deterministic", ratePerSec: 300 })
    const candidate = store().study.candidates.find((c) => c.id === store().study.activeCandidateId)!
    expect(candidate.design.nodes.find((n) => n.id === "users")!.client?.arrival).toEqual({ kind: "deterministic", ratePerSec: 300 })
  })

  it("writes run length, seeds and SLO through the same contract", () => {
    newProject("advanced")
    store().updateContract({ workload: { durationSec: 600, warmupSec: 0, seeds: [1, 2, 3] } })
    store().updateContract({ targets: { ...store().study.targets, slo: { p99LatencyMs: 250, maxErrorRatePct: null } } })
    const study = store().study
    expect(study.workload).toMatchObject({ durationSec: 600, warmupSec: 0, seeds: [1, 2, 3] })
    expect(study.targets.slo).toEqual({ p99LatencyMs: 250, maxErrorRatePct: null })
    const design = useStudio.getState().design
    expect(design.scenario).toMatchObject({ durationSec: 600, warmupSec: 0 })
    expect(design.slo).toEqual({ p99LatencyMs: 250, maxErrorRatePct: null })
  })

  it("the client inspector's jump opens the row under the Behaviour lens", () => {
    newProject("jump")
    store().setLens("load")
    store().setWorkloadEditOpen(true)
    expect(store().workloadEditOpen).toBe(true)
    expect(store().lens).toBe("behaviour")
  })
})
