import { useStudyStore } from "../study/store";

/**
 * Every agent call, in order.
 *
 * The point is accountability rather than debugging. An agent that created three candidates and
 * discarded two of them made decisions the user did not see, and the only way for that to be
 * reviewable after the fact is a log of what it called and what came back. It also shows the
 * revision each edit produced, so a change can be traced to the call that made it.
 */
export function ActivityLog({ onClose }: { onClose: () => void }) {
  const activity = useStudyStore((s) => s.activity);
  const webmcp = useStudyStore((s) => s.webmcp);

  return (
    <div className="palette palette-wide" onClick={(e) => e.stopPropagation()}>
      <div className="palette-title">agent activity</div>
      <p className="muted">{webmcp.detail}</p>

      {activity.length === 0 ? (
        <p className="muted">No agent calls yet.</p>
      ) : (
        <ol className="activity">
          {[...activity].reverse().map((entry, i) => (
            <li key={i} className={entry.ok ? "" : "issue-error"}>
              <span className="activity-time tnum">
                {new Date(entry.at).toLocaleTimeString()}
              </span>
              <span className="activity-tool">{entry.tool}</span>
              <span className="activity-summary">{entry.summary}</span>
              {entry.revision !== undefined && (
                <span className="activity-rev tnum">
                  {entry.candidateId} r{entry.revision}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <button className="btn" onClick={onClose}>
        close
      </button>
    </div>
  );
}
