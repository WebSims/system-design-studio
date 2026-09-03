import { useCallback, useRef, useState, type ChangeEvent } from "react"
import { performanceCalibration } from "@sds/schema"
import { studyFilename } from "../persist"
import { useRaceModel } from "../raceModel"
import { useRacePlayback } from "../racePlayback"
import { useStudio } from "../store"
import { useStudyStore, type LensId } from "../study/store"
import {
  BotIcon,
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  CompareIcon,
  DownloadIcon,
  GaugeIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  StopIcon,
  UploadIcon,
  type IconComponent,
} from "../ui/icons"
import { KindTile, Palette } from "./Palette"
import { ORDERED_PRESETS } from "./presetGroups"
import { useAddPreset } from "./useAddPreset"

const LENSES: Array<{ id: LensId; label: string; hint: string; icon: IconComponent }> = [
  { id: "behaviour", label: "Behaviour", hint: "Does it break? A few requests, every order they can run in.", icon: BranchIcon },
  { id: "load", label: "Load", hint: "Does it hold up? Rates, queues, latency, the bottleneck.", icon: GaugeIcon },
]

/**
 * The lens switch.
 *
 * Two lenses over ONE canvas and one document. Not two modes with their own state: a race verdict and
 * a latency figure that described slightly different documents would be the incoherence the whole
 * study format exists to prevent.
 */
const LensTabs = () => {
  const lens = useStudyStore((s) => s.lens)
  const setLens = useStudyStore((s) => s.setLens)
  return (
    <nav className="tabs lens-tabs" aria-label="Lens">
      {LENSES.map(({ id, label, hint, icon: Glyph }) => (
        <button
          key={id}
          className={lens === id ? "active" : ""}
          aria-current={lens === id ? "page" : undefined}
          title={hint}
          onClick={() => setLens(id)}
        >
          <Glyph size={14} />
          {label}
        </button>
      ))}
    </nav>
  )
}

/**
 * One Play button that does the right thing for the lens.
 *
 * Behaviour: find races if nothing has been checked; play the break if one was found. Load: run the
 * simulation. The dock has the fine controls; this is the hero loop's one big button.
 */
const HeroPlay = () => {
  const lens = useStudyStore((s) => s.lens)
  const active = useStudyStore((s) => s.activeCandidate())
  const study = useStudyStore((s) => s.study)
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null))
  const running = useStudyStore((s) => (active ? s.running.has(active.id) : false))
  const checkOnly = useStudyStore((s) => s.checkOnly)
  const cancel = useStudyStore((s) => s.cancel)
  const rules = useStudyStore((s) => s.study.correctness.invariants.length)
  const plan = useRaceModel((s) => s.plan)
  const playing = useRacePlayback((s) => s.playing)
  const toggle = useRacePlayback((s) => s.toggle)
  const execute = useStudio((s) => s.execute)
  const simRunning = useStudio((s) => s.running)
  const blocking = useStudio((s) => s.issues.filter((i) => i.severity === "error").length)

  if (!active) return null

  if (lens === "load") {
    const calibration = performanceCalibration(study, active)
    const disabledReason = !calibration.calibrated
      ? calibration.message
      : blocking > 0
        ? "The design has errors; see the analysis rail."
        : null
    return (
      <button
        className="btn primary hero-play"
        onClick={execute}
        disabled={simRunning || disabledReason !== null}
        title={disabledReason ?? "Simulate the workload against this version."}
      >
        {simRunning ? <span className="spinner" aria-hidden="true" /> : <PlayIcon size={13} />}
        {simRunning ? "Running\u2026" : "Run under load"}
      </button>
    )
  }

  if (running) {
    return (
      <button className="btn hero-play" onClick={cancel}>
        <StopIcon size={12} />
        cancel search
      </button>
    )
  }

  if (plan) {
    return (
      <button className="btn primary hero-play breaks" onClick={toggle} title="Play the order of events that breaks a rule, on the canvas.">
        {playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
        {playing ? "pause" : "Play how it breaks"}
      </button>
    )
  }

  if (evaluation?.correctness?.status === "NO_VIOLATION_WITHIN_BOUNDS") {
    return (
      <button className="btn hero-play passes" onClick={() => void checkOnly(active.id)} title="No break found within the limits. Search again after a change.">
        <CheckIcon size={14} />
        passes rules {"\u00b7"} search again
      </button>
    )
  }

  const hasBehaviour = (active.design.workflow?.handlers.length ?? 0) > 0
  const disabledReason = !hasBehaviour
    ? "Give a component some request steps first."
    : rules === 0
      ? "Add a rule to check first."
      : null
  return (
    <button
      className="btn primary hero-play"
      disabled={disabledReason !== null}
      title={disabledReason ?? "Explore every order the requests can run in, looking for one that breaks a rule."}
      onClick={() => void checkOnly(active.id)}
    >
      <SearchIcon size={14} />
      Find races
    </button>
  )
}

/**
 * The quick-insert strip: one glyph per preset, in palette order.
 *
 * For the person who already knows what a database looks like and does not want to read a menu to
 * add one. The full palette, with blurbs and a filter, is one click to the left.
 */
const QuickInsert = () => {
  const add = useAddPreset()
  return (
    <div className="toolbar-quick" role="group" aria-label="Quick insert">
      {ORDERED_PRESETS.map((preset) => (
        <button
          key={preset.id}
          className="tool-btn icon-only"
          aria-label={`Add ${preset.label}`}
          title={`${preset.label}\n${preset.blurb}`}
          onClick={(e) => {
            e.stopPropagation()
            add(preset.id)
          }}
        >
          <KindTile preset={preset} size={15} />
        </button>
      ))}
    </div>
  )
}

const RepositoryStatus = () => {
  const study = useStudyStore((s) => s.study)
  const repository = study.repository
  if (!repository) return null

  const activeCandidate =
    study.candidates.find((candidate) => candidate.id === study.activeCandidateId) ?? study.candidates[0]
  const evidenceCoverage = activeCandidate
    ? new Set(
        activeCandidate.evidence
          .filter((evidence) => evidence.aspect !== "performance")
          .map((evidence) => `${evidence.targetKind}:${evidence.targetId}`)
      ).size
    : 0
  const architectureElements = activeCandidate
    ? activeCandidate.design.nodes.length + activeCandidate.design.edges.length
    : 0
  const sourceRevision = repository.revision ? repository.revision.slice(0, 9) : "unversioned"

  return (
    <div
      className="repository-status"
      title={`${repository.rootHint || repository.name} \u00b7 ${evidenceCoverage}/${architectureElements} architecture elements have evidence`}
    >
      <span className="repository-dot" />
      <strong>{repository.name}</strong>
      <code>
        {repository.branch || "workspace"}@{sourceRevision}
      </code>
      <span className="repository-coverage">
        {evidenceCoverage}/{architectureElements} evidenced
      </span>
      {repository.dirty && <span className="repository-dirty">dirty</span>}
    </div>
  )
}

/**
 * The header, in two rows.
 *
 * The primary row is about the STUDY: which lens, the one big button, how the document stands (saved,
 * agent connected, ready to review). The secondary row is the EDITOR toolbar: what you can insert and
 * how the file moves in and out. Grouped with labels and separators, the way an editor does it, so a
 * reader finds "add a database" and "export" without scanning a row of same-looking buttons.
 */
export const Topbar = () => {
  const design = useStudio((s) => s.design)
  const study = useStudyStore((s) => s.study)
  const exportStudyJson = useStudyStore((s) => s.exportStudyJson)
  const importStudyJson = useStudyStore((s) => s.importStudyJson)
  const persistence = useStudyStore((s) => s.persistence)
  const webmcp = useStudyStore((s) => s.webmcp)
  const reviewOpen = useStudyStore((s) => s.reviewOpen)
  const setReviewOpen = useStudyStore((s) => s.setReviewOpen)
  const agentOpen = useStudyStore((s) => s.agentOpen)
  const setAgentOpen = useStudyStore((s) => s.setAgentOpen)
  const noteCount = useStudyStore((s) => s.annotations.length)
  const fileRef = useRef<HTMLInputElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const hasCandidates = study.candidates.length > 0
  const webmcpReady = webmcp.status.includes("tools")

  const closePalette = useCallback(() => setPaletteOpen(false), [])

  const download = useCallback(() => {
    // A STUDY, not a design. The design alone would lose the rules, the bounds and every other
    // version -- which is to say it would lose the argument and keep only one of its conclusions.
    const blob = new Blob([exportStudyJson()], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = studyFilename(study)
    a.click()
    URL.revokeObjectURL(url)
  }, [exportStudyJson, study])

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    // Accepts a study OR a bare design; a design becomes a one-version project with no rules, which
    // is the honest treatment of a document that has none.
    importStudyJson(await file.text())
    event.target.value = ""
  }

  return (
    <header className="topbar" onClick={closePalette}>
      <div className="topbar-primary">
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <div>
            <div className="brand-name">
              System Design <b>Studio</b>
            </div>
            <div className="brand-sub">{"Draw \u2192 play \u2192 fix \u2192 hand off"}</div>
          </div>
        </div>

        {hasCandidates && (
          <div className="tb-section tb-study" role="group" aria-label="Study">
            <LensTabs />
            <HeroPlay />
          </div>
        )}

        <div className="tb-spacer" />

        <div className="topbar-status" role="group" aria-label="Status">
          {hasCandidates && (
            <span className="tb-meta tnum">
              {design.nodes.length} components {"\u00b7"} {design.edges.length} links
            </span>
          )}
          {persistence.status !== "idle" && (
            <span className={`save-status ${persistence.status === "failed" ? "issue-error" : ""}`} title={persistence.detail}>
              {persistence.status === "failed" ? "Not saved" : persistence.status}
            </span>
          )}
          <button
            className={`btn tool-btn status-btn ${agentOpen ? "active" : ""}`}
            title={webmcp.detail}
            aria-pressed={agentOpen}
            onClick={(e) => {
              e.stopPropagation()
              setAgentOpen(!agentOpen)
            }}
          >
            <span className="status-glyph">
              <BotIcon size={15} />
              <span className={`status-dot ${webmcpReady ? "ready" : ""}`} />
            </span>
            Agent
            {noteCount > 0 && <span className="count-pill tnum">{noteCount}</span>}
          </button>
          {hasCandidates && (
            <button
              className={`btn tool-btn ${reviewOpen ? "active" : ""}`}
              aria-pressed={reviewOpen}
              title="Compare versions, approve one, and send the approved change to your agent."
              onClick={(e) => {
                e.stopPropagation()
                setReviewOpen(!reviewOpen)
              }}
            >
              <CompareIcon size={15} />
              Review &amp; hand off
            </button>
          )}
        </div>
      </div>

      <div className="topbar-secondary toolbar" role="toolbar" aria-label="Editor tools">
        {hasCandidates && (
          <div className="toolbar-group" role="group" aria-label="Insert">
            <span className="toolbar-label">Insert</span>
            <div className="menu-anchor">
              <button
                className={`btn tool-btn ${paletteOpen ? "active" : ""}`}
                aria-expanded={paletteOpen}
                aria-haspopup="dialog"
                title="Browse every component, with a note on when each is the wrong choice."
                onClick={(e) => {
                  e.stopPropagation()
                  setPaletteOpen((open) => !open)
                }}
              >
                <PlusIcon size={14} />
                Component
                <ChevronDownIcon size={12} className="tool-caret" />
              </button>
              {paletteOpen && <Palette onClose={closePalette} />}
            </div>
            <span className="toolbar-sep" aria-hidden="true" />
            <QuickInsert />
          </div>
        )}

        <RepositoryStatus />

        <div className="tb-spacer" />

        <div className="toolbar-group" role="group" aria-label="File">
          <span className="toolbar-label">File</span>
          {hasCandidates && (
            <button className="btn tool-btn" onClick={download} title="Download the whole study: every version, the rules, the bounds.">
              <DownloadIcon size={14} />
              Export
            </button>
          )}
          <button className="btn tool-btn" onClick={() => fileRef.current?.click()} title="Open a study or a bare design from a JSON file.">
            <UploadIcon size={14} />
            Import
          </button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => void importFile(e)} />
        </div>
      </div>
    </header>
  )
}
