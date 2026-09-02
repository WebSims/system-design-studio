import type {
  CandidateEvaluation,
  Dominance,
  EligibilityDecision,
  Interval,
  ParetoAxis,
  PortfolioResult,
  Study,
} from "@sds/schema";

/**
 * The Pareto frontier among the candidates tested.
 *
 * "AMONG THE CANDIDATES TESTED" IS NOT A HEDGE, IT IS THE CLAIM
 *
 * Nothing here searched the space of architectures. Seven designs were written down by a person
 * or an agent and seven designs were measured, so the strongest available statement is that no
 * OTHER candidate in this study beats candidate six on every axis. Dropping the qualifier turns
 * a defensible statement into a false one, and it is the single easiest thing for a summary --
 * or an agent writing a summary -- to drop. So it is baked into the `claim` string and into the
 * axis labels, not left to the renderer.
 *
 * WHY THERE IS NO SCORE
 *
 * Because a weighted score requires exchange rates -- how many milliseconds of p99 is one CPU
 * unit worth -- and nobody has them. A tool that picked some would be publishing its authors'
 * preferences as if they were the user's, and the number would be quoted in design reviews as
 * though it meant something. A frontier says "these three are all defensible and here is what
 * you are trading", which is the actual answer.
 *
 * WHY UNCERTAIN DIFFERENCES ARE TIES
 *
 * Every sampled metric here is an estimate with a measured 95% interval. If candidate A's p99
 * interval is 180-220ms and candidate B's is 200-240ms, A is not faster than B -- the data does
 * not support it. Requiring NON-OVERLAPPING intervals before calling one better is the
 * difference between a comparison and a coin flip presented as a comparison. It also means the
 * frontier is usually larger than a naive comparison would produce, which is the honest cost of
 * not overclaiming.
 */

export interface PortfolioInput {
  study: Study;
  decisions: readonly EligibilityDecision[];
  evaluations: Readonly<Record<string, CandidateEvaluation>>;
  engineVersion: string;
}

/**
 * The axes, in a fixed order.
 *
 * Latency and error rate are sampled and therefore interval-compared. Resource axes are
 * deterministic given the design, so they are compared exactly -- but they are still SEPARATE
 * axes rather than being summed into a cost, for the same reason there is no score: adding a CPU
 * unit to a megabyte requires an exchange rate.
 */
export function axesFor(input: PortfolioInput): ParetoAxis[] {
  const axes: ParetoAxis[] = [];
  const slo = input.study.targets.slo;

  // Throughput is deliberately ABSENT as an axis.
  //
  // Under an open-loop arrival process every candidate that meets its SLO is serving the same
  // offered load, so throughput is a property of the workload rather than of the design, and
  // ranking on it would reward whichever candidate happened to shed less during the burst --
  // which the error-rate axis already captures, correctly and without double-counting.
  if (slo.p99LatencyMs !== null || true) {
    axes.push({ id: "p99Ms", label: "p99 latency (ms)", lowerIsBetter: true, sampled: true });
  }
  axes.push({ id: "errorRatePct", label: "error rate (%)", lowerIsBetter: true, sampled: true });

  const resourceAxes: Array<[string, string]> = [
    ["cpuUnits", "compute units"],
    ["memoryMb", "memory (MB)"],
    ["storageMb", "storage (MB)"],
    ["connectionSlots", "connection slots"],
    ["networkBytes", "network (bytes)"],
  ];
  for (const [id, label] of resourceAxes) {
    // An axis is included only if EVERY eligible candidate has a value for it. One unmeasured
    // candidate removes the axis for everybody, because comparing the measured ones among
    // themselves while silently excluding the unmeasured one from that axis would let it reach
    // the frontier by having no data.
    const eligible = input.decisions.filter((d) => d.eligible);
    const known = eligible.every((d) => {
      const r = input.evaluations[d.candidateId]?.resources;
      return r && (r as Record<string, unknown>)[id] !== null;
    });
    if (eligible.length > 0 && known) {
      axes.push({ id, label, lowerIsBetter: true, sampled: false });
    }
  }

  return axes;
}

export function buildPortfolio(input: PortfolioInput): PortfolioResult {
  const axes = axesFor(input);
  const eligible = input.decisions.filter((d) => d.eligible).map((d) => d.candidateId);
  const dominated: Dominance[] = [];
  const ties: Array<[string, string]> = [];
  const warnings: string[] = [];

  const excludedAxes = ["cpuUnits", "memoryMb", "storageMb", "connectionSlots", "networkBytes"]
    .filter((id) => !axes.some((a) => a.id === id));
  if (excludedAxes.length > 0 && eligible.length > 0) {
    const gaps = new Set<string>();
    for (const id of eligible) {
      for (const n of input.evaluations[id]?.resources.unmeasuredNodes ?? []) gaps.add(n);
    }
    warnings.push(
      `${excludedAxes.join(", ")} ${excludedAxes.length === 1 ? "is" : "are"} not compared, because at least one eligible candidate has no measured value for ${excludedAxes.length === 1 ? "it" : "them"}. ` +
        (gaps.size > 0
          ? `Measure ${[...gaps].join(", ")} to bring ${excludedAxes.length === 1 ? "that axis" : "those axes"} into the comparison. `
          : "") +
        `Unknown is not treated as zero: doing so would let an unmeasured design win on cost.`
    );
  }

  const beaten = new Set<string>();
  for (const a of eligible) {
    for (const b of eligible) {
      if (a === b) continue;
      const verdict = compare(a, b, axes, input);
      if (verdict.kind === "dominates") {
        dominated.push({ winner: a, loser: b, strictlyBetterOn: verdict.betterOn });
        beaten.add(b);
      } else if (verdict.kind === "tie" && a < b) {
        ties.push([a, b]);
      }
    }
  }

  const frontier = eligible.filter((id) => !beaten.has(id));

  return {
    studyId: input.study.id,
    engineVersion: input.engineVersion,
    decisions: [...input.decisions],
    frontier,
    dominated,
    ties,
    axes,
    claim: claimFor(input, frontier, eligible, axes),
    warnings,
  };
}

type Verdict =
  | { kind: "dominates"; betterOn: string[] }
  | { kind: "dominated" }
  | { kind: "tie" }
  | { kind: "incomparable" };

/**
 * Does `a` dominate `b`?
 *
 * Pareto dominance: no worse on any axis, and strictly better on at least one. With intervals,
 * "no worse" means "not strictly worse" and "strictly better" means the intervals do not
 * overlap. A pair that is indistinguishable on every axis is a TIE and is reported as such --
 * neither dominates, both stay on the frontier, and the report says the difference is inside
 * the noise rather than picking one.
 */
function compare(a: string, b: string, axes: readonly ParetoAxis[], input: PortfolioInput): Verdict {
  const betterOn: string[] = [];
  let worseOnSomething = false;
  let anyComparable = false;

  for (const axis of axes) {
    const va = valueOn(a, axis, input);
    const vb = valueOn(b, axis, input);
    if (!va || !vb) continue;
    anyComparable = true;

    const cmp = axis.sampled
      ? compareIntervals(va as Interval, vb as Interval, axis.lowerIsBetter)
      : compareScalars(va as number, vb as number, axis.lowerIsBetter);

    if (cmp === "better") betterOn.push(axis.id);
    else if (cmp === "worse") worseOnSomething = true;
  }

  if (!anyComparable) return { kind: "incomparable" };
  if (betterOn.length > 0 && !worseOnSomething) return { kind: "dominates", betterOn };
  if (worseOnSomething && betterOn.length === 0) return { kind: "dominated" };
  if (betterOn.length === 0 && !worseOnSomething) return { kind: "tie" };
  return { kind: "incomparable" };
}

/**
 * Compare two sampled metrics.
 *
 * Non-overlapping intervals or nothing. An overlap means the two runs are consistent with
 * either design being faster, and reporting one as better on that evidence is the mistake this
 * whole module exists to avoid.
 */
function compareIntervals(
  a: Interval,
  b: Interval,
  lowerIsBetter: boolean
): "better" | "worse" | "same" {
  // A single replication has no half-width, so it has no interval and cannot support a
  // comparison. Treated as indistinguishable rather than compared on its mean: one run is an
  // anecdote and the study's default of eight seeds exists so that it never comes to this.
  if (!Number.isFinite(a.halfWidth) || !Number.isFinite(b.halfWidth)) return "same";

  const aBeatsB = lowerIsBetter ? a.high < b.low : a.low > b.high;
  const bBeatsA = lowerIsBetter ? b.high < a.low : b.low > a.high;
  if (aBeatsB) return "better";
  if (bBeatsA) return "worse";
  return "same";
}

/**
 * Compare two deterministic metrics.
 *
 * Resource totals are exact functions of the design, so an exact comparison is right -- but a
 * relative tolerance is still applied. Two candidates differing by a thousandth of a CPU unit
 * are the same candidate for any purpose a reader has, and letting a difference that small
 * decide a dominance relation would make the frontier depend on rounding.
 */
function compareScalars(
  a: number,
  b: number,
  lowerIsBetter: boolean
): "better" | "worse" | "same" {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  if (Math.abs(a - b) / scale < 0.005) return "same";
  const aBetter = lowerIsBetter ? a < b : a > b;
  return aBetter ? "better" : "worse";
}

function valueOn(
  candidateId: string,
  axis: ParetoAxis,
  input: PortfolioInput
): Interval | number | null {
  const e = input.evaluations[candidateId];
  if (!e) return null;
  if (axis.id === "p99Ms") return e.performance?.p99Ms ?? null;
  if (axis.id === "errorRatePct") return e.performance?.errorRatePct ?? null;
  const v = (e.resources as unknown as Record<string, number | null>)[axis.id];
  return v ?? null;
}

function claimFor(
  input: PortfolioInput,
  frontier: readonly string[],
  eligible: readonly string[],
  axes: readonly ParetoAxis[]
): string {
  const total = input.decisions.length;
  const labelOf = (id: string) =>
    input.study.candidates.find((c) => c.id === id)?.label ?? id;

  // An empty study is the product's starting state, so this is the first sentence a new user
  // reads. "Each failed a gate" would be vacuously true of nothing and would read as a fault
  // report on a study that has not been asked a question yet.
  if (total === 0) {
    return (
      `Nothing to compare yet: this study has no candidate architectures. ` +
      `Add at least two, so the comparison has something to be between.`
    );
  }

  if (eligible.length === 0) {
    return (
      `No candidate is eligible for comparison. ${total} ${total === 1 ? "was" : "were"} tested; ` +
      `each failed at least one hard gate, and the reasons are listed per candidate. ` +
      `Nothing is ranked, because ranking designs that do not solve the problem would be ranking them on the wrong question.`
    );
  }

  const axisNames = axes.map((a) => a.label).join(", ");
  const front = frontier.map(labelOf).join("; ");

  return (
    `${frontier.length} of ${eligible.length} eligible candidate${eligible.length === 1 ? "" : "s"} ` +
    `(out of ${total} tested) ${frontier.length === 1 ? "is" : "are"} PARETO-OPTIMAL AMONG THE CANDIDATES TESTED: ${front}. ` +
    `Axes compared: ${axisNames}. No weighting was applied and no candidate is called best. ` +
    `Nothing here searched the space of possible architectures, so nothing here supports a claim of global optimality -- ` +
    `only that no other candidate in this study beats these on every axis. ` +
    `Differences smaller than the measured 95% intervals are reported as ties rather than as wins.`
  );
}
