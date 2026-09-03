import type { NodeResult, RunResult } from "@sds/core";
import type { DesignPreview } from "@sds/analytic";
import { performanceCalibration } from "@sds/schema";
import { useStudio } from "../store";
import { useStudyStore } from "../study/store";
import { AnalyzerPanel } from "./AnalyzerPanel";
import { Chart } from "./Chart";
import { Transport } from "./Transport";

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
        instant estimate <span className="section-tag">closed form</span>
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

  if (node.connections) {
    const c = node.connections;
    const holdsSockets = c.capacity > 1;
    return (
      <>
        {holdsSockets && (
          <>
            <div className="station-detail tnum">
              connections{" "}
              <b className={c.utilization >= 0.85 ? "bad" : c.utilization >= 0.7 ? "warn" : ""}>
                {num(c.avgHeld)} / {num(c.capacity)}
              </b>{" "}
              ({pct(c.utilization)}) · peak {num(c.peakHeld)} · {c.memoryMb.toFixed(0)} MB
            </div>
            <div className="station-detail tnum dim">
              accepts {c.acceptRatePerSec.toFixed(1)}/s at p99 {ms(c.acceptLatency.p99)} ·{" "}
              {num(c.closed)} closed
              {c.droppedByFault > 0 && ` (${num(c.droppedByFault)} by fault)`}
            </div>
          </>
        )}
        {c.refused > 0 && (
          <p className="note warn">
            <b>{num(c.refused)} connections refused.</b> A refused connection is a hard failure,
            not a slow response: the user gets nothing at all.
          </p>
        )}
        {c.pushes > 0 && (
          <div className="station-detail tnum">
            pushes <b>{c.pushRatePerSec.toFixed(0)}/s</b> · delivery p50 {ms(c.pushLatency.p50)} /
            p99 {ms(c.pushLatency.p99)} · work pool {pct(c.workUtilization)} busy
          </div>
        )}
        {holdsSockets && (
          <Chart series={c.connectionSeries} height={72} color="#f5c518" yLabel="conns" />
        )}
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

      {/*
        Time-varying load has no steady state, so the aggregate percentiles below
        average across regimes that never coexisted. The figure to read is the first
        breach and the time series.
      */}
      {!result.steadyState && (
        <div className={`verdict ${result.firstBreach ? "bad" : "ok"}`}>
          <div className="verdict-title">
            {result.firstBreach
              ? `SLO first broke at ${result.firstBreach.offeredRatePerSec.toFixed(0)}/s`
              : "load varied, and the SLO held throughout"}
          </div>
          <div className="verdict-body">
            {result.firstBreach && (
              <>
                {result.firstBreach.atSec.toFixed(0)}s into the run, on{" "}
                <b>{result.firstBreach.breach}</b>. That is the capacity limit this run found. A
                ramp reads slightly high, because queues take time to fill and the system is
                always catching up with a load that has already moved on.{" "}
              </>
            )}
            {result.aggregateCaveat}
          </div>
        </div>
      )}

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
          <div className="verdict-title">simulator self-check failed — do not trust these numbers</div>
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

      {/*
        Realtime headline figures. Connections held answers "how many users", and
        fan-out explains why the delivery cost bears no relation to the message rate.
      */}
      {(result.connectionsHeld > 0 || result.largestFanout > 1) && (
        <>
          <div className="section">realtime</div>
          <div className="metrics">
            {result.connectionsHeld > 0 && (
              <Metric
                label="connections held"
                value={num(result.connectionsHeld)}
                tone={result.connectionsRefused > 0 ? "bad" : "ok"}
              />
            )}
            {result.connectionsRefused > 0 && (
              <Metric label="refused" value={num(result.connectionsRefused)} tone="bad" />
            )}
            {result.largestFanout > 1 && (
              <>
                <Metric label="largest fan-out" value={`${result.largestFanout}×`} />
                <Metric
                  label="calls per message"
                  value={result.callsPerMessage.toFixed(1)}
                  title="total downstream traversals per message, across every hop"
                />
              </>
            )}
          </div>
          {result.largestFanout > 1 && (
            <p className="note">
              One message becomes <b className="tnum">{result.largestFanout}</b> deliveries, so the
              write path costs {result.largestFanout}× what the message rate suggests. Room size is
              a product decision that is also a capacity decision, and it rarely appears in one.
            </p>
          )}
        </>
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
      <p className={`note ${result.steadyState ? "" : "warn"}`}>
        Mean {ms(result.endToEnd.mean)}, max {ms(result.endToEnd.max)}, over{" "}
        <b className="tnum">{result.endToEnd.count.toLocaleString()}</b> requests. Percentiles carry
        up to {(result.endToEnd.relativeError * 100).toFixed(1)}% bucketing error.
        {!result.steadyState &&
          " Because load varied, these span more than one regime — read the time series above instead."}
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

      {!result.steadyState && (
        <>
          <div className="section">offered load over time</div>
          <Chart series={result.offeredRateSeries} color="#4ab4e6" yLabel="req/s" />
        </>
      )}

      <div className="section">throughput over time</div>
      <Chart series={result.throughputSeries} color="#2aa8a8" yLabel="req/s" />

      <div className="section">p99 latency over time</div>
      <Chart
        series={result.latencyP99Series}
        color="#f08d2c"
        yLabel="ms"
        threshold={slo.p99LatencyMs}
      />

      <div className="section">simulator self-checks</div>
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
  const study = useStudyStore((s) => s.study);
  const active =
    study.candidates.find((candidate) => candidate.id === study.activeCandidateId) ??
    study.candidates[0];
  const calibration = active ? performanceCalibration(study, active) : null;
  const uncalibrated = calibration !== null && !calibration.calibrated;

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

      {uncalibrated ? (
        <div className="verdict verdict-warn">
          <div className="verdict-title">performance not calibrated</div>
          <div className="verdict-body">{calibration?.message}</div>
          <div className="verdict-body">
            The canvas shows ?ms and withholds utilization, latency, throughput, scenarios and
            recommendations. Correctness search is still available in Behaviour.
          </div>
        </div>
      ) : (
        <>
          <PreviewPanel preview={preview} />

          <button className="btn primary run" onClick={execute} disabled={running || blocking.length > 0}>
            {running ? "Running…" : "Run simulation"}
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
                Run a simulation for tail latency, queue behavior, and trace playback.
              </p>
            )
          )}

          <AnalyzerPanel />
        </>
      )}
    </aside>
  );
}
