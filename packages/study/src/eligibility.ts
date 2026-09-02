import type {
  BusinessGoal,
  CandidateEvaluation,
  EligibilityDecision,
  GateOutcome,
  Interval,
  Study,
} from "@sds/schema";

/**
 * The hard gates. A candidate opens all five or it is not compared at all.
 *
 * WHY GATES RATHER THAN A WEIGHTED SCORE
 *
 * Because the things being gated on are not commensurable with the things being compared. A
 * design that oversells is not "worse on the correctness dimension"; it does not solve the
 * problem. Folding that into a score with latency and cost produces a number in which a fast,
 * cheap, broken design beats a slower correct one -- and the number looks authoritative
 * precisely because it combined everything.
 *
 * So correctness is a gate, and among candidates that pass it, nothing is scored at all: the
 * comparison is a Pareto frontier with no weights. See `pareto.ts`.
 *
 * THE ORDER IS THE ORDER, AND THE THIRD GATE IS THE INTERESTING ONE
 *
 *   1. schema-valid              -- the document parses and its references resolve
 *   2. correctness-exhausted     -- the search finished rather than running out of budget
 *   3. no-violation              -- and it found nothing
 *   4. slo-satisfied             -- the CONSERVATIVE end of the interval meets the SLO
 *   5. business-goals-satisfied  -- likewise for the business goals
 *
 * Gate two comes before gate three deliberately. A candidate that hit a state cap has not
 * been shown to be safe and has not been shown to be broken; it has been shown nothing. Every
 * tool that collapses "we did not find a problem" and "we finished looking and there was no
 * problem" into one boolean produces its most dangerous output at exactly the moment its
 * search was weakest, and the output looks like good news.
 */

export interface EligibilityInput {
  study: Study;
  evaluation: CandidateEvaluation;
  /** Schema/study errors attributable to this candidate. */
  modelErrors: readonly string[];
}

export function decideEligibility(input: EligibilityInput): EligibilityDecision {
  const { study, evaluation } = input;
  const gates: GateOutcome[] = [];

  // ---- 1: the document itself ----
  gates.push(
    input.modelErrors.length === 0
      ? { gate: "schema-valid", passed: true, reason: "the design and its workflow validate" }
      : {
          gate: "schema-valid",
          passed: false,
          reason: input.modelErrors.slice(0, 3).join("; "),
        }
  );

  // ---- 2 and 3: correctness ----
  const c = evaluation.correctness;
  if (!c) {
    gates.push({
      gate: "correctness-exhausted",
      passed: false,
      reason: "no correctness run has been performed for this candidate at these bounds",
    });
    gates.push({ gate: "no-violation", passed: false, reason: "nothing was checked" });
  } else if (c.status === "INVALID_MODEL") {
    gates.push({
      gate: "correctness-exhausted",
      passed: false,
      reason: `the model could not be evaluated: ${c.modelErrors.slice(0, 2).join("; ")}`,
    });
    gates.push({ gate: "no-violation", passed: false, reason: "nothing was checked" });
  } else if (c.status === "INCONCLUSIVE_BOUND_REACHED") {
    gates.push({
      gate: "correctness-exhausted",
      passed: false,
      reason:
        `the search stopped at the ${c.stats.capHit} cap after ${c.stats.statesVisited.toLocaleString()} states, ` +
        `so part of the space inside these bounds was never examined. This is not evidence of a bug and not evidence of safety.`,
    });
    gates.push({
      gate: "no-violation",
      passed: false,
      reason: "cannot be assessed while the search is incomplete",
    });
  } else {
    gates.push({
      gate: "correctness-exhausted",
      passed: true,
      reason: `the search ran to exhaustion over ${c.stats.statesVisited.toLocaleString()} states`,
    });
    if (c.status === "VIOLATED") {
      const steps = c.counterexample?.steps.length ?? 0;
      gates.push({
        gate: "no-violation",
        passed: false,
        reason:
          `invariant "${c.counterexample?.invariantLabel ?? "unknown"}" is violated by a ` +
          `${steps}-transition counterexample${
            c.counterexample?.faultsUsed.length
              ? ` using ${c.counterexample.faultsUsed.join(", ")}`
              : " with no injected fault"
          }`,
      });
    } else if (c.invariantsChecked.length === 0) {
      // Refused rather than passed. A search over a design with nothing to check trivially
      // finds nothing, and passing it here would make "declare no invariants" the cheapest
      // route through the gate.
      gates.push({
        gate: "no-violation",
        passed: false,
        reason: "no invariants were checked, so the absence of a violation means nothing",
      });
    } else {
      gates.push({
        gate: "no-violation",
        passed: true,
        reason: `no violation of ${c.invariantsChecked.length} invariants within the configured bounds`,
      });
    }
  }

  // ---- 4: the SLO, at the conservative end ----
  const p = evaluation.performance;
  if (!p) {
    gates.push({
      gate: "slo-satisfied",
      passed: false,
      reason: "no performance run has been performed for this candidate at these seeds",
    });
  } else if (p.unstable) {
    gates.push({
      gate: "slo-satisfied",
      passed: false,
      reason:
        "the simulation reports no steady state: some queue grows without bound, so no latency figure describes anything",
    });
  } else {
    const failures: string[] = [];
    const slo = study.targets.slo;
    if (slo.p99LatencyMs !== null) {
      // The PESSIMISTIC end of the interval, not the mean.
      //
      // A candidate whose mean p99 is 480ms against a 500ms target with a ±40ms interval has
      // not met the target; it has a coin flip on meeting the target. Gating on the mean would
      // let half the replications fail and still call it a pass, and the failures would be
      // the ones users noticed.
      const worst = p.p99Ms.high;
      if (!(worst <= slo.p99LatencyMs)) {
        failures.push(
          `p99 is ${fmt(p.p99Ms.mean)}ms (95% interval up to ${fmt(worst)}ms) against a ${slo.p99LatencyMs}ms target`
        );
      }
    }
    if (slo.maxErrorRatePct !== null) {
      const worst = p.errorRatePct.high;
      if (!(worst <= slo.maxErrorRatePct)) {
        failures.push(
          `error rate is ${fmt(p.errorRatePct.mean)}% (up to ${fmt(worst)}%) against a ${slo.maxErrorRatePct}% ceiling`
        );
      }
    }
    gates.push(
      failures.length === 0
        ? {
            gate: "slo-satisfied",
            passed: true,
            reason: `every SLO is met at the conservative end of the 95% interval over ${p.replications} replications`,
          }
        : { gate: "slo-satisfied", passed: false, reason: failures.join("; ") }
    );
  }

  // ---- 5: the business goals ----
  const b = evaluation.business;
  if (study.targets.businessGoals.length === 0) {
    gates.push({
      gate: "business-goals-satisfied",
      passed: true,
      reason: "this study declares no business goals",
    });
  } else if (!b) {
    gates.push({
      gate: "business-goals-satisfied",
      passed: false,
      reason: "no business metrics were measured for this candidate",
    });
  } else {
    const failures: string[] = [];
    for (const goal of study.targets.businessGoals) {
      const interval = businessInterval(b.metrics, goal);
      if (!interval) {
        // Not measured is not satisfied. A goal the engine could not evaluate must not open a
        // gate: that would make "name a metric the workflow never records" a way through.
        failures.push(`"${goal.label}" could not be evaluated: ${goal.metric} was not measured`);
        continue;
      }
      if (!goalHolds(goal, interval)) {
        failures.push(
          `"${goal.label}" not met: ${goal.metric} is ${fmt(interval.mean)} ` +
            `(95% interval ${fmt(interval.low)} to ${fmt(interval.high)}), needs ${goal.comparison} ${goal.value}`
        );
      }
    }
    gates.push(
      failures.length === 0
        ? {
            gate: "business-goals-satisfied",
            passed: true,
            reason: `all ${study.targets.businessGoals.length} business goals are met at the conservative end of their intervals`,
          }
        : { gate: "business-goals-satisfied", passed: false, reason: failures.join("; ") }
    );
  }

  return {
    candidateId: evaluation.candidateId,
    eligible: gates.every((g) => g.passed),
    gates,
  };
}

/**
 * Evaluate a goal against the WORST plausible value in its interval.
 *
 * For a `<=` goal that is the high end; for `>=` it is the low end. Same reasoning as the SLO
 * gate: a goal met on average is a goal missed half the time, and "we oversold on average
 * zero pizzas" is not a sentence anybody should be allowed to write.
 *
 * `==` is compared against the whole interval, so a goal of exactly zero oversells requires
 * every replication to have produced zero. That is the strictest reading and it is the right
 * one for a goal stated as an equality.
 */
function goalHolds(goal: BusinessGoal, interval: Interval): boolean {
  switch (goal.comparison) {
    case "<=":
      return interval.high <= goal.value + EPSILON;
    case ">=":
      return interval.low >= goal.value - EPSILON;
    case "==":
      return (
        interval.low >= goal.value - EPSILON && interval.high <= goal.value + EPSILON
      );
  }
}

/**
 * Tolerance for floating-point comparison of goals.
 *
 * Small enough not to admit a real miss, large enough that a count of zero measured as
 * 4e-17 by an interval calculation does not fail a goal of zero.
 */
const EPSILON = 1e-9;

function businessInterval(
  metrics: Record<string, Interval>,
  goal: BusinessGoal
): Interval | null {
  return metrics[goal.metric] ?? null;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(3);
}

/** A one-line summary of why a candidate is out, for the compare view. */
export function ineligibilityReason(decision: EligibilityDecision): string | null {
  if (decision.eligible) return null;
  const failed = decision.gates.find((g) => !g.passed);
  return failed ? failed.reason : "ineligible";
}
