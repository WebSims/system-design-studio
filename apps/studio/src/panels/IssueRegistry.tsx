import { useMemo, useState } from "react";
import { issueEvidenceRefKey, issueStatus, type Issue, type IssueSeverity, type IssueStatus } from "@sds/schema";
import { useStudio } from "../store";
import { activeIssueBaseline } from "../study/mutations";
import { useStudyStore } from "../study/store";

const STATUS_MARK: Record<IssueStatus, string> = {
  open: "!",
  verified: "✓",
  "accepted-risk": "≈",
  dismissed: "×",
};

type StatusFilter = "all" | IssueStatus;
type SeverityFilter = "all" | IssueSeverity;

export function IssueRegistry() {
  const study = useStudyStore((state) => state.study);
  const density = useStudyStore((state) => state.uiDensity);
  const upsert = useStudyStore((state) => state.upsertIssue);
  const decide = useStudyStore((state) => state.decideIssue);
  const requestFocus = useStudyStore((state) => state.requestFocus);
  const select = useStudio((state) => state.select);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IssueSeverity>("warning");
  const baselineRevision = activeIssueBaseline(study).revision;
  const rows = useMemo(
    () => study.issueRegistry.map((issue) => ({ issue, status: issueStatus(issue, baselineRevision) })),
    [baselineRevision, study.issueRegistry]
  );
  const visible = rows.filter(({ issue, status }) =>
    (statusFilter === "all" || status === statusFilter) &&
    (severityFilter === "all" || issue.severity === severityFilter)
  );
  const selectedIssues = rows.filter(({ issue }) => selected.has(issue.id));

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const decideSelected = (outcome: "verified" | "accepted-risk" | "dismissed") => {
    for (const { issue } of selectedIssues) {
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
        <div className="registry-batch" role="group" aria-label={`Actions for ${selected.size} selected issues`}>
          <button className="btn small" type="button" onClick={() => decideSelected("verified")}>verify</button>
          <button className="btn small" type="button" onClick={() => decideSelected("accepted-risk")}>accept risk</button>
          <button className="btn small" type="button" onClick={() => decideSelected("dismissed")}>dismiss</button>
        </div>
      )}
    </section>
  );
}
