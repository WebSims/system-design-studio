import type { RunResult } from "@sds/core";
import type { DesignPreview } from "@sds/analytic";
import { useStudio } from "../store";
import { usePlayback } from "../playback";
import { Chart } from "./Chart";

const ms = (v: number | null | undefined): string =>
  v == null || !isFinite(v) ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`;

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

function sloVerdictTone(result: RunResult): "bad" | undefined {
  const target = result.design.slo.p99LatencyMs;
  return target !== null && result.endToEnd.p99 > target ? "bad" : undefined;
}

/**
 * True when the p99 is close enough to its target that the run's own uncertainty
 * spans the boundary.
 *
 * A pass/fail verdict inside the error bar is not a result, it is a coin toss
 * dressed as one. Saying so is the difference between a tool that informs a
 * decision and a tool that launders noise into confidence.
 */
function sloBorderline(result: RunResult): boolean {
  const target = result.design.slo.p99LatencyMs;
  if (target === null) return false;
  const margin = result.endToEnd.p99 * result.confidence.approxTailRelativeError;
  return Math.abs(result.endToEnd.p99 - target) < margin;
}


function Metric({
  label,
  value,
  unit,
  tone,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "ok" | "warn" | "bad" | "muted";
  title?: string;
}) {
  return (
    <div className="metric" title={title}>
      <div className={`metric-value tnum ${tone ?? ""}`}>
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

/**
 * The live closed-form estimate.
 *
 * Shown while editing, before any simulation has run. It is exact for a single
 * M/M/c station and says so; where it cannot be exact it declines to show a number
 * and explains why, rather than presenting an approximation as a result.
 */
function PreviewPanel({ preview }: { preview: DesignPreview }) {
  const bottleneck = preview.nodes.find((n) => n.nodeId === preview.bottleneckNodeId);

  return (
    <>
      <div className="section">
        estimate <span className="section-tag">closed form · instant</span>
      </div>

      {!preview.stable ? (
        /**
         * The most important refusal in the product. When arrivals exceed capacity
         * the queue grows for as long as you run, so latency is a function of run
         * length rather than of the design. Printing "p99 = 4.2s" there is
         * meaningless -- run twice as long and it doubles.
         */
        <div className="verdict crit">
          <div className="verdict-title">does not scale</div>
          <div className="verdict-body">
            {bottleneck ? (
              <>
                <b>{bottleneck.label}</b> is offered{" "}
                <b className="tnum">{bottleneck.arrivalRatePerSec.toFixed(0)}/s</b> against a
                capacity of{" "}
                <b className="tnum">
                  {((bottleneck.capacity * 1000) / bottleneck.serviceMeanMs).toFixed(0)}/s
                </b>{" "}
                (&rho; = <b className="tnum">{bottleneck.rho.toFixed(2)}</b>). Its queue grows
                without bound, so there is no steady state and no latency figure to report.
              </>
            ) : (
              "a station is offered more work than it can serve."
            )}
          </div>
        </div>
      ) : (
        <div className="metrics">
          <Metric
            label="bottleneck load"
            value={pct(preview.bottleneckUtilization)}
            tone={
              preview.bottleneckUtilization >= 0.85
                ? "bad"
                : preview.bottleneckUtilization >= 0.7
                  ? "warn"
                  : "ok"
            }
            title={bottleneck ? `${bottleneck.label} (${bottleneck.model})` : undefined}
          />
          <Metric label="mean latency" value={ms(preview.endToEndMeanMs)} />
          {preview.endToEndP99Ms !== null ? (
            <Metric label="p99 latency" value={ms(preview.endToEndP99Ms)} />
          ) : (
            <Metric label="p99 latency" value="—" tone="muted" title={preview.p99Reason ?? ""} />
          )}
          <Metric label="throughput" value={preview.throughputPerSec.toFixed(0)} unit="/s" />
        </div>
      )}

      {preview.endToEndP99Ms === null && preview.p99Reason && preview.stable && (
        <p className="note">
          <b>p99 withheld.</b> {preview.p99Reason}
        </p>
      )}
      {preview.notes.map((n) => (
        <p className="note warn" key={n}>
          {n}
        </p>
      ))}
    </>
  );
}

function Transport({ result }: { result: RunResult }) {
  const playing = usePlayback((s) => s.playing);
  const tMs = usePlayback((s) => s.tMs);
  const speed = usePlayback((s) => s.speed);
  const toggle = usePlayback((s) => s.toggle);
  const setSpeed = usePlayback((s) => s.setSpeed);
  const seek = usePlayback((s) => s.seek);

  const hops = result.trace.hops;
  if (hops.length === 0) return null;
  const start = Math.min(...hops.map((h) => h.tStart));
  const end = Math.max(...hops.map((h) => h.tEnd));

  return (
    <>
      <div className="section">
        trace playback
        <span className="section-tag">1 in {result.trace.sampleEvery.toLocaleString()} sampled</span>
      </div>
      <div className="transport">
        <button className="btn small" onClick={toggle}>
          {playing ? "pause" : "play"}
        </button>
        <input
          type="range"
          min={start}
          max={end}
          step={(end - start) / 500}
          value={Math.min(end, Math.max(start, tMs))}
          onChange={(e) => {
            usePlayback.getState().pause();
            seek(Number(e.target.value));
          }}
        />
        <select className="input tiny" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={0.1}>0.1&times;</option>
          <option value={0.25}>0.25&times;</option>
          <option value={1}>1&times;</option>
          <option value={4}>4&times;</option>
        </select>
      </div>
      <p className="note">
        The animation replays a recorded trace; the simulation already finished. Speed
        and position are free because playback cannot influence the model.
      </p>
    </>
  );
}

function ResultPanel({ result }: { result: RunResult }) {
  const slo = result.design.slo;
  const errTone = result.errors.ratePct > 1 ? "bad" : result.errors.ratePct > 0 ? "warn" : "ok";
  const failedInvariants = result.invariants.filter((i) => !i.passed);

  return (
    <>
      <div className="section">
        measured <span className="section-tag">{result.observedSec}s simulated in {result.wallMs}ms</span>
      </div>

      {!result.stability.stable && (
        <div className="verdict crit">
          <div className="verdict-title">unstable — latency below is not meaningful</div>
          <div className="verdict-body">{result.stability.detail}</div>
        </div>
      )}

      {failedInvariants.length > 0 && (
        /**
         * Surfaced prominently, not buried. A simulator that violates conservation
         * of requests or Little's Law is producing plausible-looking wrong numbers;
         * the desired failure mode is the tool distrusting itself out loud.
         */
        <div className="verdict crit">
          <div className="verdict-title">invariant violated — do not trust these numbers</div>
          {failedInvariants.map((i) => (
            <div className="verdict-body" key={i.name}>
              {i.name}: {i.detail}
            </div>
          ))}
        </div>
      )}

      {result.sloPassed !== null && (
        <div className={`verdict ${result.sloPassed ? "ok" : "bad"}`}>
          <div className="verdict-title">{result.sloPassed ? "meets SLO" : "misses SLO"}</div>
          <div className="verdict-body">
            {slo.p99LatencyMs !== null && (
              <>
                p99 {ms(result.endToEnd.p99)} against a {slo.p99LatencyMs}ms target
              </>
            )}
            {slo.p99LatencyMs !== null && slo.maxErrorRatePct !== null && " · "}
            {slo.maxErrorRatePct !== null && (
              <>
                errors {result.errors.ratePct.toFixed(2)}% against {slo.maxErrorRatePct}%
              </>
            )}
          </div>
        </div>
      )}

      <div className="metrics">
        <Metric label="throughput" value={result.throughputPerSec.toFixed(1)} unit="/s" />
        <Metric label="offered" value={result.offeredRatePerSec.toFixed(0)} unit="/s" />
        <Metric label="errors" value={result.errors.ratePct.toFixed(2)} unit="%" tone={errTone} />
        <Metric label="in system" value={result.avgInSystem.toFixed(2)} title="Little's Law L" />
      </div>

      <div className="section">latency of successful requests</div>
      <div className="metrics four">
        <Metric label="p50" value={ms(result.endToEnd.p50)} />
        <Metric label="p90" value={ms(result.endToEnd.p90)} />
        <Metric
          label="p99"
          value={ms(result.endToEnd.p99)}
          tone={sloVerdictTone(result)}
          title={`+/- ${(result.confidence.approxTailRelativeError * 100).toFixed(1)}% seed to seed`}
        />
        <Metric label="p99.9" value={ms(result.endToEnd.p999)} />
      </div>
      <p className="note">
        Mean {ms(result.endToEnd.mean)}, max {ms(result.endToEnd.max)}, over{" "}
        <b className="tnum">{result.endToEnd.count.toLocaleString()}</b> requests. Percentiles carry
        up to {(result.endToEnd.relativeError * 100).toFixed(1)}% bucketing error.
      </p>

      {/*
        The tool stating its own precision, separately for the mean and the tail.
        Reporting one figure for both overstates confidence in the p99, which is
        the number the SLO is written against -- caught when the default design's
        p99 was seen ranging 262-302ms while the tool claimed 1% accuracy.
      */}
      <div className={`confidence ${result.confidence.sufficient ? "ok" : "warn"}`}>
        <b>{result.confidence.sufficient ? "sample size adequate" : "sample size low"}</b>
        <div>{result.confidence.note}</div>
      </div>

      {sloBorderline(result) && (
        <p className="note warn">
          The p99 sits within its own uncertainty of the {slo.p99LatencyMs}ms target, so this
          pass/fail verdict is not robust. Raise the run duration, or change the seed and see
          whether the verdict holds.
        </p>
      )}

      {result.errors.total > 0 && (
        <>
          <div className="section">error breakdown</div>
          <div className="metrics">
            <Metric label="shed" value={result.errors.shed.toLocaleString()} />
            <Metric label="timeout" value={result.errors.timeout.toLocaleString()} />
            <Metric label="network" value={result.errors.network.toLocaleString()} />
          </div>
        </>
      )}

      <div className="section">stations</div>
      {result.nodes
        .filter((n) => n.kind === "server")
        .map((n) => (
          <div className="station-row" key={n.nodeId}>
            <div className="station-head">
              <span>{n.label}</span>
              <span className="tnum">{pct(n.utilization)} busy</span>
            </div>
            <div className="station-detail tnum">
              c={n.capacity} · queue avg {n.avgQueueLength.toFixed(2)} / max {n.maxQueueLength} ·
              wait {ms(n.avgWaitMs)}
              {n.shed > 0 && ` · shed ${n.shed.toLocaleString()}`}
            </div>
            <Chart series={n.queueLengthSeries} height={72} color="#7b51a1" yLabel="queue" />
          </div>
        ))}

      <div className="section">throughput over time</div>
      <Chart series={result.throughputSeries} color="#2aa8a8" yLabel="req/s" />

      <div className="section">p99 latency over time</div>
      <Chart
        series={result.latencyP99Series}
        color="#f08d2c"
        yLabel="ms"
        threshold={slo.p99LatencyMs}
      />

      <div className="section">invariants</div>
      {result.invariants.map((i) => (
        <div className={`invariant ${i.passed ? "ok" : "bad"}`} key={i.name}>
          <span className="inv-mark">{i.passed ? "✓" : "✗"}</span>
          <span className="inv-name">{i.name}</span>
          <span className="inv-detail">{i.detail}</span>
        </div>
      ))}

      <Transport result={result} />
    </>
  );
}

export function ResultsRail() {
  const preview = useStudio((s) => s.preview);
  const run = useStudio((s) => s.run);
  const runStale = useStudio((s) => s.runStale);
  const running = useStudio((s) => s.running);
  const error = useStudio((s) => s.error);
  const issues = useStudio((s) => s.issues);
  const execute = useStudio((s) => s.execute);

  const blocking = issues.filter((i) => i.severity === "error");

  return (
    <aside className="rail left">
      <div className="rail-title">analysis</div>

      {blocking.length > 0 && (
        <div className="verdict bad">
          <div className="verdict-title">design is not runnable</div>
          {blocking.map((i, k) => (
            <div className="verdict-body" key={k}>
              {i.message}
            </div>
          ))}
        </div>
      )}

      <PreviewPanel preview={preview} />

      <button className="btn primary run" onClick={execute} disabled={running || blocking.length > 0}>
        {running ? "simulating…" : "run simulation"}
      </button>

      {error && (
        <div className="verdict bad">
          <div className="verdict-title">simulation refused</div>
          <div className="verdict-body">{error}</div>
        </div>
      )}

      {run && runStale && (
        <p className="note warn">
          The design changed after this run. Figures below describe the previous
          version; run again to refresh them.
        </p>
      )}

      {run ? (
        <ResultPanel result={run} />
      ) : (
        !error && (
          <p className="note">
            The estimate above is closed-form and instant. Run the simulation for
            percentiles, queue dynamics over time, and a replayable trace.
          </p>
        )
      )}
    </aside>
  );
}
