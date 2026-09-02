import type { BusinessSummary, Interval, PerformanceSummary } from "@sds/schema";
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

  // Says what to do, not just what is missing. "no candidate" is accurate and leaves the reader
  // to guess which of four views fixes it.
  if (!active) {
    return (
      <div className="view">
        <p className="muted">Ask Codex to create a candidate first.</p>
      </div>
    );
  }

  const p = evaluation?.performance ?? null;
  const b = evaluation?.business ?? null;

  return (
    <div className="view view-performance">
      <div className="view-main">
        <section className="section">
          <header className="section-head">
            <h2>performance</h2>
            {running ? (
              <button className="btn" onClick={cancel}>
                cancel
              </button>
            ) : (
              <button className="btn primary" onClick={() => void evaluate(active.id)}>
                measure over {study.workload.seeds.length} seeds
              </button>
            )}
          </header>

          <p className="muted">
            {active.label} \u00b7 {study.workload.durationSec}s \u00b7 {study.workload.seeds.length} seeds
          </p>

          {running && <p className="muted">running {study.workload.seeds.length} replications\u2026</p>}
          {!p && !running && (
            <p className="muted">Not measured yet. Results use 95% intervals.</p>
          )}

          {p && <PerformanceTable performance={p} slo={study.targets.slo} />}
        </section>

        {b && <BusinessTable business={b} study={study} />}

        {evaluation && evaluation.warnings.length > 0 && (
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
                  <span className="muted">\u2014</span>
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
                    <span className="muted">\u2014</span>
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
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null));
  const r = evaluation?.resources;

  return (
    <section className="section">
      <header className="section-head">
        <h2>resources</h2>
      </header>
      <p className="muted">
        Physical units only. No prices: a price is a claim about a vendor's rate card that this tool
        cannot check, and multiplying a guessed rate by a simulated hour would produce its most
        confident-looking and least defensible number.
      </p>

      {!r ? (
        <p className="muted">not measured yet</p>
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
              unknown, not zero. Measure {r.unmeasuredNodes.join(", ")} to bring{" "}
              {r.unknownAxes.join(", ")} into the comparison. Treating a missing figure as zero would
              let an unmeasured design win on cost.
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
