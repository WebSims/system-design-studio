import { useMemo, useState } from "react"
import { useStudio } from "../store"
import { useStudyStore, type Annotation } from "../study/store"
import { useRaceModel } from "../raceModel"
import { AgentStepper } from "./AgentStepper"
import {
  CODEBASE_PROMPT,
  alternativePrompt,
  fixRacePrompt,
  freeformPrompt,
  traceEndpointPrompt,
  type PromptContext,
} from "../codebase-prompt"

/**
 * THE AGENT AS A VISIBLE PARTICIPANT.
 *
 * Two streams merged into one, newest first: every tool call the agent made (what it did) and every
 * note it pinned to the canvas (what it thinks). Before this, both lived behind a status dot; a
 * person reviewing a design the agent drew had to guess which parts came from it. Now an agent that
 * added Postgres from db.ts:12-40, created version B and found a race in version A shows up as three
 * lines a reader can click.
 *
 * The composer at the bottom is the other direction. There is no embedded model here and there
 * should not be -- the agent that shares this page has its own. What the studio can do is shape the
 * request: put the project id, the active version, the selected element and the current break into
 * it, so the person types "make it not oversell" and the agent knows exactly where to look.
 */
export function AgentPanel() {
  const setAgentOpen = useStudyStore((s) => s.setAgentOpen)
  const activity = useStudyStore((s) => s.activity)
  const annotations = useStudyStore((s) => s.annotations)
  const webmcp = useStudyStore((s) => s.webmcp)
  const dismiss = useStudyStore((s) => s.dismissAnnotation)
  const requestFocus = useStudyStore((s) => s.requestFocus)
  const selectCandidate = useStudyStore((s) => s.selectCandidate)
  const study = useStudyStore((s) => s.study)
  const webmcpReady = webmcp.status.includes("tools")
  // The tracker earns its space once the agent has done anything, or the project is still being built.
  const showSteps = activity.length > 0 || study.repository === null

  const stream = useMemo(() => {
    const items: Array<{ at: number; kind: "call"; entry: (typeof activity)[number] } | { at: number; kind: "note"; note: Annotation }> = [
      ...activity.map((entry) => ({ at: entry.at, kind: "call" as const, entry })),
      ...annotations.map((note) => ({ at: note.at, kind: "note" as const, note })),
    ]
    return items.sort((a, b) => b.at - a.at).slice(0, 200)
  }, [activity, annotations])

  const goTo = (note: Annotation) => {
    if (note.candidateId && note.candidateId !== study.activeCandidateId) selectCandidate(note.candidateId)
    if (note.targetKind === "node") requestFocus({ kind: "node", id: note.targetId })
    else if (note.targetKind === "edge") requestFocus({ kind: "edge", id: note.targetId })
    else if (note.targetKind === "step") requestFocus({ kind: "step", index: Number(note.targetId) })
  }

  return (
    <aside className="agent-panel" aria-label="agent">
      <header className="drawer-head">
        <div>
          <h2>agent</h2>
          <p className="muted">
            <span className={`status-dot ${webmcpReady ? "ready" : ""}`} />{" "}
            {webmcpReady
              ? `connected through WebMCP · ${webmcp.status} · it can draw and test versions, not approve them`
              : "no WebMCP client attached · open this page beside your coding agent"}
          </p>
        </div>
        <button className="btn small" onClick={() => setAgentOpen(false)} aria-label="close agent panel">
          close
        </button>
      </header>

      {showSteps && <AgentStepper />}

      <div className="agent-stream">
        {stream.length === 0 ? (
          <p className="muted agent-empty">
            Nothing yet. When the agent draws, tests or annotates, each action shows here with what it touched.
          </p>
        ) : (
          <ol className="agent-items">
            {stream.map((item) =>
              item.kind === "call" ? (
                <li key={`c-${item.at}-${item.entry.tool}`} className={`agent-item call ${item.entry.ok ? "" : "failed"}`}>
                  <span className="agent-time tnum">{new Date(item.at).toLocaleTimeString()}</span>
                  <span className="agent-body">
                    <span className="agent-tool">{item.entry.tool.replace(/^studio_/, "").replace(/_/g, " ")}</span>
                    <span className="agent-summary">{item.entry.summary}</span>
                    {item.entry.revision !== undefined && (
                      <span className="agent-rev tnum">
                        {labelOf(study, item.entry.candidateId)} r{item.entry.revision}
                      </span>
                    )}
                  </span>
                </li>
              ) : (
                <li key={item.note.id} className={`agent-item note tone-${item.note.tone} by-${item.note.by}`}>
                  <span className="agent-time tnum">{new Date(item.at).toLocaleTimeString()}</span>
                  <span className="agent-body">
                    <button className="agent-target" onClick={() => goTo(item.note)} title="show on the canvas">
                      {targetLabel(item.note, study)}
                    </button>
                    <span className="agent-summary">{item.note.text}</span>
                  </span>
                  <button className="btn btn-quiet agent-dismiss" onClick={() => dismiss(item.note.id)} aria-label="dismiss note">
                    &times;
                  </button>
                </li>
              )
            )}
          </ol>
        )}
      </div>

      <AskAgent />
    </aside>
  )
}

const labelOf = (study: ReturnType<typeof useStudyStore.getState>["study"], id: string | undefined): string =>
  (id && study.candidates.find((c) => c.id === id)?.label) || id || ""

const targetLabel = (note: Annotation, study: ReturnType<typeof useStudyStore.getState>["study"]): string => {
  const candidate = note.candidateId ? study.candidates.find((c) => c.id === note.candidateId) : null
  const design = candidate?.design
  if (note.targetKind === "node") return design?.nodes.find((n) => n.id === note.targetId)?.label ?? note.targetId
  if (note.targetKind === "edge") {
    const edge = design?.edges.find((e) => e.id === note.targetId)
    const from = edge ? design?.nodes.find((n) => n.id === edge.from)?.label : null
    const to = edge ? design?.nodes.find((n) => n.id === edge.to)?.label : null
    return from && to ? `${from} \u2192 ${to}` : note.targetId
  }
  if (note.targetKind === "step") return `step ${Number(note.targetId) + 1}`
  return candidate?.label ?? note.targetId
}

type Intent = "draw" | "trace" | "fix" | "alternative" | "free"

const INTENTS: Array<{ id: Intent; label: string; hint: string }> = [
  { id: "draw", label: "Draw this codebase", hint: "reconstruct the current system from the code, with evidence" },
  { id: "trace", label: "Trace an endpoint", hint: "one endpoint into request steps, a citation per step" },
  { id: "fix", label: "Fix the break", hint: "a new version that removes the race the studio found" },
  { id: "alternative", label: "Propose an alternative", hint: "a version with a different trade-off, compared" },
  { id: "free", label: "Ask anything", hint: "your words, with the studio's context attached" },
]

/**
 * The composer. Copy is the only action it takes: the agent decides which tools to call, and the
 * person can edit the visible request before sending it.
 */
function AskAgent() {
  const study = useStudyStore((s) => s.study)
  const active = useStudyStore((s) => s.activeCandidate())
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null))
  const selection = useStudio((s) => s.selection)
  const design = useStudio((s) => s.design)
  const plan = useRaceModel((s) => s.plan)
  const [intent, setIntent] = useState<Intent>(evaluation?.correctness?.counterexample ? "fix" : active ? "trace" : "draw")
  const [endpoint, setEndpoint] = useState("")
  const [text, setText] = useState("")
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  const ce = evaluation?.correctness?.counterexample ?? null
  const invariant = ce ? study.correctness.invariants.find((i) => i.id === ce.invariantId) : null
  const selectedLabel =
    selection?.kind === "node"
      ? design.nodes.find((n) => n.id === selection.id)?.label
      : selection?.kind === "edge"
        ? (() => {
            const e = design.edges.find((x) => x.id === selection.id)
            return e ? `${e.from} \u2192 ${e.to}` : undefined
          })()
        : undefined

  const ctx: PromptContext = {
    studyId: study.id,
    studyName: study.name,
    candidateId: active?.id ?? null,
    candidateLabel: active?.label ?? null,
    candidateRevision: active?.revision ?? null,
    selected: selection && selectedLabel ? { kind: selection.kind, id: selection.id, label: selectedLabel } : null,
    breaks:
      ce && invariant
        ? `rule "${invariant.label}" is broken after ${ce.steps.length} steps${
            plan?.violatingNodeId ? `, at ${design.nodes.find((n) => n.id === plan.violatingNodeId)?.label ?? plan.violatingNodeId}` : ""
          }${ce.faultsUsed.length > 0 ? `, using faults ${ce.faultsUsed.join(", ")}` : ""}. ${invariant.message}`
        : null,
  }

  const prompt =
    intent === "draw"
      ? CODEBASE_PROMPT
      : intent === "trace"
        ? traceEndpointPrompt(endpoint, ctx)
        : intent === "fix"
          ? fixRacePrompt(ctx)
          : intent === "alternative"
            ? alternativePrompt(ctx)
            : freeformPrompt(text, ctx)

  const canCopy = intent !== "free" || text.trim().length > 0

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
    setTimeout(() => setCopyState("idle"), 2500)
  }

  return (
    <div className="ask-agent">
      <div className="ask-head">
        <h3>ask the agent</h3>
        <span className="muted">shapes a request with this project's ids; you paste it into your agent</span>
      </div>
      <div className="intent-row" role="tablist" aria-label="what to ask">
        {INTENTS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={intent === item.id}
            className={`chip ${intent === item.id ? "on" : ""}`}
            title={item.hint}
            onClick={() => setIntent(item.id)}
            disabled={(item.id === "fix" && !ce) || (item.id !== "draw" && !active)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {intent === "trace" && (
        <input
          className="input"
          value={endpoint}
          placeholder="POST /claim"
          onChange={(e) => setEndpoint(e.target.value)}
          aria-label="endpoint to trace"
        />
      )}
      {intent === "free" && (
        <textarea
          className="input ask-text"
          value={text}
          rows={3}
          placeholder="e.g. why does version A oversell, and what is the cheapest fix?"
          onChange={(e) => setText(e.target.value)}
          aria-label="your question"
        />
      )}
      <details className="ask-preview">
        <summary>what will be copied</summary>
        <pre>{prompt}</pre>
      </details>
      <div className="row-actions">
        <button className="btn small primary" disabled={!canCopy} onClick={() => void copy()}>
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy request"}
        </button>
        <span className="muted">
          {copyState === "failed" ? "Open the preview and copy it by hand." : "Editable after you paste."}
        </span>
      </div>
    </div>
  )
}
