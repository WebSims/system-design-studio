import { z } from "zod";
import { ExprSchema } from "./domain";
import { ArrivalProcessSchema, DesignSchema, RequestClassSchema, SloSchema } from "./design";

/**
 * The study document: one problem, many candidate architectures, one shared yardstick.
 *
 * WHY A STUDY IS NOT JUST A FOLDER OF DESIGNS
 *
 * Because the interesting question is never "is this design good", it is "is this
 * design better than the alternatives, on evidence, for this problem". A folder of
 * designs cannot answer that, for a reason that sounds pedantic and is not: each
 * design carries its own workload and its own SLO, so the cheapest way to win a
 * comparison is to quietly lower the bar. Halve the arrival rate, widen the p99
 * target, and a design that fails becomes a design that passes. Nobody does this on
 * purpose. Everybody does it by accident, because the workload lives next to the
 * design being edited and gets edited with it.
 *
 * So the study owns the yardstick. Workload, SLOs, business goals, correctness
 * contract and exploration bounds are study-level and canonical; a candidate's local
 * copies are overwritten from the study before every evaluation (see
 * `syncCandidateToStudy`). A candidate can differ from its rivals in architecture and
 * in nothing else. That is the only arrangement in which "candidate 7 beat candidate 1"
 * means anything.
 *
 * WHY EVALUATIONS ARE CACHED BY HASH RATHER THAN BY TIMESTAMP
 *
 * Because a stale number is worse than no number. The cache key covers the candidate's
 * content, the engine version, the seeds and the bounds -- everything that could change
 * the answer. Change any of them and the cache misses, which is the point: a result
 * shown next to a design must have been produced by that design.
 */

// ---------------------------------------------------------------------------
// product contract
// ---------------------------------------------------------------------------

/**
 * What a recorded business outcome means.
 *
 * The workflow's `respond` operations tag themselves with free-text outcome labels;
 * this is where a label acquires meaning. The mapping is what lets the studio say
 * "three duplicate successes" instead of "three responses tagged dup2", and -- more
 * importantly -- it is what lets the eligibility gate know that `oversell` is a
 * failure even though the request that produced it returned HTTP 200.
 *
 * That last point is the whole reason this type exists. Every oversell in history was
 * a successful response.
 */
export const OutcomeKindSchema = z.enum([
  /** The intended happy path: one unit allocated to one entitled claimant. */
  "valid",
  /** Succeeded, but the same logical claim already succeeded. A correctness failure. */
  "duplicate",
  /** Correctly refused: sold out, not entitled, already claimed. Not a failure. */
  "rejected",
  /** Allocated a unit that did not exist. A correctness failure. */
  "oversell",
  /** A reservation that timed out before confirmation. */
  "expired",
  /** The system failed to answer. */
  "error",
]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const ContractOutcomeSchema = z
  .object({
    /** Must match an `outcome` label used by a `respond` operation. */
    label: z.string().min(1).max(64),
    kind: OutcomeKindSchema,
    description: z.string().default(""),
  })
  .strict();
export type ContractOutcome = z.infer<typeof ContractOutcomeSchema>;

/**
 * A promise the product makes, and the invariant that checks it.
 *
 * `invariantId` may be null, and when it is, the studio labels the promise
 * UNVERIFIED and keeps saying so. This is deliberately uncomfortable. A design review
 * where three of five promises are unverified is a useful document; one where the
 * unverified promises are invisible is a liability, because a reader assumes the tool
 * checked everything it displayed.
 */
export const ContractPromiseSchema = z
  .object({
    id: z.string().min(1).max(64),
    statement: z.string().min(1),
    invariantId: z.string().min(1).nullable().default(null),
  })
  .strict();
export type ContractPromise = z.infer<typeof ContractPromiseSchema>;

export const ProductContractSchema = z
  .object({
    summary: z.string().default(""),
    outcomes: z.array(ContractOutcomeSchema).max(32).default([]),
    promises: z.array(ContractPromiseSchema).max(32).default([]),
    /**
     * What this study explicitly is not trying to establish.
     *
     * Carried in the document and rendered in every report, because the most
     * expensive misreading of a result is not "the number is wrong", it is "the
     * number answered a question I wasn't asking".
     */
    nonGoals: z.array(z.string()).max(32).default([]),
  })
  .strict();
export type ProductContract = z.infer<typeof ProductContractSchema>;

// ---------------------------------------------------------------------------
// correctness contract
// ---------------------------------------------------------------------------

/**
 * When an invariant is checked.
 *
 * `safety` is checked after EVERY transition. It is a statement that must never be
 * false, even momentarily, even mid-handler: "allocations never exceed inventory".
 *
 * `postcondition` is checked only at quiescence -- when no actor can move and no
 * timer can fire. It is a statement about the end state: "inventory plus allocations
 * equals what we started with". Checking it mid-flight would report violations that
 * are merely a handler halfway through its work.
 *
 * WHAT IS NOT HERE
 *
 * Liveness, fairness, and temporal operators generally. "Eventually every reservation
 * is resolved" is a true and important property and this engine cannot check it: it
 * requires reasoning about infinite runs, and every run here is bounded by
 * construction. Offering a syntax for it would produce results whose meaning depended
 * on the bound, which is exactly the kind of number this tool refuses to print.
 */
export const InvariantScopeSchema = z.enum(["safety", "postcondition"]);
export type InvariantScope = z.infer<typeof InvariantScopeSchema>;

export const InvariantSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1),
    scope: InvariantScopeSchema.default("safety"),
    /** Must evaluate to a boolean. Absent (null) is treated as a violation. */
    expr: ExprSchema,
    /** Shown verbatim when violated. Write it as the bug, not as the rule. */
    message: z.string().default(""),
  })
  .strict();
export type Invariant = z.infer<typeof InvariantSchema>;

/**
 * The application-level failures the explorer is allowed to inject.
 *
 * Each flag costs state space, so each is separately switchable and the total is
 * capped by `ExplorationBounds.faults`. All seven are v1 scope; all seven are
 * *application-level*, meaning they are things a single-region system with a working
 * network still does to itself. Partitions, replica divergence and clock skew are
 * deferred, and their absence is reported in the assumptions of every result rather
 * than left for a reader to discover.
 */
export const FaultModelSchema = z
  .object({
    /** The same logical request submitted twice from outside, with a fresh key. */
    duplicateRequest: z.boolean().default(true),
    /** A caller times out and retries carrying the SAME idempotency key. */
    retrySameKey: z.boolean().default(true),
    /**
     * A caller times out and retries carrying a DIFFERENT key.
     *
     * The failure mode that defeats idempotency, and the one people forget: a retry
     * is only deduplicable if the key was generated before the first attempt, not
     * per attempt. Modelled separately because a design can be safe under one and
     * broken under the other.
     */
    retryNewKey: z.boolean().default(true),
    /** A worker dies after a durable write and before its response or ack. */
    workerCrash: z.boolean().default(true),
    /** An at-least-once queue delivers a message again before it was acked. */
    queueRedelivery: z.boolean().default(true),
    /** A lease expires while its holder is still working and still believes it holds. */
    leaseExpiry: z.boolean().default(true),
    /** A scheduled expiry fires, possibly racing the request that armed it. */
    reservationExpiry: z.boolean().default(true),
  })
  .strict();
export type FaultModel = z.infer<typeof FaultModelSchema>;

/**
 * The explicit limits of an exploration, and therefore the exact scope of the claim
 * it can support.
 *
 * THESE NUMBERS ARE THE PRODUCT.
 *
 * "No violation found" is meaningless without them and defensible with them. Every
 * result carries the bounds it ran under, every report prints them, and the phrase
 * "proved safe" appears nowhere in this codebase, because a bounded search cannot
 * establish it.
 *
 * The defaults are chosen from what the failures actually need, not from what looks
 * thorough. Every application-level race in the v1 fault model is exhibited by three
 * actors and one fault -- two contenders plus one interfering retry or timer is the
 * shape of a lost update, a double claim, a stale-lease write and a duplicate
 * consumer. Raising the actor count multiplies the state space to re-find the same
 * counterexample with more witnesses.
 */
export const ExplorationBoundsSchema = z
  .object({
    /** Initial concurrent requests. Consumers, timers and retries may create later lanes. */
    actors: z.number().int().min(1).max(6).default(3),
    /** Injected faults per execution. */
    faults: z.number().int().min(0).max(4).default(1),
    /** Transitions along any single execution before it is truncated. */
    transitions: z.number().int().min(1).max(500).default(40),
    /**
     * Distinct states visited before the search stops.
     *
     * Hitting this yields INCONCLUSIVE_BOUND_REACHED, never a safe verdict. That
     * asymmetry is the single most important behaviour in the explorer.
     */
    states: z.number().int().min(100).max(20_000_000).default(100_000),
    /**
     * Wall-clock budget, ms. Also yields inconclusive when hit.
     *
     * THIS IS A HANG GUARD, NOT A BUDGET, AND THE DEFAULT IS SET ACCORDINGLY.
     *
     * A wall-clock cap is the one bound that makes a verdict depend on the machine: the same
     * study on a loaded host can report INCONCLUSIVE_BOUND_REACHED where an idle one reports
     * NO_VIOLATION_WITHIN_BOUNDS. That is disclosed rather than hidden -- `stats.capHit` says
     * which happened -- but it is still a property nobody wants, so the default is set far above
     * what any reasonable search needs rather than close to it.
     *
     * An earlier default of five seconds was chosen because it felt responsive. The shipped
     * seven-candidate portfolio completes in about a second, which looked like ample headroom
     * until the test suite ran the searches alongside a dozen simulation files and the queue
     * candidate took five seconds of contended CPU -- flipping its verdict from VIOLATED to
     * inconclusive, and with it four gates and the entire Pareto frontier. The bug was in the
     * default, not in the search.
     *
     * The state cap is the bound that is meant to bite, because it is a property of the problem
     * rather than of the hardware. This one exists so that a pathological design cannot wedge a
     * UI, and the evaluation runs in a worker with an abort signal for the cases it does not
     * catch.
     */
    timeMs: z.number().int().min(50).max(600_000).default(30_000),
  })
  .strict();
export type ExplorationBounds = z.infer<typeof ExplorationBoundsSchema>;

export const CorrectnessContractSchema = z
  .object({
    invariants: z.array(InvariantSchema).max(32).default([]),
    faults: FaultModelSchema.default({}),
    bounds: ExplorationBoundsSchema.default({}),
    /**
     * Distinct values each request field may take during exploration, overriding the
     * field's own `exploreDomain`. Study-level so every candidate contends over the
     * same identities.
     */
    identityDomains: z.record(z.array(z.union([z.number(), z.boolean(), z.string()])).max(8))
      .default({}),
    /**
     * Counter values to substitute in the initial state during exploration.
     *
     * WHY THIS IS NECESSARY AND NOT A CHEAT
     *
     * The performance run wants a realistic inventory -- two hundred pizzas, so that
     * contention, throughput and time-to-exhaust mean something. The correctness search
     * wants an inventory of one, because overselling two hundred pizzas requires at least
     * two hundred and one concurrent actors, and the search is bounded at three. With a
     * realistic inventory the oversell invariant is unfalsifiable, and the explorer would
     * report NO_VIOLATION_WITHIN_BOUNDS for a design that oversells every time it is
     * deployed.
     *
     * That is the worst possible outcome, so the initial state is part of the exploration
     * bounds and is stated explicitly here rather than being quietly scaled. It is
     * study-level, so every candidate faces the same scarcity, and it is reported in the
     * claim so a reader knows the search was run against an inventory of one.
     *
     * It is restricted to counters. Substituting table rows would change which
     * identities exist, and identity is what `identityDomains` is for.
     */
    stateOverrides: z.record(z.number().int()).default({}),
  })
  .strict();
export type CorrectnessContract = z.infer<typeof CorrectnessContractSchema>;

// ---------------------------------------------------------------------------
// workload and goals
// ---------------------------------------------------------------------------

/**
 * The one workload every candidate is measured against.
 *
 * Canonical, and pushed into candidates rather than read from them. See the file
 * header: this field is the anti-cheating mechanism.
 */
export const StudyWorkloadSchema = z
  .object({
    arrival: ArrivalProcessSchema,
    durationSec: z.number().positive().default(1200),
    warmupSec: z.number().nonnegative().default(200),
    /**
     * Independent seeds. One seed is an anecdote.
     *
     * Shared across candidates so comparisons are PAIRED -- the same arrival
     * sequence hits every architecture, so a difference between two candidates is
     * not a difference between two workloads. This is the common-random-numbers
     * property the RNG was built for.
     */
    seeds: z.array(z.number().int().nonnegative()).min(1).max(64).default([1, 2, 3, 4, 5, 6, 7, 8]),
    traceLimit: z.number().int().nonnegative().default(5000),
    classes: z.array(RequestClassSchema).max(16).default([]),
  })
  .strict();
export type StudyWorkload = z.infer<typeof StudyWorkloadSchema>;

/**
 * Business metrics the workflow layer produces.
 *
 * Kept as a closed enum rather than free strings so a goal cannot reference a metric
 * that will never be measured -- which would silently never fail.
 */
export const BusinessMetricSchema = z.enum([
  "validAllocations",
  "duplicateSuccesses",
  "oversells",
  "remainingInventory",
  "expiredReservations",
  "strandedReservations",
  "idempotencyHits",
  "transactionConflicts",
  "lockWaitMsP99",
  "redeliveries",
  "abandonedMessages",
  "timeToExhaustSec",
  "staleOwnerRejections",
]);
export type BusinessMetric = z.infer<typeof BusinessMetricSchema>;

export const BusinessGoalSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1),
    metric: BusinessMetricSchema,
    comparison: z.enum(["<=", ">=", "=="]),
    value: z.number(),
  })
  .strict();
export type BusinessGoal = z.infer<typeof BusinessGoalSchema>;

/**
 * The bar. Latency and error SLOs plus business goals, all study-level.
 *
 * `businessGoals` sit beside the SLOs rather than under them because they fail
 * independently: a design can serve every request in 40ms with a 0% error rate and
 * sell three hundred pizzas it does not have. A tool that ranked on latency alone
 * would call that the winner.
 */
export const StudyTargetsSchema = z
  .object({
    slo: SloSchema.default({}),
    businessGoals: z.array(BusinessGoalSchema).max(32).default([]),
  })
  .strict();
export type StudyTargets = z.infer<typeof StudyTargetsSchema>;

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

/**
 * Who authored a candidate.
 *
 * Rendered everywhere, never inferred, and never editable by the author it describes.
 * An agent cannot mark its own work human, because the WebMCP tool that creates
 * candidates sets this field itself and does not accept it as a parameter.
 */
export const CandidateOriginSchema = z.enum(["human", "agent", "library"]);
export type CandidateOrigin = z.infer<typeof CandidateOriginSchema>;

export const CandidateSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1),
    /**
     * Which pattern this is an instance of, for the library portfolio. Free text;
     * used for grouping in the compare view and for nothing load-bearing.
     */
    pattern: z.string().default(""),
    origin: CandidateOriginSchema.default("human"),
    /**
     * Monotonic revision, incremented on every accepted draft replacement.
     *
     * The concurrency control for agent edits: `studio_replace_candidate_draft`
     * requires the caller to state the revision it believes it is replacing, so two
     * agents (or an agent and a human) cannot silently clobber each other. Without
     * it, the last writer wins and the loser never finds out.
     */
    revision: z.number().int().nonnegative().default(0),
    notes: z.string().default(""),
    /**
     * Why this candidate is expected to be interesting -- including "this one is
     * deliberately broken". The library portfolio ships four candidates that are
     * meant to fail, and a reader needs to know that is intentional.
     */
    intent: z.string().default(""),
    design: DesignSchema,
  })
  .strict();
export type Candidate = z.infer<typeof CandidateSchema>;

// ---------------------------------------------------------------------------
// results: correctness
// ---------------------------------------------------------------------------

/**
 * The four possible correctness verdicts. There is no fifth, and in particular there
 * is no "SAFE".
 *
 *   VIOLATED                      -- an invariant was falsified. A counterexample is
 *                                    attached and it is minimal in transition count.
 *   NO_VIOLATION_WITHIN_BOUNDS    -- the search EXHAUSTED the configured bounds and
 *                                    found nothing. The strongest available claim.
 *   INCONCLUSIVE_BOUND_REACHED    -- a state or time cap stopped the search early.
 *                                    Says nothing about safety in either direction.
 *   INVALID_MODEL                 -- the workflow or contract does not typecheck.
 *                                    Not a correctness result at all.
 */
export const CorrectnessStatusSchema = z.enum([
  "VIOLATED",
  "NO_VIOLATION_WITHIN_BOUNDS",
  "INCONCLUSIVE_BOUND_REACHED",
  "INVALID_MODEL",
]);
export type CorrectnessStatus = z.infer<typeof CorrectnessStatusSchema>;

export const FaultKindSchema = z.enum([
  "duplicate-request",
  "retry-same-key",
  "retry-new-key",
  "worker-crash",
  "queue-redelivery",
  "lease-expiry",
  "reservation-expiry",
  "caller-timeout",
]);
export type FaultKind = z.infer<typeof FaultKindSchema>;

/** One concurrent thread of control in a counterexample. Rendered as a swimlane. */
export const ActorLaneSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["request", "queue-consumer", "expiry-timer", "system"]),
    /** Handler this lane is executing. */
    handlerId: z.string(),
    /** The identity fields this lane's request carries, for reading the trace. */
    identity: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
  })
  .strict();
export type ActorLane = z.infer<typeof ActorLaneSchema>;

/**
 * One observable change to state.
 *
 * Both `before` and `after` are carried rather than just the new value, because the
 * whole content of a lost-update counterexample is that `before` was not what the
 * writer thought it was.
 */
export const StateDiffSchema = z
  .object({
    collection: z.string(),
    key: z.string().nullable().default(null),
    field: z.string().nullable().default(null),
    before: z.union([z.number(), z.boolean(), z.string()]).nullable().default(null),
    after: z.union([z.number(), z.boolean(), z.string()]).nullable().default(null),
  })
  .strict();
export type StateDiff = z.infer<typeof StateDiffSchema>;

export const CounterexampleStepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    laneId: z.string(),
    /** Operation id from the workflow, or a synthetic id for a fault transition. */
    opId: z.string(),
    opKind: z.string(),
    /** Plain-language description, generated from the operation. Never AI-written. */
    label: z.string(),
    fault: FaultKindSchema.nullable().default(null),
    diffs: z.array(StateDiffSchema).default([]),
    /** Locals bound by this step, so a reader can see what the actor believed. */
    observed: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
  })
  .strict();
export type CounterexampleStep = z.infer<typeof CounterexampleStepSchema>;

export const CounterexampleSchema = z
  .object({
    invariantId: z.string(),
    invariantLabel: z.string(),
    message: z.string(),
    scope: InvariantScopeSchema,
    lanes: z.array(ActorLaneSchema),
    steps: z.array(CounterexampleStepSchema),
    /**
     * True when breadth-first order guarantees no shorter counterexample exists.
     *
     * Always true for the shipped explorer, and carried explicitly anyway so that a
     * future search order which cannot make the claim is unable to imply it by
     * omission.
     */
    minimal: z.boolean().default(true),
    faultsUsed: z.array(FaultKindSchema).default([]),
  })
  .strict();
export type Counterexample = z.infer<typeof CounterexampleSchema>;

export const ExplorationStatsSchema = z
  .object({
    statesVisited: z.number().int().nonnegative(),
    statesEnqueued: z.number().int().nonnegative(),
    transitionsApplied: z.number().int().nonnegative(),
    maxDepthReached: z.number().int().nonnegative(),
    /** States skipped because an equivalent one was already visited. */
    duplicatesPruned: z.number().int().nonnegative(),
    /** Transitions skipped by independence reduction. */
    independencePruned: z.number().int().nonnegative(),
    /** Executions truncated by the transition bound rather than reaching quiescence. */
    depthTruncated: z.number().int().nonnegative(),
    /** Executions that ran to quiescence with all postconditions checked. */
    quiescentTerminals: z.number().int().nonnegative(),
    wallMs: z.number().nonnegative(),
    exhausted: z.boolean(),
    capHit: z.enum(["states", "time", "none"]),
  })
  .strict();
export type ExplorationStats = z.infer<typeof ExplorationStatsSchema>;

export const CorrectnessResultSchema = z
  .object({
    status: CorrectnessStatusSchema,
    counterexample: CounterexampleSchema.nullable().default(null),
    /** Invariants that were actually checked. Empty means the claim is vacuous. */
    invariantsChecked: z.array(z.string()).default([]),
    bounds: ExplorationBoundsSchema,
    faults: FaultModelSchema,
    stats: ExplorationStatsSchema,
    /** Why the model was rejected, when status is INVALID_MODEL. */
    modelErrors: z.array(z.string()).default([]),
    /**
     * The scope of the claim, in prose, assembled from the bounds and fault model.
     *
     * Generated rather than authored so it cannot fall out of step with the numbers
     * it describes, and attached to the result rather than the UI so the CLI, the
     * report and the WebMCP tool all say the same thing.
     */
    claim: z.string().default(""),
    assumptions: z.array(z.string()).default([]),
  })
  .strict();
export type CorrectnessResult = z.infer<typeof CorrectnessResultSchema>;

// ---------------------------------------------------------------------------
// results: performance, business, resources
// ---------------------------------------------------------------------------

/**
 * A measured interval over independent replications.
 *
 * Declared here rather than imported from @sds/core because the schema package sits
 * below the engine and must not depend on it. The engine maps its own
 * `Interval` into this shape, and the round-trip test pins the mapping.
 */
export const IntervalSchema = z
  .object({
    mean: z.number(),
    /** Student-t 95% half-width. NaN with a single replication, on purpose. */
    halfWidth: z.number(),
    low: z.number(),
    high: z.number(),
    samples: z.number().int().nonnegative(),
  })
  .strict();
export type Interval = z.infer<typeof IntervalSchema>;

export const PerformanceSummarySchema = z
  .object({
    throughputPerSec: IntervalSchema,
    p50Ms: IntervalSchema,
    p99Ms: IntervalSchema,
    errorRatePct: IntervalSchema,
    maxUtilization: IntervalSchema,
    replications: z.number().int().positive(),
    seeds: z.array(z.number().int()),
    /** Simulation reported the run as non-stationary. Rankings are then withheld. */
    unstable: z.boolean().default(false),
    /**
     * Why a closed-form estimate was not produced.
     *
     * Null means one was. Non-null is the honest case for any stateful workflow: a
     * handler that branches on state has a service-time distribution that depends on
     * the state, and the queueing formulas assume it does not.
     */
    closedFormWithheldReason: z.string().nullable().default(null),
  })
  .strict();
export type PerformanceSummary = z.infer<typeof PerformanceSummarySchema>;

export const BusinessSummarySchema = z
  .object({
    metrics: z.record(IntervalSchema).default({}),
    outcomes: z.record(IntervalSchema).default({}),
  })
  .strict();
export type BusinessSummary = z.infer<typeof BusinessSummarySchema>;

/**
 * Resource totals, each independently unknown.
 *
 * `unknownAxes` lists the axes where at least one contributing node had no measured
 * profile. Those axes are excluded from Pareto comparison entirely rather than filled
 * with zero, because filling with zero is how an unmeasured design wins.
 */
export const ResourceAccountingSchema = z
  .object({
    cpuUnits: z.number().nonnegative().nullable().default(null),
    memoryMb: z.number().nonnegative().nullable().default(null),
    storageMb: z.number().nonnegative().nullable().default(null),
    connectionSlots: z.number().nonnegative().nullable().default(null),
    networkBytes: z.number().nonnegative().nullable().default(null),
    unknownAxes: z.array(z.string()).default([]),
    /** Nodes that contributed no profile, so a reader knows what to go and measure. */
    unmeasuredNodes: z.array(z.string()).default([]),
  })
  .strict();
export type ResourceAccounting = z.infer<typeof ResourceAccountingSchema>;

// ---------------------------------------------------------------------------
// results: candidate evaluation and portfolio
// ---------------------------------------------------------------------------

/**
 * Everything known about one candidate, and the exact conditions under which it was
 * learned.
 *
 * The five identity fields at the top are not bookkeeping. They are the reason a
 * number displayed in the compare view can be trusted: change the candidate, the
 * engine, the seeds or the bounds and this record no longer matches, so it is not
 * shown.
 */
export const CandidateEvaluationSchema = z
  .object({
    evaluationId: z.string().min(1),
    candidateId: z.string().min(1),
    candidateRevision: z.number().int().nonnegative(),
    /** Content hash of the synchronised candidate design. */
    candidateHash: z.string().min(1),
    engineVersion: z.string().min(1),
    seeds: z.array(z.number().int()),
    boundsHash: z.string().min(1),
    correctness: CorrectnessResultSchema.nullable().default(null),
    performance: PerformanceSummarySchema.nullable().default(null),
    business: BusinessSummarySchema.nullable().default(null),
    resources: ResourceAccountingSchema.default({}),
    /** Modelling assumptions in force. Always non-empty in practice. */
    assumptions: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
    createdAt: z.number().int().nonnegative().default(0),
    wallMs: z.number().nonnegative().default(0),
  })
  .strict();
export type CandidateEvaluation = z.infer<typeof CandidateEvaluationSchema>;

/**
 * One hard gate, and why it did or did not open.
 *
 * Gates are sequential and reported individually rather than collapsed to a boolean,
 * because "ineligible" is not useful feedback and "ineligible: correctness search hit
 * the state cap at 100,000 states, raise the bound or narrow the fault model" is.
 */
export const EligibilityGateSchema = z.enum([
  "schema-valid",
  "correctness-exhausted",
  "no-violation",
  "slo-satisfied",
  "business-goals-satisfied",
]);
export type EligibilityGate = z.infer<typeof EligibilityGateSchema>;

export const GateOutcomeSchema = z
  .object({
    gate: EligibilityGateSchema,
    passed: z.boolean(),
    reason: z.string().default(""),
  })
  .strict();
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

export const EligibilityDecisionSchema = z
  .object({
    candidateId: z.string(),
    eligible: z.boolean(),
    gates: z.array(GateOutcomeSchema),
  })
  .strict();
export type EligibilityDecision = z.infer<typeof EligibilityDecisionSchema>;

/**
 * The comparison outcome.
 *
 * `frontier` is the Pareto-optimal set AMONG THE CANDIDATES TESTED. That qualifier is
 * carried in the type's documentation, in the `claim` string, and in every rendering,
 * because dropping it turns a defensible statement into a false one: nothing here
 * searched the space of all architectures, so nothing here can call anything best.
 */
export const ParetoAxisSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    /** Whether a smaller value is preferable on this axis. */
    lowerIsBetter: z.boolean(),
    /** True when the axis is measured with uncertainty and needs interval logic. */
    sampled: z.boolean(),
  })
  .strict();
export type ParetoAxis = z.infer<typeof ParetoAxisSchema>;

export const DominanceSchema = z
  .object({
    winner: z.string(),
    loser: z.string(),
    /** Axes on which the winner is strictly better with non-overlapping intervals. */
    strictlyBetterOn: z.array(z.string()),
  })
  .strict();
export type Dominance = z.infer<typeof DominanceSchema>;

export const PortfolioResultSchema = z
  .object({
    studyId: z.string(),
    engineVersion: z.string(),
    decisions: z.array(EligibilityDecisionSchema),
    /** Eligible candidates no other eligible candidate dominates. */
    frontier: z.array(z.string()),
    dominated: z.array(DominanceSchema),
    /** Pairs whose difference is inside the noise. Explicitly not ranked. */
    ties: z.array(z.tuple([z.string(), z.string()])),
    axes: z.array(ParetoAxisSchema),
    claim: z.string().default(""),
    warnings: z.array(z.string()).default([]),
  })
  .strict();
export type PortfolioResult = z.infer<typeof PortfolioResultSchema>;

// ---------------------------------------------------------------------------
// the study document
// ---------------------------------------------------------------------------

export const STUDY_SCHEMA_VERSION = 1 as const;

export const StudySchema = z
  .object({
    version: z.literal(STUDY_SCHEMA_VERSION),
    id: z.string().min(1).max(64),
    name: z.string().default("untitled study"),
    /**
     * The problem in the words of whoever has it.
     *
     * First field a reader sees and the only one the engine never touches. It exists
     * because a study whose problem statement has drifted from its invariants is a
     * study that is measuring the wrong thing, and the only way anyone notices is by
     * reading the two next to each other.
     */
    problem: z.string().default(""),
    contract: ProductContractSchema.default({}),
    workload: StudyWorkloadSchema,
    targets: StudyTargetsSchema.default({}),
    correctness: CorrectnessContractSchema.default({}),
    candidates: z.array(CandidateSchema).max(64).default([]),
    /**
     * Cached evaluations, keyed by `evaluationKey(...)`.
     *
     * Persisted with the study so reopening it does not silently discard hours of
     * exploration, and keyed by content so reopening it cannot silently show a result
     * for a design that has since changed.
     */
    evaluations: z.record(CandidateEvaluationSchema).default({}),
    /** Candidate currently open in the editor. */
    activeCandidateId: z.string().nullable().default(null),
    /**
     * The candidate a human has chosen.
     *
     * Human-only. No WebMCP tool writes this field, and there is no tool that could:
     * promotion is the one action with authority, so it stays behind a click. An
     * agent may create, test and argue; it may not decide.
     */
    promotedCandidateId: z.string().nullable().default(null),
    createdAt: z.number().int().nonnegative().default(0),
    updatedAt: z.number().int().nonnegative().default(0),
  })
  .strict();
export type Study = z.infer<typeof StudySchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function candidateById(study: Study, id: string): Candidate | undefined {
  return study.candidates.find((c) => c.id === id);
}

/**
 * A stable, order-insensitive hash of any JSON value.
 *
 * FNV-1a over a canonical serialisation: object keys sorted, no incidental
 * whitespace. Not cryptographic and does not need to be -- it guards a local cache
 * against staleness, not against an adversary. It DOES need to be stable across
 * builds and platforms, which rules out `JSON.stringify` key order and any hash
 * seeded from the environment.
 */
export function contentHash(value: unknown): string {
  const s = canonicalJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // A second pass over the length mixes in size, so a truncated document cannot
  // collide with its own prefix as cheaply.
  h ^= s.length;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0") + s.length.toString(36);
}

/** Canonical JSON: sorted keys, undefined dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The cache key. Every input that could change the answer, and nothing that could not.
 *
 * `revision` is excluded deliberately: two revisions with identical content should
 * share a cached result, because they are the same design. Including it would throw
 * away valid work every time someone renamed a node and renamed it back.
 */
export function evaluationKey(input: {
  candidateHash: string;
  engineVersion: string;
  seeds: readonly number[];
  boundsHash: string;
}): string {
  return [
    input.candidateHash,
    input.engineVersion,
    input.seeds.join("."),
    input.boundsHash,
  ].join("|");
}

/** Hash of everything that governs a correctness search or a performance run. */
export function studyBoundsHash(study: Study): string {
  return contentHash({
    workload: { ...study.workload, seeds: undefined },
    targets: study.targets,
    correctness: study.correctness,
  });
}

/**
 * Overwrite a candidate's local evaluation settings from the study.
 *
 * Called before every evaluation, on a copy, so an edit cannot escape the study's
 * yardstick. See the file header for why this is not merely tidy.
 *
 * The client arrival process is rewritten on EVERY client node rather than the first,
 * because a candidate with two clients could otherwise carry half the intended load.
 */
export function syncCandidateToStudy(study: Study, candidate: Candidate): Candidate {
  const w = study.workload;
  return {
    ...candidate,
    design: {
      ...candidate.design,
      classes: w.classes.length > 0 ? w.classes.map((c) => ({ ...c })) : candidate.design.classes,
      scenario: {
        ...candidate.design.scenario,
        durationSec: w.durationSec,
        warmupSec: w.warmupSec,
        traceLimit: w.traceLimit,
      },
      slo: { ...study.targets.slo },
      nodes: candidate.design.nodes.map((n) =>
        n.kind === "client" && n.client
          ? { ...n, client: { ...n.client, arrival: structuredArrival(w.arrival) } }
          : n
      ),
    },
  };
}

/** Defensive copy of an arrival process, so two candidates cannot alias one object. */
function structuredArrival<T>(a: T): T {
  return JSON.parse(JSON.stringify(a)) as T;
}

// ---------------------------------------------------------------------------
// creating a study, and freezing its yardstick once results exist
// ---------------------------------------------------------------------------

/**
 * An empty study.
 *
 * The product's starting point, and deliberately not an example. A tool that opens onto
 * somebody else's problem teaches that the problem is the fixed part and the architecture
 * is the variable, which is backwards: the problem is the input. Examples stay one menu
 * click away for demonstrations and tests.
 *
 * Empty but VALID -- a Poisson arrival, one seed set, no invariants and no candidates. It
 * passes `StudySchema`, so every downstream consumer can assume a well-formed study from
 * the first frame and the UI needs no "no study yet" branch.
 */
export function blankStudy(input: { id: string; name?: string; problem?: string; now?: number } ): Study {
  const now = input.now ?? Date.now();
  return StudySchema.parse({
    version: STUDY_SCHEMA_VERSION,
    id: input.id,
    name: input.name ?? "untitled study",
    problem: input.problem ?? "",
    workload: { arrival: { kind: "poisson", ratePerSec: 50 } },
    createdAt: now,
    updatedAt: now,
  });
}

/** The executable half of a study: everything an evaluation's verdict depends on. */
export const StudyContractPatchSchema = z
  .object({
    workload: StudyWorkloadSchema.partial().optional(),
    targets: StudyTargetsSchema.optional(),
    contract: ProductContractSchema.optional(),
    correctness: CorrectnessContractSchema.optional(),
  })
  .strict();
export type StudyContractPatch = z.infer<typeof StudyContractPatchSchema>;

export interface StudyLock {
  locked: boolean;
  /** Empty when unlocked. Names what caused the lock, so the message can be acted on. */
  reason: string;
}

/**
 * Whether the yardstick is frozen.
 *
 * WHY THIS EXISTS
 *
 * An agent that can rewrite the invariants it is being judged against is not being judged.
 * The dangerous sequence is not malice, it is helpfulness: a design fails the oversell
 * invariant, and the obvious next move for something optimising "make the tests pass" is to
 * weaken the invariant. Every verdict afterwards is then evidence about a bar that was
 * lowered to clear it, and nothing in the output would look wrong.
 *
 * So the contract is writable while the study is still a question and frozen once it starts
 * producing answers -- the moment a result is cached, or a human promotes something. Before
 * that there is nothing to bias; after it, changing the yardstick invalidates results that
 * are already on screen and may already have been reported.
 *
 * This is a rule about the DOCUMENT, not about agents, so it binds the manual UI too. A
 * human can still start a new study, or clear the results to reopen this one, and both of
 * those are explicit acts that leave the old verdicts behind rather than silently
 * reinterpreting them.
 */
export function studyContractLock(study: Study): StudyLock {
  if (study.promotedCandidateId !== null) {
    return {
      locked: true,
      reason: `${study.promotedCandidateId} is promoted; the workload, SLOs and invariants it was judged against cannot change afterwards`,
    };
  }
  const results = Object.keys(study.evaluations).length;
  if (results > 0) {
    return {
      locked: true,
      reason: `${results} evaluation${results === 1 ? "" : "s"} already exist; changing the yardstick now would reinterpret results rather than produce new ones`,
    };
  }
  return { locked: false, reason: "" };
}

export class StudyContractLockedError extends Error {
  constructor(reason: string) {
    super(`the study contract is locked: ${reason}. Clear the results or start a new study.`);
    this.name = "StudyContractLockedError";
  }
}

/**
 * Apply a patch to the executable contract, or refuse.
 *
 * `name` and `problem` are NOT here and are always editable: they are prose the engine never
 * reads, so fixing a typo in a problem statement cannot change a verdict. Freezing them would
 * protect nothing and would stop a study being explained better.
 */
export function applyStudyContract(study: Study, patch: StudyContractPatch, now = Date.now()): Study {
  const lock = studyContractLock(study);
  if (lock.locked) throw new StudyContractLockedError(lock.reason);
  return StudySchema.parse({
    ...study,
    contract: patch.contract ?? study.contract,
    workload: patch.workload ? { ...study.workload, ...patch.workload } : study.workload,
    targets: patch.targets ?? study.targets,
    correctness: patch.correctness ?? study.correctness,
    updatedAt: now,
  });
}

/**
 * Drop every cached result, unfreezing the contract.
 *
 * The deliberate escape from the lock, and it is destructive on purpose: the only way to
 * change the yardstick is to visibly discard what the old one produced. Promotion is cleared
 * too, because a promotion is a decision about results that are being deleted.
 */
export function clearStudyResults(study: Study, now = Date.now()): Study {
  return StudySchema.parse({
    ...study,
    evaluations: {},
    promotedCandidateId: null,
    updatedAt: now,
  });
}
