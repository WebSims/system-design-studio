import { currentBaselineCandidate } from "@sds/schema";
import { useStudyStore } from "../study/store";

/**
 * The versions strip.
 *
 * Present in every view, because "which architecture am I looking at" is the question a reader loses
 * track of first and the one that makes every number on screen ambiguous when they do. It also
 * carries the two badges that decide how much scrutiny a candidate deserves: who wrote it, and
 * whether a human has chosen it.
 */
export function CandidateBar() {
  const study = useStudyStore((s) => s.study);
  const running = useStudyStore((s) => s.running);
  const select = useStudyStore((s) => s.selectCandidate);
  const addCandidate = useStudyStore((s) => s.addCandidate);
  const removeCandidate = useStudyStore((s) => s.removeCandidate);
  const portfolio = useStudyStore((s) => s.portfolio);

  const eligible = new Set(
    (portfolio?.decisions ?? []).filter((d) => d.eligible).map((d) => d.candidateId)
  );
  const frontier = new Set(portfolio?.frontier ?? []);
  const active = study.candidates.find((candidate) => candidate.id === study.activeCandidateId);
  const currentBaselineId = currentBaselineCandidate(study)?.id ?? null;

  const duplicateActive = () => {
    if (!active) return;
    const candidate = addCandidate({
      label: `${active.label} v2`.slice(0, 120),
      intent: `A version based on ${active.label}.`,
      copyFrom: active.id,
      origin: "human",
    });
    select(candidate.id);
  };

  // The project's name lives in the top bar's breadcrumb; this row owns one level only: versions.
  return (
    <div className="candidate-bar" aria-label="Versions">
      <span className="candidate-bar-title">versions</span>

      <div className="candidate-chips">
        {study.candidates.map((candidate) => {
          const isActive = candidate.id === study.activeCandidateId;
          const isPromoted = candidate.id === study.promotedCandidateId;
          const isCurrentBaseline = candidate.role === "baseline" && candidate.id === currentBaselineId;
          const isPriorBaseline = candidate.role === "baseline" && !isCurrentBaseline;
          return (
            <div
              key={candidate.id}
              className={[
                "candidate-chip",
                isActive ? "active" : "",
                candidate.origin === "agent" ? "agent" : "",
                `role-${candidate.role}`,
                isCurrentBaseline ? "current-baseline" : "",
                isPriorBaseline ? "prior-baseline" : "",
                eligible.has(candidate.id) ? "eligible" : "",
                frontier.has(candidate.id) ? "frontier" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={candidate.intent || candidate.label}
            >
              <button
                className="candidate-select"
                aria-current={isActive ? "true" : undefined}
                onClick={() => select(candidate.id)}
              >
                {/* Origin is rendered, never inferred, and an agent cannot set it. */}
                <span className={`chip-role chip-role-${candidate.role} ${isPriorBaseline ? "chip-role-prior" : ""}`}>
                  {isCurrentBaseline ? "CURRENT" : isPriorBaseline ? "PRIOR" : "VERSION"}
                </span>
                {candidate.origin === "agent" && <span className="chip-mark">AI</span>}
                {candidate.candidateType === "repository-fix" && (
                  <span className="chip-mark chip-fix">FIX {candidate.issuePlans.length}</span>
                )}
                {isPromoted && <span className="chip-mark chip-promoted">✓</span>}
                <span className="chip-label">{candidate.label}</span>
                <span className="chip-rev tnum">r{candidate.revision}</span>
                {running.has(candidate.id) && <span className="chip-spin" />}
              </button>
              {!isPromoted && !isCurrentBaseline && study.candidates.length > 1 && (
                <button
                  className="chip-remove"
                  aria-label={`remove ${candidate.label}`}
                  title={`Remove ${candidate.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCandidate(candidate.id);
                  }}
                >
                  &times;
                </button>
              )}
            </div>
          );
        })}
        {active && (
          <button
            className="candidate-chip candidate-add"
            disabled={study.candidates.length >= 64}
            title="Copy the active version and change it"
            onClick={duplicateActive}
          >
            New version
          </button>
        )}
      </div>
    </div>
  );
}
