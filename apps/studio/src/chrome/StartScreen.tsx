import { useEffect, useState } from "react"
import { blankDesign } from "@sds/schema"
import { CODEBASE_PROMPT, CODEBASE_PROMPT_ROUTE } from "../codebase-prompt"
import { DEMO_SCENARIOS } from "../examples"
import type { StoredStudy } from "../persist"
import { useStudyStore } from "../study/store"
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardIcon,
  CompareIcon,
  EyeIcon,
  EyeOffIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
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
]

const NOT_YET = ["isolation levels", "partitions", "quorum", "clock skew", "liveness"]

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

/** Saved studies, newest first. Absent when there are none, so a first run is not told it has no history. */
const RecentStudies = () => {
  const storedStudies = useStudyStore((s) => s.storedStudies)
  const openStudy = useStudyStore((s) => s.openStudy)
  const [recent, setRecent] = useState<StoredStudy[]>([])

  useEffect(() => {
    let cancelled = false
    storedStudies()
      .then((list) => {
        if (cancelled) return
        setRecent([...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4))
      })
      .catch(() => {
        // IndexedDB unavailable: the section simply does not appear.
      })
    return () => {
      cancelled = true
    }
  }, [storedStudies])

  if (recent.length === 0) return null

  return (
    <section className="start-recent" aria-label="Recent studies">
      <h2 className="start-section-title">
        <HistoryIcon size={14} />
        Continue
      </h2>
      <ul className="recent-list">
        {recent.map((study) => (
          <li key={study.id}>
            <button className="recent-item" onClick={() => void openStudy(study.id)}>
              <strong>{study.name}</strong>
              <span className="recent-meta tnum">
                {study.candidateCount} version{study.candidateCount === 1 ? "" : "s"} {"\u00b7"} {relativeTime(study.updatedAt)}
              </span>
              <ChevronRightIcon size={14} className="recent-chevron" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The tools that add a candidate, and so replace this screen with the canvas. */
const RENDERING_TOOLS = ["studio_import_architecture", "studio_create_candidate"] as const

/** The empty human-authored candidate behind every "Design manually" button. */
const manualCandidate = () => ({
  label: "manual design",
  intent: "Created manually from an empty canvas.",
  design: blankDesign(),
  origin: "human" as const,
})

/**
 * An agent has started on this project but nothing is drawn yet.
 *
 * The workbench swaps the start screen for the canvas only when a candidate exists.
 * create_study, update_study and validate_draft never add one, so a person watching the agent
 * work sees the sidebar log move while this page stays put and reads that as broken. Say what
 * happened, and name the one step that changes the picture.
 */
const AgentProgress = () => {
  const studyName = useStudyStore((s) => s.study.name)
  const activity = useStudyStore((s) => s.activity)
  const addCandidate = useStudyStore((s) => s.addCandidate)

  const last = activity[activity.length - 1]
  if (!last) return null

  const failed = activity.filter((entry) => !entry.ok).length

  return (
    <section className="agent-progress" aria-label="Agent progress" aria-live="polite">
      <span className="start-glyph ready">
        <BotIcon size={16} />
      </span>
      <div className="agent-progress-body">
        <strong>
          Project &ldquo;{studyName}&rdquo; is open. Nothing is drawn yet.
        </strong>
        <span className="agent-progress-meta tnum">
          {activity.length} tool call{activity.length === 1 ? "" : "s"}
          {failed > 0 && ` \u00b7 ${failed} failed`} {"\u00b7"} last: <code>{last.tool}</code> {"\u2014"} {last.summary}
        </span>
        <span className="agent-progress-hint">
          The canvas appears once the agent calls{" "}
          {RENDERING_TOOLS.map((tool, index) => (
            <span key={tool}>
              {index > 0 && " or "}
              <code>{tool}</code>
            </span>
          ))}
          . Validating a draft stores nothing.
        </span>
      </div>
      <button className="btn with-icon" onClick={() => addCandidate(manualCandidate())}>
        <PencilIcon size={14} />
        Design manually instead
      </button>
    </section>
  )
}

/**
 * What the studio shows before there is anything to show: three ways in.
 *
 * A worked scenario, because a race you can watch happen in the first minute is worth more than any
 * paragraph about one. The codebase prompt, because the agent reconstructing the current system is
 * the way this gets used on real work. A blank canvas, because sometimes the design is in your head.
 * Nothing is loaded until a person picks; the studio still boots empty.
 */
export const StartScreen = () => {
  const webmcp = useStudyStore((s) => s.webmcp)
  const addCandidate = useStudyStore((s) => s.addCandidate)
  const loadStudyDocument = useStudyStore((s) => s.loadStudyDocument)
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [promptOpen, setPromptOpen] = useState(false)
  const webmcpReady = webmcp.status.includes("tools")

  const copySelected = async () => {
    setCopyState("copying")
    setCopyState((await copyPrompt(CODEBASE_PROMPT)) ? "copied" : "failed")
  }

  const startManualDesign = () => addCandidate(manualCandidate())

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

        <AgentProgress />
        <RecentStudies />

        <section className="start-section" aria-label="Start">
          <h2 className="start-section-title">
            <PlusIcon size={14} />
            Start
          </h2>
          <div className="start-grid">
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

            <div className="start-option import">
              <span className="start-option-head">
                <span className={`start-glyph ${webmcpReady ? "ready" : ""}`}>
                  <BotIcon size={16} />
                </span>
                <span className="start-kicker">from a codebase</span>
              </span>
              <strong>Let your coding agent draw the current system</strong>
              <span className="start-blurb">
                Paste one request into a WebMCP-capable agent. It reads the repository and imports
                the architecture with a citation per component.
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

            <div className="start-option blank">
              <span className="start-option-head">
                <span className="start-glyph">
                  <PencilIcon size={16} />
                </span>
                <span className="start-kicker">from scratch</span>
              </span>
              <strong>Blank canvas</strong>
              <span className="start-blurb">
                Add components from the palette, link them, give one some request steps, add a rule.
              </span>
              <div className="start-actions">
                <button className="btn with-icon" onClick={startManualDesign}>
                  <PlusIcon size={14} />
                  Design manually
                </button>
              </div>
            </div>
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
