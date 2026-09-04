import { useCallback, useState } from "react"
import { activeRepositorySnapshot, groundingReportForCandidate, performanceCalibration } from "@sds/schema"
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
  GaugeIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  StopIcon,
  type IconComponent,
} from "../ui/icons"
import { KindTile, Palette } from "./Palette"
import { ProjectMenu } from "./ProjectMenu"
import { ORDERED_PRESETS } from "./presetGroups"
import { useAddPreset } from "./useAddPreset"
import { CANVAS_PRESET_MIME } from "../canvas/editing"

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
  const simBusy = useStudio((s) => s.sessionBusy)
  const simSession = useStudio((s) => s.session)
  const setSessionPaused = useStudio((s) => s.setSessionPaused)
  const blocking = useStudio((s) => s.issues.filter((i) => i.severity === "error").length)

  if (!active) return null

  if (lens === "load") {
    const calibration = performanceCalibration(study, active)
    const disabledReason = !calibration.calibrated
      ? calibration.message
      : blocking > 0
        ? "The design has errors; see the analysis rail."
        : null
    const live =
      simSession !== null &&
      simSession.mode === "full" &&
      simSession.status !== "completed" &&
      simSession.status !== "invalidated"
    const busy = simRunning || simBusy
    return (
      <button
        className="btn primary hero-play"
        onClick={() => (live ? void setSessionPaused(!simSession.paused) : void execute())}
        disabled={busy || disabledReason !== null}
        title={disabledReason ?? "Simulate the workload against this version."}
      >
        {busy ? (
          <span className="spinner" aria-hidden="true" />
        ) : live && !simSession.paused ? (
          <PauseIcon size={13} />
        ) : (
          <PlayIcon size={13} />
        )}
        {busy
          ? "Updating\u2026"
          : live
            ? simSession.paused
              ? "Resume load"
              : "Pause load"
            : "Run under load"}
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
        no break found {"\u00b7"} search again
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
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy"
            event.dataTransfer.setData(CANVAS_PRESET_MIME, preset.id)
            event.dataTransfer.setData("text/plain", preset.id)
          }}
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
  const repository = activeRepositorySnapshot(study)
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
  const grounding = activeCandidate ? groundingReportForCandidate(study, activeCandidate) : null

  return (
    <details className="repository-status" onClick={(event) => event.stopPropagation()}>
      <summary title={`${repository.rootHint || repository.name} \u00b7 open grounding report`}>
        <span className={`repository-dot ${grounding?.status ?? ""}`} aria-hidden="true" />
        <strong>{repository.name}</strong>
        <code>
          {repository.branch || "workspace"}@{sourceRevision}
        </code>
        {grounding && <span className={`repository-grounding ${grounding.status}`}>{grounding.status}</span>}
        {repository.dirty && <span className="repository-dirty">dirty</span>}
      </summary>
      <section className="grounding-popover" aria-label="Repository grounding" aria-live="polite">
        <header>
          <div>
            <span className="panel-kicker">CURRENT · {grounding?.status ?? "unverified"}</span>
            <strong>{repository.rootHint || repository.name}</strong>
          </div>
          <code>{repository.revision || "revision missing"}</code>
        </header>
        <dl className="grounding-metrics">
          <div><dt>Architecture</dt><dd>{grounding?.architecture.covered ?? evidenceCoverage}/{grounding?.architecture.required ?? architectureElements}</dd></div>
          <div><dt>Behaviour</dt><dd>{grounding?.behavior.covered ?? 0}/{grounding?.behavior.required ?? 0}</dd></div>
          <div><dt>Inventory</dt><dd>{grounding?.inventory.total ?? 0}</dd></div>
        </dl>
        <p className="muted">Scope: {repository.scope.join(", ") || "whole repository"}</p>
        {repository.excludedScope.length > 0 && <p className="muted">Excluded: {repository.excludedScope.join(", ")}</p>}
        {grounding && grounding.gaps.length > 0 ? (
          <ul className="grounding-gaps">
            {grounding.gaps.slice(0, 6).map((gap, index) => <li key={`${gap.code}-${index}`}>{gap.message}</li>)}
          </ul>
        ) : <p className="grounding-clear">Grounding checks complete.</p>}
      </section>
    </details>
  )
}

/**
 * The header, in two rows and six controls.
 *
 * The primary row is about the PROJECT: where you are (the breadcrumb), which lens, the one Play
 * button whose label follows the lens, and how things stand (saved, agent connected, ready to
 * review). The secondary row is the EDITOR toolbar: what you can insert. Export and Import act on
 * the project, so they live in the project popover behind its name, not here.
 */
export const Topbar = () => {
  const design = useStudio((s) => s.design)
  const study = useStudyStore((s) => s.study)
  const persistence = useStudyStore((s) => s.persistence)
  const webmcp = useStudyStore((s) => s.webmcp)
  const reviewOpen = useStudyStore((s) => s.reviewOpen)
  const setReviewOpen = useStudyStore((s) => s.setReviewOpen)
  const agentOpen = useStudyStore((s) => s.agentOpen)
  const setAgentOpen = useStudyStore((s) => s.setAgentOpen)
  const noteCount = useStudyStore((s) => s.annotations.length)
  const agentBusy = useStudyStore((s) => s.agentBusy > 0)
  const homeOpen = useStudyStore((s) => s.homeOpen)
  const uiDensity = useStudyStore((s) => s.uiDensity)
  const setUiDensity = useStudyStore((s) => s.setUiDensity)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const hasCandidates = study.candidates.length > 0
  /** The canvas is showing: lens, Play, Insert and Review make sense. The breadcrumb stays over the home. */
  const onCanvas = hasCandidates && !homeOpen
  const webmcpReady = webmcp.status.includes("tools")

  const closePalette = useCallback(() => setPaletteOpen(false), [])

  return (
    <header className="topbar" onClick={closePalette}>
      <div className="topbar-primary">
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <div>
            <div className="brand-name">
              System Design <b>Studio</b>
            </div>
            {hasCandidates ? <ProjectMenu /> : <div className="brand-sub">{"Draw \u2192 play \u2192 fix \u2192 hand off"}</div>}
          </div>
        </div>

        {onCanvas && (
          <div className="tb-section tb-study" role="group" aria-label="Project">
            <LensTabs />
            <HeroPlay />
          </div>
        )}

        <div className="tb-spacer" />

        <div className="topbar-status" role="group" aria-label="Status">
          <div
            className={`density-control density-control-${uiDensity}`}
            title={
              uiDensity === "guided"
                ? "Guided keeps core controls visible and folds advanced modelling settings."
                : "Expert expands advanced modelling settings and shows raw evidence and rule expressions."
            }
          >
            <div className="tabs tabs-small density-toggle" role="group" aria-label="Interface detail">
              <button
                className={uiDensity === "guided" ? "active" : ""}
                aria-pressed={uiDensity === "guided"}
                onClick={() => setUiDensity("guided")}
              >
                Guided
              </button>
              <button
                className={uiDensity === "expert" ? "active" : ""}
                aria-pressed={uiDensity === "expert"}
                onClick={() => setUiDensity("expert")}
              >
                Expert
              </button>
            </div>
            <span className="density-caption" role="status" aria-live="polite">
              {uiDensity === "guided" ? "Core controls" : "All controls"}
            </span>
          </div>
          {onCanvas && (
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
            className={`btn tool-btn status-btn ${agentOpen ? "active" : ""} ${agentBusy ? "busy" : ""}`}
            title={agentBusy ? "The agent is working on this project right now." : webmcp.detail}
            aria-pressed={agentOpen}
            aria-busy={agentBusy}
            onClick={(e) => {
              e.stopPropagation()
              setAgentOpen(!agentOpen)
            }}
          >
            <span className="status-glyph">
              <BotIcon size={15} />
              <span className={`status-dot ${webmcpReady ? "ready" : ""} ${agentBusy ? "busy" : ""}`} />
            </span>
            {agentBusy ? "Agent working" : "Agent"}
            {noteCount > 0 && <span className="count-pill tnum">{noteCount}</span>}
          </button>
          {onCanvas && (
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

      {onCanvas && (
        <div className="topbar-secondary toolbar" role="toolbar" aria-label="Editor tools">
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

          <RepositoryStatus />

          <div className="tb-spacer" />
        </div>
      )}
    </header>
  )
}
