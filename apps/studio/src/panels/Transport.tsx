import { useEffect, useMemo } from "react";
import type { RunResult } from "@sds/core";
import { buildFocusWarp, prepareTrace, type RequestSpan } from "../canvas/choreography";
import { hopIcon, iconDataUrl, rootIcon, visitIcon } from "../canvas/identicon";
import { usePlayback } from "../playback";
import { useStudio } from "../store";

/**
 * TRACE PLAYBACK CONTROLS, AND A WATERFALL FOR ONE REQUEST.
 *
 * Two modes, because a single linear timescale cannot show a design honestly. Real
 * systems span four orders of magnitude of duration -- a quarter-millisecond network
 * hop next to a two-second timeout -- so playing simulated time linearly makes the fast
 * events a blur, while stretching the fast events would put two sprites on screen at
 * different simulated instants.
 *
 * Ambient mode plays simulated time linearly and is therefore honest about
 * simultaneity. Focus mode follows ONE request and stretches its span to a few seconds;
 * it makes no claim about what else was happening, which is precisely why stretching it
 * distorts nothing. Following one request end to end is also what the identicon lineage
 * was always for.
 */

const ms = (v: number): string =>
  v >= 1000 ? `${(v / 1000).toFixed(2)}s` : v >= 1 ? `${v.toFixed(1)}ms` : `${(v * 1000).toFixed(0)}\u00b5s`;

function Sprite({ icon, size = 14 }: { icon: ReturnType<typeof rootIcon>; size?: number }) {
  return (
    <img
      className="wf-icon"
      src={iconDataUrl(icon, size * 2)}
      alt=""
      width={size}
      height={size}
    />
  );
}

/**
 * A distributed-trace waterfall for the focused request.
 *
 * The pedagogical payload of focus mode: which station held the request, for how long,
 * how much of that was queueing rather than work, and where the time actually went. The
 * animation shows the shape of the journey; this shows the numbers behind it.
 */
function Waterfall({ result, span }: { result: RunResult; span: RequestSpan }) {
  const design = useStudio((s) => s.design);
  const prepared = useMemo(
    () => prepareTrace(design, result.trace),
    [design, result.trace]
  );
  const tMs = usePlayback((s) => s.tMs);

  const total = Math.max(1e-6, span.endMs - span.startMs);
  const labelOf = (id: string) => design.nodes.find((n) => n.id === id)?.label ?? id;
  const edgeOf = (id: string) => design.edges.find((e) => e.id === id);

  type Row = {
    key: string;
    kind: "visit" | "hop";
    label: string;
    startMs: number;
    endMs: number;
    /** Queue wait within a visit, for the split bar. */
    waitMs: number;
    icon: ReturnType<typeof rootIcon>;
    failed: boolean;
    detail: string;
  };

  const rows: Row[] = [];

  for (const i of span.visits) {
    const v = prepared.trace.visits[i]!;
    const failed = v.outcome !== "served" && v.outcome !== "hit";
    rows.push({
      key: `v${i}`,
      kind: "visit",
      label: labelOf(v.nodeId),
      startMs: v.tEnqueue,
      endMs: v.tExit,
      waitMs: v.tServiceStart === null ? v.tExit - v.tEnqueue : v.tServiceStart - v.tEnqueue,
      icon: visitIcon(v.requestId, v.nodeId, failed),
      failed,
      detail: `${v.outcome} \u00b7 ${ms(v.tExit - v.tEnqueue)}`,
    });
  }
  for (const i of span.hops) {
    const h = prepared.trace.hops[i]!;
    const e = edgeOf(h.edgeId);
    rows.push({
      key: `h${i}`,
      kind: "hop",
      label: e ? `${labelOf(e.from)} \u2192 ${labelOf(e.to)}` : h.edgeId,
      startMs: h.tStart,
      endMs: h.tEnd,
      waitMs: 0,
      icon: hopIcon(h.requestId, h.edgeId, !h.delivered),
      failed: !h.delivered,
      detail: `${h.forward ? "request" : "response"} \u00b7 ${ms(h.tEnd - h.tStart)}`,
    });
  }

  rows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const playheadPct = ((tMs - span.startMs) / total) * 100;

  return (
    <div className="waterfall">
      <div
        className="wf-playhead"
        style={{ left: `${Math.max(0, Math.min(100, playheadPct))}%` }}
      />
      {rows.map((row) => {
        const left = ((row.startMs - span.startMs) / total) * 100;
        const width = Math.max(0.6, ((row.endMs - row.startMs) / total) * 100);
        const waitPct = row.endMs > row.startMs ? (row.waitMs / (row.endMs - row.startMs)) * 100 : 0;
        const active = tMs >= row.startMs && tMs <= row.endMs;
        return (
          <div className={`wf-row ${active ? "active" : ""}`} key={row.key}>
            <div className="wf-label">
              <Sprite icon={row.icon} />
              <span className="wf-name">{row.label}</span>
            </div>
            <div className="wf-track">
              <div
                className={`wf-bar ${row.kind} ${row.failed ? "failed" : ""}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={row.detail}
              >
                {/* Queueing shown separately from work: it is the actionable half. */}
                {waitPct > 2 && <div className="wf-wait" style={{ width: `${waitPct}%` }} />}
              </div>
            </div>
            <div className="wf-time tnum">{ms(row.endMs - row.startMs)}</div>
          </div>
        );
      })}
      <p className="note">
        One request, {ms(total)} end to end. The pale part of each bar is queueing rather
        than work &mdash; the half you can fix with capacity. Bars overlap where the request
        fanned out and waited for several dependencies at once.
      </p>
    </div>
  );
}

export function Transport({ result }: { result: RunResult }) {
  const design = useStudio((s) => s.design);
  const playing = usePlayback((s) => s.playing);
  const tMs = usePlayback((s) => s.tMs);
  const speed = usePlayback((s) => s.speed);
  const mode = usePlayback((s) => s.mode);
  const focusRequestId = usePlayback((s) => s.focusRequestId);
  const focusDurationSec = usePlayback((s) => s.focusDurationSec);
  const inFlight = usePlayback((s) => s.inFlight);
  const toggle = usePlayback((s) => s.toggle);
  const setSpeed = usePlayback((s) => s.setSpeed);
  const setMode = usePlayback((s) => s.setMode);
  const setFocus = usePlayback((s) => s.setFocus);
  const setFocusDuration = usePlayback((s) => s.setFocusDuration);
  const seek = usePlayback((s) => s.seek);

  const prepared = useMemo(
    () => prepareTrace(design, result.trace),
    [design, result.trace]
  );

  // Longest-lived requests first: those have the most to show, and a request whose
  // whole life was two hops of network is not worth watching.
  const candidates = prepared.requests.slice(0, 24);

  // Focus mode is the default, so a request has to be chosen as soon as a trace lands
  // or the panel would open onto nothing. A re-run produces new request ids, so a stale
  // selection has to be replaced rather than left dangling.
  const firstCandidate = candidates[0]?.requestId ?? null;
  const selectionValid =
    focusRequestId !== null && prepared.requests.some((r) => r.requestId === focusRequestId);
  useEffect(() => {
    if (!selectionValid && firstCandidate !== null) setFocus(firstCandidate);
  }, [firstCandidate, selectionValid, setFocus]);

  if (result.trace.hops.length === 0) return null;
  const focused =
    focusRequestId !== null
      ? prepared.requests.find((r) => r.requestId === focusRequestId) ?? null
      : null;

  const window =
    mode === "focus" && focused
      ? { startMs: focused.startMs, endMs: focused.endMs }
      : { startMs: prepared.spanStartMs, endMs: prepared.spanEndMs };

  const warp = mode === "focus" && focused ? buildFocusWarp(prepared, focused) : null;

  return (
    <>
      <div className="section">
        trace playback
        <span className="section-tag">
          1 in {result.trace.sampleEvery.toLocaleString()} sampled
        </span>
      </div>

      <div className="mode-row">
        <button
          className={`chip ${mode === "ambient" ? "on" : ""}`}
          onClick={() => setMode("ambient")}
        >
          ambient
        </button>
        <button
          className={`chip ${mode === "focus" ? "on" : ""}`}
          onClick={() => {
            setMode("focus");
            if (focusRequestId === null && candidates[0]) setFocus(candidates[0].requestId);
          }}
        >
          follow one request
        </button>
      </div>

      <div className="transport">
        <button className="btn small" onClick={toggle}>
          {playing ? "pause" : "play"}
        </button>
        <input
          type="range"
          min={window.startMs}
          max={window.endMs}
          step={(window.endMs - window.startMs) / 500 || 1}
          value={Math.min(window.endMs, Math.max(window.startMs, tMs))}
          onChange={(e) => {
            usePlayback.getState().pause();
            seek(Number(e.target.value));
          }}
        />
        {/* "Nothing in flight" is a real state, not a broken animation: on most designs
            a request spends the overwhelming majority of its life at a station rather
            than on a wire. Saying so is cheaper than leaving a viewer to guess. */}
        <span className="inflight tnum" title="sprites currently on a wire">
          {inFlight > 0 ? `${inFlight} in flight` : "at a station"}
        </span>
        {mode === "ambient" ? (
          <select
            className="input tiny"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            <option value={0.01}>0.01&times;</option>
            <option value={0.1}>0.1&times;</option>
            <option value={0.5}>0.5&times;</option>
            <option value={1}>1&times;</option>
            <option value={4}>4&times;</option>
          </select>
        ) : (
          <select
            className="input tiny"
            value={focusDurationSec}
            onChange={(e) => setFocusDuration(Number(e.target.value))}
          >
            <option value={3}>3s</option>
            <option value={6}>6s</option>
            <option value={12}>12s</option>
          </select>
        )}
      </div>

      {mode === "ambient" ? (
        <p className="note">
          Simulated time, played linearly, so everything on screen is at the same instant.
          Real designs span four orders of magnitude of duration, so sub-millisecond hops
          are a blur at 1&times; &mdash; slow it down, or follow one request instead.
        </p>
      ) : (
        <>
          <div className="focus-picker">
            {candidates.map((r) => (
              <button
                key={r.requestId}
                className={`focus-chip ${r.requestId === focusRequestId ? "on" : ""} ${
                  r.failed ? "failed" : ""
                }`}
                onClick={() => setFocus(r.requestId)}
                title={`${ms(r.endMs - r.startMs)} end to end, ${r.visits.length} stations, ${
                  r.hops.length
                } hops${r.failed ? ", failed" : ""}`}
              >
                <Sprite icon={rootIcon(r.requestId)} size={12} />
                <span className="tnum">{ms(r.endMs - r.startMs)}</span>
              </button>
            ))}
          </div>
          {/* Guarded on `focused` rather than asserted non-null: on the first render
              after a run the selection effect has not yet chosen a request, and a
              non-null assertion here crashed the whole app. */}
          {focused && warp && (
            warp.nonLinear ? (
              <p className="note warn">
                <b>Non-linear timeline.</b> This request spends almost all of its{" "}
                {ms(focused.endMs - focused.startMs)} at one station, so played to scale the
                network hops would flash past in under a frame. Short phases are stretched, by
                up to {warp.maxStretch.toFixed(0)}&times;, so each is visible. Ordering is
                preserved and long phases still look long, but the animation is not to scale
                &mdash; the waterfall below is, and every bar carries its real duration.
              </p>
            ) : (
              <p className="note">
                One request, {ms(focused.endMs - focused.startMs)} end to end, played over{" "}
                {focusDurationSec}s. Its phases are close enough in duration that this
                timeline is to scale.
              </p>
            )
          )}
          <p className="note">
            Nothing is claimed about what else happened at the same instant &mdash; which is what
            makes following one request safe to stretch. Ambient mode never is.
          </p>
        </>
      )}

      {mode === "focus" && focused && <Waterfall result={result} span={focused} />}

      <p className="note">
        The animation replays a recorded trace; the simulation already finished. Speed and
        position are free because playback cannot influence the model &mdash; which is also why
        the engine can measure millions of requests while this animates a sampled few
        thousand.
      </p>
    </>
  );
}
