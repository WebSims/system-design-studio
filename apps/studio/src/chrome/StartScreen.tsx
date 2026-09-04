import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { CODEBASE_PROMPT, CODEBASE_PROMPT_ROUTE } from "../codebase-prompt"
import { DEMO_SCENARIOS } from "../examples"
import type { StoredStudy } from "../persist"
import { manualCandidate } from "../study/mutations"
import { useStudyStore } from "../study/store"
import { AgentStepper } from "../panels/AgentStepper"
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ClipboardIcon,
  CompareIcon,
  EyeIcon,
  EyeOffIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  UploadIcon,
  WrenchIcon,
  type IconComponent,
} from "../ui/icons"

/** The loop the product is built around, in the order the brand line says it. The detail is a tooltip. */
const LOOP: Array<{ icon: IconComponent; label: string; detail: string }> = [
  { icon: PencilIcon, label: "Draw", detail: "the components, the links, the request steps" },
  { icon: PlayIcon, label: "Play", detail: "every order the requests can run in" },
  { icon: WrenchIcon, label: "Fix", detail: "the version that breaks, measured under load" },
  { icon: CompareIcon, label: "Hand off", detail: "the approved change to your agent" },
]

const FINDS = [
  "lost updates",
  "double bookings",
  "idempotency keys per attempt",
  "unfenced leases",
  "stale owners",
  "queue redelivery",
  "crash mid-write",
  "expiry timing",
  "the bottleneck",
  "retry storms",
  "growing backlog",
  "quorum gaps",
  "replica partitions",
  "divergence and clock skew",
]

const NOT_YET = ["general liveness proofs", "packet-level networking", "deployment orchestration"]

type CopyState = "idle" | "copying" | "copied" | "failed"

/**
 * Copy is the only action this prompt takes. The agent remains responsible for deciding which
 * registered tools to call, and the user can edit the visible request before sending it.
 */
const copyPrompt = async (prompt: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(prompt)
    return true
  } catch {
    return false
  }
}

const relativeTime = (at: number): string => {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}

const PromptRoute = () => (
  <ol className="prompt-route" aria-label="Create system design from codebase workflow">
    {CODEBASE_PROMPT_ROUTE.map((step) => (
      <li key={step}>{step}</li>
    ))}
  </ol>
)

/** Re-read the saved list whenever a save lands, so a rename or a new project shows without a reload. */
const useStoredProjects = (): { projects: StoredStudy[]; refresh: () => void } => {
  const storedStudies = useStudyStore((s) => s.storedStudies)
  const saveStatus = useStudyStore((s) => s.persistence.status)
  const [projects, setProjects] = useState<StoredStudy[]>([])
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    storedStudies()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => {
        // IndexedDB unavailable: the list simply stays empty.
      })
    return () => {
      cancelled = true
    }
  }, [storedStudies, saveStatus, tick])

  return { projects, refresh }
}

const ProjectRow = ({
  project,
  isOpen,
  onChanged,
}: {
  project: StoredStudy
  isOpen: boolean
  onChanged: () => void
}) => {
  const openStudy = useStudyStore((s) => s.openStudy)
  const renameStoredStudy = useStudyStore((s) => s.renameStoredStudy)
  const duplicateStoredStudy = useStudyStore((s) => s.duplicateStoredStudy)
  const deleteStoredStudy = useStudyStore((s) => s.deleteStoredStudy)
  const setHomeOpen = useStudyStore((s) => s.setHomeOpen)
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view")
  const [name, setName] = useState(project.name)

  const open = () => {
    if (isOpen) {
      setHomeOpen(false)
      return
    }
    void openStudy(project.id)
  }

  const submitRename = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) await renameStoredStudy(project.id, { name })
    setMode("view")
    onChanged()
  }

  const remove = async () => {
    await deleteStoredStudy(project.id)
    setMode("view")
    onChanged()
  }

  return (
    <li className={`project-row ${isOpen ? "open" : ""}`}>
      {mode === "rename" ? (
        <form className="project-row-rename" onSubmit={(e) => void submitRename(e)}>
          <input autoFocus value={name} maxLength={120} aria-label="Project name" onChange={(e) => setName(e.target.value)} />
          <button className="btn small primary" type="submit">
            Save
          </button>
          <button className="btn small" type="button" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="project-row-main" onClick={open} title={project.problem || project.name}>
          <span className="project-row-name">
            <strong>{project.name}</strong>
            {isOpen && <span className="chip-mark chip-open">open</span>}
            {project.hasAgentVersions && <span className="chip-mark">AI</span>}
          </span>
          {project.problem && <span className="project-row-problem">{project.problem}</span>}
          <span className="project-row-meta tnum">
            {project.candidateCount} version{project.candidateCount === 1 ? "" : "s"} {"\u00b7"} {relativeTime(project.updatedAt)}
          </span>
        </button>
      )}

      {mode === "delete" ? (
        <div className="confirm-row">
          <span className="small">Delete “{project.name}”?</span>
          <button className="btn small danger" onClick={() => void remove()}>
            Delete
          </button>
          <button className="btn small" onClick={() => setMode("view")}>
            Keep
          </button>
        </div>
      ) : (
        mode === "view" && (
          <div className="project-row-actions" role="group" aria-label={`${project.name} actions`}>
            <button className="btn small ghost" onClick={() => setMode("rename")}>
              Rename
            </button>
            <button
              className="btn small ghost"
              title="Copy this project with its results cleared, and open the copy."
              onClick={() => void duplicateStoredStudy(project.id)}
            >
              Duplicate
            </button>
            <button
              className="btn small ghost danger"
              disabled={isOpen}
              title={isOpen ? "Open another project first; the open one cannot be deleted." : "Delete this project."}
              onClick={() => setMode("delete")}
            >
              Delete
            </button>
          </div>
        )
      )}
    </li>
  )
}

/** Every saved project. Absent when there are none, so a first run is not told it has no history. */
const ProjectsList = () => {
  const openId = useStudyStore((s) => s.study.id)
  const hasCandidates = useStudyStore((s) => s.study.candidates.length > 0)
  const { projects, refresh } = useStoredProjects()

  if (projects.length === 0) return null

  return (
    <section className="start-recent projects-list" aria-label="Projects">
      <h2 className="start-section-title">
        <HistoryIcon size={14} />
        Projects
        <span className="muted tnum small">{projects.length}</span>
      </h2>
      <ul className="recent-list">
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} isOpen={hasCandidates && project.id === openId} onChanged={refresh} />
        ))}
      </ul>
    </section>
  )
}

/**
 * An agent has started on this project but nothing is drawn yet.
 *
 * `studio_create_study` opens the canvas at once, so this is the rare fallback: a project the agent
 * emptied or an older start. The tracker names the step that is blocking and the last failure, so a
 * person watching the sidebar log move while this page stays put can see why.
 */
const AgentProgress = () => {
  const studyName = useStudyStore((s) => s.study.name)
  const activity = useStudyStore((s) => s.activity)
  const addCandidate = useStudyStore((s) => s.addCandidate)
  if (activity.length === 0) return null

  return (
    <section className="agent-progress" aria-label="Agent progress" aria-live="polite">
      <span className="start-glyph ready">
        <BotIcon size={16} />
      </span>
      <div className="agent-progress-body">
        <strong>Project &ldquo;{studyName}&rdquo; is open. Nothing is drawn yet.</strong>
        <AgentStepper compact />
      </div>
      <button className="btn with-icon" onClick={() => addCandidate(manualCandidate())}>
        <PencilIcon size={14} />
        Draw it yourself instead
      </button>
    </section>
  )
}

/**
 * The Projects home: every saved project, and three ways to start a new one.
 *
 * A worked scenario, because a race you can watch happen in the first minute is worth more than any
 * paragraph about one. The codebase prompt, because the agent reconstructing the current system is
 * the way this gets used on real work. A blank canvas, because sometimes the design is in your head.
 * Every start makes a NEW project: the open one stays saved and one click brings it back.
 */
export const StartScreen = () => {
  const webmcp = useStudyStore((s) => s.webmcp)
  const study = useStudyStore((s) => s.study)
  const homeOpen = useStudyStore((s) => s.homeOpen)
  const setHomeOpen = useStudyStore((s) => s.setHomeOpen)
  const createStudy = useStudyStore((s) => s.createStudy)
  const addCandidate = useStudyStore((s) => s.addCandidate)
  const loadStudyDocument = useStudyStore((s) => s.loadStudyDocument)
  const importStudyJson = useStudyStore((s) => s.importStudyJson)
  const fileRef = useRef<HTMLInputElement>(null)
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [promptOpen, setPromptOpen] = useState(false)
  const webmcpReady = webmcp.status.includes("tools")
  const overProject = homeOpen && study.candidates.length > 0

  useEffect(() => {
    if (!overProject) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHomeOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [overProject, setHomeOpen])

  const copySelected = async () => {
    setCopyState("copying")
    setCopyState((await copyPrompt(CODEBASE_PROMPT)) ? "copied" : "failed")
  }

  /** One click, one empty canvas, in a fresh project; the open project is already saved. */
  const startNewProject = () => {
    createStudy({})
    addCandidate(manualCandidate())
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    // A project file, or a bare design, which becomes a one-version project with no rules.
    importStudyJson(await file.text())
    event.target.value = ""
  }

  const copyLabel =
    copyState === "copying"
      ? "Copying\u2026"
      : copyState === "copied"
        ? "Prompt copied"
        : copyState === "failed"
          ? "Copy unavailable"
          : "Copy agent prompt"

  const copyFeedback =
    copyState === "copied"
      ? "Ready to paste. You can edit the request before sending."
      : copyState === "failed"
        ? "Open the prompt and copy it by hand."
        : webmcpReady
          ? `WebMCP is ready \u00b7 ${webmcp.status}`
          : "Open this page beside a WebMCP-capable coding agent to expose the Studio tools."

  return (
    <div className="empty-study">
      <div className="start-shell">
        {overProject && (
          <div className="start-back">
            <button className="btn with-icon" onClick={() => setHomeOpen(false)} title="Esc">
              <ArrowRightIcon size={13} className="flip" />
              Back to {study.name}
            </button>
          </div>
        )}
        <header className="start-hero">
          <div className="empty-kicker">
            <span className="kicker-dot" aria-hidden="true" />
            System Design Studio
          </div>
          <h1>Draw a system. Watch it break. Fix it. Hand it to your agent.</h1>
          <p className="empty-lede">
            Model the architecture, give its requests real steps, and the studio finds the order of
            events that breaks a rule and plays it on your drawing. Then measure the fix under load.
          </p>
          <ol className="start-loop" aria-label="How it works">
            {LOOP.map(({ icon: Glyph, label, detail }, index) => (
              <li key={label} title={`${label}: ${detail}`}>
                <span className="loop-glyph">
                  <Glyph size={14} />
                </span>
                <b>{label}</b>
                {index < LOOP.length - 1 && <ArrowRightIcon size={12} className="loop-arrow" aria-hidden="true" />}
              </li>
            ))}
          </ol>
        </header>

        {!overProject && <AgentProgress />}

        <section className="start-section" aria-label="Start">
          <h2 className="start-section-title">
            <PlusIcon size={14} />
            Start a project
          </h2>
          <div className="start-grid">
            <div className="start-option blank">
              <span className="start-option-head">
                <span className="start-glyph">
                  <PencilIcon size={16} />
                </span>
                <span className="start-kicker">from scratch</span>
              </span>
              <strong>New project</strong>
              <span className="start-blurb">
                An empty canvas. Add components from the palette, link them, give one some request steps, add a rule.
              </span>
              <div className="start-actions">
                <button className="btn primary with-icon" onClick={startNewProject}>
                  <PlusIcon size={14} />
                  New project
                </button>
                <button className="btn with-icon" onClick={() => fileRef.current?.click()} title="Open a project or a bare design from a JSON file.">
                  <UploadIcon size={14} />
                  Import JSON
                </button>
                <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => void importFile(e)} />
              </div>
            </div>

            <div className="start-option import">
              <span className="start-option-head">
                <span className={`start-glyph ${webmcpReady ? "ready" : ""}`}>
                  <BotIcon size={16} />
                </span>
                <span className="start-kicker">from a codebase</span>
              </span>
              <strong>Let your coding agent draw the current system</strong>
              <span className="start-blurb">
                Paste one request into a WebMCP-capable agent. It opens a project and draws the
                architecture here as it reads the repository, with evidence for every component and link.
              </span>
              <div className="start-actions">
                <button className="btn primary with-icon" disabled={copyState === "copying"} onClick={() => void copySelected()}>
                  {copyState === "copied" ? <CheckIcon size={14} /> : <ClipboardIcon size={14} />}
                  {copyLabel}
                </button>
                <button className="btn with-icon" onClick={() => setPromptOpen((open) => !open)} aria-expanded={promptOpen}>
                  {promptOpen ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                  {promptOpen ? "Hide prompt" : "Show prompt"}
                </button>
              </div>
              <span className={`copy-feedback ${webmcpReady ? "ready" : ""}`} aria-live="polite">
                <span className="status-dot-inline" aria-hidden="true" />
                {copyFeedback}
              </span>
            </div>

            {DEMO_SCENARIOS.map((scenario) => (
              <button key={scenario.id} className="start-option scenario" onClick={() => loadStudyDocument(scenario.open())}>
                <span className="start-option-head">
                  <span className="start-glyph accent">
                    <PlayIcon size={16} />
                  </span>
                  <span className="start-kicker">worked scenario</span>
                </span>
                <strong>{scenario.label}</strong>
                <span className="start-blurb" title={scenario.teaches}>
                  {scenario.summary}
                </span>
                <span className="start-cta">
                  Open and play the race
                  <ArrowRightIcon size={13} />
                </span>
              </button>
            ))}
          </div>
        </section>

        {promptOpen && (
          <div className="starter-prompt">
            <div className="starter-prompt-head">
              <span>Paste into your agent</span>
              <strong>Create system design from codebase</strong>
            </div>
            <p>{CODEBASE_PROMPT}</p>
            <PromptRoute />
          </div>
        )}

        <ProjectsList />

        <footer className="start-scope" aria-label="What this can find">
          <span className="scope-label finds">
            <CheckIcon size={12} />
            Finds
          </span>
          <ul className="chip-row" aria-label="Finds">
            {FINDS.map((item) => (
              <li key={item} className="chip static">
                {item}
              </li>
            ))}
          </ul>
          <span className="scope-label">Not yet</span>
          <ul className="chip-row" aria-label="Not yet">
            {NOT_YET.map((item) => (
              <li key={item} className="chip static muted">
                {item}
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  )
}
