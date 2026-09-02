import type { EligibilityDecision, PortfolioResult } from "@sds/schema";
import { useStudyStore } from "../study/store";

/**
 * The compare view.
 *
 * WHAT IT REFUSES TO DO
 *
 * Rank. There is no score, no weighting, no "recommended" badge, and no sort order that implies one.
 * Candidates on the frontier are shown as a set because that is what they are: three defensible
 * answers with different trade-offs, and choosing between them needs an exchange rate between
 * milliseconds and CPU units that nobody has.
 *
 * PROMOTION IS THE ONLY BUTTON WITH AUTHORITY
 *
 * It is here, it is human-only, and no WebMCP tool can reach it. An agent may create, test and
 * argue; the decision stays with a person, and the button is deliberately not the most prominent
 * thing on the screen.
 */
export function CompareView() {
  const study = useStudyStore((s) => s.study);
  const portfolio = useStudyStore((s) => s.portfolio);
  const running = useStudyStore((s) => s.running);
  const evaluateAll = useStudyStore((s) => s.evaluateAll);
  const refresh = useStudyStore((s) => s.refreshPortfolio);
  const cancel = useStudyStore((s) => s.cancel);
  const promote = useStudyStore((s) => s.promote);
  const select = useStudyStore((s) => s.selectCandidate);
  const setView = useStudyStore((s) => s.setView);

  const busy = running.size > 0;

  return (
    <div className="view view-compare">
      <div className="view-main">
        <section className="section">
          <header className="section-head">
            <h2>compare</h2>
            <div className="row-actions">
              {busy ? (
                <button className="btn" onClick={cancel}>
                  cancel ({running.size} running)
                </button>
              ) : (
                <>
                  <button className="btn primary" onClick={() => void evaluateAll()}>
                    Run all
                  </button>
                  <button className="btn" onClick={() => void refresh()}>
                    refresh
                  </button>
                </>
              )}
            </div>
          </header>

          {!portfolio ? (
            <p className="muted">No comparison yet.</p>
          ) : (
            <>
              <p className="lede">{portfolio.claim}</p>
              {portfolio.warnings.map((w, i) => (
                <p key={i} className="issue-warning">
                  {w}
                </p>
              ))}
            </>
          )}
        </section>

        {portfolio && (
          <section className="section">
            <header className="section-head">
              <h2>the gates</h2>
            </header>
            <p className="muted">Candidates must pass all five gates to enter the comparison.</p>

            <div className="gate-grid">
              {portfolio.decisions.map((decision) => (
                <GateCard
                  key={decision.candidateId}
                  decision={decision}
                  portfolio={portfolio}
                  label={study.candidates.find((c) => c.id === decision.candidateId)?.label ?? decision.candidateId}
                  origin={study.candidates.find((c) => c.id === decision.candidateId)?.origin ?? "human"}
                  intent={study.candidates.find((c) => c.id === decision.candidateId)?.intent ?? ""}
                  isPromoted={study.promotedCandidateId === decision.candidateId}
                  busy={running.has(decision.candidateId)}
                  onOpen={() => {
                    select(decision.candidateId);
                    setView("design");
                  }}
                  onInspect={() => {
                    select(decision.candidateId);
                    setView("correctness");
                  }}
                  onPromote={() => promote(decision.candidateId)}
                />
              ))}
            </div>
          </section>
        )}

        {portfolio && portfolio.axes.length > 0 && (
          <section className="section">
            <header className="section-head">
              <h2>axes compared</h2>
            </header>
            <ul className="axis-list">
              {portfolio.axes.map((axis) => (
                <li key={axis.id}>
                  <strong>{axis.label}</strong>{" "}
                  <span className="muted">
                    {axis.lowerIsBetter ? "lower is better" : "higher is better"} ·{" "}
                    {axis.sampled
                      ? "measured with uncertainty, so a difference smaller than the interval is a tie"
                      : "deterministic given the design"}
                  </span>
                </li>
              ))}
            </ul>

            {portfolio.dominated.length > 0 && (
              <>
                <h3>dominance</h3>
                <ul className="axis-list">
                  {portfolio.dominated.map((d, i) => (
                    <li key={i}>
                      {labelOf(study, d.loser)} is dominated by {labelOf(study, d.winner)}, which is
                      strictly better on {d.strictlyBetterOn.join(", ")} and worse on nothing.
                    </li>
                  ))}
                </ul>
              </>
            )}

            {portfolio.ties.length > 0 && (
              <>
                <h3>ties</h3>
                <p className="muted">
                  Indistinguishable within the measured intervals. Reported as ties rather than ranked,
                  because the data is consistent with either being better.
                </p>
                <ul className="axis-list">
                  {portfolio.ties.map(([a, b], i) => (
                    <li key={i}>
                      {labelOf(study, a)} and {labelOf(study, b)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function GateCard({
  decision,
  portfolio,
  label,
  origin,
  intent,
  isPromoted,
  busy,
  onOpen,
  onInspect,
  onPromote,
}: {
  decision: EligibilityDecision;
  portfolio: PortfolioResult;
  label: string;
  origin: string;
  intent: string;
  isPromoted: boolean;
  busy: boolean;
  onOpen: () => void;
  onInspect: () => void;
  onPromote: () => void;
}) {
  const onFrontier = portfolio.frontier.includes(decision.candidateId);

  return (
    <article className={`gate-card ${decision.eligible ? "gate-eligible" : "gate-ineligible"}`}>
      <header>
        <h3>{label}</h3>
        <div className="badges">
          {origin === "agent" && <span className="badge badge-agent">AI draft</span>}
          {origin === "library" && <span className="badge badge-muted">library</span>}
          {isPromoted && <span className="badge badge-ok">chosen</span>}
          {onFrontier && <span className="badge badge-info">frontier</span>}
          {busy && <span className="badge badge-muted">Running…</span>}
        </div>
      </header>

      {intent && <p className="muted intent">{shortIntent(intent)}</p>}

      <ol className="gates">
        {decision.gates.map((gate) => (
          <li key={gate.gate} className={gate.passed ? "gate-pass" : "gate-fail"}>
            <span className="gate-name">{gate.gate.replace(/-/g, " ")}</span>
            <span className="gate-reason">{gate.reason}</span>
          </li>
        ))}
      </ol>

      <footer className="row-actions">
        <button className="btn btn-quiet" onClick={onOpen}>
          Open design
        </button>
        <button className="btn btn-quiet" onClick={onInspect}>
          Evidence
        </button>
        {/*
          Promotion is gated on eligibility AND on being a human click. There is no WebMCP tool that
          reaches this handler, and there should never be one: this is the only action in the product
          that says "we are going with this".
        */}
        <button
          className="btn"
          disabled={!decision.eligible || isPromoted}
          title={
            decision.eligible
              ? "promote this candidate. Human-only: no agent tool can do this."
              : "only an eligible candidate can be promoted"
          }
          onClick={onPromote}
        >
          {isPromoted ? "Chosen" : "Choose"}
        </button>
      </footer>
    </article>
  );
}

function labelOf(study: ReturnType<typeof useStudyStore.getState>["study"], id: string): string {
  return study.candidates.find((c) => c.id === id)?.label ?? id;
}

function shortIntent(intent: string): string {
  const first = intent.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? intent;
  return first.length > 160 ? `${first.slice(0, 157)}\u2026` : first;
}
