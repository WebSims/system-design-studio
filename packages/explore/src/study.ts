import type { CorrectnessResult, Candidate, Study } from "@sds/schema";
import { syncCandidateToStudy, validateStudy } from "@sds/schema";
import { explore } from "./explore";

/**
 * Run the correctness search for one candidate of a study.
 *
 * The candidate is SYNCHRONISED to the study first, on a copy. That matters even though
 * correctness does not depend on the workload: the sync also copies the SLO and the
 * request classes, and running the check against the un-synced candidate would mean the
 * cached correctness result was keyed on a design that differs from the one the
 * performance run used. Two results about two slightly different documents, presented side
 * by side as if they were about one, is precisely the incoherence the study format exists
 * to prevent.
 */
export function checkCandidate(study: Study, candidate: Candidate): CorrectnessResult {
  const synced = syncCandidateToStudy(study, candidate);
  return explore({
    design: synced.design,
    invariants: study.correctness.invariants,
    faults: study.correctness.faults,
    bounds: study.correctness.bounds,
    identityDomains: study.correctness.identityDomains,
    stateOverrides: study.correctness.stateOverrides,
  });
}

/**
 * Run the correctness search for every candidate.
 *
 * Sequential rather than parallel, and that is not laziness. The bounds include a wall-
 * clock budget per candidate; running seven searches concurrently on however many cores
 * the host happens to have would make each one's time cap mean something different, so a
 * candidate could report INCONCLUSIVE on a busy machine and NO_VIOLATION_WITHIN_BOUNDS on
 * an idle one. A verdict that depends on the host is not a verdict.
 */
export function checkStudy(study: Study): Record<string, CorrectnessResult> {
  const out: Record<string, CorrectnessResult> = {};
  for (const candidate of study.candidates) {
    out[candidate.id] = checkCandidate(study, candidate);
  }
  return out;
}

/**
 * Errors that would make every correctness result meaningless, found once rather than
 * seven times.
 *
 * Returned rather than thrown so a caller can render them next to the candidates they
 * concern. An invariant that cannot be evaluated against candidate 3 is reported against
 * candidate 3, because the fix is usually to the candidate.
 */
export function studyModelErrors(study: Study): string[] {
  return validateStudy(study)
    .filter((i) => i.severity === "error")
    .map((i) => (i.candidateId ? `${i.candidateId}: ${i.message}` : i.message));
}
