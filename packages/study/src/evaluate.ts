import {
  contentHash,
  evaluationKey,
  studyBoundsHash,
  syncCandidateToStudy,
  validateDesign,
  validateStudy,
  type BusinessSummary,
  type Candidate,
  type CandidateEvaluation,
  type CorrectnessResult,
  type Interval,
  type PerformanceSummary,
  type PortfolioResult,
  type Study,
} from "@sds/schema";
import { confidenceInterval, type OutcomeMeaning, type RunResult } from "@sds/core";
import { EXPLORER_VERSION, checkCandidate } from "@sds/explore";
import { replicate } from "@sds/analyze";
import { accountResources, resourceGapNote } from "./resources";
import { decideEligibility } from "./eligibility";
import { buildPortfolio } from "./pareto";

/**
 * Evaluation, caching and portfolio assembly.
 *
 * THE CACHE KEY IS THE HONESTY MECHANISM
 *
 * A number shown next to a design must have been produced BY that design. The key covers the
 * candidate's content, the engine version, the seeds and the bounds -- everything that could
 * change the answer -- so changing any of them misses the cache and the stale number is never
 * shown. That is not an optimisation with a correctness caveat; it is a correctness mechanism
 * whose side effect is that reopening a study does not throw away an hour of exploration.
 *
 * Revision is deliberately NOT in the key. Two revisions with identical content are the same
 * design, and including it would discard valid work every time somebody renamed a node and
 * renamed it back.
 */

/**
 * Engine version. BUMP THIS ON ANY SEMANTIC CHANGE.
 *
 * Every cached evaluation is keyed on it, so a bump invalidates every stored result in every
 * saved study. That is the intended cost: a cached number produced by different semantics is
 * worse than no number, because it is indistinguishable from a current one.
 */
export const STUDY_ENGINE_VERSION = `study-1+${EXPLORER_VERSION}`;

export interface EvaluateOptions {
  /** Skip the correctness search. Used by the performance view for a fast refresh. */
  skipCorrectness?: boolean;
  /** Skip the replicated performance run. */
  skipPerformance?: boolean;
  /** Replications. Defaults to the study's seed count. */
  replications?: number;
  /** Abort cooperatively. Checked between replications and before the search. */
  signal?: { aborted: boolean };
  clock?: () => number;
}

export class EvaluationAborted extends Error {
  constructor() {
    super("evaluation aborted");
    this.name = "EvaluationAborted";
  }
}

/**
 * Evaluate one candidate: correctness, replicated performance, business outcomes, resources.
 *
 * The candidate is synchronised to the study first, on a copy, and the HASH IS TAKEN OF THE
 * SYNCHRONISED DESIGN. Hashing the un-synced one would mean two candidates that differed only
 * in a locally-edited workload shared a cache entry, and a user who had quietly halved their
 * own arrival rate would be shown the study's numbers under their own design.
 */
export function evaluateCandidate(
  study: Study,
  candidate: Candidate,
  opts: EvaluateOptions = {}
): CandidateEvaluation {
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  const synced = syncCandidateToStudy(study, candidate);
  const candidateHash = contentHash(synced.design);
  const boundsHash = studyBoundsHash(study);
  const seeds = study.workload.seeds.slice(0, opts.replications ?? study.workload.seeds.length);

  const warnings: string[] = [];
  const assumptions: string[] = [];

  const abortCheck = () => {
    if (opts.signal?.aborted) throw new EvaluationAborted();
  };

  // ---- correctness ----
  abortCheck();
  let correctness: CorrectnessResult | null = null;
  if (!opts.skipCorrectness) {
    correctness = checkCandidate(study, candidate);
    assumptions.push(...correctness.assumptions);
    if (correctness.status === "INCONCLUSIVE_BOUND_REACHED") {
      warnings.push(
        `the correctness search hit the ${correctness.stats.capHit} cap; this candidate cannot be compared until the search completes`
      );
    }
  }

  // ---- performance ----
  abortCheck();
  let performance: PerformanceSummary | null = null;
  let business: BusinessSummary | null = null;
  let representativeRun: RunResult | null = null;

  const modelErrors = validateDesign(synced.design).filter((i) => i.severity === "error");

  if (!opts.skipPerformance && modelErrors.length === 0) {
    const outcomes = outcomeMeaning(study);
    const replicated = replicate(synced.design, { seeds, outcomes });
    abortCheck();
    representativeRun = replicated.runs[0] ?? null;

    const unstable = replicated.runs.some((r) => !r.stability.stable);
    performance = {
      throughputPerSec: toInterval(replicated.intervals.throughputPerSec),
      p50Ms: toInterval(replicated.intervals.p50Ms),
      p99Ms: toInterval(replicated.intervals.p99Ms),
      errorRatePct: toInterval(replicated.intervals.errorRatePct),
      maxUtilization: toInterval(replicated.intervals.maxUtilization),
      replications: replicated.runs.length,
      seeds: replicated.seeds,
      unstable,
      closedFormWithheldReason: closedFormReason(synced.design),
    };

    if (unstable) {
      warnings.push(
        "at least one replication reported no steady state: a queue grows without bound, so its latency percentiles do not describe a system anybody would operate"
      );
    }
    if (!replicated.runs.every((r) => r.confidence.sufficient)) {
      warnings.push(
        `the measurement window is short for this utilization; the reported intervals are wide and a difference smaller than them is not a difference`
      );
    }

    business = summariseBusiness(replicated.runs);
    if (business && Object.keys(business.metrics).length === 0) {
      warnings.push("this candidate has no workflow, so no business outcome was measured");
    }
  }

  for (const issue of modelErrors) warnings.push(issue.message);

  // ---- resources ----
  const resources = accountResources({ design: synced.design, run: representativeRun });
  const gap = resourceGapNote(resources);
  if (gap) warnings.push(gap);

  const evaluation: CandidateEvaluation = {
    evaluationId: `${candidate.id}@${candidateHash}`,
    candidateId: candidate.id,
    candidateRevision: candidate.revision,
    candidateHash,
    engineVersion: STUDY_ENGINE_VERSION,
    seeds,
    boundsHash,
    correctness,
    performance,
    business,
    resources,
    assumptions: dedupe(assumptions.concat(performanceAssumptions(performance))),
    warnings: dedupe(warnings),
    createdAt: startedAt,
    wallMs: clock() - startedAt,
  };

  return evaluation;
}

/**
 * Evaluate every candidate, reusing anything already cached, and return the updated study.
 *
 * The study is returned rather than mutated, because the caller is a zustand store and an
 * IndexedDB writer and both want a value. Nothing here writes to disk.
 */
export function evaluateStudy(
  study: Study,
  opts: EvaluateOptions & { force?: boolean } = {}
): { study: Study; portfolio: PortfolioResult } {
  const boundsHash = studyBoundsHash(study);
  const evaluations = { ...study.evaluations };

  for (const candidate of study.candidates) {
    const synced = syncCandidateToStudy(study, candidate);
    const key = evaluationKey({
      candidateHash: contentHash(synced.design),
      engineVersion: STUDY_ENGINE_VERSION,
      seeds: study.workload.seeds,
      boundsHash,
    });
    if (!opts.force && evaluations[key]) continue;
    evaluations[key] = evaluateCandidate(study, candidate, opts);
  }

  const next: Study = { ...study, evaluations, updatedAt: Date.now() };
  return { study: next, portfolio: assemblePortfolio(next) };
}

/** The cached evaluation for a candidate at the study's current settings, or null. */
export function cachedEvaluation(
  study: Study,
  candidate: Candidate
): CandidateEvaluation | null {
  const synced = syncCandidateToStudy(study, candidate);
  const key = evaluationKey({
    candidateHash: contentHash(synced.design),
    engineVersion: STUDY_ENGINE_VERSION,
    seeds: study.workload.seeds,
    boundsHash: studyBoundsHash(study),
  });
  return study.evaluations[key] ?? null;
}

/**
 * Build the portfolio from whatever is currently cached.
 *
 * A candidate with no cached evaluation is INELIGIBLE, not absent. Absent would quietly shrink
 * the comparison; ineligible-because-untested is a state the reader can act on, and its gate
 * reason says exactly that.
 */
export function assemblePortfolio(study: Study): PortfolioResult {
  const studyIssues = validateStudy(study);
  const evaluations: Record<string, CandidateEvaluation> = {};
  const decisions = [];

  for (const candidate of study.candidates) {
    const cached = cachedEvaluation(study, candidate);
    const evaluation: CandidateEvaluation = cached ?? {
      evaluationId: `${candidate.id}@untested`,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      candidateHash: contentHash(syncCandidateToStudy(study, candidate).design),
      engineVersion: STUDY_ENGINE_VERSION,
      seeds: study.workload.seeds,
      boundsHash: studyBoundsHash(study),
      correctness: null,
      performance: null,
      business: null,
      resources: accountResources({
        design: syncCandidateToStudy(study, candidate).design,
        run: null,
      }),
      assumptions: [],
      warnings: ["this candidate has not been evaluated at the study's current settings"],
      createdAt: 0,
      wallMs: 0,
    };
    evaluations[candidate.id] = evaluation;
    decisions.push(
      decideEligibility({
        study,
        evaluation,
        modelErrors: studyIssues
          .filter((i) => i.severity === "error" && i.candidateId === candidate.id)
          .map((i) => i.message),
      })
    );
  }

  return buildPortfolio({
    study,
    decisions,
    evaluations,
    engineVersion: STUDY_ENGINE_VERSION,
  });
}

// ---------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------

function toInterval(i: {
  mean: number;
  halfWidth: number;
  low: number;
  high: number;
  samples: number;
}): Interval {
  return {
    mean: i.mean,
    halfWidth: i.halfWidth,
    low: i.low,
    high: i.high,
    samples: i.samples,
  };
}

/**
 * Business metrics as intervals over replications.
 *
 * As intervals rather than as totals, because a count from one seed is one sample of a random
 * variable. "We oversold two pizzas" from a single run supports no conclusion; "we oversold
 * between one and four, over eight seeds" supports the conclusion that the design oversells.
 *
 * `remainingInventory` is summed across counters rather than reported per counter, because the
 * business goal names one metric and needs one number. Studies with several depleting counters
 * get the total, which the goal's own label has to account for.
 */
function summariseBusiness(runs: readonly RunResult[]): BusinessSummary | null {
  const withBusiness = runs.filter((r) => r.business !== null);
  if (withBusiness.length === 0) return { metrics: {}, outcomes: {} };

  const pick = (f: (r: RunResult) => number): Interval =>
    toInterval(confidenceInterval(withBusiness.map(f)));

  const metrics: Record<string, Interval> = {
    validAllocations: pick((r) => r.business!.validAllocations),
    duplicateSuccesses: pick((r) => r.business!.duplicateSuccesses),
    oversells: pick((r) => r.business!.oversells),
    remainingInventory: pick((r) =>
      Object.entries(r.business!.remainingInventory)
        // `initialInventory` and its like are never written and are not stock. Summing them
        // would report the starting figure as if it were what was left.
        .filter(([id]) => !/^initial/i.test(id))
        .reduce((s, [, v]) => s + v, 0)
    ),
    expiredReservations: pick((r) => r.business!.expiredReservations),
    strandedReservations: pick((r) => r.business!.strandedReservations),
    idempotencyHits: pick((r) => r.business!.idempotencyHits),
    transactionConflicts: pick((r) => r.business!.transactionConflicts),
    lockWaitMsP99: pick((r) => r.business!.lockWaitMs.p99),
    redeliveries: pick((r) => r.business!.redeliveries),
    abandonedMessages: pick((r) => r.business!.abandonedMessages),
    staleOwnerRejections: pick((r) => r.business!.staleOwnerRejections),
    timeToExhaustSec: pick((r) => {
      const values = Object.values(r.business!.timeToExhaustSec).filter(
        (v): v is number => v !== null
      );
      // Never exhausted is reported as the run length rather than as zero. Zero would read as
      // "sold out instantly", which is the opposite of what happened.
      return values.length > 0 ? Math.min(...values) : r.observedSec;
    }),
  };

  const labels = new Set<string>();
  for (const r of withBusiness) for (const k of Object.keys(r.business!.outcomes)) labels.add(k);
  const outcomes: Record<string, Interval> = {};
  for (const label of [...labels].sort()) {
    outcomes[label] = pick((r) => r.business!.outcomes[label] ?? 0);
  }

  return { metrics, outcomes };
}

/**
 * Why a closed-form estimate was not produced.
 *
 * WITHHELD RATHER THAN APPROXIMATED, AND THIS IS THE RIGHT CALL
 *
 * The analytic preview solves a queueing network in which each station has a service-time
 * distribution. A stateful handler does not: its service time depends on which branch it took,
 * and which branch it took depends on the state, and the state depends on how many requests got
 * there first. A handler that finds the inventory empty does a single read; one that finds a
 * unit does a read, a write and an insert. Those are different service times drawn in
 * proportions that shift over the run as the stock depletes.
 *
 * A preview could still produce a number by averaging. It would be a plausible number with no
 * error bound and no way for a reader to know it was a guess, and it would appear next to
 * simulation results that do have error bounds. So it is withheld and the reason is stated,
 * which is less satisfying and much more useful.
 */
function closedFormReason(design: { workflow: unknown }): string | null {
  if (!design.workflow) return null;
  return (
    "No closed-form estimate is offered for this candidate. Its handlers branch on state, so " +
    "each station's service-time distribution depends on how much inventory is left -- and the " +
    "queueing formulas assume it does not. An averaged estimate would be a plausible number " +
    "with no error bound, sitting next to replicated results that have one. The simulation " +
    "figures above, with their 95% intervals, are the only estimate this candidate supports."
  );
}

function performanceAssumptions(p: PerformanceSummary | null): string[] {
  if (!p) return [];
  const out = [
    `performance measured over ${p.replications} independent replications with seeds ${p.seeds.join(", ")}`,
  ];
  if (p.closedFormWithheldReason) out.push(p.closedFormWithheldReason);
  return out;
}

/** Outcome meanings, lifted from the product contract rather than duplicated. */
export function outcomeMeaning(study: Study): OutcomeMeaning {
  const by = (kind: string) =>
    study.contract.outcomes.filter((o) => o.kind === kind).map((o) => o.label);
  return {
    valid: by("valid"),
    duplicate: by("duplicate"),
    oversell: by("oversell"),
    expired: by("expired"),
    rejected: by("rejected"),
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
