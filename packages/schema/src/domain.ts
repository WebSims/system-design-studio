import { z } from "zod";

/**
 * The declarative domain layer: state, expressions, and workflow operations.
 *
 * WHY THIS EXISTS
 *
 * Everything the engine could previously describe was load-shaped. A request cost
 * some milliseconds at some stations and either succeeded or did not. That is enough
 * to answer "how fast" and "how much" and it is structurally incapable of answering
 * "is this correct", because a design with no state cannot be inconsistent.
 *
 * The failures people actually ship are state failures: two winners for one prize,
 * a retried charge, a message processed twice, a lock whose owner has already been
 * declared dead. None of them are visible to a latency model. All of them are
 * visible to a state model, and most of them are visible under only two or three
 * concurrent actors -- which is what makes exhaustive exploration viable.
 *
 * SO WHY DECLARATIVE, RATHER THAN LETTING PEOPLE WRITE CODE
 *
 * Two reasons, both load-bearing.
 *
 * The first is that the same workflow must be executed by two very different
 * engines: a breadth-first explorer that enumerates every interleaving, and a
 * discrete-event simulator that samples one. If the workflow were arbitrary
 * JavaScript, "the explorer and the simulator agree" would be unprovable and in
 * practice untrue -- the classic failure of tools that grow a second execution path.
 * A closed set of operations over a closed set of state shapes can be applied by a
 * single shared kernel, and the conformance test that proves it is possible to write.
 *
 * The second is that a counterexample has to be explainable. A trace through opaque
 * user code is a stack, not an argument. A trace through named operations on named
 * collections is a story: "actor A read inventory = 1, actor B read inventory = 1,
 * both wrote 0, two people hold the last pizza."
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * Loops, function calls, recursion, and unbounded data. A workflow is a finite tree
 * of operations with finite branching. This is not a general-purpose language and
 * should not become one: the moment a workflow can loop an unbounded number of
 * times, the state space stops being usefully bounded and the honest answer to every
 * correctness question becomes "inconclusive".
 *
 * All durations are MILLISECONDS, matching the rest of the schema.
 */

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

/**
 * Structural limits on a workflow.
 *
 * These bound the *shared kernel's* work per transition, and therefore the
 * explorer's per-state cost. They are not about taste either: the explorer's
 * running time is (states) x (enabled transitions) x (cost of one transition), and
 * the last factor has to stay small for the first to be allowed to be large.
 */
export const MAX_COLLECTIONS = 32;
export const MAX_FIELDS_PER_COLLECTION = 24;
export const MAX_REQUEST_FIELDS = 24;
export const MAX_OPERATIONS_PER_HANDLER = 200;
/** Nesting depth for `atomic` / `branch` bodies and for expression trees. */
export const MAX_NESTING_DEPTH = 12;
/** Rows one table may hold before the kernel refuses to grow it further. */
export const MAX_TABLE_ROWS = 4096;

// ---------------------------------------------------------------------------
// values and field types
// ---------------------------------------------------------------------------

/**
 * The value domain.
 *
 * Three JavaScript types, chosen because they are exactly the types that
 * canonicalise to a stable string without ambiguity. `number` is constrained to
 * integers everywhere it is stored (see `FieldType`), because floating point state
 * would make canonical hashing -- and therefore duplicate-state detection -- depend
 * on the order in which arithmetic happened to be performed.
 */
export const LiteralSchema = z.union([z.number(), z.boolean(), z.string()]);
export type Literal = z.infer<typeof LiteralSchema>;

/**
 * Field types.
 *
 * `timestamp` is a LOGICAL timestamp, not a wall clock. It holds the millisecond
 * value the executing engine reports as "now", which in the explorer is a small
 * integer counter and in the simulator is the simulated clock. Nothing compares a
 * timestamp against real time; expiry is modelled as an explicit transition, not as
 * a clock reading (see `scheduleExpiry`). This is the difference between a model
 * that can be explored and a model that can only be sampled.
 */
export const FieldTypeSchema = z.enum(["int", "bool", "string", "enum", "timestamp"]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: FieldTypeSchema,
    /** Required when `type` is `enum`, ignored otherwise. */
    values: z.array(z.string().min(1)).max(64).default([]),
    /** Value a row takes for this field when an insert does not mention it. */
    default: LiteralSchema.nullable().default(null),
  })
  .strict();
export type Field = z.infer<typeof FieldSchema>;

// ---------------------------------------------------------------------------
// state collections
// ---------------------------------------------------------------------------

/**
 * A piece of durable state, bound to the design node that stores it.
 *
 * The `node` binding is what keeps the correctness model and the performance model
 * describing the same system. Without it a workflow could claim an atomic
 * conditional decrement while the design contained no datastore capable of one, and
 * the two views would drift into describing different architectures -- which is the
 * failure mode of every tool that models correctness and cost separately.
 *
 * Two shapes only:
 *
 *   `counter` -- a single integer. Inventory, balance, seats remaining.
 *   `table`   -- rows keyed by one field. Claims, reservations, idempotency records.
 *
 * A counter is not a one-row table with extra steps. The distinction is that a
 * counter supports an atomic guarded delta as a primitive, which is precisely the
 * operation whose presence or absence separates candidate 1 from candidate 7 in the
 * shipped portfolio.
 */
export const CounterCollectionSchema = z
  .object({
    kind: z.literal("counter"),
    id: z.string().min(1).max(64),
    label: z.string().default(""),
    /** Design node id that stores this collection. Must be a datastore node. */
    node: z.string().min(1),
    initial: z.number().int().default(0),
  })
  .strict();
export type CounterCollection = z.infer<typeof CounterCollectionSchema>;

export const TableCollectionSchema = z
  .object({
    kind: z.literal("table"),
    id: z.string().min(1).max(64),
    label: z.string().default(""),
    node: z.string().min(1),
    /** Name of the primary-key field. Must appear in `fields`. */
    key: z.string().min(1).max(64),
    fields: z.array(FieldSchema).min(1).max(MAX_FIELDS_PER_COLLECTION),
    /**
     * Rows present before the workload starts.
     *
     * Seeded state exists so a study can express "these ten users already claimed"
     * without spending ten transitions of the exploration budget getting there.
     */
    seed: z.array(z.record(LiteralSchema)).max(256).default([]),
  })
  .strict();
export type TableCollection = z.infer<typeof TableCollectionSchema>;

export const CollectionSchema = z.discriminatedUnion("kind", [
  CounterCollectionSchema,
  TableCollectionSchema,
]);
export type Collection = z.infer<typeof CollectionSchema>;

// ---------------------------------------------------------------------------
// request field generation
// ---------------------------------------------------------------------------

/**
 * How a request's domain fields are produced.
 *
 * The generators exist because the interesting correctness questions are all about
 * *identity*: which requests share a user, which share an idempotency key, which are
 * the same logical request arriving twice. A workload that generates a fresh unique
 * id for every field cannot exhibit a duplicate-claim bug, so a tool that only
 * offered that would report every design safe.
 *
 * `duplicate` and `idempotencyKey` are therefore not conveniences, they are the
 * mechanism by which the fault model reaches the domain.
 */
const ConstantStrategySchema = z
  .object({ kind: z.literal("constant"), value: LiteralSchema })
  .strict();

/** 0, step, 2*step, ... Unique per request. The "no contention" baseline. */
const SequenceStrategySchema = z
  .object({
    kind: z.literal("sequence"),
    start: z.number().int().default(0),
    step: z.number().int().positive().default(1),
    /** Rendered as `${prefix}${n}` when the field is a string. */
    prefix: z.string().default(""),
  })
  .strict();

const UniformStrategySchema = z
  .object({
    kind: z.literal("uniform"),
    min: z.number().int(),
    max: z.number().int(),
    prefix: z.string().default(""),
  })
  .strict();

const ChoiceStrategySchema = z
  .object({
    kind: z.literal("choice"),
    values: z.array(LiteralSchema).min(1).max(256),
    /** Relative weights, normalised. Empty = uniform. */
    weights: z.array(z.number().nonnegative()).max(256).default([]),
  })
  .strict();

/**
 * Zipf over `keys` distinct values. The realistic contention shape: a few users or
 * keys attract most of the traffic, which is what makes a race reachable at moderate
 * load instead of only under a synthetic thundering herd.
 */
const ZipfStrategySchema = z
  .object({
    kind: z.literal("zipf"),
    keys: z.number().int().positive().max(1_000_000),
    skew: z.number().min(0).max(3).default(0.9),
    prefix: z.string().default(""),
  })
  .strict();

/**
 * A deterministic function of other request fields.
 *
 * This is the honest model of a client-generated idempotency key: it is stable
 * across retries of the same logical request precisely because it is derived from
 * that request's own content, and it collides between two genuinely distinct
 * requests that happen to have identical content -- which is a real hazard the
 * schema should not hide.
 */
const IdempotencyKeyStrategySchema = z
  .object({
    kind: z.literal("idempotencyKey"),
    of: z.array(z.string().min(1)).min(1).max(8),
    prefix: z.string().default("idk-"),
  })
  .strict();

/**
 * The strategies a `duplicate` may fall back to.
 *
 * Deliberately excludes `duplicate` itself. A duplicate-of-a-duplicate has no
 * additional meaning -- the outer probability already composes -- and allowing the
 * recursion would make the generator's depth unbounded for no expressive gain, at
 * the cost of a schema that cannot be turned into a flat JSON Schema for WebMCP.
 */
const BaseGenStrategySchema = z.discriminatedUnion("kind", [
  ConstantStrategySchema,
  SequenceStrategySchema,
  UniformStrategySchema,
  ChoiceStrategySchema,
  ZipfStrategySchema,
  IdempotencyKeyStrategySchema,
]);
export type BaseGenStrategy = z.infer<typeof BaseGenStrategySchema>;

/**
 * With probability `probability`, reuse the value this field took on the previous
 * request; otherwise draw from `fallback`.
 *
 * This is a *duplicate submission*: the same logical intent arriving twice from the
 * outside, as opposed to a retry generated inside the system. The distinction
 * matters because a duplicate submission carries a fresh idempotency key unless the
 * client is careful, and a retry carries the old one.
 */
const DuplicateStrategySchema = z
  .object({
    kind: z.literal("duplicate"),
    probability: z.number().min(0).max(1).default(0.05),
    fallback: BaseGenStrategySchema,
  })
  .strict();

export const GenStrategySchema = z.discriminatedUnion("kind", [
  ConstantStrategySchema,
  SequenceStrategySchema,
  UniformStrategySchema,
  ChoiceStrategySchema,
  ZipfStrategySchema,
  IdempotencyKeyStrategySchema,
  DuplicateStrategySchema,
]);
export type GenStrategy = z.infer<typeof GenStrategySchema>;

export const RequestFieldSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: FieldTypeSchema,
    values: z.array(z.string().min(1)).max(64).default([]),
    strategy: GenStrategySchema,
    /**
     * Distinct values the explorer is allowed to use for this field.
     *
     * The explorer does not sample. It needs a small finite domain, and the honest
     * way to get one is to say so explicitly rather than to quietly truncate a Zipf
     * over a million keys. Two users and one idempotency key is enough to exhibit
     * every application-level race in the v1 fault model.
     */
    exploreDomain: z.array(LiteralSchema).max(8).default([]),
  })
  .strict();
export type RequestField = z.infer<typeof RequestFieldSchema>;

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

export const ArithOpSchema = z.enum(["+", "-", "*", "/", "%"]);
export type ArithOp = z.infer<typeof ArithOpSchema>;

export const CompareOpSchema = z.enum(["==", "!=", "<", "<=", ">", ">="]);
export type CompareOp = z.infer<typeof CompareOpSchema>;

/**
 * The expression language.
 *
 * Total, finite, and side-effect free. Every node either produces a `Literal` or
 * produces the explicit absent value; there is no exception path, because an
 * expression that could throw mid-transition would leave the explorer holding a
 * half-applied state. Division by zero yields absent rather than Infinity or NaN,
 * both of which break canonical hashing.
 *
 * `count`, `distinct` and `sum` are the aggregate forms, and they exist because the
 * invariants that matter are aggregate statements: "no more claims than inventory",
 * "at most one claim per user", "allocated plus remaining equals initial". Without
 * `distinct` the one-per-user rule cannot be written down, and it is the rule that
 * half the shipped portfolio gets wrong.
 */
export type Expr =
  | { kind: "lit"; value: Literal | null }
  /** Value of a counter collection. Absent if the collection is a table. */
  | { kind: "counter"; collection: string }
  /** A generated field of the request being handled. */
  | { kind: "request"; field: string }
  /** A local variable bound by `assign` or by a `read` / `acquireLease` result. */
  | { kind: "local"; name: string }
  /** Field of a row, addressed by key. Absent if no such row. */
  | { kind: "row"; collection: string; key: Expr; field: string }
  | { kind: "exists"; collection: string; key: Expr }
  | { kind: "count"; collection: string; where: Expr | null }
  | { kind: "distinct"; collection: string; field: string; where: Expr | null }
  | { kind: "sum"; collection: string; field: string; where: Expr | null }
  /** Field of the row currently bound by an enclosing `where`. */
  | { kind: "field"; name: string }
  | { kind: "arith"; op: ArithOp; left: Expr; right: Expr }
  | { kind: "compare"; op: CompareOp; left: Expr; right: Expr }
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] }
  | { kind: "not"; arg: Expr }
  /** True when the argument is the absent value. */
  | { kind: "isNull"; arg: Expr }
  /** The executing engine's logical clock, in ms. */
  | { kind: "now" };

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("lit"), value: LiteralSchema.nullable() }).strict(),
    z.object({ kind: z.literal("counter"), collection: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("request"), field: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("local"), name: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal("row"),
        collection: z.string().min(1),
        key: ExprSchema,
        field: z.string().min(1),
      })
      .strict(),
    z
      .object({ kind: z.literal("exists"), collection: z.string().min(1), key: ExprSchema })
      .strict(),
    z
      .object({
        kind: z.literal("count"),
        collection: z.string().min(1),
        where: ExprSchema.nullable().default(null),
      })
      .strict(),
    z
      .object({
        kind: z.literal("distinct"),
        collection: z.string().min(1),
        field: z.string().min(1),
        where: ExprSchema.nullable().default(null),
      })
      .strict(),
    z
      .object({
        kind: z.literal("sum"),
        collection: z.string().min(1),
        field: z.string().min(1),
        where: ExprSchema.nullable().default(null),
      })
      .strict(),
    z.object({ kind: z.literal("field"), name: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal("arith"),
        op: ArithOpSchema,
        left: ExprSchema,
        right: ExprSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("compare"),
        op: CompareOpSchema,
        left: ExprSchema,
        right: ExprSchema,
      })
      .strict(),
    z.object({ kind: z.literal("and"), args: z.array(ExprSchema).min(1).max(16) }).strict(),
    z.object({ kind: z.literal("or"), args: z.array(ExprSchema).min(1).max(16) }).strict(),
    z.object({ kind: z.literal("not"), arg: ExprSchema }).strict(),
    z.object({ kind: z.literal("isNull"), arg: ExprSchema }).strict(),
    z.object({ kind: z.literal("now") }).strict(),
  ])
) as z.ZodType<Expr>;

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/**
 * What a write does to the value it targets.
 *
 * `set` replaces. `delta` adds, and is the only form that is meaningful on a
 * counter under concurrency: `set` on a counter is a read-modify-write whose read
 * happened in an earlier operation and therefore may be stale, which is exactly the
 * lost-update bug candidate 1 is built to demonstrate.
 */
export const WriteModeSchema = z.enum(["set", "delta"]);
export type WriteMode = z.infer<typeof WriteModeSchema>;

/**
 * What happens when a guarded operation's guard fails or a unique insert collides.
 *
 * `fail` aborts the handler with a domain rejection -- the correct behaviour for
 * "sold out". `continue` proceeds to the next operation with the outcome recorded in
 * a local, which is how an idempotent handler distinguishes "I just did the work"
 * from "someone already did it" and returns the same answer either way.
 */
export const OnConflictSchema = z.enum(["fail", "continue"]);
export type OnConflict = z.infer<typeof OnConflictSchema>;

export const ResponseStatusSchema = z.enum(["success", "rejected", "error"]);
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;

/**
 * A workflow operation.
 *
 * SCHEDULING POINTS
 *
 * The single most consequential semantic choice here: `read` and `write` are
 * separate operations, and control may pass to another actor between them. That is
 * not an implementation detail leaking out, it is the whole point -- a model in
 * which read-then-write is indivisible cannot express the bug that read-then-write
 * is a bug.
 *
 * Conversely `conditionalWrite`, `insertUnique` and `atomic` are indivisible. No
 * actor observes their intermediate state and no fault interrupts them partway.
 * This is the model of a compare-and-set, a unique index, and a serializable
 * transaction respectively, and it is the honest boundary: real datastores give you
 * atomicity at exactly this granularity and no finer.
 *
 * ON "EXACTLY ONCE"
 *
 * There is no operation and no queue setting that provides exactly-once delivery,
 * because none exists. Exactly-once *effects* are reachable, and the only routes
 * are `insertUnique` on a key derived from request identity, or a `conditionalWrite`
 * guarded on the effect not yet having happened. A workflow that wants the property
 * must therefore write down the mechanism, which means a reader of the design can
 * see whether it is really there.
 */
export type Operation =
  /**
   * Load state into a local. A scheduling point: whatever is read may be stale by
   * the time it is used.
   */
  | {
      op: "read";
      id: string;
      /** Expression evaluated against current state. */
      value: Expr;
      into: string;
    }
  /** Unguarded mutation. Also a scheduling point. */
  | {
      op: "write";
      id: string;
      collection: string;
      /** Row key. Ignored (and should be absent) for counters. */
      key: Expr | null;
      mode: WriteMode;
      /** Counter form: the value or delta. */
      value: Expr | null;
      /** Table form: field name -> value. */
      fields: Record<string, Expr>;
    }
  /**
   * Indivisible read-check-write. The compare-and-set / guarded update primitive.
   *
   * `guard` is evaluated and the write applied with no interleaving between them.
   */
  | {
      op: "conditionalWrite";
      id: string;
      collection: string;
      key: Expr | null;
      guard: Expr;
      mode: WriteMode;
      value: Expr | null;
      fields: Record<string, Expr>;
      onFail: OnConflict;
      /** Local receiving `true` if the guard held. */
      into: string | null;
    }
  /**
   * Indivisible insert that fails if the key is already present.
   *
   * The unique-index primitive, and the load-bearing one: it is the only operation
   * that makes "at most one claim per user" hold under arbitrary interleaving
   * without a lock.
   */
  | {
      op: "insertUnique";
      id: string;
      collection: string;
      key: Expr;
      fields: Record<string, Expr>;
      onConflict: OnConflict;
      /** Local receiving `true` if this actor was the inserter. */
      into: string | null;
    }
  /**
   * A serializable transaction. Everything inside commits together or not at all.
   *
   * Nested `atomic` is rejected by validation rather than flattened, because a
   * reader would otherwise have to guess whether the inner block meant anything.
   */
  | { op: "atomic"; id: string; body: Operation[] }
  /**
   * Take a lease on a key, expiring after `ttlMs`.
   *
   * `fencing` decides whether the holder receives a monotonically increasing token.
   * Without one, a holder whose lease has expired cannot be distinguished from the
   * current holder by the datastore, and the design has a mutual-exclusion property
   * it does not actually possess -- the failure candidate 3 exists to demonstrate
   * and candidate 5 exists to fix.
   */
  | {
      op: "acquireLease";
      id: string;
      lock: string;
      key: Expr;
      ttlMs: number;
      fencing: boolean;
      /** Local receiving the fencing token, or `true`/`false` when unfenced. */
      into: string;
      /** What to do when the lease is held by someone else. */
      onBusy: OnConflict;
    }
  | { op: "releaseLease"; id: string; lock: string; key: Expr }
  /** Enqueue a message. Returns immediately; the caller does not wait. */
  | {
      op: "publish";
      id: string;
      queue: string;
      message: Record<string, Expr>;
    }
  /**
   * Acknowledge the message that triggered this handler.
   *
   * Until this runs the message remains eligible for redelivery. A consumer that
   * mutates state and then crashes before its `ack` will see that mutation applied
   * twice, which is the at-least-once hazard in its entirety.
   */
  | { op: "ack"; id: string }
  | { op: "branch"; id: string; cond: Expr; then: Operation[]; else: Operation[] }
  | { op: "assign"; id: string; name: string; value: Expr }
  /**
   * Arm a timer that will run `handler` after `afterMs`, carrying `args`.
   *
   * Expiry is a first-class transition rather than a clock comparison so that the
   * explorer can decide to fire it early, late, or interleaved with anything else.
   * A reservation that expires while its owner is one operation from confirming is
   * a real bug and an unreachable one in any model where expiry is a timestamp
   * check.
   */
  | {
      op: "scheduleExpiry";
      id: string;
      handler: string;
      afterMs: number;
      args: Record<string, Expr>;
    }
  /**
   * Terminate the handler with a status, optionally recording a business outcome.
   *
   * `outcome` is a free label counted by the performance engine, which is how
   * "valid allocations" and "duplicate successes" become measurable numbers rather
   * than something a reader has to infer from latency.
   */
  | {
      op: "respond";
      id: string;
      status: ResponseStatus;
      outcome: string | null;
    };

export const OperationSchema: z.ZodType<Operation> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("read"),
        id: z.string().min(1),
        value: ExprSchema,
        into: z.string().min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal("write"),
        id: z.string().min(1),
        collection: z.string().min(1),
        key: ExprSchema.nullable().default(null),
        mode: WriteModeSchema.default("set"),
        value: ExprSchema.nullable().default(null),
        fields: z.record(ExprSchema).default({}),
      })
      .strict(),
    z
      .object({
        op: z.literal("conditionalWrite"),
        id: z.string().min(1),
        collection: z.string().min(1),
        key: ExprSchema.nullable().default(null),
        guard: ExprSchema,
        mode: WriteModeSchema.default("set"),
        value: ExprSchema.nullable().default(null),
        fields: z.record(ExprSchema).default({}),
        onFail: OnConflictSchema.default("fail"),
        into: z.string().min(1).nullable().default(null),
      })
      .strict(),
    z
      .object({
        op: z.literal("insertUnique"),
        id: z.string().min(1),
        collection: z.string().min(1),
        key: ExprSchema,
        fields: z.record(ExprSchema).default({}),
        onConflict: OnConflictSchema.default("fail"),
        into: z.string().min(1).nullable().default(null),
      })
      .strict(),
    z
      .object({
        op: z.literal("atomic"),
        id: z.string().min(1),
        body: z.array(OperationSchema).min(1).max(MAX_OPERATIONS_PER_HANDLER),
      })
      .strict(),
    z
      .object({
        op: z.literal("acquireLease"),
        id: z.string().min(1),
        lock: z.string().min(1),
        key: ExprSchema,
        ttlMs: z.number().int().positive().max(3_600_000),
        fencing: z.boolean().default(false),
        into: z.string().min(1),
        onBusy: OnConflictSchema.default("fail"),
      })
      .strict(),
    z
      .object({
        op: z.literal("releaseLease"),
        id: z.string().min(1),
        lock: z.string().min(1),
        key: ExprSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("publish"),
        id: z.string().min(1),
        queue: z.string().min(1),
        message: z.record(ExprSchema).default({}),
      })
      .strict(),
    z.object({ op: z.literal("ack"), id: z.string().min(1) }).strict(),
    z
      .object({
        op: z.literal("branch"),
        id: z.string().min(1),
        cond: ExprSchema,
        then: z.array(OperationSchema).max(MAX_OPERATIONS_PER_HANDLER).default([]),
        else: z.array(OperationSchema).max(MAX_OPERATIONS_PER_HANDLER).default([]),
      })
      .strict(),
    z
      .object({
        op: z.literal("assign"),
        id: z.string().min(1),
        name: z.string().min(1),
        value: ExprSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("scheduleExpiry"),
        id: z.string().min(1),
        handler: z.string().min(1),
        afterMs: z.number().int().positive().max(3_600_000),
        args: z.record(ExprSchema).default({}),
      })
      .strict(),
    z
      .object({
        op: z.literal("respond"),
        id: z.string().min(1),
        status: ResponseStatusSchema,
        outcome: z.string().max(64).nullable().default(null),
      })
      .strict(),
  ])
) as z.ZodType<Operation>;

// ---------------------------------------------------------------------------
// handlers and workflow
// ---------------------------------------------------------------------------

/**
 * What causes a handler to run.
 *
 * `request` is the root: one per workflow, driven by the client arrival process.
 * `queue` is driven by delivery, and may run more than once for one message.
 * `expiry` is driven by `scheduleExpiry`, and may run *after* the request that
 * armed it has already responded -- which is the reservation-expiry hazard.
 */
export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request") }).strict(),
  z.object({ kind: z.literal("queue"), queue: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("expiry") }).strict(),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const HandlerSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().default(""),
    trigger: TriggerSchema,
    /**
     * Design node whose capacity this handler consumes.
     *
     * Required, and required to exist, because a workflow that runs nowhere costs
     * nothing, and a correctness result about a design whose performance model was
     * never engaged is the kind of half-truth this tool is built to avoid.
     */
    node: z.string().min(1),
    steps: z.array(OperationSchema).max(MAX_OPERATIONS_PER_HANDLER).default([]),
  })
  .strict();
export type Handler = z.infer<typeof HandlerSchema>;

export const WorkflowSchema = z
  .object({
    collections: z.array(CollectionSchema).max(MAX_COLLECTIONS).default([]),
    requestFields: z.array(RequestFieldSchema).max(MAX_REQUEST_FIELDS).default([]),
    handlers: z.array(HandlerSchema).min(1).max(32),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function collectionById(wf: Workflow, id: string): Collection | undefined {
  return wf.collections.find((c) => c.id === id);
}

export function handlerById(wf: Workflow, id: string): Handler | undefined {
  return wf.handlers.find((h) => h.id === id);
}

export function rootHandler(wf: Workflow): Handler | undefined {
  return wf.handlers.find((h) => h.trigger.kind === "request");
}

/**
 * Walk every operation in a handler, including nested `atomic` and `branch` bodies.
 *
 * Pre-order, deterministic, and used by validation, by the WebMCP schema
 * generator's identifier checks, and by the resource attribution pass. Written once
 * so those three cannot disagree about what "every operation" means.
 */
export function walkOperations(
  steps: readonly Operation[],
  visit: (op: Operation, depth: number) => void,
  depth = 0
): void {
  for (const op of steps) {
    visit(op, depth);
    if (op.op === "atomic") walkOperations(op.body, visit, depth + 1);
    else if (op.op === "branch") {
      walkOperations(op.then, visit, depth + 1);
      walkOperations(op.else, visit, depth + 1);
    }
  }
}

/** Every operation in the workflow, paired with its owning handler. */
export function allOperations(wf: Workflow): Array<{ handler: Handler; op: Operation }> {
  const out: Array<{ handler: Handler; op: Operation }> = [];
  for (const handler of wf.handlers) {
    walkOperations(handler.steps, (op) => out.push({ handler, op }));
  }
  return out;
}

/**
 * Whether control may pass to another actor immediately after this operation.
 *
 * The explorer uses this to decide where to branch and the simulator uses it to
 * decide where to yield. One definition, one file, so the two engines cannot end up
 * exploring a different concurrency model than they simulate.
 *
 * Everything that touches shared state outside an indivisible bracket is a
 * scheduling point. `assign`, `branch` and `respond` are not: they are local, and
 * branching there would multiply the state space without admitting any behaviour
 * that branching at the adjacent state-touching operation does not already admit.
 */
export function isSchedulingPoint(op: Operation): boolean {
  switch (op.op) {
    case "read":
    case "write":
    case "conditionalWrite":
    case "insertUnique":
    case "atomic":
    case "acquireLease":
    case "releaseLease":
    case "publish":
    case "ack":
    case "scheduleExpiry":
      return true;
    case "assign":
    case "branch":
    case "respond":
      return false;
  }
}

/**
 * The design node an operation's cost lands on, or null for purely local work.
 *
 * Used by the discrete-event engine to charge datastore, lock and queue capacity,
 * and by validation to check that the node named actually exists and is of a kind
 * that could perform the operation.
 */
export function operationTarget(
  wf: Workflow,
  op: Operation
): { nodeId: string; role: "datastore" | "lock" | "queue" } | null {
  switch (op.op) {
    case "write":
    case "conditionalWrite":
    case "insertUnique": {
      const c = collectionById(wf, op.collection);
      return c ? { nodeId: c.node, role: "datastore" } : null;
    }
    case "read": {
      const ids = collectionsReferenced(op.value);
      for (const id of ids) {
        const c = collectionById(wf, id);
        if (c) return { nodeId: c.node, role: "datastore" };
      }
      return null;
    }
    case "acquireLease":
    case "releaseLease":
      return { nodeId: op.lock, role: "lock" };
    case "publish":
      return { nodeId: op.queue, role: "queue" };
    case "atomic": {
      for (const inner of op.body) {
        const t = operationTarget(wf, inner);
        if (t) return t;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Every collection id an expression reads, in deterministic pre-order. */
export function collectionsReferenced(expr: Expr): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  walkExpr(expr, (e) => {
    switch (e.kind) {
      case "counter":
      case "exists":
      case "count":
      case "distinct":
      case "sum":
      case "row":
        push(e.collection);
        break;
      default:
        break;
    }
  });
  return out;
}

/** Pre-order walk of an expression tree. */
export function walkExpr(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "row":
      walkExpr(expr.key, visit);
      break;
    case "exists":
      walkExpr(expr.key, visit);
      break;
    case "count":
    case "distinct":
    case "sum":
      if (expr.where) walkExpr(expr.where, visit);
      break;
    case "arith":
    case "compare":
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      break;
    case "and":
    case "or":
      for (const a of expr.args) walkExpr(a, visit);
      break;
    case "not":
    case "isNull":
      walkExpr(expr.arg, visit);
      break;
    default:
      break;
  }
}

/** Maximum nesting depth of an expression tree, for the depth bound. */
export function exprDepth(expr: Expr): number {
  let max = 0;
  const rec = (e: Expr, d: number): void => {
    if (d > max) max = d;
    switch (e.kind) {
      case "row":
      case "exists":
        rec(e.key, d + 1);
        break;
      case "count":
      case "distinct":
      case "sum":
        if (e.where) rec(e.where, d + 1);
        break;
      case "arith":
      case "compare":
        rec(e.left, d + 1);
        rec(e.right, d + 1);
        break;
      case "and":
      case "or":
        for (const a of e.args) rec(a, d + 1);
        break;
      case "not":
      case "isNull":
        rec(e.arg, d + 1);
        break;
      default:
        break;
    }
  };
  rec(expr, 1);
  return max;
}
