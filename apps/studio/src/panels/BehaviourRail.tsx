import { useMemo, useState } from "react"
import type { CorrectnessResult, Expr, Invariant, InvariantScope, Study } from "@sds/schema"
import { useStudyStore } from "../study/store"
import { verdictHeadline } from "../correctness/layout"
import { AdvancedSettings, WorkloadRow } from "./WorkloadEditor"
import {
  buildInvariant,
  describeInvariant,
  invariantTemplates,
  templateFor,
  type InvariantDraft,
} from "../correctness/builder"

/**
 * The left rail under the Behaviour lens: what you need now, the rest folded.
 *
 * Visible: the verdict, the workload (one line, with a badge while it is still the placeholder), the
 * rules, and the faults. Folded under "advanced": search limits, starting counters, run length,
 * seeds, SLO and request classes, with their values in the summary line so nothing is hidden, only
 * folded. Everything here is the project's yardstick, shared by every version.
 *
 * TWO WAYS IN, ONE MODEL
 *
 * The guided builder composes a rule from a template and a couple of collection names; the expert
 * editor shows the same rule as raw declarative JSON. Two projections of one `Invariant`, so
 * switching mid-edit is lossless: the guided form is a constructor, not a second representation.
 */
/**
 * Whether the agent just changed something under `prefix` of the study contract, so the section
 * that shows it can flash. `correctness.invariants` lights the rules; `correctness.faults` and
 * `correctness.bounds` light what can go wrong.
 */
const useStudyTouch = (...prefixes: string[]) =>
  useStudyStore(
    (s) =>
      s.agentAttention?.scope === "study" &&
      s.agentAttention.changedPaths.some((path) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))
  )

const sectionClass = (touched: boolean) => `section ${touched ? "agent-touched" : ""}`

export function BehaviourRail() {
  const study = useStudyStore((s) => s.study)
  const active = useStudyStore((s) => s.activeCandidate())
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null))
  const running = useStudyStore((s) => (active ? s.running.has(active.id) : false))
  const correctness = evaluation?.correctness ?? null
  const hasBehaviour = (active?.design.workflow?.handlers.length ?? 0) > 0

  return (
    <aside className="rail left doc-rail">
      <section className="section">
        <header className="section-head">
          <h2>does it break?</h2>
        </header>

        {!correctness && !running && (
          <p className="muted">
            {hasBehaviour
              ? `Not checked yet. Press Find races: up to ${study.correctness.bounds.actors} concurrent requests, ${study.correctness.bounds.states.toLocaleString()} states.`
              : "No request steps yet. Select a service on the canvas and pick a pattern, or write the steps yourself."}
          </p>
        )}
        {running && <p className="muted">Exploring every interleaving…</p>}
        {correctness && <Verdict result={correctness} />}
      </section>

      <WorkloadRow study={study} />
      <InvariantEditor study={study} />
      <FaultsSection study={study} />
      <AdvancedSettings study={study}>
        <StartingStock study={study} />
      </AdvancedSettings>
    </aside>
  )
}

function Verdict({ result }: { result: CorrectnessResult }) {
  const headline = verdictHeadline(result.status, result.stats)
  return (
    <div className={`verdict verdict-${headline.tone}`}>
      <div className="verdict-status">{statusLabel(result.status)}</div>
      <p className="verdict-headline">{headline.text}</p>
      <p className="verdict-claim">{result.claim}</p>

      {result.counterexample?.scope === "safety" && result.counterexample.steps.length === 1 && (
        <p className="note warn">
          This rule failed after one intermediate operation. If later work is allowed to restore
          the relationship, “always” is the wrong contract: use an end-state postcondition and
          enable the relevant crash fault. This trace alone does not establish lost work.
        </p>
      )}

      {result.modelErrors.length > 0 && (
        <ul className="issue-list">
          {result.modelErrors.map((e, i) => (
            <li key={i} className="issue-error">
              {e}
            </li>
          ))}
        </ul>
      )}

      <details className="assumptions">
        <summary>
          {result.stats.statesVisited.toLocaleString()} states · {result.stats.transitionsApplied.toLocaleString()} transitions ·{" "}
          {result.stats.wallMs < 1 ? "<1ms" : `${Math.round(result.stats.wallMs)}ms`}
        </summary>
        <dl className="stat-grid">
          <div>
            <dt>pruned as equivalent</dt>
            <dd className="tnum">{result.stats.duplicatesPruned.toLocaleString()}</dd>
          </div>
          <div>
            <dt>search finished</dt>
            <dd>{result.stats.exhausted ? "yes" : `no \u2014 hit the ${result.stats.capHit} cap`}</dd>
          </div>
          <div>
            <dt>runs that fully settled</dt>
            <dd className="tnum">{result.stats.quiescentTerminals.toLocaleString()} times</dd>
          </div>
        </dl>
        <p className="muted">what this result assumes</p>
        <ul>
          {result.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** Plain words for the engine's status codes. The codes stay in the API; the rail speaks English. */
const statusLabel = (status: CorrectnessResult["status"]): string => {
  switch (status) {
    case "VIOLATED":
      return "breaks a rule"
    case "NO_VIOLATION_WITHIN_BOUNDS":
      return "no break found within limits"
    case "INCONCLUSIVE_BOUND_REACHED":
      return "inconclusive: hit a limit"
    case "INVALID_MODEL":
      return "the model does not check out"
  }
}

/**
 * The rule list, with a guided builder and an expert JSON editor.
 *
 * Editing a rule invalidates every cached correctness result, because the bounds hash covers the
 * correctness contract. Deliberate: a person who tightens a rule and sees the old green verdict still
 * on screen has been told something false.
 */
function InvariantEditor({ study }: { study: Study }) {
  const updateContract = useStudyStore((s) => s.updateContract)
  const [mode, setMode] = useState<"guided" | "expert">("guided")
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<InvariantDraft>({
    templateId: invariantTemplates[0]!.id,
    label: "",
    message: "",
    scope: "safety",
    args: {},
  })

  const collections = useMemo(() => {
    const active = study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0]
    return active?.design.workflow?.collections ?? []
  }, [study])

  const template = templateFor(draft.templateId)

  const add = () => {
    const built = buildInvariant(draft)
    if (!built.ok) return
    updateContract({
      correctness: {
        ...study.correctness,
        invariants: [...study.correctness.invariants, built.invariant],
      },
    })
    setAdding(false)
  }

  const remove = (id: string) => {
    updateContract({
      correctness: {
        ...study.correctness,
        invariants: study.correctness.invariants.filter((i) => i.id !== id),
      },
    })
  }

  const built = buildInvariant(draft)
  const touched = useStudyTouch("correctness.invariants")

  return (
    <section className={sectionClass(touched)}>
      <header className="section-head">
        <h2>rules</h2>
        <div className="tabs tabs-small">
          <button className={mode === "guided" ? "active" : ""} onClick={() => setMode("guided")}>
            plain
          </button>
          <button className={mode === "expert" ? "active" : ""} onClick={() => setMode("expert")}>
            raw
          </button>
        </div>
      </header>

      {study.correctness.invariants.length === 0 && (
        <p className="muted">What must always be true. Add at least one rule to check, e.g. "inventory never below zero".</p>
      )}

      <ul className="invariant-list">
        {study.correctness.invariants.map((inv) => (
          <li key={inv.id}>
            <div className="invariant-head">
              <span className={`badge ${inv.scope === "safety" ? "badge-info" : "badge-muted"}`}>
                {inv.scope === "safety" ? "always" : "at the end"}
              </span>
              <strong>{inv.label}</strong>
              <button className="btn btn-quiet" onClick={() => remove(inv.id)} title="remove">
                &times;
              </button>
            </div>
            <p className="muted">{describeInvariant(inv)}</p>
            {mode === "expert" && <ExpertExpression invariant={inv} />}
          </li>
        ))}
      </ul>

      {!adding ? (
        <button className="btn small" onClick={() => setAdding(true)} disabled={collections.length === 0}
          title={collections.length === 0 ? "Rules are about data. Add a collection to a component first." : undefined}>
          + add a rule
        </button>
      ) : (
        <div className="builder">
          <label>
            the rule
            <select
              value={draft.templateId}
              onChange={(e) => setDraft({ ...draft, templateId: e.target.value, args: {} })}
            >
              {invariantTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{template?.explanation}</p>

          {template?.params.map((param) => (
            <label key={param.name}>
              {param.label}
              {param.kind === "collection" ? (
                <select
                  value={String(draft.args[param.name] ?? "")}
                  onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [param.name]: e.target.value } })}
                >
                  <option value="">Choose…</option>
                  {collections
                    .filter((c) => (param.of ? c.kind === param.of : true))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.id} ({c.kind})
                      </option>
                    ))}
                </select>
              ) : param.kind === "field" ? (
                <select
                  value={String(draft.args[param.name] ?? "")}
                  onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [param.name]: e.target.value } })}
                >
                  <option value="">Choose…</option>
                  {collections
                    .flatMap((c) => (c.kind === "table" ? c.fields.map((f) => `${c.id}.${f.name}`) : []))
                    .map((f) => (
                      <option key={f} value={f.split(".")[1]}>
                        {f}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  type="number"
                  value={String(draft.args[param.name] ?? "")}
                  onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [param.name]: Number(e.target.value) } })}
                />
              )}
            </label>
          ))}

          <label>
            when it is checked
            <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as InvariantScope })}>
              <option value="safety">after every step (always)</option>
              <option value="postcondition">only once everything has finished</option>
            </select>
          </label>

          <label>
            name it
            <input
              value={draft.label}
              placeholder="never allocate more than exists"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <label>
            what it costs when it breaks
            <input
              value={draft.message}
              placeholder="one item was allocated twice"
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
            />
          </label>

          {built.ok ? (
            mode === "expert" && <pre className="expr-preview">{JSON.stringify(built.invariant.expr, null, 1)}</pre>
          ) : (
            <p className="issue-error">{built.reason}</p>
          )}

          <div className="row-actions">
            <button className="btn small primary" disabled={!built.ok} onClick={add}>
              add rule
            </button>
            <button className="btn small" onClick={() => setAdding(false)}>
              cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function ExpertExpression({ invariant }: { invariant: Invariant }) {
  return <pre className="expr-preview">{JSON.stringify(invariant.expr as Expr, null, 1)}</pre>
}

/**
 * The faults the search may inject. "No break found" is a claim about exactly these, so each one is
 * a visible tick rather than a default.
 */
function FaultsSection({ study }: { study: Study }) {
  const touched = useStudyTouch("correctness.faults")
  return (
    <section className={sectionClass(touched)}>
      <header className="section-head">
        <h2>what can go wrong</h2>
      </header>
      <FaultToggles study={study} />
    </section>
  )
}

/**
 * Counter values the search starts from.
 *
 * Overselling 200 units needs 201 concurrent requests and the search is bounded at a handful,
 * so against the real stock every broken design comes back "no break found". The search
 * therefore starts from a smaller number, stated here where it can be seen and changed.
 */
function StartingStock({ study }: { study: Study }) {
  const updateContract = useStudyStore((s) => s.updateContract)
  const counters = useMemo(() => {
    const active = study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0]
    return (active?.design.workflow?.collections ?? []).filter((c) => c.kind === "counter")
  }, [study])
  if (counters.length === 0) return null

  const overrides = study.correctness.stateOverrides
  const set = (id: string, value: number | null) => {
    const next = { ...overrides }
    if (value === null) delete next[id]
    else next[id] = value
    updateContract({ correctness: { ...study.correctness, stateOverrides: next } })
  }

  return (
    <>
      <p className="muted advanced-sub">counters during the search · blank = as drawn</p>
      {counters.map((c) => (
        <label key={c.id}>
          {c.label || c.id}
          <input
            type="number"
            placeholder={c.kind === "counter" ? String(c.initial) : ""}
            value={overrides[c.id] ?? ""}
            onChange={(e) => set(c.id, e.target.value === "" ? null : Math.round(Number(e.target.value)))}
          />
        </label>
      ))}
    </>
  )
}

function FaultToggles({ study }: { study: Study }) {
  const updateContract = useStudyStore((s) => s.updateContract)
  const faults = study.correctness.faults

  const toggle = (key: keyof typeof faults) =>
    updateContract({
      correctness: { ...study.correctness, faults: { ...faults, [key]: !faults[key] } },
    })

  const labels: Array<[keyof typeof faults, string]> = [
    ["duplicateRequest", "the same person submits twice"],
    ["retrySameKey", "a retry with the same idempotency key"],
    ["retryNewKey", "a retry with a fresh idempotency key"],
    ["workerCrash", "a worker dies after writing, before answering"],
    ["queueRedelivery", "a queue delivers a message again"],
    ["leaseExpiry", "a lease expires under a live holder"],
    ["reservationExpiry", "a reservation expires"],
  ]

  return (
    <div className="fault-toggles">
      <p className="muted">Only ticked faults are tried. Unticked ones are assumed never to happen.</p>
      {labels.map(([key, label]) => (
        <label key={key} className="toggle">
          <input type="checkbox" checked={faults[key]} onChange={() => toggle(key)} />
          {label}
        </label>
      ))}
    </div>
  )
}
