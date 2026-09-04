import { z } from "zod";
import { ExprSchema, walkOperations } from "./domain";
import {
  ArrivalProcessSchema,
  DesignSchema,
  RequestClassSchema,
  SloSchema,
  distributionHasPositiveMean,
  nodeHasUsablePerformanceInputs,
  nodeTimingInputs,
} from "./design";

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
// repository snapshots and architecture evidence
// ---------------------------------------------------------------------------

/**
 * The repository revision an as-is architecture was reconstructed from.
 *
 * The browser cannot read the repository itself. An agent that can inspect the workspace records
 * only the stable identity needed to audit and repeat its analysis here. `rootHint` is deliberately
 * a hint rather than an authority: moving a project must not make its architecture unreadable.
 */
export const RepositorySnapshotSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(160),
    rootHint: z.string().max(1024).default(""),
    branch: z.string().max(256).default(""),
    revision: z.string().max(256).default(""),
    dirty: z.boolean().nullable().default(null),
    /** Relative directories or packages included in this architecture snapshot. */
    scope: z.array(z.string().min(1).max(512)).max(128).default([]),
    /** Relative paths explicitly left outside the reconstruction. */
    excludedScope: z.array(z.string().min(1).max(512)).max(128).default([]),
    /** Repository-relative paths changed from `revision` when the snapshot is dirty. */
    changedPaths: z.array(z.string().min(1).max(1024)).max(4096).default([]),
    /** Deterministic hash of the included working tree; required for dirty snapshots. */
    workingTreeFingerprint: z.string().max(256).default(""),
    capturedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.dirty === true && snapshot.revision.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "a dirty snapshot requires its base revision",
      });
    }
    if (snapshot.dirty === true && snapshot.workingTreeFingerprint.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workingTreeFingerprint"],
        message: "a dirty snapshot requires a deterministic working-tree fingerprint",
      });
    }
    if (snapshot.dirty === true && snapshot.changedPaths.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changedPaths"],
        message: "a dirty snapshot requires its changed-path inventory",
      });
    }
  });
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;

export const EvidenceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("edge"), edgeId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("collection"), collectionId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("handler"), handlerId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal("operation"),
      handlerId: z.string().min(1).max(128),
      operationId: z.string().min(1).max(128),
    })
    .strict(),
]);
export type EvidenceTarget = z.infer<typeof EvidenceTargetSchema>;

export function evidenceTargetKey(target: EvidenceTarget): string {
  switch (target.kind) {
    case "node":
      return `node:${target.nodeId}`;
    case "edge":
      return `edge:${target.edgeId}`;
    case "collection":
      return `collection:${target.collectionId}`;
    case "handler":
      return `handler:${target.handlerId}`;
    case "operation":
      return `operation:${target.handlerId}:${target.operationId}`;
  }
}

export function evidenceTargetLabel(target: EvidenceTarget): string {
  switch (target.kind) {
    case "node":
      return target.nodeId;
    case "edge":
      return target.edgeId;
    case "collection":
      return target.collectionId;
    case "handler":
      return target.handlerId;
    case "operation":
      return `${target.handlerId}/${target.operationId}`;
  }
}

/** How strongly the available source supports an architectural claim. */
export const EvidenceConfidenceSchema = z.enum(["observed", "inferred", "assumed"]);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;

/** Which part of the model an evidence record supports. */
export const EvidenceAspectSchema = z.enum(["architecture", "behavior", "performance"]);
export type EvidenceAspect = z.infer<typeof EvidenceAspectSchema>;

/** What kind of source produced an architectural claim. */
export const EvidenceSourceSchema = z.enum(["code", "config", "runtime", "documentation", "user"]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/**
 * One auditable reason that a node or link exists in the architecture model.
 *
 * `path` is repository-relative whenever possible. Lines and symbols are optional because config,
 * runtime traces and user-supplied constraints do not always have a source location. `claim` says
 * what the evidence establishes; a path on its own would only prove that a file exists.
 */
const ArchitectureEvidenceObjectSchema = z
  .object({
    id: z.string().min(1).max(128),
    target: EvidenceTargetSchema,
    /** Compatibility projection retained through v3 so existing integrations keep working. */
    targetKind: z.enum(["node", "edge", "collection", "handler", "operation"]),
    /** For operations this is the operation id; `target` also carries the owning handler id. */
    targetId: z.string().min(1).max(128),
    /**
     * Architecture proves that an element or dependency exists; behavior proves ordering,
     * lifecycle or delivery semantics; performance supports numeric load-model inputs. Keeping
     * these separate prevents a code citation for "calls Postgres" from being mistaken for a
     * measurement of that call's latency.
     */
    aspect: EvidenceAspectSchema.default("architecture"),
    confidence: EvidenceConfidenceSchema,
    source: EvidenceSourceSchema,
    path: z.string().max(1024).default(""),
    lineStart: z.number().int().min(1).nullable().default(null),
    lineEnd: z.number().int().min(1).nullable().default(null),
    symbol: z.string().max(512).default(""),
    /** SHA-256 of the cited slice after CRLF-to-LF normalization. */
    contentHash: z.union([z.string().regex(/^[a-f0-9]{64}$/i), z.literal("")]).default(""),
    claim: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.lineStart !== null && evidence.path.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "a line number requires a repository-relative path",
      });
    }
    if (evidence.lineEnd !== null && evidence.lineStart === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineStart"],
        message: "lineEnd requires lineStart",
      });
    }
    if (
      evidence.lineStart !== null &&
      evidence.lineEnd !== null &&
      evidence.lineEnd < evidence.lineStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "lineEnd cannot be before lineStart",
      });
    }
    if ((evidence.source === "code" || evidence.source === "config") && evidence.path.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: `${evidence.source} evidence requires a repository-relative path`,
      });
    }
    if (evidence.path.startsWith("/") || evidence.path.split(/[\\/]+/).includes("..")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "evidence paths must stay repository-relative",
      });
    }
    if (evidence.target.kind !== evidence.targetKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetKind"],
        message: "targetKind must match target.kind",
      });
    }
    const projectedId = evidenceTargetLabel(evidence.target).split("/").at(-1)!;
    if (projectedId !== evidence.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: "targetId must identify the structured target",
      });
    }
  });
export const ArchitectureEvidenceSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null) return value;
  const raw = value as Record<string, unknown>;
  if (raw.target !== undefined) {
    const target = raw.target as Record<string, unknown>;
    const kind = target.kind;
    const targetId =
      kind === "node"
        ? target.nodeId
        : kind === "edge"
          ? target.edgeId
          : kind === "collection"
            ? target.collectionId
            : kind === "handler"
              ? target.handlerId
              : kind === "operation"
                ? target.operationId
                : undefined;
    return { ...raw, targetKind: raw.targetKind ?? kind, targetId: raw.targetId ?? targetId };
  }
  if (typeof raw.targetKind !== "string" || typeof raw.targetId !== "string") return raw;
  const target =
    raw.targetKind === "node"
      ? { kind: "node", nodeId: raw.targetId }
      : raw.targetKind === "edge"
        ? { kind: "edge", edgeId: raw.targetId }
        : raw.targetKind === "collection"
          ? { kind: "collection", collectionId: raw.targetId }
          : raw.targetKind === "handler"
            ? { kind: "handler", handlerId: raw.targetId }
            : raw.targetKind === "operation" && typeof raw.handlerId === "string"
              ? { kind: "operation", handlerId: raw.handlerId, operationId: raw.targetId }
              : undefined;
  return target ? { ...raw, target } : raw;
}, ArchitectureEvidenceObjectSchema);
export type ArchitectureEvidence = z.infer<typeof ArchitectureEvidenceSchema>;

export const SourceInventoryKindSchema = z.enum([
  "entrypoint",
  "work-source",
  "runtime",
  "dependency",
  "queue",
  "state-store",
]);
export type SourceInventoryKind = z.infer<typeof SourceInventoryKindSchema>;

export const SourceInventoryDispositionSchema = z.enum(["modeled", "excluded", "unresolved"]);
export type SourceInventoryDisposition = z.infer<typeof SourceInventoryDispositionSchema>;

export const SourceInventoryItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: SourceInventoryKindSchema,
    label: z.string().min(1).max(256),
    path: z.string().min(1).max(1024),
    symbol: z.string().max(512).default(""),
    contentHash: z.union([z.string().regex(/^[a-f0-9]{64}$/i), z.literal("")]).default(""),
    disposition: SourceInventoryDispositionSchema,
    target: EvidenceTargetSchema.nullable().default(null),
    reason: z.string().max(2000).default(""),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.path.startsWith("/") || item.path.split(/[\\/]+/).includes("..")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "inventory paths must stay repository-relative",
      });
    }
    if (item.disposition === "modeled" && item.target === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "a modeled inventory item must identify its architecture or behavior target",
      });
    }
    if (item.disposition === "excluded" && item.reason.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "an excluded inventory item requires a reason",
      });
    }
  });
export type SourceInventoryItem = z.infer<typeof SourceInventoryItemSchema>;

export const GroundingReceiptSchema = z
  .object({
    repositorySnapshotId: z.string().min(1).max(128),
    policyVersion: z.number().int().positive(),
    candidateRevision: z.number().int().nonnegative(),
    designHash: z.string().min(1),
    inventoryHash: z.string().min(1),
    evidenceHash: z.string().min(1),
    sealedAt: z.number().int().nonnegative(),
  })
  .strict();
export type GroundingReceipt = z.infer<typeof GroundingReceiptSchema>;

export const BaselineGroundingSchema = z
  .object({
    repositorySnapshotId: z.string().min(1).max(128),
    policyVersion: z.number().int().positive().default(1),
    sourceInventory: z.array(SourceInventoryItemSchema).max(4096).default([]),
    receipt: GroundingReceiptSchema,
  })
  .strict();
export type BaselineGrounding = z.infer<typeof BaselineGroundingSchema>;

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

/** Baselines describe code that exists; experiments describe a proposed departure from it. */
export const CandidateRoleSchema = z.enum(["baseline", "experiment"]);
export type CandidateRole = z.infer<typeof CandidateRoleSchema>;

/** Experiments either explore the space or claim to resolve one or more registered issues. */
export const CandidateTypeSchema = z.enum(["exploration", "repository-fix"]);
export type CandidateType = z.infer<typeof CandidateTypeSchema>;

export const CandidateIssueVerificationStatusSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
  "manual",
]);
export type CandidateIssueVerificationStatus = z.infer<typeof CandidateIssueVerificationStatusSchema>;

export const CandidateIssueVerificationSchema = z
  .object({
    status: CandidateIssueVerificationStatusSchema,
    authority: z.enum(["check", "human"]),
    candidateRevision: z.number().int().nonnegative(),
    issueRevision: z.number().int().nonnegative(),
    baselineRevision: z.string().min(1).max(256),
    /** Content hash of the evaluation/report used by a check. Empty only for a human manual receipt. */
    evaluationHash: z.string().max(256).default(""),
    notes: z.string().max(2000).default(""),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((verification, ctx) => {
    if (verification.authority === "check" && verification.evaluationHash.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evaluationHash"],
        message: "check-backed issue verification requires an evaluation hash",
      });
    }
    if (verification.status === "manual" && verification.authority !== "human") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authority"],
        message: "manual verification must be recorded by a human",
      });
    }
  });
export type CandidateIssueVerification = z.infer<typeof CandidateIssueVerificationSchema>;

/** A candidate's explicit claim about one issue, including how the claim will be tested. */
export const CandidateIssuePlanSchema = z
  .object({
    issueId: z.string().min(1).max(128),
    required: z.boolean().default(true),
    hypothesis: z.string().min(1).max(2000),
    tradeoffs: z.array(z.string().min(1).max(1000)).max(32).default([]),
    verificationPlan: z.string().min(1).max(2000),
    expectedArchitectureImpact: z
      .object({
        summary: z.string().min(1).max(2000),
        targets: z.array(EvidenceTargetSchema).max(128).default([]),
      })
      .strict(),
    /** Status is trusted only while all pinned revisions still match. */
    verification: CandidateIssueVerificationSchema.nullable().default(null),
  })
  .strict();
export type CandidateIssuePlan = z.infer<typeof CandidateIssuePlanSchema>;

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
    role: CandidateRoleSchema.default("experiment"),
    candidateType: CandidateTypeSchema.default("exploration"),
    issuePlans: z.array(CandidateIssuePlanSchema).max(256).default([]),
    /** The baseline or earlier experiment this candidate was forked from. */
    basedOnCandidateId: z.string().min(1).max(64).nullable().default(null),
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
    evidence: z.array(ArchitectureEvidenceSchema).max(4096).default([]),
    /** Present only on a repository-derived baseline. Its status is always derived. */
    grounding: BaselineGroundingSchema.nullable().default(null),
    design: DesignSchema,
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.role === "experiment" && candidate.candidateType === "repository-fix" && candidate.issuePlans.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issuePlans"],
        message: "a repository-fix candidate must reference at least one issue",
      });
    }
    const plannedIssueIds = new Set<string>();
    for (let index = 0; index < candidate.issuePlans.length; index += 1) {
      const issueId = candidate.issuePlans[index]!.issueId;
      if (plannedIssueIds.has(issueId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["issuePlans", index, "issueId"],
          message: `duplicate candidate issue plan for "${issueId}"`,
        });
      }
      plannedIssueIds.add(issueId);
    }
    const nodeIds = new Set(candidate.design.nodes.map((node) => node.id));
    const edgeIds = new Set(candidate.design.edges.map((edge) => edge.id));
    const evidenceIds = new Set<string>();
    for (let index = 0; index < candidate.evidence.length; index += 1) {
      const evidence = candidate.evidence[index]!;
      if (evidenceIds.has(evidence.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", index, "id"],
          message: `duplicate evidence id "${evidence.id}"`,
        });
      }
      evidenceIds.add(evidence.id);
      const workflow = candidate.design.workflow;
      const target = evidence.target;
      const targetExists = (() => {
        switch (target.kind) {
          case "node":
            return nodeIds.has(target.nodeId);
          case "edge":
            return edgeIds.has(target.edgeId);
          case "collection":
            return workflow?.collections.some((item) => item.id === target.collectionId) ?? false;
          case "handler":
            return workflow?.handlers.some((item) => item.id === target.handlerId) ?? false;
          case "operation": {
            const handler = workflow?.handlers.find((item) => item.id === target.handlerId);
            if (!handler) return false;
            let found = false;
            walkOperations(handler.steps, (operation) => {
              if (operation.id === target.operationId) found = true;
            });
            return found;
          }
        }
      })();
      if (!targetExists) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", index, "target"],
          message: `missing ${evidence.targetKind} "${evidenceTargetLabel(evidence.target)}"`,
        });
      }
    }
    if (candidate.role === "baseline" && candidate.grounding === null) return;
    if (candidate.role !== "baseline" && candidate.grounding !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grounding"],
        message: "grounding metadata belongs only to repository baselines",
      });
    }
  });
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
// results: production scenarios
// ---------------------------------------------------------------------------

/**
 * The fixed production questions the MVP can answer with executable models.
 *
 * These are deliberately product language rather than engine operations. A user wants to know
 * whether a burst drains or a dependency failure spreads; whether the engine implemented that as
 * a changed arrival process or an injected failure probability is an internal detail.
 */
export const ProductionScenarioKindSchema = z.enum([
  "concurrency-race",
  "traffic-spike",
  "capacity-ramp",
  "dependency-degradation",
]);
export type ProductionScenarioKind = z.infer<typeof ProductionScenarioKindSchema>;

/** `inconclusive` names a missing model or bound; it is never rendered as a pass. */
export const ProductionScenarioStatusSchema = z.enum([
  "healthy",
  "warning",
  "critical",
  "inconclusive",
]);
export type ProductionScenarioStatus = z.infer<typeof ProductionScenarioStatusSchema>;

/**
 * One compact, persisted result from the standard production suite.
 *
 * The prose is stored with the numbers because a bare metric does not say what was varied or what
 * action follows. `metrics` stays deliberately open: each scenario measures different quantities,
 * while the fixed `kind` gives consumers the stable discriminator they need.
 */
export const ProductionScenarioResultSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: ProductionScenarioKindSchema,
    label: z.string().min(1).max(160),
    status: ProductionScenarioStatusSchema,
    summary: z.string().min(1).max(2000),
    evidence: z.string().min(1).max(4000),
    recommendation: z.string().min(1).max(4000),
    metrics: z.record(z.number().finite().nullable()).default({}),
    targetNodeId: z.string().min(1).max(128).nullable().default(null),
    targetEdgeId: z.string().min(1).max(128).nullable().default(null),
    assumptions: z.array(z.string().min(1).max(2000)).max(32).default([]),
  })
  .strict();
export type ProductionScenarioResult = z.infer<typeof ProductionScenarioResultSchema>;

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
    /** Results from the explicit, named production suite. Empty means it has not been run. */
    scenarios: z.array(ProductionScenarioResultSchema).max(16).default([]),
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
  "source-grounded",
  "issues-verified",
  "correctness-exhausted",
  "no-violation",
  "performance-calibrated",
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
// evidence-aware issue registry
// ---------------------------------------------------------------------------

export const IssueSourceSchema = z.enum([
  "user",
  "agent",
  "grounding-gap",
  "correctness-check",
  "performance-analysis",
]);
export type IssueSource = z.infer<typeof IssueSourceSchema>;

export const IssueSeveritySchema = z.enum(["critical", "warning", "info"]);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const IssueCategorySchema = z.enum([
  "grounding",
  "correctness",
  "reliability",
  "performance",
  "scalability",
  "data-consistency",
  "security",
  "operability",
  "other",
]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

/** Stable references only: the registry never copies source or analyzer prose into evidence. */
export const IssueEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("architecture-evidence"),
    candidateId: z.string().min(1).max(64),
    evidenceId: z.string().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal("evaluation"),
    evaluationId: z.string().min(1).max(512),
    candidateHash: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("grounding-report"),
    candidateId: z.string().min(1).max(64),
    reportHash: z.string().min(1).max(256),
    gapCode: z.string().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal("analysis"),
    analysisHash: z.string().min(1).max(256),
    findingId: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("user-observation"),
    observationId: z.string().min(1).max(128),
  }).strict(),
]);
export type IssueEvidenceRef = z.infer<typeof IssueEvidenceRefSchema>;

export const IssueVerificationContractSchema = z.object({
  kind: z.enum(["grounding", "correctness", "performance", "manual"]),
  summary: z.string().min(1).max(2000),
  requiredSignals: z.array(z.string().min(1).max(512)).max(32).default([]),
}).strict();
export type IssueVerificationContract = z.infer<typeof IssueVerificationContractSchema>;

export const IssueReceiptSchema = z.object({
  id: z.string().min(1).max(128),
  outcome: z.enum(["verified", "accepted-risk", "dismissed"]),
  /** Agents never receive an API that can write this field. */
  authority: z.enum(["human", "check"]),
  /** Issue revision this decision evaluated; edits invalidate older decisions. */
  issueRevision: z.number().int().nonnegative(),
  baselineRevision: z.string().min(1).max(256),
  candidateId: z.string().min(1).max(64).nullable().default(null),
  /** Required for check-backed correctness/performance verification. */
  evaluationHash: z.string().max(256).default(""),
  evidenceRefs: z.array(z.string().min(1).max(512)).max(128).default([]),
  reason: z.string().max(2000).default(""),
  recordedAt: z.number().int().nonnegative(),
}).strict();
export type IssueReceipt = z.infer<typeof IssueReceiptSchema>;

export const IssueStatusSchema = z.enum(["open", "verified", "accepted-risk", "dismissed"]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssueSchema = z.object({
  id: z.string().min(1).max(128),
  /** Derived from source/category/targets/baseline/title; the upsert mutation owns it. */
  fingerprint: z.string().min(1).max(256),
  revision: z.number().int().nonnegative().default(0),
  title: z.string().min(1).max(300),
  description: z.string().max(4000).default(""),
  source: IssueSourceSchema,
  severity: IssueSeveritySchema,
  category: IssueCategorySchema,
  candidateId: z.string().min(1).max(64).nullable().default(null),
  targets: z.array(EvidenceTargetSchema).max(128).default([]),
  baselineSnapshotId: z.string().min(1).max(128).nullable().default(null),
  baselineRevision: z.string().min(1).max(256),
  evidence: z.array(IssueEvidenceRefSchema).max(256).default([]),
  verification: IssueVerificationContractSchema,
  receipts: z.array(IssueReceiptSchema).max(256).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((issue, ctx) => {
  if (issue.fingerprint !== issueFingerprint(issue)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fingerprint"],
      message: "issue fingerprint does not match its source, category, targets, baseline and title",
    });
  }
});
export type Issue = z.infer<typeof IssueSchema>;

export function issueEvidenceRefKey(reference: IssueEvidenceRef): string {
  switch (reference.kind) {
    case "architecture-evidence":
      return `architecture:${reference.candidateId}:${reference.evidenceId}`;
    case "evaluation":
      return `evaluation:${reference.evaluationId}:${reference.candidateHash}`;
    case "grounding-report":
      return `grounding:${reference.candidateId}:${reference.reportHash}:${reference.gapCode}`;
    case "analysis":
      return `analysis:${reference.analysisHash}:${reference.findingId}`;
    case "user-observation":
      return `user:${reference.observationId}`;
  }
}

/** The same finding on the same baseline deterministically resolves to the same registry row. */
export function issueFingerprint(input: Pick<Issue, "source" | "category" | "targets" | "baselineRevision" | "title">): string {
  return contentHash({
    source: input.source,
    category: input.category,
    baselineRevision: input.baselineRevision,
    title: input.title.trim().toLowerCase(),
    targets: input.targets.map(evidenceTargetKey).sort(),
  });
}

/**
 * Status is a projection of revision-pinned receipts, never a writable issue field.
 * A receipt from an older baseline is deliberately ignored.
 */
export function issueStatus(issue: Issue, activeBaselineRevision: string = issue.baselineRevision): IssueStatus {
  if (activeBaselineRevision !== issue.baselineRevision) return "open";
  const evidence = new Set(issue.evidence.map(issueEvidenceRefKey));
  const valid = issue.receipts
    .filter((receipt) => {
      if (receipt.issueRevision !== issue.revision) return false;
      if (receipt.baselineRevision !== issue.baselineRevision) return false;
      if (receipt.outcome === "accepted-risk" && receipt.authority !== "human") return false;
      if (receipt.outcome !== "verified") return true;
      if (issue.verification.kind === "manual") return receipt.authority === "human";
      if (receipt.evidenceRefs.length === 0 || !receipt.evidenceRefs.every((key) => evidence.has(key))) return false;
      if (
        receipt.authority === "check" &&
        (issue.verification.kind === "correctness" || issue.verification.kind === "performance") &&
        receipt.evaluationHash.length === 0
      ) return false;
      return true;
    })
    .sort((left, right) => left.recordedAt - right.recordedAt || left.id.localeCompare(right.id));
  return valid.at(-1)?.outcome ?? "open";
}

// ---------------------------------------------------------------------------
// the study document
// ---------------------------------------------------------------------------

export const STUDY_SCHEMA_VERSION = 3 as const;

/**
 * The exact architecture revisions a person approved.
 *
 * `promotedCandidateId` answers which option was chosen. This receipt answers the more important
 * implementation question: which version of that option was reviewed, and which as-is revision it
 * was compared with. Keeping both prevents a later edit from silently inheriting an earlier human
 * decision.
 */
export const DesignApprovalSchema = z
  .object({
    candidateId: z.string().min(1).max(64),
    candidateRevision: z.number().int().nonnegative(),
    baselineCandidateId: z.string().min(1).max(64).nullable().default(null),
    baselineRevision: z.number().int().nonnegative().nullable().default(null),
    approvedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((approval, ctx) => {
    if ((approval.baselineCandidateId === null) !== (approval.baselineRevision === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [approval.baselineCandidateId === null ? "baselineRevision" : "baselineCandidateId"],
        message: "baseline candidate and revision must either both be present or both be null",
      });
    }
  });
export type DesignApproval = z.infer<typeof DesignApprovalSchema>;

export const StudySchema = z
  .object({
    version: z.literal(STUDY_SCHEMA_VERSION),
    id: z.string().min(1).max(64),
    name: z.string().default("untitled project"),
    /**
     * The problem in the words of whoever has it.
     *
     * First field a reader sees and the only one the engine never touches. It exists
     * because a study whose problem statement has drifted from its invariants is a
     * study that is measuring the wrong thing, and the only way anyone notices is by
     * reading the two next to each other.
     */
    problem: z.string().default(""),
    /** Immutable source states used by repository-derived baselines. */
    repositorySnapshots: z.array(RepositorySnapshotSchema).max(128).default([]),
    /** Snapshot that currently defines the source-grounded CURRENT baseline. */
    activeRepositorySnapshotId: z.string().min(1).max(128).nullable().default(null),
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
    /** One persisted registry for human, agent, grounding, correctness and performance problems. */
    issueRegistry: z.array(IssueSchema).max(4096).default([]),
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
    /** Revision-pinned receipt created by the same human-only promotion action. */
    approval: DesignApprovalSchema.nullable().default(null),
    createdAt: z.number().int().nonnegative().default(0),
    updatedAt: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((study, ctx) => {
    const snapshotIds = new Set<string>();
    for (let index = 0; index < study.repositorySnapshots.length; index += 1) {
      const snapshot = study.repositorySnapshots[index]!;
      if (snapshotIds.has(snapshot.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositorySnapshots", index, "id"],
          message: `duplicate repository snapshot id "${snapshot.id}"`,
        });
      }
      snapshotIds.add(snapshot.id);
    }
    if (study.activeRepositorySnapshotId !== null && !snapshotIds.has(study.activeRepositorySnapshotId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeRepositorySnapshotId"],
        message: `active repository snapshot "${study.activeRepositorySnapshotId}" is missing`,
      });
    }
    for (let index = 0; index < study.candidates.length; index += 1) {
      const grounding = study.candidates[index]!.grounding;
      if (grounding && !snapshotIds.has(grounding.repositorySnapshotId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "grounding", "repositorySnapshotId"],
          message: `grounding references missing repository snapshot "${grounding.repositorySnapshotId}"`,
        });
      }
    }
    const issueIds = new Set<string>();
    const issueFingerprints = new Set<string>();
    for (let index = 0; index < study.issueRegistry.length; index += 1) {
      const issue = study.issueRegistry[index]!;
      if (issueIds.has(issue.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["issueRegistry", index, "id"], message: `duplicate issue id "${issue.id}"` });
      }
      if (issueFingerprints.has(issue.fingerprint)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["issueRegistry", index, "fingerprint"], message: `duplicate issue fingerprint "${issue.fingerprint}"` });
      }
      issueIds.add(issue.id);
      issueFingerprints.add(issue.fingerprint);
    }
    for (let candidateIndex = 0; candidateIndex < study.candidates.length; candidateIndex += 1) {
      const candidate = study.candidates[candidateIndex]!;
      for (let planIndex = 0; planIndex < candidate.issuePlans.length; planIndex += 1) {
        const plan = candidate.issuePlans[planIndex]!;
        if (!issueIds.has(plan.issueId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["candidates", candidateIndex, "issuePlans", planIndex, "issueId"],
            message: `candidate issue plan references missing issue "${plan.issueId}"`,
          });
        }
      }
    }
  });
export type Study = z.infer<typeof StudySchema>;

/** The revision that invalidates issue and candidate-verification receipts when source moves. */
export function activeIssueBaselineRevision(study: Study): string {
  const snapshot = activeRepositorySnapshot(study);
  if (snapshot) return snapshot.revision || `snapshot:${snapshot.id}`;
  const baseline = study.candidates.find((candidate) => candidate.role === "baseline") ?? study.candidates[0];
  return `freehand:${contentHash(baseline?.design ?? null)}`;
}

/** A stored per-issue outcome is pending whenever any input it was pinned to has changed. */
export function candidateIssueVerificationStatus(
  study: Study,
  candidate: Candidate,
  plan: CandidateIssuePlan
): CandidateIssueVerificationStatus | "pending" {
  const verification = plan.verification;
  const issue = study.issueRegistry.find((item) => item.id === plan.issueId);
  if (!verification || !issue) return "pending";
  if (verification.candidateRevision !== candidate.revision) return "pending";
  if (verification.issueRevision !== issue.revision) return "pending";
  if (verification.baselineRevision !== activeIssueBaselineRevision(study)) return "pending";
  if (verification.authority === "check" && verification.evaluationHash.length === 0) return "pending";
  return verification.status;
}

export interface CandidateIssueReadiness {
  ready: boolean;
  required: number;
  satisfied: number;
  pendingIssueIds: string[];
  criticalRegressionIssueIds: string[];
}

/** Trusted approval projection for issue-linked candidates. */
export function candidateIssueReadiness(study: Study, candidate: Candidate): CandidateIssueReadiness {
  const baselineRevision = activeIssueBaselineRevision(study);
  const pendingIssueIds: string[] = [];
  let satisfied = 0;
  const requiredPlans = candidate.issuePlans.filter((plan) => plan.required);
  for (const plan of requiredPlans) {
    const issue = study.issueRegistry.find((item) => item.id === plan.issueId);
    const registryStatus = issue ? issueStatus(issue, baselineRevision) : "open";
    const registryResolved = registryStatus === "accepted-risk" || registryStatus === "dismissed" || registryStatus === "verified";
    const status = candidateIssueVerificationStatus(study, candidate, plan);
    if (registryResolved || status === "passed" || status === "manual") satisfied += 1;
    else pendingIssueIds.push(plan.issueId);
  }

  const planned = new Map(candidate.issuePlans.map((plan) => [plan.issueId, plan]));
  const criticalRegressionIssueIds = study.issueRegistry
    .filter((issue) => {
      if (issue.severity !== "critical") return false;
      if (issue.candidateId !== null && issue.candidateId !== candidate.id) return false;
      const registryStatus = issueStatus(issue, baselineRevision);
      if (registryStatus === "accepted-risk" || registryStatus === "dismissed" || registryStatus === "verified") return false;
      const plan = planned.get(issue.id);
      return plan ? candidateIssueVerificationStatus(study, candidate, plan) === "failed" : issue.candidateId === candidate.id;
    })
    .map((issue) => issue.id);

  return {
    ready: pendingIssueIds.length === 0 && criticalRegressionIssueIds.length === 0,
    required: requiredPlans.length,
    satisfied,
    pendingIssueIds,
    criticalRegressionIssueIds,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export interface PerformanceCalibrationGap {
  targetKind: "node" | "edge";
  targetId: string;
  label: string;
}

export interface PerformanceCalibration {
  /** Freehand studies are hypothetical models and do not require repository calibration. */
  required: boolean;
  calibrated: boolean;
  gaps: PerformanceCalibrationGap[];
  message: string;
}

export const GroundingStatusSchema = z.enum(["grounded", "provisional", "legacy-unverified"]);
export type GroundingStatus = z.infer<typeof GroundingStatusSchema>;

export interface GroundingGap {
  code:
    | "legacy-baseline"
    | "snapshot-missing"
    | "snapshot-not-active"
    | "revision-missing"
    | "dirty-state-unknown"
    | "dirty-paths-missing"
    | "dirty-fingerprint-missing"
    | "inventory-empty"
    | "inventory-unresolved"
    | "inventory-hash-missing"
    | "architecture-evidence-missing"
    | "behavior-evidence-missing"
    | "receipt-stale"
    | "model-invalid";
  message: string;
  target: EvidenceTarget | null;
  inventoryId: string | null;
}

export interface GroundingCoverage {
  required: number;
  covered: number;
}

export interface GroundingReport {
  candidateId: string;
  repositorySnapshotId: string | null;
  policyVersion: number;
  status: GroundingStatus;
  architecture: GroundingCoverage;
  behavior: GroundingCoverage;
  inventory: { total: number; modeled: number; excluded: number; unresolved: number };
  gaps: GroundingGap[];
  eligibleForApproval: boolean;
}

function qualifyingEvidence(evidence: ArchitectureEvidence, aspect: "architecture" | "behavior"): boolean {
  return (
    evidence.aspect === aspect &&
    (evidence.source === "code" || evidence.source === "config") &&
    (evidence.confidence === "observed" || evidence.confidence === "inferred") &&
    evidence.path.length > 0 &&
    /^[a-f0-9]{64}$/i.test(evidence.contentHash)
  );
}

function requiredGroundingTargets(candidate: Candidate): {
  architecture: EvidenceTarget[];
  behavior: EvidenceTarget[];
} {
  const architecture: EvidenceTarget[] = [
    ...candidate.design.nodes.map((node) => ({ kind: "node" as const, nodeId: node.id })),
    ...candidate.design.edges.map((edge) => ({ kind: "edge" as const, edgeId: edge.id })),
  ];
  const behavior: EvidenceTarget[] = [];
  const workflow = candidate.design.workflow;
  if (workflow) {
    behavior.push(
      ...workflow.collections.map((collection) => ({ kind: "collection" as const, collectionId: collection.id })),
      ...workflow.handlers.map((handler) => ({ kind: "handler" as const, handlerId: handler.id }))
    );
    for (const handler of workflow.handlers) {
      walkOperations(handler.steps, (operation) => {
        behavior.push({ kind: "operation", handlerId: handler.id, operationId: operation.id });
      });
    }
  }
  return { architecture, behavior };
}

/** Derive repository grounding; callers cannot supply or override this status. */
export function groundingReport(study: Study, candidate: Candidate): GroundingReport {
  const targets = requiredGroundingTargets(candidate);
  const emptyCoverage = {
    architecture: { required: targets.architecture.length, covered: 0 },
    behavior: { required: targets.behavior.length, covered: 0 },
  };
  if (candidate.role !== "baseline" || candidate.grounding === null) {
    return {
      candidateId: candidate.id,
      repositorySnapshotId: null,
      policyVersion: 1,
      status: "legacy-unverified",
      ...emptyCoverage,
      inventory: { total: 0, modeled: 0, excluded: 0, unresolved: 0 },
      gaps: [
        {
          code: "legacy-baseline",
          message: "This baseline predates auditable repository grounding and must be re-verified.",
          target: null,
          inventoryId: null,
        },
      ],
      eligibleForApproval: false,
    };
  }

  const grounding = candidate.grounding;
  const snapshot = study.repositorySnapshots.find((item) => item.id === grounding.repositorySnapshotId);
  const gaps: GroundingGap[] = [];
  const addGap = (
    code: GroundingGap["code"],
    message: string,
    target: EvidenceTarget | null = null,
    inventoryId: string | null = null
  ) => gaps.push({ code, message, target, inventoryId });

  if (!snapshot) addGap("snapshot-missing", "The baseline's repository snapshot is missing.");
  if (study.activeRepositorySnapshotId !== grounding.repositorySnapshotId) {
    addGap("snapshot-not-active", "The baseline is not linked to the project's active repository snapshot.");
  }
  if (snapshot && snapshot.revision.length === 0) addGap("revision-missing", "Record the repository base revision.");
  if (snapshot?.dirty === null) addGap("dirty-state-unknown", "Record whether the working tree was dirty.");
  if (snapshot?.dirty === true && snapshot.changedPaths.length === 0) {
    addGap("dirty-paths-missing", "List the paths changed from the recorded base revision.");
  }
  if (snapshot?.dirty === true && snapshot.workingTreeFingerprint.length === 0) {
    addGap("dirty-fingerprint-missing", "Record a deterministic working-tree fingerprint.");
  }

  const inventory = grounding.sourceInventory;
  if (inventory.length === 0) addGap("inventory-empty", "Inventory the repository entrypoints and runtime boundaries.");
  for (const item of inventory) {
    if (item.disposition === "unresolved") {
      addGap("inventory-unresolved", `Resolve inventory item "${item.label}".`, item.target, item.id);
    }
    if (!/^[a-f0-9]{64}$/i.test(item.contentHash)) {
      addGap("inventory-hash-missing", `Inventory item "${item.label}" needs a source hash.`, item.target, item.id);
    }
  }

  const evidenceKeys = new Set(
    candidate.evidence.filter((item) => qualifyingEvidence(item, "architecture")).map((item) => evidenceTargetKey(item.target))
  );
  const behaviorKeys = new Set(
    candidate.evidence.filter((item) => qualifyingEvidence(item, "behavior")).map((item) => evidenceTargetKey(item.target))
  );
  const missingArchitecture = targets.architecture.filter((target) => !evidenceKeys.has(evidenceTargetKey(target)));
  const missingBehavior = targets.behavior.filter((target) => !behaviorKeys.has(evidenceTargetKey(target)));
  for (const target of missingArchitecture) {
    addGap("architecture-evidence-missing", `Add qualifying source evidence for ${evidenceTargetKey(target)}.`, target);
  }
  for (const target of missingBehavior) {
    addGap("behavior-evidence-missing", `Add qualifying behavior evidence for ${evidenceTargetKey(target)}.`, target);
  }

  const sourceIds = new Set(candidate.design.nodes.filter((node) => node.kind === "client").map((node) => node.id));
  const reachable = new Set(sourceIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of candidate.design.edges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        changed = true;
      }
    }
  }
  const unreachable = candidate.design.nodes.filter((node) => !reachable.has(node.id));
  const invalidTiming = candidate.design.nodes.find((node) =>
    nodeTimingInputs(node).some((input) => !distributionHasPositiveMean(input.distribution))
  );
  const invalidEdge = candidate.design.edges.find(
    (edge) => !distributionHasPositiveMean(edge.network.propagationLatency)
  );
  if (sourceIds.size === 0) addGap("model-invalid", "The topology has no client or work-source node.");
  if (unreachable.length > 0) {
    addGap("model-invalid", `${unreachable.length} component${unreachable.length === 1 ? " is" : "s are"} unreachable from every work source.`);
  }
  if (invalidTiming) addGap("model-invalid", `Component "${invalidTiming.label}" has zero or unusable timing.`);
  if (invalidEdge) addGap("model-invalid", `Link "${invalidEdge.id}" has zero or unusable latency.`);
  if (study.correctness.invariants.length > 0 && (candidate.design.workflow?.handlers.length ?? 0) === 0) {
    addGap("model-invalid", "The project declares correctness invariants but the baseline has no workflow handlers.");
  }

  const receipt = grounding.receipt;
  if (
    receipt.repositorySnapshotId !== grounding.repositorySnapshotId ||
    receipt.policyVersion !== grounding.policyVersion ||
    receipt.candidateRevision !== candidate.revision ||
    receipt.designHash !== contentHash(candidate.design) ||
    receipt.inventoryHash !== contentHash(grounding.sourceInventory) ||
    receipt.evidenceHash !== contentHash(candidate.evidence)
  ) {
    addGap("receipt-stale", "Grounding inputs changed after the baseline receipt was created.");
  }

  const counts = inventory.reduce(
    (result, item) => ({ ...result, [item.disposition]: result[item.disposition] + 1 }),
    { modeled: 0, excluded: 0, unresolved: 0 }
  );
  const status: GroundingStatus = gaps.length === 0 ? "grounded" : "provisional";
  return {
    candidateId: candidate.id,
    repositorySnapshotId: grounding.repositorySnapshotId,
    policyVersion: grounding.policyVersion,
    status,
    architecture: {
      required: targets.architecture.length,
      covered: targets.architecture.length - missingArchitecture.length,
    },
    behavior: {
      required: targets.behavior.length,
      covered: targets.behavior.length - missingBehavior.length,
    },
    inventory: { total: inventory.length, ...counts },
    gaps,
    eligibleForApproval: status === "grounded",
  };
}

/** Follow candidate ancestry to the repository baseline that governs approval eligibility. */
export function groundingReportForCandidate(study: Study, candidate: Candidate): GroundingReport | null {
  let current: Candidate | undefined = candidate;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.role === "baseline") return groundingReport(study, current);
    current = current.basedOnCandidateId
      ? study.candidates.find((item) => item.id === current!.basedOnCandidateId)
      : undefined;
  }
  return null;
}

/**
 * Whether a repository-derived candidate has enough evidence to print performance results.
 *
 * Code and configuration can establish structure and capacity settings, but they cannot measure
 * production arrival rates, service time or network latency. For that reason every modeled node
 * and edge needs an explicitly performance-scoped, observed runtime measurement or a value
 * supplied by the user. Benchmark and assumed values remain useful placeholders, but they do not
 * turn a source reconstruction into a calibrated load model.
 */
export function performanceCalibration(
  study: Pick<Study, "repositorySnapshots">,
  candidate: Candidate
): PerformanceCalibration {
  if (study.repositorySnapshots.length === 0) {
    return { required: false, calibrated: true, gaps: [], message: "Performance calibration is not required for a freehand model." };
  }

  const labels = new Map(candidate.design.nodes.map((node) => [node.id, node.label]));
  const targets: Array<PerformanceCalibrationGap & { usable: boolean }> = [
    ...candidate.design.nodes.map((node) => ({
      targetKind: "node" as const,
      targetId: node.id,
      label: node.label,
      usable: nodeHasUsablePerformanceInputs(node),
    })),
    ...candidate.design.edges.map((edge) => ({
      targetKind: "edge" as const,
      targetId: edge.id,
      label: `${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to}`,
      usable: distributionHasPositiveMean(edge.network.propagationLatency),
    })),
  ];

  const gaps = targets
    .filter(
      (target) =>
        !target.usable ||
        !candidate.evidence.some(
          (item) =>
            item.targetKind === target.targetKind &&
            item.targetId === target.targetId &&
            item.aspect === "performance" &&
            item.confidence === "observed" &&
            (item.source === "runtime" || item.source === "user")
        )
    )
    .map(({ usable: _usable, ...target }) => target);

  if (gaps.length === 0) {
    return {
      required: true,
      calibrated: true,
      gaps,
      message: "Every modeled component and link has observed runtime or user-supplied performance evidence.",
    };
  }

  const sample = gaps.slice(0, 3).map((gap) => `"${gap.label}"`).join(", ");
  const more = gaps.length > 3 ? ` and ${gaps.length - 3} more` : "";
  return {
    required: true,
    calibrated: false,
    gaps,
    message:
      `Performance is uncalibrated: ${gaps.length} modeled component${gaps.length === 1 ? "" : "s"}/link${gaps.length === 1 ? "" : "s"} ` +
      `need positive model inputs and observed performance evidence from runtime measurements or the user (${sample}${more}).`,
  };
}

export function candidateById(study: Study, id: string): Candidate | undefined {
  return study.candidates.find((c) => c.id === id);
}

export function activeRepositorySnapshot(
  study: Pick<Study, "repositorySnapshots" | "activeRepositorySnapshotId">
): RepositorySnapshot | null {
  if (study.activeRepositorySnapshotId === null) return null;
  return study.repositorySnapshots.find((snapshot) => snapshot.id === study.activeRepositorySnapshotId) ?? null;
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
export function blankStudy(input: {
  id: string;
  name?: string;
  problem?: string;
  now?: number;
  /** The real workload, when it is known at creation. Merged over the placeholder. */
  workload?: Partial<z.input<typeof StudyWorkloadSchema>>;
}): Study {
  const now = input.now ?? Date.now();
  return StudySchema.parse({
    version: STUDY_SCHEMA_VERSION,
    id: input.id,
    name: input.name ?? "untitled project",
    problem: input.problem ?? "",
    workload: { ...PLACEHOLDER_WORKLOAD_INPUT, ...(input.workload ?? {}) },
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The workload a study is born with when nobody has said what the real one is.
 *
 * It exists so the empty study is VALID, not because 50 requests a second means anything. The
 * danger is that it looks like a number somebody chose: the first cached result freezes it into
 * the yardstick for every version of the study (see `studyContractLock`), and from then on the
 * only way out is a new study. So it is recognised by value, everywhere a run is about to happen,
 * and refused there. Recognised by value rather than by a flag so saved studies need no migration
 * and a person who deliberately types these exact numbers is simply asked to confirm by changing
 * any one of them.
 */
const PLACEHOLDER_WORKLOAD_INPUT = { arrival: { kind: "poisson", ratePerSec: 50 } } as const;
export const PLACEHOLDER_WORKLOAD: StudyWorkload = StudyWorkloadSchema.parse(PLACEHOLDER_WORKLOAD_INPUT);

export function isPlaceholderWorkload(workload: StudyWorkload): boolean {
  return sameValue(workload, PLACEHOLDER_WORKLOAD);
}

/** Structural equality that does not care about key order, which JSON.stringify would. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** One line for a person or an agent, saying what the placeholder is and what to do about it. */
export const PLACEHOLDER_WORKLOAD_MESSAGE =
  "The workload is still the Studio's placeholder (Poisson 50 req/s, 1200 s, 8 seeds). Running would lock it into the " +
  "yardstick for every version of this project. Set the observed or assumed arrival first: studio_update_study " +
  '{ contract: { workload: { arrival: { kind: "poisson", ratePerSec: <rate> } } } }, or the Workload row in the interface.';

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
    super(
      `the project contract is locked: ${reason}. Every version of a project shares this yardstick, so a new version ` +
        "cannot change it either. Ask the person to clear the results, or start a new project."
    );
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
    approval: null,
    updatedAt: now,
  });
}
