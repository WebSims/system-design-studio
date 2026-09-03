import type { Collection, Design, Expr, Handler, Invariant, Operation, RequestField, Workflow } from "@sds/schema"

import { buildInvariant } from "../correctness/builder"

/**
 * Pattern templates for request steps.
 *
 * WHY TEMPLATES
 *
 * The thing that races is `design.workflow`, and until now the only way to author one was
 * to post JSON through WebMCP. A developer drawing boxes could never make a race happen.
 * These templates are the shapes that already ship as the pizza candidates -- the four
 * broken ones and the three safe ones -- expressed as constructors over a *binding*: which
 * node runs the handler, which node stores the state, which lock or queue is involved.
 *
 * A template produces the same object the agent would post. It is a constructor, not a
 * second representation, so the expert JSON view and the guided view never disagree.
 *
 * DOM-FREE, so the shapes are unit-testable in node.
 */

export type PatternId =
  | "check-then-write"
  | "atomic-decrement"
  | "unique-insert"
  | "fenced-lease"
  | "unfenced-lease"
  | "queue-worker"
  | "serializable-transaction"

export interface PatternBinding {
  /** Server node that runs the request handler. */
  service: string
  /** Database node that stores the collections. */
  store: string
  /** Lock node, required by the lease patterns. */
  lock: string | null
  /** Queue node, required by the queue pattern. */
  queue: string | null
  /** Starting stock of the scarce resource. */
  stock: number
}

export interface BehaviourPattern {
  id: PatternId
  label: string
  /** What the shipped pizza portfolio says about this shape. */
  verdict: "broken" | "safe"
  summary: string
  /** Which extra node kinds the binding must supply. */
  needs: Array<"lock" | "queue">
  build: (binding: PatternBinding) => Workflow
  /**
   * Whether the lock service must issue fencing tokens for this shape to validate.
   * Undefined leaves the lock node as drawn.
   */
  lockFencing?: boolean
}

// ---------------------------------------------------------------------------
// expression helpers
// ---------------------------------------------------------------------------

const lit = (value: number | string | boolean): Expr => ({ kind: "lit", value })
const counter = (collection: string): Expr => ({ kind: "counter", collection })
const req = (field: string): Expr => ({ kind: "request", field })
const local = (name: string): Expr => ({ kind: "local", name })
const gt = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: ">", left, right })
const eq = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: "==", left, right })
const isTrue = (name: string): Expr => eq(local(name), lit(true))

export const INITIAL_COUNTER = "initialInventory"
export const STOCK_COUNTER = "inventory"
export const CLAIMS_TABLE = "claims"
export const LEASE_KEY = "free-pizza"

// ---------------------------------------------------------------------------
// state and identity
// ---------------------------------------------------------------------------

/**
 * `claimKeyMeaning` decides what the claims table is keyed by. Keyed by attempt, two
 * attempts from one person are two rows and the one-per-person rule can fail. Keyed by
 * person, the unique insert is what enforces the rule.
 */
const collectionsFor = (store: string, stock: number, keyedBy: "attempt" | "person"): Collection[] => [
  { kind: "counter", id: INITIAL_COUNTER, label: "units at the start", node: store, initial: stock },
  { kind: "counter", id: STOCK_COUNTER, label: "units remaining", node: store, initial: stock },
  {
    kind: "table",
    id: CLAIMS_TABLE,
    label: `claims, one row per ${keyedBy}`,
    node: store,
    key: "claimKey",
    fields: [
      { name: "claimKey", type: "string", values: [], default: null },
      { name: "userId", type: "string", values: [], default: null },
      { name: "status", type: "enum", values: ["reserved", "confirmed"], default: "confirmed" },
    ],
    seed: [],
  },
]

export const REQUEST_FIELDS: RequestField[] = [
  {
    name: "userId",
    type: "string",
    values: [],
    strategy: { kind: "zipf", keys: 10_000, skew: 1.1, prefix: "u" },
    exploreDomain: ["u1", "u2"],
  },
  {
    name: "claimId",
    type: "string",
    values: [],
    strategy: { kind: "duplicate", probability: 0.08, fallback: { kind: "sequence", start: 0, step: 1, prefix: "c" } },
    exploreDomain: ["c1", "c2"],
  },
  {
    name: "idemKey",
    type: "string",
    values: [],
    strategy: { kind: "idempotencyKey", of: ["userId", "claimId"], prefix: "k-" },
    exploreDomain: [],
  },
]

// ---------------------------------------------------------------------------
// step shapes
// ---------------------------------------------------------------------------

const RESPOND_OK: Operation = { op: "respond", id: "ok", status: "success", outcome: "allocated" }
const RESPOND_SOLD_OUT: Operation = { op: "respond", id: "soldout", status: "rejected", outcome: "soldOut" }
const RESPOND_ALREADY: Operation = { op: "respond", id: "already", status: "rejected", outcome: "alreadyClaimed" }

const decrement = (id: string): Operation => ({
  op: "write",
  id,
  collection: STOCK_COUNTER,
  key: null,
  mode: "delta",
  value: lit(-1),
  fields: {},
})

const recordClaim = (keyField: string): Operation => ({
  op: "write",
  id: "record-claim",
  collection: CLAIMS_TABLE,
  key: req(keyField),
  mode: "set",
  value: null,
  fields: { userId: req("userId"), status: lit("confirmed") },
})

/** read, decide, decrement, record. The read and the write are a scheduling point apart. */
const checkThenWrite = (): Operation[] => [
  { op: "read", id: "read-stock", value: counter(STOCK_COUNTER), into: "left" },
  {
    op: "branch",
    id: "have-stock",
    cond: gt(local("left"), lit(0)),
    then: [decrement("decrement"), recordClaim("claimId"), RESPOND_OK],
    else: [RESPOND_SOLD_OUT],
  },
]

const leaseGuarded = (lock: string, fencing: boolean): Operation[] => [
  {
    op: "acquireLease",
    id: "acquire",
    lock,
    key: lit(LEASE_KEY),
    ttlMs: 2000,
    fencing,
    into: "lease",
    onBusy: "fail",
  },
  ...checkThenWrite(),
  { op: "releaseLease", id: "release", lock, key: lit(LEASE_KEY) },
]

/** Guarded atomic decrement, then a unique claim keyed by the person. */
const atomicDecrementUniqueClaim = (): Operation[] => [
  {
    op: "conditionalWrite",
    id: "take-one",
    collection: STOCK_COUNTER,
    key: null,
    guard: gt(counter(STOCK_COUNTER), lit(0)),
    mode: "delta",
    value: lit(-1),
    fields: {},
    onFail: "continue",
    into: "took",
  },
  {
    op: "branch",
    id: "took-one",
    cond: isTrue("took"),
    then: [
      {
        op: "insertUnique",
        id: "claim-once",
        collection: CLAIMS_TABLE,
        key: req("userId"),
        fields: { userId: req("userId"), status: lit("confirmed") },
        onConflict: "continue",
        into: "mine",
      },
      {
        op: "branch",
        id: "was-mine",
        cond: isTrue("mine"),
        then: [RESPOND_OK],
        else: [
          {
            op: "write",
            id: "give-back",
            collection: STOCK_COUNTER,
            key: null,
            mode: "delta",
            value: lit(1),
            fields: {},
          },
          RESPOND_ALREADY,
        ],
      },
    ],
    else: [RESPOND_SOLD_OUT],
  },
]

/** Unique insert first, then an unguarded decrement. One-per-person holds; the count may not. */
const uniqueInsertThenDecrement = (): Operation[] => [
  {
    op: "insertUnique",
    id: "claim-once",
    collection: CLAIMS_TABLE,
    key: req("userId"),
    fields: { userId: req("userId"), status: lit("confirmed") },
    onConflict: "continue",
    into: "mine",
  },
  {
    op: "branch",
    id: "was-mine",
    cond: isTrue("mine"),
    then: [
      { op: "read", id: "read-stock", value: counter(STOCK_COUNTER), into: "left" },
      {
        op: "branch",
        id: "have-stock",
        cond: gt(local("left"), lit(0)),
        then: [decrement("decrement"), RESPOND_OK],
        else: [RESPOND_SOLD_OUT],
      },
    ],
    else: [RESPOND_ALREADY],
  },
]

const serializableTransaction = (): Operation[] => [
  {
    op: "atomic",
    id: "tx",
    body: [
      { op: "read", id: "read-stock", value: counter(STOCK_COUNTER), into: "left" },
      {
        op: "branch",
        id: "have-stock",
        cond: gt(local("left"), lit(0)),
        then: [
          {
            op: "insertUnique",
            id: "claim-once",
            collection: CLAIMS_TABLE,
            key: req("userId"),
            fields: { userId: req("userId"), status: lit("confirmed") },
            onConflict: "continue",
            into: "mine",
          },
          {
            op: "branch",
            id: "was-mine",
            cond: isTrue("mine"),
            then: [decrement("decrement")],
            else: [],
          },
        ],
        else: [],
      },
    ],
  },
  {
    op: "branch",
    id: "answer",
    cond: isTrue("mine"),
    then: [RESPOND_OK],
    else: [
      {
        op: "branch",
        id: "why",
        cond: gt(local("left"), lit(0)),
        then: [RESPOND_ALREADY],
        else: [RESPOND_SOLD_OUT],
      },
    ],
  },
]

const rootHandler = (node: string, steps: Operation[]): Handler => ({
  id: "claim",
  label: "claim one unit",
  trigger: { kind: "request" },
  node,
  steps,
})

const workflow = (
  binding: PatternBinding,
  keyedBy: "attempt" | "person",
  handlers: Handler[]
): Workflow => ({
  collections: collectionsFor(binding.store, binding.stock, keyedBy),
  requestFields: REQUEST_FIELDS,
  handlers,
})

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

export const behaviourPatterns: BehaviourPattern[] = [
  {
    id: "check-then-write",
    label: "check the count, then write",
    verdict: "broken",
    summary:
      "Read the remaining count, decide, then decrement. Two round trips, and anything can happen between them. The most common shape there is, and it oversells with no fault injected at all.",
    needs: [],
    build: (b) => workflow(b, "attempt", [rootHandler(b.service, checkThenWrite())]),
  },
  {
    id: "unfenced-lease",
    label: "shared lease, no fencing",
    verdict: "broken",
    summary:
      "A real distributed lock around the read and the write, with no fencing token. Safe until a lease expires under a holder that is still working.",
    needs: ["lock"],
    lockFencing: false,
    build: (b) => workflow(b, "attempt", [rootHandler(b.service, leaseGuarded(b.lock ?? "lock", false))]),
  },
  {
    id: "queue-worker",
    label: "queue in front of a worker",
    verdict: "broken",
    summary:
      "The request only enqueues. A worker does the read and the write, so the request path is fast and the consumer still races itself; redelivery adds another attempt.",
    needs: ["queue"],
    build: (b) => {
      const queue = b.queue ?? "q"
      return workflow(b, "attempt", [
        {
          id: "accept",
          label: "accept the claim",
          trigger: { kind: "request" },
          node: b.service,
          steps: [
            {
              op: "publish",
              id: "enqueue",
              queue,
              message: { userId: req("userId"), claimId: req("claimId"), idemKey: req("idemKey") },
            },
            { op: "respond", id: "accepted", status: "success", outcome: "accepted" },
          ],
        },
        {
          id: "worker",
          label: "allocate one unit",
          trigger: { kind: "queue", queue },
          node: b.service,
          steps: [
            { op: "read", id: "read-stock", value: counter(STOCK_COUNTER), into: "left" },
            {
              op: "branch",
              id: "have-stock",
              cond: gt(local("left"), lit(0)),
              then: [decrement("decrement"), recordClaim("claimId")],
              else: [],
            },
            { op: "ack", id: "ack" },
          ],
        },
      ])
    },
  },
  {
    id: "unique-insert",
    label: "unique insert, then decrement",
    verdict: "broken",
    summary:
      "A unique index on the person makes one-claim-per-person hold without a lock. The decrement after it is still read-then-write, so the count can still go negative.",
    needs: [],
    build: (b) => workflow(b, "person", [rootHandler(b.service, uniqueInsertThenDecrement())]),
  },
  {
    id: "fenced-lease",
    label: "shared lease, with fencing",
    verdict: "safe",
    summary:
      "The unfenced lease plus a token the datastore checks on every write. A holder whose lease was reassigned is refused rather than trusted. Watch the lock become the bottleneck under load.",
    needs: ["lock"],
    lockFencing: true,
    build: (b) => workflow(b, "attempt", [rootHandler(b.service, leaseGuarded(b.lock ?? "lock", true))]),
  },
  {
    id: "atomic-decrement",
    label: "atomic decrement, unique claim",
    verdict: "safe",
    summary:
      "One guarded, indivisible decrement, then a unique insert keyed on the person, giving the unit back if the insert lost. No lock, no transaction, no queue.",
    needs: [],
    build: (b) => workflow(b, "person", [rootHandler(b.service, atomicDecrementUniqueClaim())]),
  },
  {
    id: "serializable-transaction",
    label: "one serializable transaction",
    verdict: "safe",
    summary:
      "Read, check, insert and decrement inside one transaction with a unique index on the person. The shortest correct answer; its cost is conflicts under contention.",
    needs: [],
    build: (b) => workflow(b, "person", [rootHandler(b.service, serializableTransaction())]),
  },
]

export const patternFor = (id: string): BehaviourPattern | undefined =>
  behaviourPatterns.find((p) => p.id === id)

/**
 * Put a pattern onto a design. Mutates in place, so it can run inside the store's `edit`.
 *
 * Besides the workflow, a pattern may need the drawing to agree with it: a fenced lease is
 * rejected by validation when the lock service does not issue tokens, and the honest fix is
 * to flip the lock rather than to hand the user an error about a node they did not touch.
 */
export const applyPattern = (design: Design, pattern: BehaviourPattern, binding: PatternBinding): void => {
  design.workflow = pattern.build(binding)
  if (pattern.lockFencing === undefined || !binding.lock) return
  const lock = design.nodes.find((n) => n.id === binding.lock)
  if (lock?.lock) lock.lock.fencingTokens = pattern.lockFencing
}

// ---------------------------------------------------------------------------
// binding a pattern to a drawing
// ---------------------------------------------------------------------------

export interface BindingSuggestion {
  binding: PatternBinding | null
  /** Why no binding could be made, in the user's terms. */
  missing: string | null
}

/**
 * Pick the nodes a pattern needs out of the current drawing.
 *
 * `service` is the selected server when there is one, otherwise the first server. Everything
 * else is the first node of the right kind. A pattern that needs a lock or a queue the
 * drawing does not have is reported as missing rather than silently bound to nothing, because
 * the resulting workflow would fail validation with a message about ids the user never typed.
 */
export const suggestBinding = (
  design: Design,
  pattern: BehaviourPattern,
  preferredService: string | null,
  stock: number
): BindingSuggestion => {
  const firstOf = (kind: string) => design.nodes.find((n) => n.kind === kind)?.id ?? null
  const service =
    (preferredService && design.nodes.find((n) => n.id === preferredService && n.kind === "server")?.id) ??
    firstOf("server")
  const store = firstOf("database")
  const lock = firstOf("lock")
  const queue = firstOf("queue")

  if (!service) return { binding: null, missing: "add a service to run the request steps" }
  if (!store) return { binding: null, missing: "add a database to hold the state" }
  if (pattern.needs.includes("lock") && !lock) return { binding: null, missing: "this pattern needs a lock service on the canvas" }
  if (pattern.needs.includes("queue") && !queue) return { binding: null, missing: "this pattern needs a queue on the canvas" }

  return { binding: { service, store, lock, queue, stock }, missing: null }
}

/**
 * The rules every pattern is judged against.
 *
 * Built through the same guided templates the rail uses, so what the user sees in the
 * rule list is exactly what would have appeared had they added the rules by hand.
 */
export const suggestedRules = (): Invariant[] => {
  const drafts: Array<{ templateId: string; args: Record<string, string> }> = [
    { templateId: "counter-non-negative", args: { collection: STOCK_COUNTER } },
    { templateId: "rows-within-counter", args: { table: CLAIMS_TABLE, limit: INITIAL_COUNTER } },
    { templateId: "one-per-key", args: { table: CLAIMS_TABLE, field: "userId" } },
  ]
  return drafts.flatMap((draft) => {
    const built = buildInvariant({ ...draft, label: "", message: "", scope: "safety" })
    return built.ok ? [built.invariant] : []
  })
}

/**
 * Counter values the search should start from.
 *
 * One unit, not two hundred: overselling N units needs N+1 concurrent requests, and the
 * search is bounded at a handful. Stated on the contract so the verdict can report it.
 */
export const SUGGESTED_STATE_OVERRIDES: Record<string, number> = {
  [STOCK_COUNTER]: 1,
  [INITIAL_COUNTER]: 1,
}

/**
 * A workflow with nothing in it yet: state on the store, a handler on the service that
 * just answers. The schema requires at least one handler, so "start from scratch" has to
 * start from this rather than from an empty array.
 */
export const emptyWorkflow = (binding: PatternBinding): Workflow => ({
  collections: collectionsFor(binding.store, binding.stock, "attempt"),
  requestFields: REQUEST_FIELDS,
  handlers: [rootHandler(binding.service, [RESPOND_OK])],
})
