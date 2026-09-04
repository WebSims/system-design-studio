import { useMemo, useState } from "react";
import {
  activeIssueBaseline,
  issueEvidenceRefKey,
  issueStatus,
  type Issue,
  type IssueSeverity,
  type IssueStatus,
} from "@sds/schema";
import { useStudio } from "../store";
import { useStudyStore } from "../study/store";

const STATUS_MARK: Record<IssueStatus, string> = {
  open: "!",
  verified: "✓",
  "accepted-risk": "≈",
  dismissed: "×",
  historical: "↶",
};

type StatusFilter = "all" | IssueStatus;
type SeverityFilter = "all" | IssueSeverity;

export function IssueRegistry() {
  const study = useStudyStore((state) => state.study);
  const density = useStudyStore((state) => state.uiDensity);
  const upsert = useStudyStore((state) => state.upsertIssue);
  const decide = useStudyStore((state) => state.decideIssue);
  const removeIssue = useStudyStore((state) => state.removeIssue);
  const addCandidate = useStudyStore((state) => state.addCandidate);
  const selectCandidate = useStudyStore((state) => state.selectCandidate);
  const requestFocus = useStudyStore((state) => state.requestFocus);
  const select = useStudio((state) => state.select);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IssueSeverity>("warning");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const { snapshotId: baselineSnapshotId, revision: baselineRevision } = activeIssueBaseline(study);
  const rows = useMemo(
    () => study.issueRegistry.map((issue) => ({
      issue,
      status: issueStatus(issue, { snapshotId: baselineSnapshotId, revision: baselineRevision }),
    })),
    [baselineSnapshotId, baselineRevision, study.issueRegistry]
  );
  const visible = rows.filter(({ issue, status }) =>
    (statusFilter === "all" || status === statusFilter) &&
    (severityFilter === "all" || issue.severity === severityFilter)
  );
  const selectedIssues = rows.filter(({ issue }) => selected.has(issue.id));
  const historicalSelection = selectedIssues.find(({ status }) => status === "historical")?.issue;
  const derivedSelection = selectedIssues.find(({ issue }) => issue.source !== "user")?.issue;
  const referencedSelection = selectedIssues.find(({ issue }) =>
    study.candidates.some((candidate) => candidate.issuePlans.some((plan) => plan.issueId === issue.id))
  )?.issue;
  const historicalBlocker = historicalSelection
    ? `“${historicalSelection.title}” belongs to a prior source snapshot and is read-only.`
    : null;
  const deleteBlocker = historicalBlocker ?? (derivedSelection
    ? `“${derivedSelection.title}” is a derived finding. Dismiss it to retain its audit trail.`
    : referencedSelection
      ? `“${referencedSelection.title}” is used by a solution version. Remove that version first, or dismiss the issue.`
      : null);

  const toggle = (id: string) => {
    setConfirmingDelete(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const decideSelected = (outcome: "verified" | "accepted-risk" | "dismissed") => {
    for (const { issue, status } of selectedIssues) {
      if (status === "historical") continue;
      const evidenceRefs = issue.evidence.map(issueEvidenceRefKey);
      if (outcome === "verified" && issue.verification.kind !== "manual" && evidenceRefs.length === 0) continue;
      decide({
        issueId: issue.id,
        expectedRevision: issue.revision,
        outcome,
        authority: "human",
        candidateId: issue.candidateId,
        evidenceRefs: outcome === "verified" ? evidenceRefs : [],
        reason: outcome === "accepted-risk" ? "Risk accepted by a person in the Studio." : "Recorded by a person in the Studio.",
      });
    }
    setSelected(new Set());
  };

  const focus = (issue: Issue) => {
    if (issue.candidateId && issue.candidateId !== study.activeCandidateId) {
      useStudyStore.getState().selectCandidate(issue.candidateId);
    }
    const target = issue.targets.find((item) => item.kind === "node" || item.kind === "edge");
    if (!target) return;
    const ref = target.kind === "node"
      ? { kind: "node" as const, id: target.nodeId }
      : { kind: "edge" as const, id: target.edgeId };
    select(ref);
    requestFocus(ref);
  };

  const addUserIssue = () => {
    const clean = title.trim();
    if (!clean) return;
    const observationId = `observation-${Date.now().toString(36)}`;
    upsert({
      title: clean,
      description: clean,
      source: "user",
      severity,
      category: "other",
      candidateId: study.activeCandidateId,
      evidence: [{ kind: "user-observation", observationId }],
      verification: {
        kind: "manual",
        summary: "A person reviews the implemented architecture and confirms this concern is resolved.",
        requiredSignals: [],
      },
      by: "human",
    });
    setTitle("");
    setAdding(false);
  };

  const createSolution = () => {
    const active = study.candidates.find((candidate) => candidate.id === study.activeCandidateId);
    if (!active || selectedIssues.length === 0) return;
    const candidate = addCandidate({
      label: `solution for ${selectedIssues.length} issue${selectedIssues.length === 1 ? "" : "s"}`,
      intent: `Resolve ${selectedIssues.map(({ issue }) => issue.title).join("; ")}.`,
      copyFrom: active.id,
      origin: "human",
      candidateType: "repository-fix",
      issuePlans: selectedIssues.map(({ issue }) => ({
        issueId: issue.id,
        required: true,
        hypothesis: `Changing the architecture around ${issue.title} will resolve the observed failure without weakening the project contract.`,
        tradeoffs: ["The implementation cost and operational impact must be measured during evaluation."],
        verificationPlan: issue.verification.summary,
        expectedArchitectureImpact: {
          summary: issue.targets.length > 0 ? "Change the architecture elements named by this issue." : "Architecture impact is not mapped yet.",
          targets: issue.targets,
        },
        verification: null,
      })),
    });
    setSelected(new Set());
    selectCandidate(candidate.id);
  };

  const deleteSelected = () => {
    if (deleteBlocker) return;
    let removed = 0;
    const remaining = new Set(selected);
    for (const { issue } of selectedIssues) {
      if (removeIssue({
        issueId: issue.id,
        expectedRevision: issue.revision,
        authority: "human",
      })) {
        remaining.delete(issue.id);
        removed += 1;
      }
    }
    setSelected(remaining);
    setConfirmingDelete(false);
    if (removed > 0) setAnnouncement(`Deleted ${removed} issue${removed === 1 ? "" : "s"}.`);
  };

  return (
    <section className="section issue-registry" aria-label="Design issue registry">
      <header className="section-head">
        <h2>issues</h2>
        <span className="section-tag" aria-label={`${rows.filter((row) => row.status === "open").length} open issues`}>
          {rows.filter((row) => row.status === "open").length} open
        </span>
        <button className="btn small" type="button" onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          + add
        </button>
      </header>

      <div className="registry-filters">
        <label>
          <span className="sr-only">Issue state</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">all states</option>
            <option value="open">open</option>
            <option value="verified">verified</option>
            <option value="accepted-risk">accepted risk</option>
            <option value="dismissed">dismissed</option>
            <option value="historical">historical</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Issue severity</span>
          <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}>
            <option value="all">all severity</option>
            <option value="critical">critical</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
          </select>
        </label>
      </div>

      {adding && (
        <div className="registry-add">
          <label>
            concern
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What could go wrong?" autoFocus />
          </label>
          <label>
            severity
            <select value={severity} onChange={(event) => setSeverity(event.target.value as IssueSeverity)}>
              <option value="critical">critical</option>
              <option value="warning">warning</option>
              <option value="info">info</option>
            </select>
          </label>
          <button className="btn primary small" type="button" onClick={addUserIssue} disabled={!title.trim()}>add issue</button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="muted">No issues match these filters.</p>
      ) : (
        <ul className="registry-list">
          {visible.map(({ issue, status }) => (
            <li key={issue.id} className={`registry-item severity-${issue.severity}`}>
              <label className="registry-select">
                <input
                  type="checkbox"
                  checked={selected.has(issue.id)}
                  onChange={() => toggle(issue.id)}
                  aria-label={`Select ${issue.title}`}
                />
              </label>
              <details>
                <summary>
                  <span className={`registry-state state-${status}`} aria-hidden="true">{STATUS_MARK[status]}</span>
                  <span className="registry-title">{issue.title}</span>
                  <span className="registry-status">{status.replace("-", " ")}</span>
                </summary>
                <div className="registry-detail">
                  {issue.description && <p>{issue.description}</p>}
                  <p className="muted">{issue.source} · {issue.category} · baseline {issue.baselineRevision}</p>
                  <p><b>Verify:</b> {issue.verification.summary}</p>
                  {density === "expert" && (
                    <>
                      <p className="muted">{issue.evidence.length} evidence reference{issue.evidence.length === 1 ? "" : "s"} · revision {issue.revision}</p>
                      <ul className="registry-evidence">
                        {issue.evidence.map((reference) => <li key={issueEvidenceRefKey(reference)}><code>{issueEvidenceRefKey(reference)}</code></li>)}
                      </ul>
                    </>
                  )}
                  {issue.targets.some((target) => target.kind === "node" || target.kind === "edge") && (
                    <button className="btn small" type="button" onClick={() => focus(issue)}>focus on canvas</button>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      {selected.size > 0 && (
        <>
          <div className="registry-batch" role="group" aria-label={`Actions for ${selected.size} selected issues`}>
            <button
              className="btn primary small"
              type="button"
              onClick={createSolution}
              disabled={historicalBlocker !== null}
              title={historicalBlocker ?? undefined}
            >
              new solution
            </button>
            <button className="btn small" type="button" disabled={historicalBlocker !== null} title={historicalBlocker ?? undefined} onClick={() => decideSelected("verified")}>verify</button>
            <button className="btn small" type="button" disabled={historicalBlocker !== null} title={historicalBlocker ?? undefined} onClick={() => decideSelected("accepted-risk")}>accept risk</button>
            <button className="btn small" type="button" disabled={historicalBlocker !== null} title={historicalBlocker ?? undefined} onClick={() => decideSelected("dismissed")}>dismiss</button>
            <button className="btn small danger" type="button" onClick={() => setConfirmingDelete(true)}>delete…</button>
          </div>
          {confirmingDelete && (
            <div className="confirm-row" role="group" aria-label="Confirm permanent issue deletion">
              <span className="small">
                {deleteBlocker ?? `Permanently delete ${selectedIssues.length} manually added issue${selectedIssues.length === 1 ? "" : "s"}? This cannot be undone.`}
              </span>
              <button
                className="btn small danger"
                type="button"
                onClick={deleteSelected}
                disabled={deleteBlocker !== null}
                autoFocus={deleteBlocker === null}
              >
                Delete
              </button>
              <button
                className="btn small"
                type="button"
                onClick={() => setConfirmingDelete(false)}
                autoFocus={deleteBlocker !== null}
              >
                Keep
              </button>
            </div>
          )}
        </>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
