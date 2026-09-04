import { useMemo, useState } from "react";
import {
  activeIssueBaselineRevision,
  candidateIssueVerificationStatus,
  issueStatus,
  type EligibilityDecision,
  type PortfolioResult,
} from "@sds/schema";
import { reimportPrompt } from "../codebase-prompt";
import { buildImplementationHandoff } from "../implementation-handoff";
import { baselineAncestor } from "../study/mutations";
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
  const setLens = useStudyStore((s) => s.setLens);
  const setReviewOpen = useStudyStore((s) => s.setReviewOpen);

  const busy = running.size > 0;

  return (
    <div className="view view-compare">
      <div className="view-main">
        <section className="section">
          <header className="section-head">
            <h2>versions</h2>
            <div className="row-actions">
              {busy ? (
                <button className="btn" onClick={cancel}>
                  cancel ({running.size} running)
                </button>
              ) : (
                <>
                  <button className="btn primary" onClick={() => void evaluateAll()}>
                    Run all versions
                  </button>
                  <button className="btn" onClick={() => void refresh()}>
                    Refresh
                  </button>
                </>
              )}
            </div>
          </header>

          {!portfolio ? (
            <p className="muted">No comparison yet. Run all versions to see which pass the rules and how they trade off.</p>
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
        <IssueCandidateMatrix />

        {portfolio && (
          <section className="section">
            <header className="section-head">
              <h2>does each version pass?</h2>
            </header>
            <p className="muted">A version has to pass every check before its numbers are compared with the others.</p>

            <div className="gate-grid">
              {portfolio.decisions.map((decision) => {
                const candidate = study.candidates.find(
                  (item) => item.id === decision.candidateId
                );
                return (
                  <GateCard
                    key={decision.candidateId}
                    decision={decision}
                    portfolio={portfolio}
                    label={candidate?.label ?? decision.candidateId}
                    origin={candidate?.origin ?? "human"}
                    intent={candidate?.intent ?? ""}
                    role={candidate?.role ?? "experiment"}
                    isPromoted={study.promotedCandidateId === decision.candidateId}
                    isApproved={
                      study.approval?.candidateId === decision.candidateId &&
                      study.approval.candidateRevision === candidate?.revision
                    }
                    busy={running.has(decision.candidateId)}
                    onOpen={() => {
                      select(decision.candidateId);
                      setReviewOpen(false);
                    }}
                    onInspect={() => {
                      select(decision.candidateId);
                      setLens("behaviour");
                      setReviewOpen(false);
                    }}
                    onPromote={() => promote(decision.candidateId)}
                  />
                );
              })}
            </div>
          </section>
        )}

        <ImplementationHandoffPanel />

        {portfolio && portfolio.axes.length > 0 && (
          <section className="section">
            <header className="section-head">
              <h2>trade-offs</h2>
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
                <h3>strictly better</h3>
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

const ISSUE_RESULT_MARK = {
  pending: "○",
  passed: "✓",
  failed: "×",
  inconclusive: "?",
  manual: "H",
  "accepted-risk": "≈",
} as const;

function IssueCandidateMatrix() {
  const study = useStudyStore((state) => state.study);
  const verify = useStudyStore((state) => state.verifyCandidateIssue);
  const candidates = useMemo(
    () => study.candidates.filter((candidate) => candidate.issuePlans.length > 0),
    [study.candidates]
  );
  const issueIds = useMemo(
    () => [...new Set(candidates.flatMap((candidate) => candidate.issuePlans.map((plan) => plan.issueId)))],
    [candidates]
  );
  const issues = useMemo(() => new Map(study.issueRegistry.map((issue) => [issue.id, issue])), [study.issueRegistry]);
  if (candidates.length === 0 || issueIds.length === 0) return null;
  const baselineRevision = activeIssueBaselineRevision(study);

  return (
    <section className="section candidate-issue-matrix">
      <header className="section-head">
        <div>
          <h2>issue coverage</h2>
          <p className="section-subtitle">One row per problem, one evidence-pinned result per proposed solution.</p>
        </div>
      </header>
      <div className="matrix-scroll">
        <table>
          <caption className="sr-only">Issue by candidate verification comparison</caption>
          <thead>
            <tr>
              <th scope="col">issue</th>
              {candidates.map((candidate) => <th scope="col" key={candidate.id}>{candidate.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {issueIds.map((issueId) => {
              const issue = issues.get(issueId);
              if (!issue) return null;
              const registryStatus = issueStatus(issue, baselineRevision);
              return (
                <tr key={issueId}>
                  <th scope="row">
                    <span className={`severity-label severity-${issue.severity}`}>{issue.severity}</span>
                    {issue.title}
                  </th>
                  {candidates.map((candidate) => {
                    const plan = candidate.issuePlans.find((item) => item.issueId === issueId);
                    if (!plan) return <td key={candidate.id} className="matrix-empty">—</td>;
                    const checked = candidateIssueVerificationStatus(study, candidate, plan);
                    const status = registryStatus === "accepted-risk" ? "accepted-risk" : checked;
                    return (
                      <td key={candidate.id} className={`matrix-result result-${status}`}>
                        <span className="result-mark" aria-hidden="true">{ISSUE_RESULT_MARK[status]}</span>
                        <strong>{status.replace("-", " ")}</strong>
                        <details>
                          <summary>plan</summary>
                          <p>{plan.hypothesis}</p>
                          <p><b>Verify:</b> {plan.verificationPlan}</p>
                          <p><b>Impact:</b> {plan.expectedArchitectureImpact.summary}</p>
                          {plan.tradeoffs.length > 0 && <p><b>Trade-offs:</b> {plan.tradeoffs.join("; ")}</p>}
                        </details>
                        {status !== "passed" && status !== "manual" && status !== "accepted-risk" && (
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => verify({
                              candidateId: candidate.id,
                              issueId,
                              expectedCandidateRevision: candidate.revision,
                              expectedIssueRevision: issue.revision,
                              status: "manual",
                              authority: "human",
                              notes: "Manually verified by a person in the comparison matrix.",
                            })}
                          >
                            record manual pass
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="matrix-legend">✓ passed · × failed · ? inconclusive · H human verified · ≈ accepted risk · ○ pending</p>
    </section>
  );
}

function ImplementationHandoffPanel() {
  const study = useStudyStore((state) => state.study);
  const releaseApprovalForReimport = useStudyStore((state) => state.releaseApprovalForReimport);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [verifyStep, setVerifyStep] = useState<"idle" | "confirm" | "copied" | "failed">("idle");
  const handoff = buildImplementationHandoff(study);

  if (handoff.status === "blocked") {
    const approvalReady =
      study.approval !== null &&
      !["approval-stale", "evaluation-required", "approval-ineligible"].includes(handoff.code);
    const steps = [
      { label: "Repository snapshot", done: study.activeRepositorySnapshotId !== null },
      { label: "A version that passes the rules is approved", done: approvalReady },
      { label: "Ready to send to the agent", done: false },
    ];
    return (
      <section className="section implementation-handoff handoff-blocked">
        <header className="section-head">
          <div>
            <h2>send to agent</h2>
            <p className="section-subtitle">Turn an approved version into a precise code task for your coding agent.</p>
          </div>
          <span className="badge badge-muted">not ready</span>
        </header>
        <p className="handoff-message">{handoff.message}</p>
        <ol className="handoff-steps" aria-label="Implementation handoff readiness">
          {steps.map((step, index) => (
            <li key={step.label} className={step.done ? "done" : "waiting"}>
              <span aria-hidden="true">{step.done ? "✓" : index + 1}</span>
              {step.label}
            </li>
          ))}
        </ol>
        <p className="handoff-boundary">
          WebMCP can read the finished receipt. It cannot approve a design, edit repository files,
          deploy, or mark the model synchronized.
        </p>
      </section>
    );
  }

  const componentChanges = handoff.delta.nodes.filter(
    (change) => change.implementationRelevant
  ).length;
  const approvalTime = new Date(handoff.approval.approvedAt);
  const approvedAt = Number.isNaN(approvalTime.getTime())
    ? "time unavailable"
    : approvalTime.toLocaleString();

  const copyPrompt = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(handoff.implementationPrompt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  /**
   * Step two of the loop with code: release the approval (a human act) and hand the agent a
   * re-import request. The approved version is remembered so the delta section defaults to
   * approved -> as built once the import lands.
   */
  const startVerify = async () => {
    const approved = {
      id: handoff.approvedDesign.candidateId,
      label: handoff.approvedDesign.label,
    };
    const prompt = reimportPrompt(approved, {
      studyId: study.id,
      studyName: study.name,
      candidateId: approved.id,
      candidateLabel: approved.label,
      candidateRevision: handoff.approvedDesign.revision,
    });
    let copied = false;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(prompt);
      copied = true;
    } catch {
      copied = false;
    }
    releaseApprovalForReimport();
    setVerifyStep(copied ? "copied" : "failed");
  };

  return (
    <section className="section implementation-handoff handoff-ready">
      <header className="section-head">
        <div>
          <h2>send to agent</h2>
          <p className="section-subtitle">The exact architecture change a person approved.</p>
        </div>
        <span className="badge badge-ok">approved</span>
      </header>

      <div className="handoff-receipt">
        <div className="handoff-route-card">
          <span>From the current system</span>
          <strong>{handoff.baseline.label}</strong>
          <code>
            {handoff.baseline.candidateId}@r{handoff.baseline.revision}
          </code>
        </div>
        <span className="handoff-route-arrow" aria-hidden="true">→</span>
        <div className="handoff-route-card approved">
          <span>To the approved version</span>
          <strong>{handoff.approvedDesign.label}</strong>
          <code>
            {handoff.approvedDesign.candidateId}@r{handoff.approvedDesign.revision}
          </code>
        </div>
      </div>

      <div className="handoff-meta">
        <span>
          source <code>{handoff.repository.revision || "revision not recorded"}</code>
        </span>
        <span>
          {handoff.repository.dirty === true
            ? "includes uncommitted changes"
            : handoff.repository.dirty === false
              ? "clean snapshot"
              : "dirty state unknown"}
        </span>
        <span>approved {approvedAt}</span>
      </div>

      <div className="handoff-counts" aria-label="Approved implementation change counts">
        <div>
          <strong className="tnum">{componentChanges}</strong>
          <span>components</span>
        </div>
        <div>
          <strong className="tnum">{handoff.delta.edges.length}</strong>
          <span>links</span>
        </div>
        <div>
          <strong className="tnum">{handoff.delta.workflow.changed ? 1 : 0}</strong>
          <span>behaviors</span>
        </div>
        <div>
          <strong className="tnum">{handoff.sourcePaths.length}</strong>
          <span>source paths</span>
        </div>
      </div>

      {handoff.issueChanges.length > 0 && (
        <div className="handoff-issue-map">
          <h3>Why each change is in the handoff</h3>
          <ul>
            {handoff.issueChanges.map((item) => (
              <li key={item.issueId}>
                <span className="handoff-map-mark" aria-hidden="true">→</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.architectureImpact.summary}</p>
                  <small>{item.verificationResult.replace("-", " ")} · {item.verificationPlan}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {handoff.sourcePaths.length > 0 && (
        <div className="handoff-sources">
          <h3>Where the agent should start</h3>
          <div>
            {handoff.sourcePaths.slice(0, 8).map((path) => (
              <code key={path}>{path}</code>
            ))}
            {handoff.sourcePaths.length > 8 && (
              <span>+{handoff.sourcePaths.length - 8} more</span>
            )}
          </div>
          <p>
            Evidence-backed starting points only—the agent must re-read current source before
            editing.
          </p>
        </div>
      )}

      {handoff.unresolvedFindings.length > 0 && (
        <p className="handoff-findings">
          <strong>
            {handoff.unresolvedFindings.length} unresolved production{" "}
            {handoff.unresolvedFindings.length === 1 ? "finding" : "findings"}
          </strong>
          <span> carried into the implementation acceptance criteria.</span>
        </p>
      )}

      {handoff.warnings.length > 0 && (
        <ul className="handoff-warnings">
          {handoff.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <footer className="handoff-actions">
        <div>
          <button className="btn primary" onClick={() => void copyPrompt()}>
            {copyState === "copied" ? "Copied for your agent" : "Send approved change to agent"}
          </button>
          <span className={`copy-status copy-${copyState}`} aria-live="polite">
            {copyState === "copied"
              ? "Paste it into your coding agent. It edits the code with its own tools; the studio never touches files."
              : copyState === "failed"
                ? "Clipboard access failed."
                : ""}
          </span>
        </div>
        <p>Approval authorizes this code delta—not deployment.</p>
      </footer>

      <div className="handoff-verify">
        <h3>after the agent has changed the code</h3>
        {verifyStep === "confirm" ? (
          <>
            <p>
              This withdraws the approval so the new commit can become the current system, keeps
              every result and the approved version, and copies a re-import request for your agent.
              When the import lands, the review shows approved against as built.
            </p>
            <div className="row-actions">
              <button type="button" className="btn primary small" onClick={() => void startVerify()}>
                release approval and copy the request
              </button>
              <button type="button" className="btn small ghost" onClick={() => setVerifyStep("idle")}>
                not yet
              </button>
            </div>
          </>
        ) : (
          <div className="row-actions">
            <button type="button" className="btn small" onClick={() => setVerifyStep("confirm")}>
              Verify the change landed
            </button>
            <span className="muted">re-import at the new commit and diff it against this approval</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ArchitectureDelta() {
  const study = useStudyStore((state) => state.study);
  const verifyAgainstId = useStudyStore((state) => state.verifyAgainstId);
  const diffBaseId = useStudyStore((state) => state.diffBaseId);
  const setDiffBase = useStudyStore((state) => state.setDiffBase);
  const selectCandidate = useStudyStore((state) => state.selectCandidate);
  const setReviewOpen = useStudyStore((state) => state.setReviewOpen);
  const [baseChoice, setBaseChoice] = useState("");
  const [headChoice, setHeadChoice] = useState("");
  if (study.candidates.length < 2) return null;

  const candidateIds = new Set(study.candidates.map((candidate) => candidate.id));
  /**
   * After a hand-off the question is "did what landed match what was approved", so when a
   * person released an approval for a re-import and a newer import exists, the default pair
   * is approved -> as built rather than current -> approved.
   */
  const approvedForVerify = verifyAgainstId && candidateIds.has(verifyAgainstId) ? verifyAgainstId : null;
  // Candidates are appended in creation order, so "a baseline imported after the approval"
  // is the last baseline positioned after the approved version.
  const approvedIndex = approvedForVerify ? study.candidates.findIndex((c) => c.id === approvedForVerify) : -1;
  const asBuilt =
    approvedIndex >= 0
      ? [...study.candidates.slice(approvedIndex + 1)].reverse().find((c) => c.role === "baseline") ?? null
      : null;
  const verifying = approvedForVerify !== null && asBuilt !== null;
  const preferredHead = study.promotedCandidateId ?? study.activeCandidateId;
  const preferredBaseline = preferredHead ? baselineAncestor(study, preferredHead) : null;
  const defaultBaseId = verifying
    ? approvedForVerify!
    : (preferredBaseline?.id ??
      study.candidates.find((candidate) => candidate.role === "baseline")?.id ??
      study.candidates[0]!.id);
  const baseId = candidateIds.has(baseChoice) ? baseChoice : defaultBaseId;
  const activeCandidateId = study.activeCandidateId;
  const defaultHeadId = verifying && asBuilt!.id !== baseId
    ? asBuilt!.id
    : study.promotedCandidateId !== null &&
    study.promotedCandidateId !== baseId &&
    candidateIds.has(study.promotedCandidateId)
      ? study.promotedCandidateId
      : activeCandidateId !== null &&
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

  const shownOnCanvas = diffBaseId === baseId && activeCandidateId === headId;
  const showOnCanvas = () => {
    if (activeCandidateId !== headId) selectCandidate(headId);
    setDiffBase(baseId);
    setReviewOpen(false);
  };

  return (
    <section className="section architecture-delta">
      <header className="section-head">
        <div>
          <h2>{verifying ? "did the code change land?" : "what changed between versions"}</h2>
          <p className="section-subtitle">
            {verifying
              ? "The re-imported system against the version that was approved. Anything marked here was built differently from what was signed off."
              : "See what structurally changed before comparing outcomes."}
          </p>
        </div>
        <button type="button" className={`btn small ${shownOnCanvas ? "" : "primary"}`} onClick={showOnCanvas}>
          {shownOnCanvas ? "shown on canvas" : "show on canvas"}
        </button>
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
          These versions share no stable component IDs. Additions and removals are exact, but the
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
  role,
  isPromoted,
  isApproved,
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
  role: "baseline" | "experiment";
  isPromoted: boolean;
  isApproved: boolean;
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
          {origin === "agent" && <span className="badge badge-agent">agent draft</span>}
          {origin === "library" && <span className="badge badge-muted">library</span>}
          {isApproved && <span className="badge badge-ok">approved</span>}
          {isPromoted && !isApproved && <span className="badge badge-warn">review needed</span>}
          {onFrontier && <span className="badge badge-info">a trade-off</span>}
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
          Open on canvas
        </button>
        <button className="btn btn-quiet" onClick={onInspect}>
          How it breaks
        </button>
        {/* Approval is eligibility-gated and only reachable from this human click. */}
        <button
          className="btn"
          disabled={!decision.eligible || role !== "experiment" || isApproved}
          title={
            role === "baseline"
              ? "The current system is what a change starts from, not something to approve."
              : decision.eligible
                ? "Approve this exact revision. Human-only: no agent tool can do this."
                : "Only a version that passes the rules can be approved."
          }
          onClick={onPromote}
        >
          {isApproved ? "Approved" : isPromoted ? "Approve again" : "Approve this version"}
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
