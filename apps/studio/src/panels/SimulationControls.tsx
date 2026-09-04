import { useEffect, useMemo, useState } from "react";
import type { SimulationMode } from "@sds/core";
import { useStudio } from "../store";
import { DensitySection } from "./DensitySection";
import {
  FAILURE_KINDS,
  failureStrengthLabel,
  failureSummary,
  failureTargetId,
  failureTargetsFor,
  makeFailureEvent,
  type FailureKind,
} from "./failureEditor";

const SPEEDS = [0.5, 1, 2, 4] as const;

// A live session survives lens changes while this panel unmounts. Keep IDs outside the
// component so returning to Load cannot reuse an earlier interactive failure ID.
let failureSequence = 1;

/**
 * Presentation controls for a worker-owned simulation session.
 *
 * The timer only chooses how much virtual time to ask for per UI batch. The engine
 * has no timer and does not receive wall-clock time, so pausing or changing speed
 * cannot alter the event order or random stream.
 */
export function SimulationControls() {
  const design = useStudio((state) => state.design);
  const mode = useStudio((state) => state.sessionMode);
  const sessionId = useStudio((state) => state.sessionId);
  const session = useStudio((state) => state.session);
  const busy = useStudio((state) => state.sessionBusy);
  const enabledSourceIds = useStudio((state) => state.enabledSourceIds);
  const setMode = useStudio((state) => state.setSessionMode);
  const start = useStudio((state) => state.startSession);
  const setSourceEnabled = useStudio((state) => state.setSourceEnabled);
  const advanceBy = useStudio((state) => state.advanceSessionBy);
  const advanceEvents = useStudio((state) => state.advanceSessionEvents);
  const setPaused = useStudio((state) => state.setSessionPaused);
  const setSpeed = useStudio((state) => state.setSessionSpeed);
  const finish = useStudio((state) => state.finishSession);
  const replay = useStudio((state) => state.replaySession);
  const injectFailure = useStudio((state) => state.injectFailure);
  const edit = useStudio((state) => state.edit);
  const [failureKind, setFailureKind] = useState<FailureKind>("node-outage");
  const [targetId, setTargetId] = useState("");
  const [startSec, setStartSec] = useState(5);
  const [durationSec, setDurationSec] = useState(10);
  const [strength, setStrength] = useState(50);

  const sources = design.nodes.filter((node) => node.kind === "client" && node.client);
  const active =
    sessionId !== null &&
    session !== null &&
    session.status !== "completed" &&
    session.status !== "invalidated";

  useEffect(() => {
    if (!active || !session || session.paused || busy) return;
    const timer = window.setTimeout(() => {
      void advanceBy(1000 * session.presentationSpeed);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [active, advanceBy, busy, session]);

  const chooseMode = (next: SimulationMode) => setMode(next);
  const sourceLocked = Boolean(session && session.status !== "ready");
  const occupied = session
    ? Object.values(session.occupancy).reduce((sum, value) => sum + value.total, 0)
    : 0;
  const failureTargets = useMemo(() => failureTargetsFor(design, failureKind), [design, failureKind]);
  const resolvedTarget = failureTargets.some((target) => target.id === targetId)
    ? targetId
    : (failureTargets[0]?.id ?? "");

  const makeFailure = (id: string, atSec: number) =>
    makeFailureEvent({
      design,
      kind: failureKind,
      targetId: resolvedTarget,
      id,
      startSec: atSec,
      durationSec,
      strength,
    });

  const nextFailureId = (prefix: string): string => {
    let id: string;
    do {
      id = `${prefix}-${failureKind}-${failureSequence++}`;
    } while (design.scenario.failures.some((event) => event.id === id));
    return id;
  };

  return (
    <section className="simulation-session" aria-labelledby="simulation-session-title">
      <div className="section simulation-session-head">
        <span id="simulation-session-title">simulation session</span>
        {session && (
          <span className={`session-state state-${session.status}`} aria-live="polite">
            {session.status}
          </span>
        )}
      </div>

      <div className="session-mode" role="group" aria-label="Simulation mode">
        {(["manual", "full"] as const).map((value) => (
          <button
            type="button"
            key={value}
            className={`btn small ${mode === value ? "active" : ""}`}
            aria-pressed={mode === value}
            onClick={() => chooseMode(value)}
            disabled={busy}
          >
            {value === "manual" ? "Manual" : "Full stream"}
          </button>
        ))}
      </div>

      <p className="session-help">
        {mode === "manual"
          ? "Arm the session, then click a client/work source for exactly one request."
          : "Enabled sources generate their configured deterministic request streams."}
      </p>

      {sources.length > 0 && (
        <fieldset className="session-sources" disabled={busy || sourceLocked}>
          <legend>work sources</legend>
          {sources.map((source) => (
            <label key={source.id}>
              <input
                type="checkbox"
                checked={enabledSourceIds.includes(source.id)}
                onChange={(event) =>
                  void setSourceEnabled(source.id, event.currentTarget.checked)
                }
              />
              <span>{source.label}</span>
            </label>
          ))}
        </fieldset>
      )}

      {!active ? (
        <div className="session-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void start(mode)}
            disabled={busy || enabledSourceIds.length === 0}
          >
            {busy ? "Starting…" : mode === "manual" ? "Arm manual session" : "Start full stream"}
          </button>
          {session?.replayAvailable && (
            <button type="button" className="btn" onClick={() => void replay()} disabled={busy}>
              Replay trace
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="session-progress-row">
            <progress value={session.progress} max={1} aria-label="Simulation progress" />
            <span className="tnum">
              {(session.virtualTimeMs / 1000).toFixed(1)}s / {(session.durationMs / 1000).toFixed(0)}s
            </span>
          </div>

          <div className="session-readout" aria-live="polite">
            <span>
              {session.mode === "manual"
                ? `${session.injectedRequests.toLocaleString()} injected`
                : `${session.requestsStarted.toLocaleString()} generated`}
            </span>
            <span>{session.eventsExecuted.toLocaleString()} events</span>
            <span>{occupied} active now</span>
          </div>

          <div className="session-actions wrap">
            <button
              type="button"
              className="btn small"
              onClick={() => void setPaused(!session.paused)}
              disabled={busy}
              aria-label={session.paused ? "Resume session" : "Pause session"}
            >
              {session.paused ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => void advanceEvents(1)}
              disabled={busy}
            >
              Next event
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => void advanceBy(1000)}
              disabled={busy}
            >
              +1s
            </button>
            <button type="button" className="btn small" onClick={() => void finish()} disabled={busy}>
              Finish
            </button>
          </div>

          <label className="session-speed">
            <span>presentation speed</span>
            <select
              value={session.presentationSpeed}
              onChange={(event) => void setSpeed(Number(event.currentTarget.value))}
              disabled={busy}
            >
              {SPEEDS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {session?.status === "invalidated" && (
        <p className="note warn" role="status">
          Session stopped: {session.invalidationReason}. Start again to simulate the current design.
        </p>
      )}

      <DensitySection
        title="failure timeline"
        summary={`${design.scenario.failures.length} configured · outages, degradation, latency and loss`}
        className="failure-density-section"
      >
        <p className="session-help">
          Saved events replay with the scenario. Live injection uses the same event shape at the
          session's current virtual time.
        </p>

        <div className="failure-editor">
        <label>
          <span>failure</span>
          <select value={failureKind} onChange={(event) => setFailureKind(event.currentTarget.value as FailureKind)}>
            {FAILURE_KINDS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>target</span>
          <select value={resolvedTarget} onChange={(event) => setTargetId(event.currentTarget.value)}>
            {failureTargets.map((target) => (
              <option key={target.id} value={target.id}>{target.label}</option>
            ))}
          </select>
        </label>
        <div className="failure-number-row">
          <label>
            <span>start · sec</span>
            <input type="number" min={0} step={1} value={startSec} onChange={(event) => setStartSec(Math.max(0, Number(event.currentTarget.value)))} />
          </label>
          <label>
            <span>duration · sec</span>
            <input type="number" min={0.1} step={1} value={durationSec} onChange={(event) => setDurationSec(Math.max(0.1, Number(event.currentTarget.value)))} />
          </label>
        </div>
        {failureKind !== "node-outage" && (
          <label>
            <span>{failureStrengthLabel(failureKind, strength)}</span>
            <input type="range" min={failureKind === "service-degradation" || failureKind === "edge-latency" ? 10 : 0} max={100} value={strength} onChange={(event) => setStrength(Number(event.currentTarget.value))} />
          </label>
        )}
        <div className="session-actions wrap">
          <button
            type="button"
            className="btn small"
            disabled={!resolvedTarget || busy}
            onClick={() => {
              const event = makeFailure(nextFailureId("scenario"), startSec);
              edit((draft) => { draft.scenario.failures.push(event); });
            }}
          >
            Add to scenario
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!active || !resolvedTarget || busy || !session}
            onClick={() => {
              if (!session) return;
              void injectFailure(
                makeFailure(nextFailureId(`interactive-${Math.round(session.virtualTimeMs)}`), session.virtualTimeMs / 1000)
              );
            }}
          >
            Inject now
          </button>
        </div>
        </div>

        {design.scenario.failures.length > 0 && (
          <ul className="failure-list" aria-label="Configured failure events">
            {design.scenario.failures.map((event) => (
              <li key={event.id}>
                <span className="failure-marker" aria-hidden="true">!</span>
                <span>
                  <b>{FAILURE_KINDS.find((item) => item.value === event.kind)?.label}</b>
                  <small>{failureTargetId(event)} · {event.startSec}s for {event.durationSec}s · {failureSummary(event)}</small>
                </span>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={`Remove ${event.id}`}
                  title="Remove failure"
                  onClick={() => edit((draft) => { draft.scenario.failures = draft.scenario.failures.filter((item) => item.id !== event.id); })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="note network-boundary">
          Request-level model only: packet MTU, congestion control and packet reordering are out of
          scope.
        </p>
      </DensitySection>

      {session && session.activeFailures.length > 0 && (
        <div className="active-failures" role="status" aria-live="polite">
          <b>{session.activeFailures.length} active failure{session.activeFailures.length === 1 ? "" : "s"}</b>
          {session.activeFailures.map((event) => (
            <span key={event.id}>{event.kind} · {failureTargetId(event)}</span>
          ))}
        </div>
      )}

    </section>
  );
}
