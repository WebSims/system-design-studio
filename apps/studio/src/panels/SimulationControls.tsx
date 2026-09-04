import { useEffect } from "react";
import type { SimulationMode } from "@sds/core";
import { useStudio } from "../store";

const SPEEDS = [0.5, 1, 2, 4] as const;

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
            <span>{session.injectedRequests} injected</span>
            <span>{session.eventsExecuted.toLocaleString()} events</span>
            <span>{occupied} active</span>
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
    </section>
  );
}
