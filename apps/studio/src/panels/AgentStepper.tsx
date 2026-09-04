import { useStudyStore } from "../study/store"
import { deriveAgentProgress } from "../study/steps"
import { CheckIcon } from "../ui/icons"

/**
 * Where the agent is in the one canonical order, read from the document.
 *
 * WHY A TRACKER AND NOT A LOG
 *
 * A flat list of tool calls tells a person what happened, not where things stand. Six failed
 * `studio_update_study` calls in a row read as "broken"; the same six under "step 5: set the
 * yardstick" with the validator's message inline read as "stuck on the rules, here is why", which is
 * something a person can help with. The steps come from `study/steps.ts`, the same list the tools'
 * `next` hints use, so the tracker cannot disagree with what the agent was told.
 */
export const AgentStepper = ({ compact = false }: { compact?: boolean }) => {
  const study = useStudyStore((s) => s.study)
  const activity = useStudyStore((s) => s.activity)
  const progress = deriveAgentProgress(study, activity)
  const doneCount = progress.steps.filter((step) => step.status === "done").length

  return (
    <section className={`agent-steps ${compact ? "compact" : ""}`} aria-label="Agent progress" aria-live="polite">
      <header className="agent-steps-head">
        <span className="agent-steps-title">
          {progress.complete ? "all steps done" : `step ${doneCount + 1} of ${progress.steps.length}`}
        </span>
        <span className="agent-steps-count tnum">{doneCount}/{progress.steps.length}</span>
      </header>
      <ol className="agent-step-list">
        {progress.steps.map((step, index) => (
          <li key={step.id} className={`agent-step ${step.status}`} aria-current={step.status === "current" ? "step" : undefined}>
            <span className="agent-step-mark" aria-hidden="true">
              {step.status === "done" ? <CheckIcon size={11} /> : index + 1}
            </span>
            <span className="agent-step-body">
              <span className="agent-step-label">{step.label}</span>
              {step.status === "current" && (
                <>
                  <span className="agent-step-unblock muted">{step.unblocks}</span>
                  {!compact && <code className="agent-step-hint">{step.hint}</code>}
                  {progress.failure && (
                    <span className="agent-step-failure" role="alert">
                      <strong>{progress.failure.tool.replace(/^studio_/, "").replace(/_/g, " ")}</strong> failed:{" "}
                      {progress.failure.summary}
                    </span>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
