import type { NodeResult, RunResult } from "@sds/core";
import type { DesignPreview } from "@sds/analytic";
import { useStudio } from "../store";
import { usePlayback } from "../playback";
import { AnalyzerPanel } from "./AnalyzerPanel";
import { Chart } from "./Chart";

const ms = (v: number | null | undefined): string =>
  v == null || !isFinite(v) ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`;

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const num = (v: number): string => Math.round(v).toLocaleString();

function sloVerdictTone(result: RunResult): "bad" | undefined {
  const target = result.design.slo.p99LatencyMs;
  return target !== null && result.endToEnd.p99 > target ? "bad" : undefined;
}

/**
 * True when the p99 is close enough to its target that the run's own uncertainty
 * spans the boundary.
 *
 * A pass/fail verdict inside the error bar is not a result, it is a coin toss
 * dressed as one.
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
 * Shown while editing, before any simulation has run. Exact for a single M/M/c
 * station; where it cannot be exact it declines to show a number and explains why,
 * rather than presenting an approximation as a result.
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
         * length rather than of the design.
         */
        <div className="verdict crit">
          <div className="verdict-title">does not scale</div>
          <div className="verdict-body">
            {bottleneck ? (
              isFinite(bottleneck.effectiveServiceMeanMs) ? (
                <>
                  <b>{bottleneck.label}</b> is offered{" "}
                  <b className="tnum">{bottleneck.arrivalRatePerSec.toFixed(0)}/s</b> against a
                  capacity of{" "}
                  <b className="tnum">
                    {((bottleneck.capacity * 1000) / bottleneck.effectiveServiceMeanMs).toFixed(0)}/s
                  </b>{" "}
                  (&rho; = <b className="tnum">{bottleneck.rho.toFixed(2)}</b>). Its queue grows
                  without bound, so there is no steady state and no latency figure to report.
                </>
              ) : (
                <>
                  <b>{bottleneck.label}</b> has no steady state: it holds a slot while waiting on
                  a dependency that is itself saturated, so its effective service time is
                  unbounded. Fix the station below it first.
                </>
              )
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
          <Metric
            label={preview.meanIsLowerBound ? "mean latency (≥)" : "mean latency"}
            value={ms(preview.endToEndMeanMs)}
          />
          {preview.endToEndP99Ms !== null ? (
            <Metric label="p99 latency" value={ms(preview.endToEndP99Ms)} />
          ) : (
            <Metric label="p99 latency" value="—" tone="muted" title={preview.p99Reason ?? ""} />
          )}
          <Metric label="throughput" value={preview.throughputPerSec.toFixed(0)} unit="/s" />
        </div>
      )}

      {/*
        A saturated async queue does not slow requests down, so it cannot be folded
        into the stability verdict -- but it is a real outage in progress and gets
        its own callout.
      */}
      {/*
        Non-convergence of the retry fixed point is not a numerical nuisance: it IS
        the storm. Retries raise load, load raises failures, failures raise retries,
        and when that loop has positive gain there is no steady state to report.
      */}
      {!preview.converged && (
        <div className="verdict crit">
          <div className="verdict-title">retry feedback has no fixed point</div>
          <div className="verdict-body">
            Each round of retries causes more failures than it recovers, so predicted load
            diverges after {preview.iterations} iterations. That divergence is a retry storm.
            A retry budget is the fix; more capacity is not.
          </div>
        </div>
      )}

      {preview.converged && preview.retryStormWarning && (
        <div className="verdict bad">
          <div className="verdict-title">retries will amplify load</div>
          <div className="verdict-body">{preview.retryStormWarning}</div>
        </div>
      )}

      {preview.asyncBacklogWarning && (
        <div className="verdict crit">
          <div className="verdict-title">async backlog will grow without bound</div>
          <div className="verdict-body">{preview.asyncBacklogWarning}</div>
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

/** Component-specific measured detail, chosen per kind. */
function ComponentDetail({ node }: { node: NodeResult }) {
  if (node.cache) {
    const c = node.cache;
    return (
      <>
        <div className="station-detail tnum">
          hit ratio <b>{pct(c.hitRatio)}</b> · {num(c.hits)} hits / {num(c.misses)} misses ·{" "}
          {num(c.residentKeys)} keys resident
        </div>
        <div className="station-detail tnum dim">
          {num(c.evictions)} evictions · {num(c.expirations)} expirations
        </div>
        <Chart series={c.hitRatioSeries} height={64} color="#ec6ca0" yLabel="hit" />
      </>
    );
  }

  if (node.database) {
    const d = node.database;
    const poolBinding = d.poolSize < d.parallelism;
    return (
      <>
        <div className="station-detail tnum">
          pool {d.poolSize} at <b>{pct(d.poolUtilization)}</b> · execution {d.parallelism} at{" "}
          <b>{pct(d.executionUtilization)}</b>
        </div>
        <div className="station-detail tnum dim">
          waits: pool {ms(d.avgPoolWaitMs)} · execution {ms(d.avgExecutionWaitMs)} · ceiling{" "}
          {d.maxThroughputPerSec.toFixed(0)}/s
        </div>
        <p className="note">
          {poolBinding ? (
            <>
              The pool ({d.poolSize}) is below execution parallelism ({d.parallelism}), so
              connections are the constraint. Raising the pool will raise throughput.
            </>
          ) : (
            <>
              Throughput is capped at <b>{d.maxThroughputPerSec.toFixed(0)}/s</b> by execution
              parallelism, not by the pool. Raising the pool past {d.parallelism} moves waiting
              from pool to execution and changes nothing else.
            </>
          )}
        </p>
      </>
    );
  }

  if (node.queue) {
    const q = node.queue;
    const growing = q.backlogGrowthPerSec > 0.05;
    return (
      <>
        <div className="station-detail tnum">
          backlog avg <b>{num(q.avgBacklog)}</b> / max {num(q.maxBacklog)} · age p50{" "}
          {ms(q.backlogAge.p50)} / p99 {ms(q.backlogAge.p99)}
        </div>
        <div className="station-detail tnum dim">
          {q.consumers} consumers at {pct(q.consumerUtilization)} · drain{" "}
          {q.drainCapacityPerSec.toFixed(0)}/s · {num(q.enqueued)} in / {num(q.consumed)} out
          {q.dropped > 0 && ` · ${num(q.dropped)} dropped`}
        </div>
        {growing && (
          <p className="note warn">
            Backlog growing {q.backlogGrowthPerSec.toFixed(1)}/s. Nothing in the request
            percentiles reflects this, because publishing returns immediately.
          </p>
        )}
        <Chart series={q.backlogSeries} height={72} color="#6cb33e" yLabel="backlog" />
      </>
    );
  }

  if (node.loadbalancer) {
    const lb = node.loadbalancer;
    return (
      <>
        <div className="station-detail tnum">
          {lb.algorithm} · {num(lb.dispatched)} dispatched · worst spread ±
          {lb.worstImbalancePct.toFixed(1)}pp
        </div>
        <div className="station-detail tnum dim">
          {lb.perBackend.map((b) => `${b.label} ${b.sharePct.toFixed(1)}%`).join(" · ")}
        </div>
        {lb.healthCheckEnabled && (
          <>
            {lb.perBackend
              .filter((b) => b.ejections > 0)
              .map((b) => (
                <div className="station-detail tnum warn" key={b.nodeId}>
                  {b.label} ejected {b.ejections}× · {pct(b.ejectedFraction)} of the window ·{" "}
                  {pct(b.failureRate)} failing when ejected
                </div>
              ))}
            {lb.ejectionsWithheld > 0 && (
              <p className="note warn">
                {num(lb.ejectionsWithheld)} ejections withheld to stay within the capacity cap.
                Under a shared failure every backend looks unhealthy at once, and ejecting them
                all would remove the capacity that was still partly working.
              </p>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div className="station-detail tnum">
        c={node.capacity} · queue avg {node.avgQueueLength.toFixed(2)} / max {node.maxQueueLength} ·
        wait {ms(node.avgWaitMs)}
        {node.shed > 0 && ` · shed ${num(node.shed)}`}
      </div>
      {node.residencyMs.count > 0 && node.residencyMs.mean > node.serviceMeanMs * 1.5 && (
        <div className="station-detail tnum dim">
          residency {ms(node.residencyMs.mean)} against {ms(node.serviceMeanMs)} of own work — this
          station holds its slot while waiting on dependencies
        </div>
      )}
      <Chart series={node.queueLengthSeries} height={64} color="#7b51a1" yLabel="queue" />
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
  const stations = result.nodes.filter((n) => n.kind !== "client");
  const policyEdges = result.edges.filter((e) => e.hasPolicy && e.calls > 0);

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

      {result.stability.retryStormWarning && (
        <div className="verdict crit">
          <div className="verdict-title">retry amplification</div>
          <div className="verdict-body">{result.stability.retryStormWarning}</div>
        </div>
      )}

      {result.stability.asyncBacklogWarning && (
        <div className="verdict crit">
          <div className="verdict-title">async backlog growing — invisible in every percentile</div>
          <div className="verdict-body">{result.stability.asyncBacklogWarning}</div>
        </div>
      )}

      {failedInvariants.length > 0 && (
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

      {/*
        Per-class results. A blended percentile hides both a fast path and a slow
        one, which is precisely what the legacy engine's single number did.
      */}
      {result.classes.length > 1 && (
        <>
          <div className="section">request classes</div>
          {result.classes.map((c) => (
            <div className="class-row" key={c.classId}>
              <div className="class-head">
                <span>{c.label}</span>
                <span className="tnum">{pct(c.share)} of traffic</span>
              </div>
              <div className="class-detail tnum">
                {c.throughputPerSec.toFixed(0)}/s · p50 {ms(c.latency.p50)} · p99{" "}
                {ms(c.latency.p99)} · {c.errors.ratePct.toFixed(2)}% errors
              </div>
            </div>
          ))}
          <p className="note">
            The blended p99 above sits between these. Reporting only the blend hides both
            the fast path and the slow one.
          </p>
        </>
      )}

      {result.errors.total > 0 && (
        <>
          <div className="section">error breakdown</div>
          <div className="metrics four">
            <Metric label="error" value={num(result.errors.error)} />
            <Metric label="timeout" value={num(result.errors.timeout)} />
            <Metric label="shed" value={num(result.errors.shed)} />
            <Metric label="network" value={num(result.errors.network)} />
            <Metric label="queue full" value={num(result.errors.queueFull)} />
            <Metric label="circuit open" value={num(result.errors.circuitOpen)} />
            <Metric label="bulkhead" value={num(result.errors.bulkheadFull)} />
          </div>
        </>
      )}

      {policyEdges.length > 0 && (
        <>
          <div className="section">
            calls &amp; failure policies
            <span className="section-tag">
              {result.retryAmplification.toFixed(2)}&times; system-wide
            </span>
          </div>
          {policyEdges.map((e) => {
            const ampTone =
              e.amplification > 1.5 ? "bad" : e.amplification > 1.15 ? "warn" : "";
            return (
              <div className="class-row" key={e.edgeId}>
                <div className="class-head">
                  <span>
                    {e.fromLabel} <span className="arrow">&rarr;</span> {e.toLabel}
                  </span>
                  <span className={`tnum ${ampTone}`}>{e.amplification.toFixed(2)}&times;</span>
                </div>
                <div className="class-detail tnum">
                  {num(e.calls)} calls &middot; {num(e.attempts)} attempts &middot; {num(e.retries)}{" "}
                  retries &middot; {num(e.failures)} failed
                </div>
                {(e.budgetRejections > 0 ||
                  e.breakerTrips > 0 ||
                  e.bulkheadRejections > 0) && (
                  <div className="class-detail tnum dim">
                    {e.budgetRejections > 0 && `${num(e.budgetRejections)} budget-capped `}
                    {e.breakerTrips > 0 &&
                      `· breaker tripped ${e.breakerTrips}× (open ${pct(e.breakerOpenFraction)}) `}
                    {e.bulkheadRejections > 0 && `· ${num(e.bulkheadRejections)} bulkhead-rejected`}
                  </div>
                )}
                {e.bulkheadUtilization !== null && (
                  <div className="class-detail tnum dim">
                    bulkhead {pct(e.bulkheadUtilization)} busy &middot; outstanding calls avg{" "}
                    {e.avgConcurrency.toFixed(1)}
                  </div>
                )}
              </div>
            );
          })}
          <p className="note">
            Amplification is attempts over calls. Each tier multiplies, so three layers
            retrying three times is 27&times; &mdash; which is why a budget matters more than
            the attempt count.
          </p>
        </>
      )}

      <div className="section">stations</div>
      {stations.map((n) => (
        <div className="station-row" key={n.nodeId}>
          <div className="station-head">
            <span>
              {n.label} <span className="station-kind">{n.kind}</span>
            </span>
            <span
              className={`tnum ${
                n.utilization >= 0.85 ? "bad" : n.utilization >= 0.7 ? "warn" : ""
              }`}
            >
              {pct(n.utilization)} busy
            </span>
          </div>
          <ComponentDetail node={n} />
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

      <AnalyzerPanel />
    </aside>
  );
}
