import { useStudyStore } from "../study/store";

/**
 * The candidate strip.
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
  const removeCandidate = useStudyStore((s) => s.removeCandidate);
  const portfolio = useStudyStore((s) => s.portfolio);

  const eligible = new Set(
    (portfolio?.decisions ?? []).filter((d) => d.eligible).map((d) => d.candidateId)
  );
  const frontier = new Set(portfolio?.frontier ?? []);

  return (
    <div className="candidate-bar">
      <span className="candidate-bar-title" title={study.problem}>
        {study.name}
      </span>

      <div className="candidate-chips">
        {study.candidates.map((candidate) => {
          const isActive = candidate.id === study.activeCandidateId;
          const isPromoted = candidate.id === study.promotedCandidateId;
          return (
            <button
              key={candidate.id}
              className={[
                "candidate-chip",
                isActive ? "active" : "",
                candidate.origin === "agent" ? "agent" : "",
                eligible.has(candidate.id) ? "eligible" : "",
                frontier.has(candidate.id) ? "frontier" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={candidate.intent || candidate.label}
              onClick={() => select(candidate.id)}
            >
              {/* Origin is rendered, never inferred, and an agent cannot set it. */}
              {candidate.origin === "agent" && <span className="chip-mark">AI</span>}
              {isPromoted && <span className="chip-mark chip-promoted">\u2713</span>}
              <span className="chip-label">{candidate.label}</span>
              <span className="chip-rev tnum">r{candidate.revision}</span>
              {running.has(candidate.id) && <span className="chip-spin" />}
              {!isPromoted && study.candidates.length > 1 && (
                <span
                  className="chip-remove"
                  role="button"
                  aria-label={`remove ${candidate.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCandidate(candidate.id);
                  }}
                >
                  &times;
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
