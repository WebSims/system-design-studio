import { useState } from "react";
import type { EligibilityDecision, PortfolioResult } from "@sds/schema";
import { useStudyStore } from "../study/store";
import { compareDesignTopology, type EdgeDelta, type NodeDelta } from "../topology";

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
                    Refresh
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

        <ArchitectureDelta />

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

function ArchitectureDelta() {
  const study = useStudyStore((state) => state.study);
  const [baseChoice, setBaseChoice] = useState("");
  const [headChoice, setHeadChoice] = useState("");
  if (study.candidates.length < 2) return null;

  const candidateIds = new Set(study.candidates.map((candidate) => candidate.id));
  const defaultBaseId =
    study.promotedCandidateId && candidateIds.has(study.promotedCandidateId)
      ? study.promotedCandidateId
      : study.candidates[0]!.id;
  const baseId = candidateIds.has(baseChoice) ? baseChoice : defaultBaseId;
  const activeCandidateId = study.activeCandidateId;
  const defaultHeadId =
    activeCandidateId !== null &&
    activeCandidateId !== baseId &&
    candidateIds.has(activeCandidateId)
      ? activeCandidateId
      : (study.candidates.find((candidate) => candidate.id !== baseId)?.id ?? baseId);
  const headId = candidateIds.has(headChoice) && headChoice !== baseId ? headChoice : defaultHeadId;
  const base = study.candidates.find((candidate) => candidate.id === baseId)!;
  const head = study.candidates.find((candidate) => candidate.id === headId)!;
  const delta = compareDesignTopology(base.design, head.design);
  const changes = [...delta.nodes, ...delta.edges];
  const summary = [
    { label: "nodes added", value: delta.summary.nodesAdded, tone: "added" },
    { label: "nodes removed", value: delta.summary.nodesRemoved, tone: "removed" },
    { label: "nodes configured", value: delta.summary.nodesChanged, tone: "changed" },
    { label: "nodes moved", value: delta.summary.nodesMoved, tone: "moved" },
    { label: "links added", value: delta.summary.edgesAdded, tone: "added" },
    { label: "links removed", value: delta.summary.edgesRemoved, tone: "removed" },
    { label: "links configured", value: delta.summary.edgesChanged, tone: "changed" },
  ];

  return (
    <section className="section architecture-delta">
      <header className="section-head">
        <div>
          <h2>architecture delta</h2>
          <p className="section-subtitle">See what structurally changed before comparing outcomes.</p>
        </div>
      </header>

      <div className="delta-pickers">
        <label>
          <span>From</span>
          <select
            className="input"
            value={baseId}
            onChange={(event) => {
              setBaseChoice(event.target.value);
              if (event.target.value === headId) setHeadChoice("");
            }}
          >
            {study.candidates
              .filter((candidate) => candidate.id !== headId || study.candidates.length === 2)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} · r{candidate.revision}
                </option>
              ))}
          </select>
        </label>

        <span className="delta-arrow" aria-hidden="true">
          →
        </span>

        <label>
          <span>To</span>
          <select className="input" value={headId} onChange={(event) => setHeadChoice(event.target.value)}>
            {study.candidates
              .filter((candidate) => candidate.id !== baseId)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} · r{candidate.revision}
                </option>
              ))}
          </select>
        </label>
      </div>

      <div className="delta-summary" aria-label="Architecture change counts">
        {summary.map((item) => (
          <div key={item.label} className={`delta-metric delta-${item.tone}`}>
            <strong className="tnum">{item.value}</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      {!delta.comparable && (
        <p className="delta-warning">
          These candidates share no stable component IDs. Additions and removals are exact, but the
          studio cannot pair components to claim that one was changed or moved.
        </p>
      )}

      {changes.length === 0 ? (
        <p className="delta-empty">The authored topology and component settings are identical.</p>
      ) : (
        <details className="delta-details" open={changes.length <= 8}>
          <summary>
            Inspect {changes.length} authored {changes.length === 1 ? "change" : "changes"}
          </summary>
          <ul className="delta-changes">
            {changes.map((change) => (
              <li key={`${change.kind}:${change.id}`}>
                <span className={`delta-token delta-${change.status}`} aria-hidden="true">
                  {deltaToken(change.status)}
                </span>
                <span>
                  <strong>{change.kind === "node" ? change.label : `${change.from} → ${change.to}`}</strong>
                  <small>{describeDelta(change)}</small>
                </span>
                <code>{change.id}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="delta-limit">
        Exact-ID authored delta only. It does not infer runtime impact, risk, causality, or which
        design is better.
      </p>
    </section>
  );
}

function deltaToken(status: NodeDelta["status"] | EdgeDelta["status"]): string {
  if (status === "added") return "+";
  if (status === "removed") return "−";
  if (status === "moved") return "↔";
  return "~";
}

function describeDelta(change: NodeDelta | EdgeDelta): string {
  if (change.status === "added") return `${change.kind} added`;
  if (change.status === "removed") return `${change.kind} removed`;
  if (change.kind === "node") {
    const parts = [
      change.changedFields.length > 0
        ? `changed ${change.changedFields.map(readableField).join(", ")}`
        : "",
      change.moved ? "moved on canvas" : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  return `changed ${change.changedFields.map(readableField).join(", ")}`;
}

function readableField(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
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
