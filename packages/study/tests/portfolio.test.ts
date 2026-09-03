import { describe, expect, it } from "vitest";
import {
  ArchitectureEvidenceSchema,
  StudySchema,
  contentHash,
  evaluationKey,
  studyBoundsHash,
  type CandidateEvaluation,
  type EligibilityDecision,
  type Interval,
  type Study,
} from "@sds/schema";
import { pizzaStudy } from "@sds/models";
import {
  STUDY_ENGINE_VERSION,
  accountResources,
  assemblePortfolio,
  buildPortfolio,
  cachedEvaluation,
  decideEligibility,
  evaluateCandidate,
  resourceGapNote,
} from "../src/index";

/**
 * The portfolio layer: gates, dominance, unknowns and the cache.
 *
 * These are the tests about JUDGEMENT rather than about physics. The engines below produce
 * numbers; this layer decides which candidates are allowed to be compared and what a
 * difference has to look like before it counts as a difference. Every assertion here
 * corresponds to a way the comparison could flatter a design it should not.
 *
 * Built from synthetic evaluations rather than by running the engines, deliberately. A test
 * that had to simulate seven designs to check that an overlapping interval is a tie would take
 * twenty seconds to make a point about arithmetic, and it would fail for reasons unrelated to
 * the point whenever the engines changed.
 */

const study = pizzaStudy();

function interval(mean: number, halfWidth: number, samples = 8): Interval {
  return { mean, halfWidth, low: mean - halfWidth, high: mean + halfWidth, samples };
}

function evaluation(over: Partial<CandidateEvaluation> & { candidateId: string }): CandidateEvaluation {
  return {
    evaluationId: `${over.candidateId}@test`,
    candidateRevision: 0,
    candidateHash: "h",
    engineVersion: STUDY_ENGINE_VERSION,
    seeds: [1, 2, 3, 4, 5, 6, 7, 8],
    boundsHash: "b",
    correctness: {
      status: "NO_VIOLATION_WITHIN_BOUNDS",
      counterexample: null,
      invariantsChecked: ["no-oversell"],
      bounds: study.correctness.bounds,
      faults: study.correctness.faults,
      stats: {
        statesVisited: 500,
        statesEnqueued: 500,
        transitionsApplied: 1000,
        maxDepthReached: 10,
        duplicatesPruned: 100,
        independencePruned: 10,
        depthTruncated: 0,
        quiescentTerminals: 40,
        wallMs: 20,
        exhausted: true,
        capHit: "none",
      },
      modelErrors: [],
      claim: "",
      assumptions: [],
    },
    performance: {
      throughputPerSec: interval(100, 2),
      p50Ms: interval(50, 2),
      p99Ms: interval(200, 5),
      errorRatePct: interval(0.1, 0.02),
      maxUtilization: interval(0.6, 0.02),
      replications: 8,
      seeds: [1, 2, 3, 4, 5, 6, 7, 8],
      unstable: false,
      closedFormWithheldReason: null,
    },
    business: {
      metrics: {
        oversells: interval(0, 0),
        duplicateSuccesses: interval(0, 0),
        remainingInventory: interval(0, 0),
      },
      outcomes: {},
    },
    resources: {
      cpuUnits: 10,
      memoryMb: 1000,
      storageMb: 100,
      connectionSlots: 40,
      networkBytes: 1_000_000,
      unknownAxes: [],
      unmeasuredNodes: [],
    },
    scenarios: [],
    assumptions: [],
    warnings: [],
    createdAt: 0,
    wallMs: 0,
    ...over,
  } as CandidateEvaluation;
}

function decide(e: CandidateEvaluation, modelErrors: string[] = []): EligibilityDecision {
  return decideEligibility({ study, evaluation: e, modelErrors });
}

// ---------------------------------------------------------------------------
// hard gates
// ---------------------------------------------------------------------------

describe("the hard gates", () => {
  it("passes a candidate that is valid, exhausted, unviolated and inside its SLO", () => {
    const d = decide(evaluation({ candidateId: "ok" }));
    expect(d.eligible).toBe(true);
    expect(d.gates.map((g) => g.gate)).toEqual([
      "schema-valid",
      "correctness-exhausted",
      "no-violation",
      "performance-calibrated",
      "slo-satisfied",
      "business-goals-satisfied",
    ]);
  });

  it("refuses a candidate whose search hit a cap, and does not call it violated either", () => {
    const e = evaluation({ candidateId: "capped" });
    e.correctness = {
      ...e.correctness!,
      status: "INCONCLUSIVE_BOUND_REACHED",
      stats: { ...e.correctness!.stats, exhausted: false, capHit: "states" },
    };
    const d = decide(e);
    expect(d.eligible).toBe(false);
    const exhausted = d.gates.find((g) => g.gate === "correctness-exhausted")!;
    expect(exhausted.passed).toBe(false);
    // The wording is the product. "Not evidence of a bug and not evidence of safety" is the
    // only honest description, and collapsing it either way is the failure mode this whole
    // gate ordering exists to prevent.
    expect(exhausted.reason).toContain("not evidence of a bug and not evidence of safety");
  });

  it("refuses a candidate with no invariants rather than passing it vacuously", () => {
    const e = evaluation({ candidateId: "vacuous" });
    e.correctness = { ...e.correctness!, invariantsChecked: [] };
    const d = decide(e);
    expect(d.eligible).toBe(false);
    expect(d.gates.find((g) => g.gate === "no-violation")!.reason).toContain("means nothing");
  });

  it("refuses a candidate that has never been evaluated", () => {
    const e = evaluation({ candidateId: "untested", correctness: null, performance: null });
    const d = decide(e);
    expect(d.eligible).toBe(false);
    expect(d.gates.find((g) => g.gate === "correctness-exhausted")!.reason).toContain(
      "no correctness run"
    );
  });

  it("gates the SLO on the pessimistic end of the interval, not the mean", () => {
    // Target is 500ms. Mean 480 passes on the mean and fails on the interval, and failing is
    // right: half the replications are over the line, and those are the ones users notice.
    const e = evaluation({ candidateId: "borderline" });
    e.performance = { ...e.performance!, p99Ms: interval(480, 40) };
    const d = decide(e);
    expect(d.eligible).toBe(false);
    const slo = d.gates.find((g) => g.gate === "slo-satisfied")!;
    expect(slo.reason).toContain("interval up to 520");
  });

  it("passes when the whole interval is inside the SLO", () => {
    const e = evaluation({ candidateId: "comfortable" });
    e.performance = { ...e.performance!, p99Ms: interval(300, 40) };
    expect(decide(e).eligible).toBe(true);
  });

  it("keeps an uncalibrated repository model out of the comparison", () => {
    const candidate = structuredClone(study.candidates[0]!);
    const repositoryStudy: Study = {
      ...study,
      repository: {
        name: "checkout",
        rootHint: "",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: [],
        capturedAt: 1,
      },
      candidates: [candidate],
    };
    const uncalibrated = decideEligibility({
      study: repositoryStudy,
      evaluation: evaluation({ candidateId: candidate.id }),
      modelErrors: [],
    });
    expect(uncalibrated.eligible).toBe(false);
    expect(uncalibrated.gates.find((gate) => gate.gate === "performance-calibrated")).toMatchObject({
      passed: false,
      reason: expect.stringContaining("uncalibrated"),
    });

    candidate.evidence = [
      ...candidate.design.nodes.map((node, index) =>
        ArchitectureEvidenceSchema.parse({
          id: `perf-node-${index}`,
          targetKind: "node",
          targetId: node.id,
          aspect: "performance",
          confidence: "observed",
          source: "runtime",
          claim: "Measured runtime inputs.",
        })
      ),
      ...candidate.design.edges.map((edge, index) =>
        ArchitectureEvidenceSchema.parse({
          id: `perf-edge-${index}`,
          targetKind: "edge",
          targetId: edge.id,
          aspect: "performance",
          confidence: "observed",
          source: "user",
          claim: "User supplied a measured latency.",
        })
      ),
    ];
    const calibrated = decideEligibility({
      study: repositoryStudy,
      evaluation: evaluation({ candidateId: candidate.id }),
      modelErrors: [],
    });
    expect(calibrated.gates.find((gate) => gate.gate === "performance-calibrated")?.passed).toBe(true);
  });

  it("refuses an unstable run outright rather than reporting its percentiles", () => {
    const e = evaluation({ candidateId: "unstable" });
    e.performance = { ...e.performance!, unstable: true };
    const d = decide(e);
    expect(d.eligible).toBe(false);
    expect(d.gates.find((g) => g.gate === "slo-satisfied")!.reason).toContain("no steady state");
  });

  it("fails a business goal that is met on average but not at the conservative end", () => {
    const e = evaluation({ candidateId: "sometimes" });
    e.business = {
      metrics: { ...e.business!.metrics, oversells: interval(0.5, 0.6) },
      outcomes: {},
    };
    const d = decide(e);
    expect(d.eligible).toBe(false);
    expect(d.gates.find((g) => g.gate === "business-goals-satisfied")!.reason).toContain(
      "no pizza is promised twice"
    );
  });

  it("fails a business goal whose metric was never measured", () => {
    // Not measured is not satisfied. Otherwise "name a metric the workflow never records"
    // becomes a way through the gate.
    const e = evaluation({ candidateId: "unmeasured" });
    e.business = { metrics: {}, outcomes: {} };
    const d = decide(e);
    expect(d.eligible).toBe(false);
    expect(d.gates.find((g) => g.gate === "business-goals-satisfied")!.reason).toContain(
      "could not be evaluated"
    );
  });

  it("reports the schema errors verbatim when the document does not validate", () => {
    const d = decide(evaluation({ candidateId: "broken" }), ["cache has no origin"]);
    expect(d.eligible).toBe(false);
    expect(d.gates[0]!.reason).toContain("cache has no origin");
  });
});

// ---------------------------------------------------------------------------
// Pareto dominance
// ---------------------------------------------------------------------------

describe("interval-aware Pareto dominance", () => {
  function portfolio(evaluations: CandidateEvaluation[]) {
    const decisions = evaluations.map((e) => decide(e));
    const byId: Record<string, CandidateEvaluation> = {};
    for (const e of evaluations) byId[e.candidateId] = e;
    const withCandidates: Study = {
      ...study,
      candidates: evaluations.map((e, i) => ({
        ...study.candidates[i % study.candidates.length]!,
        id: e.candidateId,
        label: e.candidateId,
      })),
    };
    return buildPortfolio({
      study: withCandidates,
      decisions,
      evaluations: byId,
      engineVersion: STUDY_ENGINE_VERSION,
    });
  }

  it("a candidate better on every axis dominates", () => {
    const fast = evaluation({ candidateId: "fast" });
    fast.performance = { ...fast.performance!, p99Ms: interval(100, 5) };
    fast.resources = { ...fast.resources, cpuUnits: 5, memoryMb: 500 };
    const slow = evaluation({ candidateId: "slow" });
    slow.performance = { ...slow.performance!, p99Ms: interval(300, 5) };

    const p = portfolio([fast, slow]);
    expect(p.frontier).toEqual(["fast"]);
    expect(p.dominated).toEqual([
      { winner: "fast", loser: "slow", strictlyBetterOn: expect.arrayContaining(["p99Ms"]) },
    ]);
  });

  it("overlapping intervals are a TIE, and both stay on the frontier", () => {
    // 180-220 versus 200-240. The data is consistent with either being faster, so calling one
    // the winner would be reporting a coin flip as a measurement.
    const a = evaluation({ candidateId: "a" });
    a.performance = { ...a.performance!, p99Ms: interval(200, 20) };
    const b = evaluation({ candidateId: "b" });
    b.performance = { ...b.performance!, p99Ms: interval(220, 20) };

    const p = portfolio([a, b]);
    expect(p.frontier.sort()).toEqual(["a", "b"]);
    expect(p.dominated).toEqual([]);
    expect(p.ties).toEqual([["a", "b"]]);
  });

  it("non-overlapping intervals do decide it", () => {
    const a = evaluation({ candidateId: "a" });
    a.performance = { ...a.performance!, p99Ms: interval(200, 5) };
    const b = evaluation({ candidateId: "b" });
    b.performance = { ...b.performance!, p99Ms: interval(260, 5) };

    const p = portfolio([a, b]);
    expect(p.frontier).toEqual(["a"]);
  });

  it("a trade-off leaves both on the frontier", () => {
    // Faster but more expensive. There is no exchange rate between milliseconds and CPU units,
    // so there is no answer, and inventing a weighting would be publishing the authors'
    // preferences as the user's.
    const fast = evaluation({ candidateId: "fast-costly" });
    fast.performance = { ...fast.performance!, p99Ms: interval(100, 5) };
    fast.resources = { ...fast.resources, cpuUnits: 40 };
    const cheap = evaluation({ candidateId: "slow-cheap" });
    cheap.performance = { ...cheap.performance!, p99Ms: interval(300, 5) };
    cheap.resources = { ...cheap.resources, cpuUnits: 4 };

    const p = portfolio([fast, cheap]);
    expect(p.frontier.sort()).toEqual(["fast-costly", "slow-cheap"]);
  });

  it("a single replication cannot pass the SLO gate, because it has no conservative end", () => {
    // Stronger than "it cannot win a comparison", and it falls out of the same principle.
    //
    // Gating on the pessimistic end of the interval requires there to be one. A single run has
    // a mean and no spread, so its `high` is NaN, and NaN fails every comparison -- which is the
    // correct answer rather than an accident. One seed is an anecdote: it cannot establish that
    // a target is met, so it does not, and the study's default of eight seeds exists so that it
    // never comes to this.
    const one = evaluation({ candidateId: "one-seed" });
    one.performance = {
      ...one.performance!,
      p99Ms: { mean: 100, halfWidth: NaN, low: NaN, high: NaN, samples: 1 },
      replications: 1,
    };
    const d = decide(one);
    expect(d.eligible).toBe(false);
    expect(d.gates.find((g) => g.gate === "slo-satisfied")!.passed).toBe(false);

    const many = evaluation({ candidateId: "eight-seeds" });
    many.performance = { ...many.performance!, p99Ms: interval(300, 5) };
    const p = portfolio([one, many]);
    // And being ineligible, it is not on the frontier however fast its single run looked.
    expect(p.frontier).toEqual(["eight-seeds"]);
  });

  it("two eligible candidates whose intervals cannot be compared are a tie", () => {
    // The dominance side of the same question, with both candidates eligible: identical numbers
    // on every axis means neither dominates and both survive.
    const a = evaluation({ candidateId: "twin-a" });
    const b = evaluation({ candidateId: "twin-b" });
    const p = portfolio([a, b]);
    expect(p.frontier.sort()).toEqual(["twin-a", "twin-b"]);
    expect(p.ties).toEqual([["twin-a", "twin-b"]]);
  });

  it("an ineligible candidate is never on the frontier, however good its numbers", () => {
    const broken = evaluation({ candidateId: "broken-but-fast" });
    broken.performance = { ...broken.performance!, p99Ms: interval(10, 1) };
    broken.resources = { ...broken.resources, cpuUnits: 1, memoryMb: 1 };
    broken.correctness = {
      ...broken.correctness!,
      status: "VIOLATED",
      counterexample: {
        invariantId: "no-oversell",
        invariantLabel: "never oversell",
        message: "two people, one pizza",
        scope: "safety",
        lanes: [],
        steps: [],
        minimal: true,
        faultsUsed: [],
      },
    };
    const sound = evaluation({ candidateId: "correct-but-slow" });
    sound.performance = { ...sound.performance!, p99Ms: interval(300, 5) };

    const p = portfolio([broken, sound]);
    expect(p.frontier).toEqual(["correct-but-slow"]);
    expect(p.claim).toContain("PARETO-OPTIMAL AMONG THE CANDIDATES TESTED");
  });

  it("says nothing at all when nothing is eligible", () => {
    const a = evaluation({ candidateId: "a", correctness: null });
    const b = evaluation({ candidateId: "b", correctness: null });
    const p = portfolio([a, b]);
    expect(p.frontier).toEqual([]);
    expect(p.claim).toContain("No candidate is eligible");
    expect(p.claim).toContain("Nothing is ranked");
  });

  it("never uses the words best or optimal without the qualifier", () => {
    const p = portfolio([evaluation({ candidateId: "a" })]);
    expect(p.claim).toContain("AMONG THE CANDIDATES TESTED");
    expect(p.claim).toContain("no candidate is called best");
    expect(p.claim).toContain("supports a claim of global optimality");
    expect(p.claim).toContain("Nothing here searched the space of possible architectures");
  });
});

// ---------------------------------------------------------------------------
// missing resource data
// ---------------------------------------------------------------------------

describe("unknown resources are never treated as zero", () => {
  it("drops an axis for everybody when one eligible candidate lacks it", () => {
    const measured = evaluation({ candidateId: "measured" });
    const unmeasured = evaluation({ candidateId: "unmeasured" });
    unmeasured.resources = {
      cpuUnits: null,
      memoryMb: null,
      storageMb: null,
      connectionSlots: null,
      networkBytes: null,
      unknownAxes: ["cpuUnits", "memoryMb", "networkBytes", "storageMb", "connectionSlots"],
      unmeasuredNodes: ["mystery box"],
    };

    const decisions = [decide(measured), decide(unmeasured)];
    const p = buildPortfolio({
      study: {
        ...study,
        candidates: [
          { ...study.candidates[0]!, id: "measured", label: "measured" },
          { ...study.candidates[1]!, id: "unmeasured", label: "unmeasured" },
        ],
      },
      decisions,
      evaluations: { measured, unmeasured },
      engineVersion: STUDY_ENGINE_VERSION,
    });

    // No resource axis at all: comparing the measured candidates among themselves while
    // excluding the unmeasured one from that axis would let it reach the frontier by having no
    // data.
    expect(p.axes.map((a) => a.id)).toEqual(["p99Ms", "errorRatePct"]);
    expect(p.warnings.join(" ")).toContain("Unknown is not treated as zero");
    expect(p.warnings.join(" ")).toContain("mystery box");
    // And with nothing to separate them, both survive.
    expect(p.frontier.sort()).toEqual(["measured", "unmeasured"]);
  });

  it("accounts a real design's resources, multiplied by replicas", () => {
    const candidate = study.candidates.find((c) => c.id === "c5-fenced-lease")!;
    const r = accountResources({ design: candidate.design, run: null });
    // Four API replicas at one CPU unit each, plus the balancer, the database and the lock.
    expect(r.cpuUnits).toBe(4 * 1 + 2 + 4 + 1);
    expect(r.memoryMb).toBe(4 * 512 + 1024 + 8192 + 256);
    expect(r.unmeasuredNodes).toEqual([]);
    // Network is per-request and there is no run, so it is unknown rather than zero.
    expect(r.networkBytes).toBeNull();
    expect(r.unknownAxes).toContain("networkBytes");
  });

  it("names the node to go and measure", () => {
    const candidate = study.candidates[0]!;
    const stripped = structuredClone(candidate.design);
    stripped.nodes = stripped.nodes.map((n) =>
      n.id === "db" ? { ...n, resources: undefined } : n
    );
    const r = accountResources({ design: stripped, run: null });
    expect(r.cpuUnits).toBeNull();
    expect(r.unmeasuredNodes).toEqual(["claims store"]);
    expect(resourceGapNote(r)).toContain("claims store");
    expect(resourceGapNote(r)).toContain("rather than assumed to be zero");
  });

  it("does not demand a storage figure from a stateless component", () => {
    // Otherwise every candidate's storage axis is unknown, and the axis is useless.
    const candidate = study.candidates.find((c) => c.id === "c6-serializable-transaction")!;
    const r = accountResources({ design: candidate.design, run: null });
    expect(r.storageMb).toBe(512);
    expect(r.unknownAxes).not.toContain("storageMb");
  });

  it("does demand one from a datastore", () => {
    const candidate = study.candidates[0]!;
    const stripped = structuredClone(candidate.design);
    stripped.nodes = stripped.nodes.map((n) =>
      n.id === "db" ? { ...n, resources: { ...n.resources!, storageMb: null } } : n
    );
    const r = accountResources({ design: stripped, run: null });
    expect(r.storageMb).toBeNull();
    expect(r.unknownAxes).toContain("storageMb");
  });

  it("excludes the client, which is the workload rather than the system", () => {
    const candidate = study.candidates[0]!;
    const r = accountResources({ design: candidate.design, run: null });
    // One API replica, the balancer and the database. No client contribution.
    expect(r.cpuUnits).toBe(1 + 2 + 4);
  });
});

// ---------------------------------------------------------------------------
// the cache
// ---------------------------------------------------------------------------

describe("the evaluation cache is content-addressed", () => {
  it("keys on the candidate, the engine, the seeds and the bounds", () => {
    const base = { candidateHash: "h1", engineVersion: "e1", seeds: [1, 2], boundsHash: "b1" };
    const key = evaluationKey(base);
    expect(evaluationKey({ ...base, candidateHash: "h2" })).not.toBe(key);
    expect(evaluationKey({ ...base, engineVersion: "e2" })).not.toBe(key);
    expect(evaluationKey({ ...base, seeds: [1, 3] })).not.toBe(key);
    expect(evaluationKey({ ...base, boundsHash: "b2" })).not.toBe(key);
    expect(evaluationKey({ ...base })).toBe(key);
  });

  it("hashes content order-independently, so key order cannot invalidate a result", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    // Arrays are ordered, because a node list's order is not semantically free -- two designs
    // with reordered edges route identically but the diff a user reads is different.
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it("a cached evaluation is found again for an unchanged candidate", () => {
    const quick = tinyStudy();
    const candidate = quick.candidates[0]!;
    const e = evaluateCandidate(quick, candidate, { skipPerformance: true });
    const key = evaluationKey({
      candidateHash: e.candidateHash,
      engineVersion: STUDY_ENGINE_VERSION,
      seeds: quick.workload.seeds,
      boundsHash: studyBoundsHash(quick),
    });
    const withCache: Study = { ...quick, evaluations: { [key]: e } };
    expect(cachedEvaluation(withCache, candidate)?.evaluationId).toBe(e.evaluationId);
  });

  it("a cached evaluation is NOT found after the design changes", () => {
    const quick = tinyStudy();
    const candidate = quick.candidates[0]!;
    const e = evaluateCandidate(quick, candidate, { skipPerformance: true });
    const key = evaluationKey({
      candidateHash: e.candidateHash,
      engineVersion: STUDY_ENGINE_VERSION,
      seeds: quick.workload.seeds,
      boundsHash: studyBoundsHash(quick),
    });
    const edited = structuredClone(candidate);
    edited.design.nodes = edited.design.nodes.map((n) =>
      n.id === "api" ? { ...n, server: { ...n.server!, concurrency: 64 } } : n
    );
    const withCache: Study = { ...quick, evaluations: { [key]: e } };
    // A stale number is worse than no number, so the miss is the feature.
    expect(cachedEvaluation(withCache, edited)).toBeNull();
  });

  it("a cached evaluation is NOT found after the bounds change", () => {
    const quick = tinyStudy();
    const candidate = quick.candidates[0]!;
    const e = evaluateCandidate(quick, candidate, { skipPerformance: true });
    const key = evaluationKey({
      candidateHash: e.candidateHash,
      engineVersion: STUDY_ENGINE_VERSION,
      seeds: quick.workload.seeds,
      boundsHash: studyBoundsHash(quick),
    });
    const wider: Study = {
      ...quick,
      evaluations: { [key]: e },
      correctness: { ...quick.correctness, bounds: { ...quick.correctness.bounds, actors: 4 } },
    };
    expect(cachedEvaluation(wider, candidate)).toBeNull();
  });

  it("is reproducible: the same candidate evaluated twice produces the same verdict", () => {
    const quick = tinyStudy();
    const candidate = quick.candidates[0]!;
    const a = evaluateCandidate(quick, candidate, { skipPerformance: true });
    const b = evaluateCandidate(quick, candidate, { skipPerformance: true });
    expect(a.candidateHash).toBe(b.candidateHash);
    expect(a.correctness!.status).toBe(b.correctness!.status);
    expect(JSON.stringify(a.correctness!.counterexample)).toBe(
      JSON.stringify(b.correctness!.counterexample)
    );
  });

  it("an untested candidate is reported ineligible rather than omitted", () => {
    const quick = tinyStudy();
    const p = assemblePortfolio(quick);
    // Omitting it would quietly shrink the comparison. Ineligible-because-untested is a state a
    // reader can act on.
    expect(p.decisions.length).toBe(quick.candidates.length);
    expect(p.decisions.every((d) => !d.eligible)).toBe(true);
    expect(p.frontier).toEqual([]);
  });

  it("the engine version is part of every evaluation, so semantics changes invalidate", () => {
    const quick = tinyStudy();
    const e = evaluateCandidate(quick, quick.candidates[0]!, { skipPerformance: true });
    expect(e.engineVersion).toBe(STUDY_ENGINE_VERSION);
    expect(e.engineVersion).toContain("explore-");
  });
});

describe("evaluation can be cancelled", () => {
  it("throws rather than returning a partial result", () => {
    const quick = tinyStudy();
    expect(() =>
      evaluateCandidate(quick, quick.candidates[0]!, {
        signal: { aborted: true },
        skipPerformance: true,
      })
    ).toThrow(/aborted/);
  });
});

describe("a stateful candidate withholds its closed-form estimate", () => {
  it("and says why", () => {
    const quick = tinyStudy();
    const e = evaluateCandidate(quick, quick.candidates[0]!, { replications: 2 });
    const reason = e.performance!.closedFormWithheldReason;
    expect(reason).not.toBeNull();
    expect(reason).toContain("branch on state");
    expect(reason).toContain("no error bound");
  });
});

/**
 * A version of the shipped study small enough to evaluate inside a unit test.
 *
 * Two candidates, a short window and two seeds. The workload is study-level, so shrinking it
 * here shrinks it for both candidates equally -- which is exactly the property the study format
 * exists to guarantee, and it is why this shortcut is safe.
 */
function tinyStudy(): Study {
  const full = pizzaStudy();
  return StudySchema.parse({
    ...full,
    candidates: [
      full.candidates.find((c) => c.id === "c1-check-then-write")!,
      full.candidates.find((c) => c.id === "c6-serializable-transaction")!,
    ],
    workload: {
      ...full.workload,
      arrival: { kind: "poisson", ratePerSec: 60 },
      durationSec: 40,
      warmupSec: 5,
      seeds: [1, 2],
      traceLimit: 0,
    },
    evaluations: {},
  });
}
