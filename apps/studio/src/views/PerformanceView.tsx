import { useState } from "react";
import type {
  BusinessSummary,
  Interval,
  PerformanceSummary,
  ProductionScenarioResult,
} from "@sds/schema";
import { performanceCalibration } from "@sds/schema";
import { PRODUCTION_SCENARIO_RECIPES } from "@sds/study";
import { useStudyStore } from "../study/store";

/**
 * The performance view.
 *
 * WHAT IT SHOWS THAT THE OLD RESULTS RAIL DOES NOT
 *
 * Intervals rather than numbers, and business outcomes beside latency. Both are the same point: a
 * single run's p99 is one sample of a random variable, and a design that serves every request in
 * forty milliseconds while overselling three hundred pizzas is not fast, it is broken. Ranking on
 * latency alone would hand the crown to the worst candidate in the shipped portfolio, and it would
 * be right about every number it printed.
 *
 * WHY THERE IS NO CLOSED-FORM ESTIMATE HERE
 *
 * Because a stateful handler's service time depends on which branch it took, and which branch it
 * took depends on the state. The queueing formulas assume it does not. An averaged estimate would be
 * a plausible number with no error bound, displayed next to replicated results that have one -- so it
 * is withheld and the reason is shown instead.
 */
export function PerformanceView() {
  const study = useStudyStore((s) => s.study);
  const active = useStudyStore((s) => s.activeCandidate());
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null));
  const running = useStudyStore((s) => (active ? s.running.has(active.id) : false));
  const evaluate = useStudyStore((s) => s.evaluate);
  const cancel = useStudyStore((s) => s.cancel);

  if (!active) {
    return <div className="dock-empty">Create a version first.</div>;
  }

  const calibration = performanceCalibration(study, active);
  const disabledReason = calibration.calibrated ? null : calibration.message;
  const p = disabledReason ? null : (evaluation?.performance ?? null);
  const b = disabledReason ? null : (evaluation?.business ?? null);

  return (
    <div className="view view-performance load-dock">
      <div className="view-main">
        {disabledReason && (
          <section className="section">
            <div className="verdict verdict-warn">
              <div className="verdict-status">performance not calibrated</div>
              <p className="verdict-claim">
                {disabledReason} Load measurements, scenarios and resource conclusions are withheld;
                correctness remains available in Behaviour.
              </p>
            </div>
          </section>
        )}

        <ProductionSuite
          candidateId={active.id}
          candidateLabel={active.label}
          disabledReason={disabledReason}
        />

        <section className="section">
          <header className="section-head">
            <h2>measured under load</h2>
            {running ? (
              <button className="btn" onClick={cancel}>
                cancel
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={() => void evaluate(active.id)}
                disabled={disabledReason !== null}
                title={disabledReason ?? undefined}
              >
                Run {study.workload.seeds.length} seeds
              </button>
            )}
          </header>

          <p className="muted">
            {active.label} · {study.workload.durationSec}s · {study.workload.seeds.length} seeds
          </p>

          {running && <p className="muted">Running {study.workload.seeds.length} replications…</p>}
          {!p && !running && (
            <p className="muted">
              {disabledReason
                ? "Measurements become available after every component and link has observed performance evidence."
                : "No measurements yet. Results include 95% intervals."}
            </p>
          )}

          {p && <PerformanceTable performance={p} slo={study.targets.slo} />}
        </section>

        {b && <BusinessTable business={b} study={study} />}

        {!disabledReason && evaluation && evaluation.warnings.length > 0 && (
          <section className="section">
            <header className="section-head">
              <h2>caveats</h2>
            </header>
            <ul className="issue-list">
              {evaluation.warnings.map((w, i) => (
                <li key={i} className="issue-warning">
                  {w}
                </li>
              ))}
            </ul>
          </section>
        )}

        {p?.closedFormWithheldReason && (
          <section className="section">
            <header className="section-head">
              <h2>why there is no instant estimate</h2>
            </header>
            <p className="muted">{p.closedFormWithheldReason}</p>
          </section>
        )}
      </div>

      <aside className="view-side">
        <ResourcePanel />
      </aside>
    </div>
  );
}

/**
 * The production-language front door to the engines.
 *
 * A scenario is shown even when it cannot run. That missing workflow, SLO or dependency is itself
 * useful architecture information, and hiding the card would make absence look like safety.
 */
function ProductionSuite({
  candidateId,
  candidateLabel,
  disabledReason,
}: {
  candidateId: string;
  candidateLabel: string;
  disabledReason: string | null;
}) {
  const evaluation = useStudyStore((state) => state.evaluationFor(candidateId));
  const evaluate = useStudyStore((state) => state.evaluate);
  const cancel = useStudyStore((state) => state.cancel);
  const workerRunning = useStudyStore((state) => state.running.has(candidateId));
  const requestFocus = useStudyStore((state) => state.requestFocus);
  const [requested, setRequested] = useState(false);
  const results = disabledReason ? [] : (evaluation?.scenarios ?? []);
  const running = requested && workerRunning;

  const run = async () => {
    setRequested(true);
    try {
      await evaluate(candidateId, { correctness: false, performance: false, scenarios: true });
    } finally {
      setRequested(false);
    }
  };

  // The canvas is always on screen now, so "inspect" pans to the element rather than changing tabs.
  const inspect = (result: ProductionScenarioResult) => {
    if (result.targetNodeId) requestFocus({ kind: "node", id: result.targetNodeId });
    else if (result.targetEdgeId) requestFocus({ kind: "edge", id: result.targetEdgeId });
  };

  const critical = results.filter((result) => result.status === "critical").length;
  const warnings = results.filter((result) => result.status === "warning").length;
  const inconclusive = results.filter((result) => result.status === "inconclusive").length;

  return (
    <section className="section production-suite">
      <header className="section-head production-suite-head">
        <div>
          <h2>production scenarios</h2>
          <p className="section-subtitle">
            Counterfactual tests of the model for {candidateLabel}, not observations from production.
          </p>
        </div>
        {running ? (
          <button className="btn" onClick={cancel}>cancel</button>
        ) : (
          <button
            className="btn primary"
            onClick={() => void run()}
            disabled={workerRunning || disabledReason !== null}
            title={disabledReason ?? undefined}
          >
            {results.length > 0 ? "Run suite again" : "Run production suite"}
          </button>
        )}
      </header>

      {running && <p className="muted" aria-live="polite">Running four deterministic probes in the worker…</p>}
      {disabledReason && (
        <p className="muted">Production scenarios require calibrated timing and capacity inputs.</p>
      )}

      {results.length > 0 && !running && (
        <div className="scenario-rollup" aria-label="Production scenario summary">
          <span>{results.length}/{PRODUCTION_SCENARIO_RECIPES.length} tested</span>
          {critical > 0 && <strong className="scenario-count critical">{critical} critical</strong>}
          {warnings > 0 && <strong className="scenario-count warning">{warnings} warning{warnings === 1 ? "" : "s"}</strong>}
          {inconclusive > 0 && <strong className="scenario-count inconclusive">{inconclusive} inconclusive</strong>}
          {critical + warnings + inconclusive === 0 && <strong className="scenario-count healthy">all healthy in-model</strong>}
        </div>
      )}

      <div className="scenario-grid">
        {PRODUCTION_SCENARIO_RECIPES.map((recipe) => {
          const result = results.find((item) => item.kind === recipe.kind);
          return result ? (
            <ScenarioCard key={recipe.kind} result={result} onInspect={() => inspect(result)} />
          ) : (
            <article className="scenario-card scenario-pending" key={recipe.kind}>
              <header>
                <span className="scenario-icon" aria-hidden="true">◇</span>
                <h3>{recipe.label}</h3>
                <span className="scenario-status">not run</span>
              </header>
              <p>{recipe.description}</p>
            </article>
          );
        })}
      </div>

      <p className="scenario-caveat">
        Result quality follows model quality. Source evidence on the canvas shows what came from
        code and what is still inferred or assumed.
      </p>
    </section>
  );
}

function ScenarioCard({
  result,
  onInspect,
}: {
  result: ProductionScenarioResult;
  onInspect: () => void;
}) {
  const canInspect = result.targetNodeId !== null || result.targetEdgeId !== null;
  return (
    <article className={`scenario-card scenario-${result.status}`}>
      <header>
        <span className="scenario-icon" aria-hidden="true">
          {result.status === "healthy" ? "✓" : result.status === "critical" ? "!" : result.status === "warning" ? "△" : "?"}
        </span>
        <h3>{result.label}</h3>
        <span className="scenario-status">{result.status}</span>
      </header>
      <p className="scenario-summary">{result.summary}</p>
      <div className="scenario-proof">
        <span>measured evidence</span>
        <p>{result.evidence}</p>
      </div>
      <div className="scenario-action">
        <span>next move</span>
        <p>{result.recommendation}</p>
      </div>
      <footer>
        {canInspect && <button className="btn small" onClick={onInspect}>Inspect target</button>}
        {result.assumptions.length > 0 && (
          <details>
            <summary>{result.assumptions.length} assumption{result.assumptions.length === 1 ? "" : "s"}</summary>
            <ul>
              {result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
          </details>
        )}
      </footer>
    </article>
  );
}

function PerformanceTable({
  performance,
  slo,
}: {
  performance: PerformanceSummary;
  slo: { p99LatencyMs: number | null; maxErrorRatePct: number | null };
}) {
  if (performance.unstable) {
    return (
      <div className="verdict verdict-crit">
        <div className="verdict-status">no steady state</div>
        <p>A queue keeps growing, so latency results are not valid.</p>
      </div>
    );
  }

  const rows: Array<[string, Interval, string, number | null, boolean]> = [
    ["throughput", performance.throughputPerSec, "req/s", null, false],
    ["p50 latency", performance.p50Ms, "ms", null, true],
    ["p99 latency", performance.p99Ms, "ms", slo.p99LatencyMs, true],
    ["error rate", performance.errorRatePct, "%", slo.maxErrorRatePct, true],
    ["busiest station", performance.maxUtilization, "", null, true],
  ];

  return (
    <table className="metrics">
      <thead>
        <tr>
          <th>metric</th>
          <th className="tnum">mean</th>
          <th className="tnum">95% interval</th>
          <th>target</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, interval, unit, target, lowerIsBetter]) => {
          // Judged on the PESSIMISTIC end, matching the eligibility gate. A p99 whose mean is inside
          // the target and whose interval is not has not met the target -- it has a coin flip on
          // meeting it, and the failures are the ones users notice.
          const worst = lowerIsBetter ? interval.high : interval.low;
          const met = target === null ? null : lowerIsBetter ? worst <= target : worst >= target;
          return (
            <tr key={label}>
              <td>{label}</td>
              <td className="tnum">
                {fmt(interval.mean)}
                {unit}
              </td>
              <td className="tnum muted">
                {Number.isFinite(interval.halfWidth)
                  ? `${fmt(interval.low)} \u2013 ${fmt(interval.high)}`
                  : "one seed: no interval"}
              </td>
              <td>
                {target === null ? (
                  <span className="muted">—</span>
                ) : (
                  <span className={met ? "badge badge-ok" : "badge badge-bad"}>
                    {met ? "met" : "missed"} at {target}
                    {unit}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Business outcomes.
 *
 * `oversells` and `duplicateSuccesses` lead, because they are the two that a latency table cannot
 * see and the two that decide whether the design solves the problem. Every one of them returned HTTP
 * 200 to the user.
 */
function BusinessTable({
  business,
  study,
}: {
  business: BusinessSummary;
  study: ReturnType<typeof useStudyStore.getState>["study"];
}) {
  const ORDER: Array<[string, string]> = [
    ["validAllocations", "valid allocations"],
    ["duplicateSuccesses", "duplicate successes"],
    ["oversells", "oversells"],
    ["remainingInventory", "left unclaimed"],
    ["expiredReservations", "expired reservations"],
    ["strandedReservations", "stranded by a crash"],
    ["idempotencyHits", "deduplicated by a unique key"],
    ["transactionConflicts", "transaction conflicts"],
    ["staleOwnerRejections", "writes fenced off"],
    ["redeliveries", "queue redeliveries"],
    ["abandonedMessages", "messages abandoned"],
    ["lockWaitMsP99", "p99 lock wait (ms)"],
    ["timeToExhaustSec", "seconds until sold out"],
  ];

  const goals = new Map(study.targets.businessGoals.map((g) => [g.metric as string, g]));

  return (
    <section className="section">
      <header className="section-head">
        <h2>business outcomes</h2>
      </header>
      <p className="muted">Correct responses can still create bad business outcomes.</p>
      <table className="metrics">
        <thead>
          <tr>
            <th>outcome</th>
            <th className="tnum">mean</th>
            <th className="tnum">95% interval</th>
            <th>goal</th>
          </tr>
        </thead>
        <tbody>
          {ORDER.filter(([key]) => business.metrics[key]).map(([key, label]) => {
            const interval = business.metrics[key]!;
            const goal = goals.get(key);
            const met =
              goal === undefined
                ? null
                : goal.comparison === "<="
                  ? interval.high <= goal.value
                  : goal.comparison === ">="
                    ? interval.low >= goal.value
                    : interval.low >= goal.value && interval.high <= goal.value;
            const bad = key === "oversells" || key === "duplicateSuccesses";
            return (
              <tr key={key} className={bad && interval.mean > 0 ? "row-bad" : ""}>
                <td>{label}</td>
                <td className="tnum">{fmt(interval.mean)}</td>
                <td className="tnum muted">
                  {Number.isFinite(interval.halfWidth)
                    ? `${fmt(interval.low)} \u2013 ${fmt(interval.high)}`
                    : "\u2014"}
                </td>
                <td>
                  {goal === undefined ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className={met ? "badge badge-ok" : "badge badge-bad"}>
                      {met ? "met" : "missed"}: {goal.comparison} {goal.value}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {Object.keys(business.outcomes).length > 0 && (
        <>
          <h3>responses by label</h3>
          <table className="metrics">
            <tbody>
              {Object.entries(business.outcomes).map(([label, interval]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="tnum">{fmt(interval.mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/**
 * Resource totals, with unknowns named rather than zeroed.
 *
 * The panel says which nodes to measure, because "three axes are unknown" is not actionable and
 * "measure the claims store" is.
 */
function ResourcePanel() {
  const active = useStudyStore((s) => s.activeCandidate());
  const study = useStudyStore((s) => s.study);
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null));
  const calibrated = active ? performanceCalibration(study, active).calibrated : true;
  const r = calibrated ? evaluation?.resources : null;

  return (
    <section className="section">
      <header className="section-head">
        <h2>resources</h2>
      </header>
      <p className="muted">
        Hardware units only. Pricing depends on the vendor and is not modeled.
      </p>

      {!r ? (
        <p className="muted">{calibrated ? "not measured yet" : "withheld until calibrated"}</p>
      ) : (
        <>
          <dl className="stat-grid">
            <Axis label="compute units" value={r.cpuUnits} />
            <Axis label="memory (MB)" value={r.memoryMb} />
            <Axis label="storage (MB)" value={r.storageMb} />
            <Axis label="connection slots" value={r.connectionSlots} />
            <Axis label="network (MB)" value={r.networkBytes === null ? null : r.networkBytes / 1e6} />
          </dl>
          {r.unmeasuredNodes.length > 0 && (
            <p className="issue-warning">
              Unknown, not zero. Measure {r.unmeasuredNodes.join(", ")} to compare{" "}
              {r.unknownAxes.join(", ")}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Axis({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value === null ? "muted" : "tnum"}>{value === null ? "unknown" : fmt(value)}</dd>
    </div>
  );
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 10) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}
