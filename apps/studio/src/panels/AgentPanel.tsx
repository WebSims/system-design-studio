import { useEffect, useMemo, useRef, useState } from "react"
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
import {
  DEFAULT_OPENAI_MODEL,
  EMBEDDED_AGENT_PROVIDER_ID,
  EXTERNAL_AGENT_PROVIDER_ID,
  OPENAI_KEY_SAFETY_URL,
  type AgentProvider,
  type AgentProviderId,
} from "../agent/providers"

/**
 * THE AGENT AS A VISIBLE PARTICIPANT.
 *
 * Two streams merged into one, newest first: every tool call the agent made (what it did) and every
 * note it pinned to the canvas (what it thinks). Before this, both lived behind a status dot; a
 * person reviewing a design the agent drew had to guess which parts came from it. Now an agent that
 * added Postgres from db.ts:12-40, created version B and found a race in version A shows up as three
 * lines a reader can click.
 *
 * The composer at the bottom is the other direction. The primary route hands a context-rich request
 * to the coding agent that can also inspect the repository. A deliberately secondary BYOK route can
 * execute the same guarded Studio tools directly in the browser; it has no extra authority and no
 * repository access.
 */
export function AgentPanel({ providers }: { providers: readonly AgentProvider[] }) {
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
  const showSteps = activity.length > 0 || study.repositorySnapshots.length === 0

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

      <AskAgent providers={providers} />
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

/** The composer shared by the external handoff and the opt-in browser executor. */
function AskAgent({ providers }: { providers: readonly AgentProvider[] }) {
  const study = useStudyStore((s) => s.study)
  const active = useStudyStore((s) => s.activeCandidate())
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null))
  const selection = useStudio((s) => s.selection)
  const design = useStudio((s) => s.design)
  const plan = useRaceModel((s) => s.plan)
  const setAgentBusy = useStudyStore((s) => s.setAgentBusy)
  const [intent, setIntent] = useState<Intent>(evaluation?.correctness?.counterexample ? "fix" : active ? "trace" : "draw")
  const [endpoint, setEndpoint] = useState("")
  const [text, setText] = useState("")
  const [providerId, setProviderId] = useState<AgentProviderId>(EXTERNAL_AGENT_PROVIDER_ID)
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState(DEFAULT_OPENAI_MODEL)
  const [browserRiskAccepted, setBrowserRiskAccepted] = useState(false)
  const [sendState, setSendState] = useState<"idle" | "running" | "done" | "failed" | "cancelled">("idle")
  const [providerMessage, setProviderMessage] = useState("")
  const [answer, setAnswer] = useState("")
  const abortRef = useRef<AbortController | null>(null)

  const provider = providers.find((item) => item.id === providerId) ?? providers[0]
  const embedded = provider?.id === EMBEDDED_AGENT_PROVIDER_ID

  useEffect(
    () => () => {
      abortRef.current?.abort()
      abortRef.current = null
    },
    []
  )

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
    selected:
      selection && selection.kind !== "canvas" && selectedLabel
        ? { kind: selection.kind, id: selection.id, label: selectedLabel }
        : null,
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

  const intentReady = (intent !== "free" || text.trim().length > 0) && !(embedded && intent === "draw")
  const credentialsReady = !embedded || (apiKey.trim().length > 0 && model.trim().length > 0 && browserRiskAccepted)
  const canSend = Boolean(provider) && intentReady && credentialsReady && sendState !== "running"

  const selectProvider = (id: AgentProviderId) => {
    if (sendState === "running") return
    setProviderId(id)
    setSendState("idle")
    setProviderMessage("")
    setAnswer("")
    if (id === EXTERNAL_AGENT_PROVIDER_ID) {
      // The app never writes the key anywhere; dropping state here also clears it when leaving the
      // opt-in provider. Closing the panel unmounts this component and does the same.
      setApiKey("")
      setBrowserRiskAccepted(false)
    }
  }

  const send = async () => {
    if (!provider || !canSend) return
    const controller = new AbortController()
    abortRef.current = controller
    setAgentBusy(1)
    setSendState("running")
    setProviderMessage(embedded ? "Starting an in-browser agent run…" : "Copying the request…")
    setAnswer("")
    try {
      const result = await provider.run({
        prompt,
        signal: controller.signal,
        ...(embedded ? { credential: { apiKey, model } } : {}),
        onEvent: (event) => setProviderMessage(event.message),
      })
      setSendState("done")
      setProviderMessage(
        result.kind === "handoff"
          ? result.text
          : "Finished in " + result.rounds + " model round" + (result.rounds === 1 ? "" : "s") +
            " with " + result.toolCalls + " Studio tool call" + (result.toolCalls === 1 ? "" : "s") + "."
      )
      if (result.kind === "executed") setAnswer(result.text)
    } catch (error) {
      if (controller.signal.aborted) {
        setSendState("cancelled")
        setProviderMessage("Agent run cancelled.")
      } else {
        setSendState("failed")
        setProviderMessage(error instanceof Error ? error.message : "Agent run failed.")
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setAgentBusy(-1)
    }
  }

  return (
    <div className="ask-agent">
      <div className="ask-head">
        <h3>ask the agent</h3>
        <span className="muted">one guarded tool contract, with the external coding agent kept as the primary path</span>
      </div>
      <div className="provider-tabs" role="tablist" aria-label="Agent provider">
        {providers.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={provider?.id === item.id}
            className={`provider-tab ${provider?.id === item.id ? "active" : ""}`}
            onClick={() => selectProvider(item.id)}
            disabled={sendState === "running"}
          >
            <span>{item.label}</span>
            {(item.primary || provider?.id === item.id) && (
              <small>
                {[item.primary ? "recommended" : null, provider?.id === item.id ? "selected" : null]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            )}
          </button>
        ))}
      </div>
      {provider && <p className="provider-description">{provider.description}</p>}
      <div className="intent-row" role="tablist" aria-label="what to ask">
        {INTENTS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={intent === item.id}
            className={`chip ${intent === item.id ? "on" : ""}`}
            title={item.hint}
            onClick={() => setIntent(item.id)}
            disabled={
              sendState === "running" ||
              (item.id === "fix" && !ce) ||
              (item.id !== "draw" && !active && !(embedded && item.id === "free"))
            }
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
      {embedded && intent === "draw" && (
        <p className="provider-inline-warning" role="note">
          Repository reconstruction needs the external coding agent, which can inspect files. Choose Ask anything to
          create or change a design from your own description.
        </p>
      )}
      {embedded && provider && (
        <section className="byok-settings" aria-label="In-browser provider settings">
          <div className="byok-warning" role="note">
            <strong>Local experiment only.</strong>{" "}
            <span>
              Your key is sent directly from this page to OpenAI. Browser scripts or extensions can expose client-side
              keys, so OpenAI recommends a backend for deployed apps. Studio keeps this value only in this open panel's
              memory; it is never saved, exported, logged, or exposed to tools.{" "}
            </span>
            <a href={OPENAI_KEY_SAFETY_URL} target="_blank" rel="noreferrer">Key safety guidance</a>
          </div>
          <label className="field">
            <span className="field-label">OpenAI API key <span className="field-hint">session only</span></span>
            <input
              className="input"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setApiKey(event.target.value)}
              aria-describedby="byok-memory-note"
              placeholder="sk-…"
            />
          </label>
          <label className="field">
            <span className="field-label">Model <span className="field-hint">editable</span></span>
            <input
              className="input"
              value={model}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label className="byok-consent">
            <input
              type="checkbox"
              checked={browserRiskAccepted}
              onChange={(event) => setBrowserRiskAccepted(event.target.checked)}
            />
            <span id="byok-memory-note">I understand this browser session can expose the key.</span>
          </label>
          <span className="muted provider-capability">
            The model receives {provider.toolNames.length} guarded Studio tools through the same contract as WebMCP. It
            cannot approve, verify, dismiss, accept risk, inspect repository files, or author repository evidence.
          </span>
        </section>
      )}
      <details className="ask-preview">
        <summary>{embedded ? "what will be sent" : "what will be copied"}</summary>
        <pre>{prompt}</pre>
      </details>
      <div className="row-actions">
        <button className="btn small primary" disabled={!canSend} onClick={() => void send()}>
          {sendState === "running" ? "Working…" : embedded ? "Run in browser" : sendState === "done" ? "Copied" : "Copy request"}
        </button>
        {sendState === "running" && (
          <button className="btn small" onClick={() => abortRef.current?.abort()}>Cancel</button>
        )}
      </div>
      {providerMessage && (
        <p className={`provider-status ${sendState === "failed" ? "failed" : ""}`} aria-live="polite">
          {sendState === "failed" ? "Error — " : ""}{providerMessage}
        </p>
      )}
      {answer && (
        <section className="provider-answer" aria-label="Agent response">
          <strong>Agent response</strong>
          <p>{answer}</p>
        </section>
      )}
    </div>
  )
}
