import { useEffect, useMemo, useRef } from "react"
import { useStudio } from "../store"
import { useStudyStore } from "../study/store"
import { useRaceModel } from "../raceModel"
import { useRacePlayback } from "../racePlayback"
import { laneColour } from "../canvas/race"
import { describeFault, layoutCounterexample } from "../correctness/layout"

/**
 * THE BOTTOM DOCK UNDER THE BEHAVIOUR LENS: the counterexample as a timeline.
 *
 * DevTools shape: transport on the left, one column per actor, one row per step, the current
 * step highlighted and the state after it summarised in the gutter. The same cursor drives this,
 * the sprites on the canvas and the chips on the data nodes -- they read one store, so they cannot
 * disagree about which step is "now". Clicking a row scrubs; the scrubber scrubs; play advances.
 *
 * The prose is generated from structure (see `correctness/layout.ts`). Nothing here is narrated by
 * a model: a counterexample is evidence, and the words next to it are assembled from its own fields.
 */
export function RaceDock() {
  const counterexample = useRaceModel((s) => s.counterexample)
  const plan = useRaceModel((s) => s.plan)
  const design = useRaceModel((s) => s.design)
  const cursor = useRacePlayback((s) => s.cursor)
  const playing = useRacePlayback((s) => s.playing)
  const stepMs = useRacePlayback((s) => s.stepMs)
  const toggle = useRacePlayback((s) => s.toggle)
  const seek = useRacePlayback((s) => s.seek)
  const stepBack = useRacePlayback((s) => s.stepBack)
  const stepForward = useRacePlayback((s) => s.stepForward)
  const setStepMs = useRacePlayback((s) => s.setStepMs)
  const study = useStudyStore((s) => s.study)
  const active = useStudyStore((s) => s.activeCandidate())
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null))
  const select = useStudio((s) => s.select)

  const layout = useMemo(() => (counterexample ? layoutCounterexample(counterexample) : null), [counterexample])
  const invariant = counterexample
    ? study.correctness.invariants.find((i) => i.id === counterexample.invariantId) ?? null
    : null

  const currentRowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [cursor])

  if (!counterexample || !layout || !plan || !design) {
    const status = evaluation?.correctness?.status
    return (
      <div className="dock-empty">
        {status === "NO_VIOLATION_WITHIN_BOUNDS"
          ? "No way to break a rule was found within the search limits. Loosen the limits, add a fault, or switch to the Load lens to see how it holds up under traffic."
          : status === "INCONCLUSIVE_BOUND_REACHED"
            ? "The search hit a limit before finishing. It found no break, but it did not look everywhere."
            : "When a race is found, it plays here: one column per request, one row per step, the state after each step on the right."}
      </div>
    )
  }

  const total = layout.steps.length
  const at = Math.max(-1, Math.min(cursor, total - 1))
  const atEnd = at >= total - 1
  const values = layout.timeline[Math.max(0, at)]?.values ?? {}
  const explanation = layout.explanation

  return (
    <div className="race-dock">
      <div className="dock-transport">
        <button className="btn small" onClick={() => seek(-1)} title="to the start" aria-label="to the start">
          {"\u23ee"}
        </button>
        <button className="btn small" onClick={stepBack} title="previous step" aria-label="previous step" disabled={at < 0}>
          {"\u25c0"}
        </button>
        <button className="btn small primary play" onClick={toggle} aria-label={playing ? "pause" : "play"}>
          {playing ? "\u23f8 pause" : atEnd ? "\u25b6 replay" : "\u25b6 play"}
        </button>
        <button className="btn small" onClick={stepForward} title="next step" aria-label="next step" disabled={atEnd}>
          {"\u25b6"}
        </button>
        <input
          type="range"
          className="dock-scrub"
          min={-1}
          max={Math.max(0, total - 1)}
          value={at}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="step through how it breaks"
        />
        <span className="tnum dock-counter">{at < 0 ? "start" : `step ${at + 1} / ${total}`}</span>
        <select
          className="dock-speed"
          value={stepMs}
          onChange={(e) => setStepMs(Number(e.target.value))}
          aria-label="playback speed"
        >
          <option value={2400}>slow</option>
          <option value={1400}>normal</option>
          <option value={700}>fast</option>
        </select>
      </div>

      <div className="dock-body">
        <div className="dock-lanes-wrap">
          <div className="dock-lanes" style={{ gridTemplateColumns: `repeat(${layout.lanes.length}, minmax(180px, 1fr))` }}>
            {layout.lanes.map((lane, laneIndex) => {
              const home = plan.homeNodeByLane[lane.id]
              const homeLabel = home ? design.nodes.find((n) => n.id === home)?.label : null
              return (
                <div
                  key={lane.id}
                  className={`lane-head lane-${lane.kind}`}
                  style={{ "--lane": lane.kind === "system" ? "var(--fg-3)" : laneColour(laneIndex) } as React.CSSProperties}
                >
                  <span className="lane-swatch" aria-hidden="true" />
                  <span className="lane-id">{lane.id}</span>
                  <span className="lane-label">
                    {lane.label}
                    {homeLabel ? ` · at ${homeLabel}` : ""}
                  </span>
                </div>
              )
            })}

            {layout.steps.map((laid, i) => {
              const step = plan.steps[i]
              const isCurrent = i === at
              return (
                <div
                  key={laid.step.index}
                  ref={isCurrent ? currentRowRef : undefined}
                  className={`lane-row ${isCurrent ? "lane-row-current" : ""} ${i > at ? "lane-row-future" : ""}`}
                  style={{ gridColumn: `${laid.column + 1}`, "--lane": laid.isEnvironment ? "var(--fg-3)" : laneColour(laid.column) } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className={`lane-cell ${laid.step.fault ? "lane-cell-fault" : ""} ${isCurrent && atEnd ? "lane-cell-violation" : ""}`}
                    onClick={() => {
                      seek(i)
                      const target = step?.targetNodeId ?? step?.homeNodeId
                      if (target) select({ kind: "node", id: target })
                    }}
                    title={laid.step.fault ? describeFault(laid.step.fault) : undefined}
                  >
                    <span className="lane-step">{laid.step.index + 1}</span>
                    <span className="lane-op">{laid.step.label}</span>
                    {laid.observedSummary && <span className="lane-saw">saw {laid.observedSummary}</span>}
                    {laid.diffSummary && <span className="lane-diff">{laid.diffSummary}</span>}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <aside className="dock-side">
          <div className={`dock-verdict ${atEnd ? "broken" : ""}`}>
            <span className="badge badge-bad">{invariant ? invariant.label : "rule broken"}</span>
            <p>{atEnd ? (invariant?.message || explanation[0]) : explanation[0]}</p>
          </div>

          <h3>{at < 0 ? "before anything runs" : `state after step ${at + 1}`}</h3>
          <dl className="stat-grid dock-state">
            {Object.entries(values).map(([id, value]) => {
              const changed = at >= 0 && (plan.steps[at]?.changed.includes(id) ?? false)
              const violated = atEnd && plan.violatedCollections.includes(id)
              return (
                <div key={id} className={`${changed ? "changed" : ""} ${violated ? "violated" : ""}`}>
                  <dt>{id}</dt>
                  <dd className="tnum">{value}</dd>
                </div>
              )
            })}
          </dl>

          {counterexample.faultsUsed.length > 0 && (
            <ul className="fault-list">
              {counterexample.faultsUsed.map((f) => (
                <li key={f}>
                  <span className="badge badge-warn">{f}</span> {describeFault(f)}
                </li>
              ))}
            </ul>
          )}

          {explanation.length > 1 && (
            <details>
              <summary>the story in words</summary>
              {explanation.slice(1).map((paragraph, i) => (
                <p key={i} className="muted">
                  {paragraph}
                </p>
              ))}
            </details>
          )}

          {layout.inconsistencies.length > 0 && (
            <ul className="issue-list">
              {layout.inconsistencies.map((text, k) => (
                <li key={k} className="issue-error">
                  trace inconsistency: {text}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  )
}
