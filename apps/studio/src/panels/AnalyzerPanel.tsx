import type { Finding, Severity } from "@sds/analyze";
import { useStudio } from "../store";

/**
 * THE ANALYZER PANEL
 *
 * The part of the tool that answers questions rather than reporting measurements.
 *
 * It runs on demand, not on every edit, because an analysis is hundreds of
 * simulations: a knee search, two probes per parameter, and a config search. That
 * it can run at all in a couple of seconds is the whole return on making the
 * engine headless.
 *
 * Two presentation rules, mirroring the engine's:
 *
 *   Every finding shows the numbers behind it, so a reader can disagree.
 *   Every recommendation names values, so a reader can act.
 */

const ms = (v: number | null | undefined): string =>
  v == null || !isFinite(v) ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`;

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

const fmtNum = (v: number): string =>
  Number.isInteger(v) ? v.toLocaleString() : v.toFixed(v < 10 ? 2 : 1);

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "critical",
  warning: "warning",
  info: "note",
};

function FindingCard({ finding }: { finding: Finding }) {
  const select = useStudio((s) => s.select);
  return (
    <div className={`finding sev-${finding.severity}`}>
      <div className="finding-head">
        <span className="finding-sev">{SEVERITY_LABEL[finding.severity]}</span>
        <span className="finding-title">{finding.title}</span>
      </div>
      <div className="finding-row">
        <span className="finding-tag">evidence</span>
        <span>{finding.evidence}</span>
      </div>
      <div className="finding-row">
        <span className="finding-tag fix">fix</span>
        <span>{finding.remediation}</span>
      </div>
      {(finding.nodeId || finding.edgeId) && (
        <button
          className="btn small finding-jump"
          onClick={() =>
            select(
              finding.nodeId
                ? { kind: "node", id: finding.nodeId }
                : { kind: "edge", id: finding.edgeId! }
            )
          }
        >
          inspect
        </button>
      )}
    </div>
  );
}

export function AnalyzerPanel() {
  const analysis = useStudio((s) => s.analysis);
  const analysing = useStudio((s) => s.analysing);
  const stale = useStudio((s) => s.analysisStale);
  const analyze = useStudio((s) => s.analyze);
  const loadDesign = useStudio((s) => s.loadDesign);
  const issues = useStudio((s) => s.issues);

  const blocked = issues.some((i) => i.severity === "error");

  return (
    <>
      <div className="section">
        analyzer
        {analysis && (
          <span className="section-tag">
            {(analysis.report.result ? 1 : 0) +
              analysis.knee.simulations +
              analysis.sensitivity.simulations +
              (analysis.configSearch?.simulations ?? 0)}{" "}
            simulations in {(analysis.wallMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      <button className="btn primary run" onClick={analyze} disabled={analysing || blocked}>
        {analysing ? "analysing…" : analysis ? "re-run analysis" : "analyse design"}
      </button>

      {!analysis && !analysing && (
        <p className="note">
          Runs hundreds of simulations to answer where the design breaks, which parameter
          matters, and what the smallest change is that meets the SLO. A few seconds.
        </p>
      )}

      {analysis && stale && (
        <p className="note warn">
          The design changed after this analysis. Re-run it before acting on anything below.
        </p>
      )}

      {analysis && (
        <>
          <p className="note">
            <b>{analysis.report.summary}</b>
          </p>

          {/* ---- where it breaks ---- */}
          <div className="section">where it breaks</div>
          {analysis.knee.unavailableReason ? (
            <p className="note warn">{analysis.knee.unavailableReason}</p>
          ) : (
            <>
              <div className="metrics">
                <div className="metric">
                  <div
                    className={`metric-value tnum ${
                      analysis.knee.headroomFraction < 0
                        ? "bad"
                        : analysis.knee.headroomFraction < 0.2
                          ? "warn"
                          : "ok"
                    }`}
                  >
                    {analysis.knee.maxRatePerSec.toFixed(0)}
                    <span className="metric-unit">/s</span>
                  </div>
                  <div className="metric-label">holds up to</div>
                </div>
                <div className="metric">
                  <div
                    className={`metric-value tnum ${
                      analysis.knee.headroomFraction < 0 ? "bad" : "ok"
                    }`}
                  >
                    {analysis.knee.headroomFraction >= 0 ? "+" : ""}
                    {(analysis.knee.headroomFraction * 100).toFixed(0)}
                    <span className="metric-unit">%</span>
                  </div>
                  <div className="metric-label">
                    {analysis.knee.headroomFraction >= 0 ? "headroom" : "over capacity"}
                  </div>
                </div>
              </div>
              <p className="note">
                Currently offered <b className="tnum">{analysis.knee.currentRatePerSec.toFixed(0)}/s</b>.
                {analysis.knee.breach && (
                  <>
                    {" "}
                    First thing to give way is <b>{analysis.knee.breach}</b>
                    {analysis.knee.firstFailingRatePerSec !== null && (
                      <>
                        , at{" "}
                        <b className="tnum">
                          {analysis.knee.firstFailingRatePerSec.toFixed(0)}/s
                        </b>
                      </>
                    )}
                    .
                  </>
                )}{" "}
                {analysis.knee.precisionNote}
              </p>
              {analysis.knee.nonMonotonic && (
                <p className="note warn">
                  A lower rate also failed, so this boundary is not really a boundary. That
                  usually means load shedding: at a higher rate more work is rejected, and the
                  requests that survive can be faster.
                </p>
              )}
            </>
          )}

          {/* ---- where the latency goes ---- */}
          {analysis.report.criticalPath && (
            <>
              <div className="section">
                where the latency goes
                <span className="section-tag">
                  mean {ms(analysis.report.criticalPath.endToEndMeanMs)}
                </span>
              </div>
              {analysis.report.criticalPath.contributions.slice(0, 8).map((c) => (
                <div className="attrib" key={`${c.kind}:${c.id}`}>
                  <div className="attrib-head">
                    <span>
                      {c.label}
                      {c.kind === "network" && <span className="station-kind">network</span>}
                    </span>
                    <span className="tnum">{pct(c.share)}</span>
                  </div>
                  <div className="attrib-bar">
                    <div
                      className={`attrib-fill ${c.kind === "network" ? "net" : ""}`}
                      style={{ width: `${Math.max(1, c.share * 100)}%` }}
                    />
                  </div>
                  <div className="attrib-detail tnum">
                    {ms(c.totalMs)} = {c.visitsPerRequest.toFixed(2)} visits &times;{" "}
                    {ms(c.perVisitMs)}
                    {c.queueShare > 0.05 && ` · ${pct(c.queueShare)} of that is queueing`}
                  </div>
                </div>
              ))}
              <p className="note">
                Residual{" "}
                <b className="tnum">
                  {(analysis.report.criticalPath.residualFraction * 100).toFixed(1)}%
                </b>
                . The mean decomposes exactly, so a large residual would mean these shares
                cannot be trusted. <b>p99 is not attributed:</b>{" "}
                {analysis.report.criticalPath.p99Reason}
              </p>
              {analysis.report.criticalPath.caveat && (
                <p className="note warn">{analysis.report.criticalPath.caveat}</p>
              )}
            </>
          )}

          {/* ---- which knob matters ---- */}
          <div className="section">
            which knob matters
            <span className="section-tag">
              each improved {pct(analysis.sensitivity.perturbation)}
            </span>
          </div>
          {analysis.sensitivity.results.slice(0, 6).map((r) => {
            const meaningful = r.improvementMs > analysis.sensitivity.baseP99Ms * 0.02;
            return (
              <div className="knob-row" key={r.knobId}>
                <div className="knob-head">
                  <span>{r.label}</span>
                  <span className={`tnum ${meaningful ? "ok" : ""}`}>
                    {r.improvementMs >= 0 ? "−" : "+"}
                    {ms(Math.abs(r.improvementMs))}
                  </span>
                </div>
                <div className="knob-detail tnum">
                  {fmtNum(r.baseValue)} &rarr; {fmtNum(r.improvedValue)} · p99{" "}
                  {ms(r.baseP99Ms)} &rarr; {ms(r.improvedP99Ms)}
                  {r.elasticity !== null && ` · elasticity ${r.elasticity.toFixed(2)}`}
                  {r.fixesSlo && " · fixes the SLO on its own"}
                </div>
              </div>
            );
          })}
          <p className="note">
            Measured, not reasoned about: each parameter is perturbed and the design
            re-simulated with an identical arrival sequence, so the difference is
            attributable to the parameter. Elasticity is signed by the parameter, not by
            whether it helped &mdash; raising concurrency lowers p99 (negative), lowering
            service time also lowers p99 (positive).
          </p>
          {analysis.sensitivity.notes.map((n) => (
            <p className="note warn" key={n}>
              {n}
            </p>
          ))}

          {/* ---- smallest change ---- */}
          {analysis.configSearch && (
            <>
              <div className="section">smallest change that meets the SLO</div>
              {!analysis.configSearch.found ? (
                <p className="note warn">{analysis.configSearch.reason}</p>
              ) : analysis.configSearch.changes.length === 0 ? (
                <p className="note">No changes needed.</p>
              ) : (
                <>
                  {analysis.configSearch.changes.map((c) => (
                    <div className="knob-row" key={c.knobId}>
                      <div className="knob-head">
                        <span>{c.label}</span>
                        <span className="tnum ok">
                          {fmtNum(c.from)} &rarr; {fmtNum(c.to)}
                        </span>
                      </div>
                      <div className="knob-detail tnum">{c.factor.toFixed(1)}&times;</div>
                    </div>
                  ))}
                  <p className="note">
                    p99 <b className="tnum">{ms(analysis.configSearch.beforeP99Ms)}</b> &rarr;{" "}
                    <b className="tnum">{ms(analysis.configSearch.afterP99Ms)}</b>. Minimal in one
                    step: dialling any single change back breaks the SLO again. There is no cost
                    model in this build, so this is the smallest <i>set</i> of changes, not the
                    cheapest &mdash; and it only searches capacity, because "make the code faster"
                    is not a configuration.
                  </p>
                  <button
                    className="btn"
                    onClick={() => loadDesign(analysis.configSearch!.design)}
                  >
                    apply this configuration
                  </button>
                </>
              )}
              {analysis.configSearch.notes.map((n) => (
                <p className="note" key={n}>
                  {n}
                </p>
              ))}
            </>
          )}

          {/* ---- findings ---- */}
          <div className="section">
            findings
            <span className="section-tag">{analysis.report.findings.length}</span>
          </div>
          {analysis.report.findings.length === 0 ? (
            <p className="note">Nothing to report.</p>
          ) : (
            analysis.report.findings.map((f) => <FindingCard finding={f} key={f.id} />)
          )}
        </>
      )}
    </>
  );
}
