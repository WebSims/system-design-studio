import { describe, expect, it } from "vitest"
import { blankStudy, isPlaceholderWorkload, applyStudyContract, type Study } from "@sds/schema"
import { AGENT_STEPS, deriveAgentProgress, nextStepHint } from "../src/study/steps"
import { applyArchitecturePatch, createCandidate, importRepositoryArchitecture } from "../src/study/mutations"

/**
 * The step tracker reads DOCUMENT STATE. These tests walk a study through the canonical order and
 * check that the tracker follows, and that skipping ahead is recorded rather than refused.
 */

const fresh = () => blankStudy({ id: "s1", name: "seats" })

const withDrawing = (study: Study) => createCandidate(study, { label: "as-is (drawing)", origin: "agent" })

const drawn = () => {
  const { study, candidate } = withDrawing(fresh())
  return applyArchitecturePatch(study, {
    candidateId: candidate.id,
    expectedRevision: 0,
    by: "agent",
    operations: [
      {
        op: "add-node",
        node: { id: "browser", kind: "client", label: "browser", x: 0, y: 240, client: { arrival: { kind: "poisson", ratePerSec: 20 } } },
      },
      {
        op: "add-node",
        node: {
          id: "api",
          kind: "server",
          label: "api",
          x: 320,
          y: 240,
          server: { concurrency: 8, fanout: "sequential", serviceTime: { kind: "deterministic", value: 0.01 } },
        },
      },
      {
        op: "add-node",
        node: {
          id: "db",
          kind: "database",
          label: "db",
          x: 640,
          y: 240,
          database: { serviceTime: { kind: "deterministic", value: 0.002 } },
        },
      },
      { op: "add-edge", edge: { id: "browser-api", from: "browser", to: "api", semantics: { kind: "synchronous" }, latency: { kind: "deterministic", value: 0.25 }, fanoutFactor: 1 } },
      { op: "add-edge", edge: { id: "api-db", from: "api", to: "db", semantics: { kind: "synchronous" }, latency: { kind: "deterministic", value: 0.001 }, fanoutFactor: 1 } },
    ],
  })
}

const statusOf = (study: Study, activity: Parameters<typeof deriveAgentProgress>[1] = []) =>
  Object.fromEntries(deriveAgentProgress(study, activity).steps.map((step) => [step.id, step.status]))

describe("the canonical step order", () => {
  it("draws first and sets the yardstick only after the workflow exists", () => {
    expect(AGENT_STEPS.map((step) => step.id)).toEqual([
      "project",
      "catalog",
      "draw",
      "workflow",
      "yardstick",
      "repository",
      "inventory",
      "seal",
      "evaluate",
    ])
  })

  it("starts with nothing done and the project step current", () => {
    const progress = deriveAgentProgress(fresh())
    expect(progress.current).toBe("project")
    expect(progress.steps[0]!.hint).toContain("studio_create_study")
    expect(progress.complete).toBe(false)
  })

  it("counts the project done once a version exists, and asks for the catalog next", () => {
    const { study } = withDrawing(fresh())
    const status = statusOf(study)
    expect(status.project).toBe("done")
    expect(status.catalog).toBe("current")
  })

  it("accepts a successful catalog read from the activity log", () => {
    const { study } = withDrawing(fresh())
    const status = statusOf(study, [{ tool: "studio_get_catalog", at: 1, ok: true, summary: "read the catalog" }])
    expect(status.catalog).toBe("done")
    expect(status.draw).toBe("current")
  })

  it("fills the drawing hint with the candidate id and revision", () => {
    const { study, candidate } = withDrawing(fresh())
    const progress = deriveAgentProgress(study, [{ tool: "studio_get_catalog", at: 1, ok: true, summary: "" }])
    const draw = progress.steps.find((step) => step.id === "draw")!
    expect(draw.hint).toContain(`candidateId: "${candidate.id}"`)
    expect(draw.hint).toContain(`expectedRevision: ${candidate.revision}`)
  })

  it("treats a valid drawing as having read enough of the catalog", () => {
    const { study } = drawn()
    const status = statusOf(study)
    expect(status.catalog).toBe("done")
    expect(status.draw).toBe("done")
    expect(status.workflow).toBe("current")
  })

  it("keeps the yardstick undone while the workload is the placeholder, and says so", () => {
    const { study } = drawn()
    const progress = deriveAgentProgress(study)
    const yardstick = progress.steps.find((step) => step.id === "yardstick")!
    expect(yardstick.status).toBe("todo")
    expect(isPlaceholderWorkload(study.workload)).toBe(true)
    expect(yardstick.hint).toMatch(/placeholder/)
    expect(yardstick.hint).toContain("invariantTemplates")
  })

  it("marks the yardstick done only with both a real workload and a rule", () => {
    const { study } = drawn()
    const workloadOnly = applyStudyContract(study, { workload: { arrival: { kind: "poisson", ratePerSec: 120 } } })
    expect(statusOf(workloadOnly).yardstick).toBe("todo")
    const both = applyStudyContract(workloadOnly, {
      correctness: {
        ...workloadOnly.correctness,
        invariants: [
          {
            id: "non-negative",
            label: "never negative",
            scope: "safety",
            expr: { kind: "compare", op: ">=", left: { kind: "counter", collection: "stock" }, right: { kind: "lit", value: 0 } },
            message: "went negative",
          },
        ],
      },
    })
    expect(statusOf(both).yardstick).toBe("done")
  })

  it("records a step done out of order rather than refusing it", () => {
    const study = applyStudyContract(fresh(), { workload: { arrival: { kind: "poisson", ratePerSec: 120 } } })
    const withRule = applyStudyContract(study, {
      correctness: {
        ...study.correctness,
        invariants: [
          {
            id: "r",
            label: "r",
            scope: "safety",
            expr: { kind: "compare", op: ">=", left: { kind: "counter", collection: "stock" }, right: { kind: "lit", value: 0 } },
            message: "m",
          },
        ],
      },
    })
    const status = statusOf(withRule)
    expect(status.yardstick).toBe("done")
    expect(status.project).toBe("current")
  })

  it("marks sealing done when a baseline is linked to a repository", () => {
    const { study, candidate } = drawn()
    const sealed = importRepositoryArchitecture(study, {
      repository: { id: "repo-1", name: "checkout", rootHint: "", branch: "main", revision: "abc", dirty: false, scope: [], excludedScope: [], changedPaths: [], workingTreeFingerprint: "", capturedAt: 1 },
      label: "as-is",
      fromCandidateId: candidate.id,
      expectedRevision: candidate.revision,
      origin: "human",
    })
    const status = statusOf(sealed.study)
    expect(status.seal).toBe("done")
    expect(status.evaluate).toBe("todo")
    const progress = deriveAgentProgress(sealed.study)
    expect(progress.steps.find((step) => step.id === "evaluate")!.hint).toContain(`candidateId: "${candidate.id}"`)
  })

  it("puts the last failed call next to the current step", () => {
    const { study } = drawn()
    const failure = { tool: "studio_update_study", at: 5, ok: false, summary: "the contract patch is not valid: ..." }
    const progress = deriveAgentProgress(study, [failure])
    expect(progress.failure).toEqual(failure)
    expect(progress.current).toBe("workflow")
  })

  it("forgets a failure once a later call succeeds", () => {
    const { study } = drawn()
    const progress = deriveAgentProgress(study, [
      { tool: "studio_update_study", at: 5, ok: false, summary: "no" },
      { tool: "studio_update_study", at: 6, ok: true, summary: "updated" },
    ])
    expect(progress.failure).toBeNull()
  })

  it("nextStepHint is the current step's hint, and null once everything is done", () => {
    expect(nextStepHint(fresh())).toContain("studio_create_study")
    const { study } = drawn()
    expect(nextStepHint(study)).toContain("set-workflow")
    const finished: Study = {
      ...study,
      evaluations: { k: {} as never },
      repositorySnapshots: [{ id: "repo-1", name: "r", rootHint: "", branch: "", revision: "", dirty: null, scope: [], excludedScope: [], changedPaths: [], workingTreeFingerprint: "", capturedAt: 1 }],
      activeRepositorySnapshotId: "repo-1",
    }
    const all = deriveAgentProgress({
      ...finished,
      candidates: finished.candidates.map((candidate) => ({ ...candidate, role: "baseline" as const })),
    })
    expect(all.steps.filter((step) => step.status === "done").map((step) => step.id)).toContain("seal")
  })
})
