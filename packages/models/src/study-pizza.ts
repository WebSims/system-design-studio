import {
  DESIGN_SCHEMA_VERSION,
  STUDY_SCHEMA_VERSION,
  StudySchema,
  type Design,
  type Expr,
  type Operation,
  type Study,
} from "@sds/schema";

/**
 * The limited-inventory study: "two hundred free pizzas, one per person, first come first
 * served".
 *
 * WHY THIS PROBLEM
 *
 * Because it is the smallest problem that contains every hazard worth teaching, and because
 * everybody already knows what the right answer looks like -- which means a tool that gets
 * it wrong is caught immediately rather than believed.
 *
 * It has scarce state (a counter that must not go below zero), an identity rule (one per
 * person), a burst arrival shape (everybody arrives when the announcement goes out), an
 * expiry (a reservation that is not confirmed goes back in the pool), and a business
 * outcome that is not latency (how many pizzas actually reached a person who was entitled to
 * one). No amount of queueing theory answers any of those questions, and no amount of
 * correctness checking answers whether the design survives the burst.
 *
 * THE PORTFOLIO
 *
 * Seven candidates: four that are broken and three that are not. The broken ones are broken
 * on purpose and say so in their `intent`, because a portfolio of working designs teaches
 * nothing -- the value is in seeing the counterexample for the design you were about to
 * ship. Every one of the four is a pattern that ships in production constantly.
 *
 * They differ ONLY in architecture. Workload, SLOs, invariants, fault model and exploration
 * bounds are study-level and are pushed into each candidate before evaluation, so a
 * comparison between two of them is a comparison of two architectures and nothing else.
 */

// ---------------------------------------------------------------------------
// expression shorthands
// ---------------------------------------------------------------------------

const lit = (value: number | string | boolean): Expr => ({ kind: "lit", value });
const counter = (collection: string): Expr => ({ kind: "counter", collection });
const req = (field: string): Expr => ({ kind: "request", field });
const local = (name: string): Expr => ({ kind: "local", name });
const rowField = (collection: string, key: Expr, field: string): Expr => ({
  kind: "row",
  collection,
  key,
  field,
});
const gt = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: ">", left, right });
const gte = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: ">=", left, right });
const lte = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: "<=", left, right });
const eq = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: "==", left, right });
const plus = (left: Expr, right: Expr): Expr => ({ kind: "arith", op: "+", left, right });
const countOf = (collection: string): Expr => ({ kind: "count", collection, where: null });
const distinctOf = (collection: string, field: string): Expr => ({
  kind: "distinct",
  collection,
  field,
  where: null,
});
const isTrue = (name: string): Expr => eq(local(name), lit(true));

// ---------------------------------------------------------------------------
// shared topology
// ---------------------------------------------------------------------------

/** Inventory in the performance run. The correctness run seeds one; see `stateOverrides`. */
const STOCK = 200;

/**
 * Resource profiles, cited as estimates rather than measurements.
 *
 * Every one of them is a guess with its provenance attached, and the studio renders the
 * provenance. The reason for going to that trouble on numbers this rough is that a resource
 * axis with an unattributed number on it looks exactly like a resource axis with a measured
 * one, and the Pareto comparison would rank on both with equal confidence.
 */
const PROFILE_NOTE = {
  source: "order-of-magnitude estimate for a small container; not measured on the user's system",
};

function apiNode(replicas: number, label = "claim service"): Record<string, unknown> {
  return {
    id: "api",
    kind: "server",
    label,
    x: 300,
    y: 0,
    server: {
      concurrency: 32,
      replicas,
      // Deliberately fast: the point of the study is contention on state, not CPU on the
      // application tier. A slow handler would hide the datastore behind its own latency.
      serviceTime: { kind: "lognormal", mean: 3, p99: 20 },
      queueCapacity: 512,
      admissionPolicy: "shed",
      blocksOnDependencies: true,
      citation: { source: "typical request-handler overhead excluding datastore work" },
    },
    resources: {
      cpuUnits: 1,
      memoryMb: 512,
      connectionSlots: 8,
      networkBytesPerRequest: 2048,
      citation: PROFILE_NOTE,
    },
  };
}

function dbNode(): Record<string, unknown> {
  return {
    id: "db",
    kind: "database",
    label: "claims store",
    x: 600,
    y: 0,
    database: {
      poolSize: 40,
      // Eight queries genuinely executing at once. This is the number the whole study
      // contends over, and it is the reason a lock service or a serialised transaction
      // shows up as a throughput ceiling rather than as a rounding error.
      parallelism: 8,
      serviceTime: { kind: "lognormal", mean: 4, p99: 30 },
      admissionPolicy: "block",
      citation: { source: "single-primary relational store, indexed point reads and writes" },
    },
    resources: {
      cpuUnits: 4,
      memoryMb: 8192,
      storageMb: 512,
      connectionSlots: 40,
      networkBytesPerRequest: 1024,
      citation: PROFILE_NOTE,
    },
  };
}

function clientNode(): Record<string, unknown> {
  return {
    id: "crowd",
    kind: "client",
    label: "the crowd",
    x: 0,
    y: 0,
    client: {
      // Overwritten from the study's canonical workload before every evaluation. Present
      // here so the candidate is a valid standalone design, not because it is authoritative.
      arrival: { kind: "spike", baseRatePerSec: 20, peakRatePerSec: 1200, atSec: 300, durationSec: 30 },
      timeoutMs: 2000,
    },
  };
}

function lbNode(): Record<string, unknown> {
  return {
    id: "lb",
    kind: "loadbalancer",
    label: "edge",
    x: 150,
    y: 0,
    loadbalancer: {
      algorithm: "power-of-two-choices",
      serviceTime: { kind: "deterministic", value: 0.4 },
      concurrency: 2048,
    },
    resources: { cpuUnits: 2, memoryMb: 1024, networkBytesPerRequest: 3072, citation: PROFILE_NOTE },
  };
}

function lockNode(fencing: boolean): Record<string, unknown> {
  return {
    id: "lock",
    kind: "lock",
    label: fencing ? "lease service (fenced)" : "lease service (advisory)",
    x: 600,
    y: -220,
    lock: {
      concurrency: 32,
      serviceTime: { kind: "lognormal", mean: 1.5, p99: 12 },
      defaultTtlMs: 2000,
      fencingTokens: fencing,
      citation: { source: "in-memory key-value store used as a lock, single region" },
    },
    resources: { cpuUnits: 1, memoryMb: 256, networkBytesPerRequest: 256, citation: PROFILE_NOTE },
  };
}

function queueNode(): Record<string, unknown> {
  return {
    id: "q",
    kind: "queue",
    label: "claim queue",
    x: 600,
    y: 220,
    queue: {
      consumers: 8,
      consumerServiceTime: { kind: "lognormal", mean: 8, p99: 60 },
      publishTime: { kind: "deterministic", value: 0.8 },
      delivery: "at-least-once",
      requireAck: true,
      visibilityTimeoutMs: 5000,
      maxRedeliveries: 3,
      citation: { source: "managed at-least-once broker with a visibility timeout" },
    },
    resources: { cpuUnits: 2, memoryMb: 2048, storageMb: 64, networkBytesPerRequest: 512, citation: PROFILE_NOTE },
  };
}

const BASE_EDGES = [
  { id: "e-crowd-lb", from: "crowd", to: "lb", latency: { kind: "lognormal", mean: 25, p99: 180 } },
  { id: "e-lb-api", from: "lb", to: "api", latency: { kind: "deterministic", value: 0.5 } },
];

const DB_EDGE = {
  id: "e-api-db",
  from: "api",
  to: "db",
  latency: { kind: "deterministic", value: 0.4 },
  policy: {
    timeoutMs: 800,
    // No retries on the datastore path, on purpose, in every candidate.
    //
    // A retried write is a duplicate write unless something downstream deduplicates it, and
    // whether anything does is precisely what distinguishes the candidates. Turning retries
    // on here would inject that hazard into all seven equally and make the comparison
    // between them about the retry policy instead of about the architecture.
    retry: null,
  },
};

const LOCK_EDGE = {
  id: "e-api-lock",
  from: "api",
  to: "lock",
  latency: { kind: "deterministic", value: 0.3 },
  policy: { timeoutMs: 500, retry: null },
};

const QUEUE_EDGE = {
  id: "e-api-q",
  from: "api",
  to: "q",
  latency: { kind: "deterministic", value: 0.3 },
};

// ---------------------------------------------------------------------------
// shared state and identity
// ---------------------------------------------------------------------------

/**
 * State declarations shared by every candidate.
 *
 * `initialInventory` is written by nobody. It exists so that an invariant can say "no more
 * claims than we started with" WITHOUT hard-coding the number -- which matters because the
 * correctness search seeds the inventory down to one, and an invariant carrying a literal
 * 200 would become unfalsifiable at exactly the moment it needed to bite.
 *
 * `claimKey` is the field candidates disagree about. A candidate that keys claims by the
 * ATTEMPT can hold two rows for one person; one that keys by the PERSON cannot. Same table,
 * same invariant, different key -- which is the cleanest possible way to show that the fix
 * is a schema decision and not a code decision.
 */
function collections(claimKeyMeaning: "attempt" | "person"): Record<string, unknown>[] {
  return [
    { kind: "counter", id: "initialInventory", label: "pizzas at the start", node: "db", initial: STOCK },
    { kind: "counter", id: "inventory", label: "pizzas remaining", node: "db", initial: STOCK },
    {
      kind: "table",
      id: "claims",
      label: `claims, one row per ${claimKeyMeaning}`,
      node: "db",
      key: "claimKey",
      fields: [
        { name: "claimKey", type: "string" },
        { name: "userId", type: "string" },
        {
          name: "status",
          type: "enum",
          values: ["reserved", "confirmed"],
          default: "confirmed",
        },
      ],
    },
  ];
}

/**
 * Request identity.
 *
 * `userId` is Zipf over ten thousand people, because a real crowd is not uniform: a few
 * people refresh far more than the rest, and those are the people whose duplicate claims
 * appear. A uniform draw over ten thousand would make a collision so rare that a broken
 * design would look fine for the whole run.
 *
 * `claimId` is a sequence, so it is unique per attempt. `idemKey` derives from it, so it is
 * stable across retries of that attempt and different for a genuinely new submission. That
 * pairing is what makes the two retry faults distinguishable.
 */
const REQUEST_FIELDS = [
  {
    name: "userId",
    type: "string",
    strategy: { kind: "zipf", keys: 10_000, skew: 1.1, prefix: "u" },
    exploreDomain: ["u1", "u2"],
  },
  {
    name: "claimId",
    type: "string",
    strategy: { kind: "duplicate", probability: 0.08, fallback: { kind: "sequence", prefix: "c" } },
    exploreDomain: ["c1", "c2"],
  },
  {
    // Derived from BOTH fields, not from `claimId` alone.
    //
    // With only the claim id, two different people who happened to pick the same attempt
    // number would share an idempotency key, and a design keyed on that key would dedupe one
    // person's claim against another's. That is a bug in the workload rather than in any
    // candidate, and it would show up as a spurious counterexample blaming the design.
    name: "idemKey",
    type: "string",
    strategy: { kind: "idempotencyKey", of: ["userId", "claimId"], prefix: "k-" },
  },
];

// ---------------------------------------------------------------------------
// workflow shapes
// ---------------------------------------------------------------------------

const RESPOND_OK: Operation = { op: "respond", id: "ok", status: "success", outcome: "allocated" };
const RESPOND_SOLD_OUT: Operation = {
  op: "respond",
  id: "soldout",
  status: "rejected",
  outcome: "soldOut",
};
const RESPOND_ALREADY: Operation = {
  op: "respond",
  id: "already",
  status: "rejected",
  outcome: "alreadyClaimed",
};

/** read, decide, decrement, record. Two of those four are a scheduling point apart. */
function checkThenWrite(): Operation[] {
  return [
    { op: "read", id: "read-stock", value: counter("inventory"), into: "left" },
    {
      op: "branch",
      id: "have-stock",
      cond: gt(local("left"), lit(0)),
      then: [
        {
          op: "write",
          id: "decrement",
          collection: "inventory",
          key: null,
          mode: "delta",
          value: lit(-1),
          fields: {},
        },
        {
          op: "write",
          id: "record-claim",
          collection: "claims",
          key: req("claimId"),
          mode: "set",
          value: null,
          fields: { userId: req("userId"), status: lit("confirmed") },
        },
        RESPOND_OK,
      ],
      else: [RESPOND_SOLD_OUT],
    },
  ];
}

/** The same body, wrapped in a lease. Safe only if the lease is fenced. */
function leaseGuarded(fencing: boolean): Operation[] {
  return [
    {
      op: "acquireLease",
      id: "acquire",
      lock: "lock",
      key: lit("free-pizza"),
      ttlMs: 2000,
      fencing,
      into: "lease",
      onBusy: "fail",
    },
    ...checkThenWrite(),
    { op: "releaseLease", id: "release", lock: "lock", key: lit("free-pizza") },
  ];
}

/** Guarded atomic decrement, then a unique claim keyed by the person. */
function atomicDecrementUniqueClaim(withReservation: boolean): Operation[] {
  const confirm: Operation[] = withReservation
    ? [
        {
          op: "scheduleExpiry",
          id: "arm-expiry",
          handler: "expire",
          afterMs: 30_000,
          args: { userId: req("userId") },
        },
        { op: "respond", id: "ok", status: "success", outcome: "reserved" },
      ]
    : [RESPOND_OK];

  return [
    {
      op: "conditionalWrite",
      id: "take-one",
      collection: "inventory",
      key: null,
      // Guard and write are indivisible. This single property is the difference between
      // this candidate and candidate one, and it is one operation rather than a lock, a
      // transaction, or a queue.
      guard: gt(counter("inventory"), lit(0)),
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
          collection: "claims",
          key: req("userId"),
          fields: {
            userId: req("userId"),
            status: lit(withReservation ? "reserved" : "confirmed"),
          },
          onConflict: "continue",
          into: "mine",
        },
        {
          op: "branch",
          id: "was-mine",
          cond: isTrue("mine"),
          then: confirm,
          else: [
            // Lost the uniqueness race, so give the unit back. Without this the design is
            // correct and leaks: every duplicate attempt strands a pizza nobody can have.
            {
              op: "write",
              id: "give-back",
              collection: "inventory",
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
  ];
}

/** Everything inside one serializable transaction, plus a unique claim on the person. */
function serializableTransaction(): Operation[] {
  return [
    {
      op: "atomic",
      id: "tx",
      body: [
        { op: "read", id: "read-stock", value: counter("inventory"), into: "left" },
        {
          op: "branch",
          id: "have-stock",
          cond: gt(local("left"), lit(0)),
          then: [
            {
              op: "insertUnique",
              id: "claim-once",
              collection: "claims",
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
                {
                  op: "write",
                  id: "decrement",
                  collection: "inventory",
                  key: null,
                  mode: "delta",
                  value: lit(-1),
                  fields: {},
                },
              ],
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
  ];
}

// ---------------------------------------------------------------------------
// designs
// ---------------------------------------------------------------------------

interface CandidateSpec {
  id: string;
  label: string;
  pattern: string;
  intent: string;
  notes: string;
  nodes: Record<string, unknown>[];
  edges: unknown[];
  handlers: unknown[];
  claimKeyMeaning: "attempt" | "person";
}

function designFor(spec: CandidateSpec): Design {
  return {
    version: DESIGN_SCHEMA_VERSION,
    name: spec.label,
    nodes: spec.nodes as never,
    edges: spec.edges as never,
    classes: [],
    scenario: { durationSec: 900, warmupSec: 120, seed: 1, traceLimit: 4000 },
    slo: { p99LatencyMs: 500, maxErrorRatePct: 1 },
    workflow: {
      collections: collections(spec.claimKeyMeaning) as never,
      requestFields: REQUEST_FIELDS as never,
      handlers: spec.handlers as never,
    },
  } as Design;
}

function rootHandler(steps: Operation[]): Record<string, unknown> {
  return { id: "claim", label: "claim a pizza", trigger: { kind: "request" }, node: "api", steps };
}

const CANDIDATES: CandidateSpec[] = [
  {
    id: "c1-check-then-write",
    label: "1. check the count, then write",
    pattern: "non-atomic check-then-write",
    intent:
      "DELIBERATELY BROKEN. The most common shape there is: read the remaining count, decide, then decrement. The read and the write are two separate round trips to the datastore, and anything can happen in between. Expected to oversell with no fault injected at all.",
    notes:
      "Nothing here is unusual or careless-looking. It is what the obvious implementation looks like, which is exactly why it is worth seeing the counterexample for.",
    nodes: [clientNode(), lbNode(), apiNode(1), dbNode()],
    edges: [...BASE_EDGES, DB_EDGE],
    handlers: [rootHandler(checkThenWrite())],
    claimKeyMeaning: "attempt",
  },

  {
    id: "c2-process-local-mutex",
    label: "2. a mutex, behind four replicas",
    pattern: "process-local mutex behind multiple replicas",
    intent:
      "DELIBERATELY BROKEN, and broken in the way that is hardest to see in a code review. The handler holds a process-local mutex around the read and the write, so within any one replica the sequence really is indivisible -- and there are four replicas.",
    notes:
      "The workflow here is IDENTICAL to candidate one, and that identity is the finding rather than an omission. A process-local mutex is not shared state: it excludes nothing between replicas, so it is invisible to a model of the system because it is invisible to the system. The counterexample is the same one candidate one produces, which is the point -- the mutex bought nothing. To make it real you would need the lock to live somewhere both replicas can see, which is candidates three and five.",
    nodes: [clientNode(), lbNode(), apiNode(4, "claim service (4 replicas, local mutex)"), dbNode()],
    edges: [...BASE_EDGES, DB_EDGE],
    handlers: [rootHandler(checkThenWrite())],
    claimKeyMeaning: "attempt",
  },

  {
    id: "c3-unfenced-lease",
    label: "3. a shared lease, no fencing",
    pattern: "shared lease without fencing",
    intent:
      "DELIBERATELY BROKEN. A real distributed lock, correctly acquired and correctly released, with no fencing token. Expected to be safe until a lease expires under a holder that is still working -- at which point two workers both believe they hold it.",
    notes:
      "This is the design most people mean by 'we used a lock'. It is a genuine improvement on candidates one and two and it is still wrong, because a lease can expire without its holder finding out. The holder cannot detect that; only the datastore can, and only if it is given a token to check.",
    nodes: [clientNode(), lbNode(), apiNode(4), dbNode(), lockNode(false)],
    edges: [...BASE_EDGES, DB_EDGE, LOCK_EDGE],
    handlers: [rootHandler(leaseGuarded(false))],
    claimKeyMeaning: "attempt",
  },

  {
    id: "c4-queue-no-idempotency",
    label: "4. queue before a racy worker",
    pattern: "queue with a non-atomic consumer",
    intent:
      "DELIBERATELY BROKEN, and the fastest of the seven by a wide margin. The queue shortens the request path but does not make the consumer's read and write atomic.",
    notes:
      "The latency numbers are excellent and irrelevant: concurrent consumers can still oversell, and redelivery adds another attempt. The response is also only 'accepted', not 'you got one', so this architecture changes the product promise.",
    nodes: [clientNode(), lbNode(), apiNode(2), dbNode(), queueNode()],
    edges: [...BASE_EDGES, DB_EDGE, QUEUE_EDGE],
    handlers: [
      {
        id: "accept",
        label: "accept the claim",
        trigger: { kind: "request" },
        node: "api",
        steps: [
          {
            op: "publish",
            id: "enqueue",
            queue: "q",
            message: { userId: req("userId"), claimId: req("claimId"), idemKey: req("idemKey") },
          },
          { op: "respond", id: "accepted", status: "success", outcome: "accepted" },
        ],
      },
      {
        id: "worker",
        label: "allocate a pizza",
        trigger: { kind: "queue", queue: "q" },
        node: "api",
        steps: [
          { op: "read", id: "read-stock", value: counter("inventory"), into: "left" },
          {
            op: "branch",
            id: "have-stock",
            cond: gt(local("left"), lit(0)),
            then: [
              {
                op: "write",
                id: "decrement",
                collection: "inventory",
                key: null,
                mode: "delta",
                value: lit(-1),
                fields: {},
              },
              {
                op: "write",
                id: "record-claim",
                collection: "claims",
                key: req("claimId"),
                mode: "set",
                value: null,
                fields: { userId: req("userId"), status: lit("confirmed") },
              },
            ],
            else: [],
          },
          { op: "ack", id: "ack" },
        ],
      },
    ],
    claimKeyMeaning: "attempt",
  },

  {
    id: "c5-fenced-lease",
    label: "5. a shared lease, with fencing",
    pattern: "shared lease with fencing and an authoritative datastore",
    intent:
      "EXPECTED SAFE. Candidate three plus a fencing token, which the datastore checks on every write. A holder whose lease was reassigned is refused rather than trusted.",
    notes:
      "The correctness fix is one boolean and the cost is a second round trip on every claim. Watch the lock service's utilization: it is a serialisation point, so this design's throughput ceiling is set by a component that does no useful work.",
    nodes: [clientNode(), lbNode(), apiNode(4), dbNode(), lockNode(true)],
    edges: [...BASE_EDGES, DB_EDGE, LOCK_EDGE],
    handlers: [rootHandler(leaseGuarded(true))],
    claimKeyMeaning: "attempt",
  },

  {
    id: "c6-serializable-transaction",
    label: "6. one serializable transaction",
    pattern: "serializable datastore transaction with a unique user claim",
    intent:
      "EXPECTED SAFE. Read, check, insert and decrement inside a single serializable transaction, with a unique index on the person. No lock service, no queue, one round trip.",
    notes:
      "The shortest correct answer, and the one that needs the least explaining to a reviewer. Its cost is transaction conflicts under contention, which the performance run counts: at the peak of the burst most transactions are competing for the same row, and a conflict is work done twice.",
    nodes: [clientNode(), lbNode(), apiNode(4), dbNode()],
    edges: [...BASE_EDGES, DB_EDGE],
    handlers: [rootHandler(serializableTransaction())],
    claimKeyMeaning: "person",
  },

  {
    id: "c7-atomic-decrement-unique-claim",
    label: "7. atomic decrement, unique claim, timed reservation",
    pattern: "atomic conditional decrement plus a unique idempotent claim",
    intent:
      "EXPECTED SAFE. A single guarded atomic decrement, a unique insert keyed on the person, and a reservation that expires if it is never confirmed. No lock service, no transaction, no queue.",
    notes:
      "Two indivisible operations rather than one transaction, which means no conflict retries and no serialisation point. It carries the most machinery of the three safe candidates -- the expiry handler has to give inventory back, and the failed-uniqueness path has to give it back too -- and every piece of that machinery is somewhere it can be got wrong. Compare its stranded-reservation count against candidate six's conflict count: those are the two designs' real costs and they are not the same kind of cost.",
    nodes: [clientNode(), lbNode(), apiNode(4), dbNode()],
    edges: [...BASE_EDGES, DB_EDGE],
    handlers: [
      rootHandler(atomicDecrementUniqueClaim(true)),
      {
        id: "expire",
        label: "release an unconfirmed reservation",
        trigger: { kind: "expiry" },
        node: "api",
        steps: [
          {
            op: "atomic",
            id: "reclaim",
            body: [
              {
                // Guarded and indivisible, because the confirmation and the expiry are
                // exactly the two things that race. An unguarded expiry that simply handed
                // the unit back would conjure inventory whenever it lost that race.
                op: "conditionalWrite",
                id: "drop-reservation",
                collection: "claims",
                key: req("userId"),
                guard: eq(rowField("claims", req("userId"), "status"), lit("reserved")),
                mode: "set",
                value: null,
                fields: { status: lit("confirmed") },
                onFail: "continue",
                into: "reclaimed",
              },
            ],
          },
          { op: "respond", id: "done", status: "success", outcome: "reservationExpired" },
        ],
      },
    ],
    claimKeyMeaning: "person",
  },
];

// ---------------------------------------------------------------------------
// the study
// ---------------------------------------------------------------------------

export function pizzaStudy(): Study {
  return StudySchema.parse({
    version: STUDY_SCHEMA_VERSION,
    id: "limited-free-pizza",
    name: "two hundred free pizzas",
    problem: [
      "We are giving away 200 free pizzas when the campaign goes live. One per person.",
      "First come, first served, and when they are gone the page has to say so.",
      "We expect a few thousand people to hit the button within the first minute, most of them",
      "in the first few seconds, and a lot of them will click twice because the first click",
      "felt slow. Nobody must get two, and we must not promise a pizza we do not have.",
    ].join(" "),
    contract: {
      summary:
        "Allocate at most 200 units, at most one per person, and answer every request within half a second or tell them honestly that it failed.",
      outcomes: [
        { label: "allocated", kind: "valid", description: "one pizza to one entitled person" },
        {
          label: "reserved",
          kind: "valid",
          description: "held for this person, confirmed or released within 30 seconds",
        },
        {
          label: "accepted",
          kind: "valid",
          description:
            "the request was queued. NOT the same promise as 'allocated' -- the person has not been told they have a pizza, only that we heard them.",
        },
        { label: "soldOut", kind: "rejected", description: "correctly refused; none left" },
        {
          label: "alreadyClaimed",
          kind: "rejected",
          description: "correctly refused; this person already has one",
        },
        {
          label: "reservationExpired",
          kind: "expired",
          description: "a hold that was never confirmed, returned to the pool",
        },
      ],
      promises: [
        {
          id: "p-no-oversell",
          statement: "We never allocate more than 200 pizzas.",
          invariantId: "no-oversell",
        },
        {
          id: "p-one-each",
          statement: "Nobody gets two.",
          invariantId: "one-claim-per-person",
        },
        {
          id: "p-honest-count",
          statement: "The remaining count we show is never larger than the truth.",
          invariantId: "no-negative-inventory",
        },
        {
          id: "p-accounting",
          statement: "Allocated plus remaining never exceeds what we started with.",
          invariantId: "inventory-accounting",
        },
        {
          id: "p-fast",
          statement: "The page answers within half a second at the 99th percentile.",
          // Deliberately left unlinked. It is an SLO, not a safety invariant, and it is
          // checked by the performance run rather than the explorer. The studio labels it
          // UNVERIFIED by the correctness engine, which is accurate.
          invariantId: null,
        },
      ],
      nonGoals: [
        "This study says nothing about behaviour under a network partition, replica divergence, or clock skew between regions. It models one region with a linearizable store.",
        "It says nothing about fraud: a person who controls two accounts is two people as far as this model is concerned.",
        "It attaches no monetary cost to anything. Resource axes are physical units.",
      ],
    },
    workload: {
      // The announcement goes out at t=300s and the crowd arrives at once. A steady rate
      // would exercise none of what makes this problem hard: contention on the last few
      // units happens during the burst or not at all.
      arrival: {
        kind: "spike",
        baseRatePerSec: 20,
        peakRatePerSec: 1200,
        atSec: 300,
        durationSec: 30,
      },
      durationSec: 900,
      warmupSec: 120,
      seeds: [1, 2, 3, 4, 5, 6, 7, 8],
      traceLimit: 4000,
      classes: [],
    },
    targets: {
      slo: { p99LatencyMs: 500, maxErrorRatePct: 1 },
      businessGoals: [
        {
          id: "g-no-oversell",
          label: "no pizza is promised twice",
          metric: "oversells",
          comparison: "<=",
          value: 0,
        },
        {
          id: "g-no-duplicates",
          label: "nobody receives two",
          metric: "duplicateSuccesses",
          comparison: "<=",
          value: 0,
        },
        {
          id: "g-stock-clears",
          label: "at most five pizzas go unclaimed",
          metric: "remainingInventory",
          comparison: "<=",
          value: 5,
        },
      ],
    },
    correctness: {
      invariants: [
        {
          id: "no-oversell",
          label: "never allocate more pizzas than exist",
          scope: "safety",
          expr: lte(countOf("claims"), counter("initialInventory")),
          message:
            "More people are holding a pizza than there were pizzas. Somebody is going to arrive at the counter and be told there is nothing for them.",
        },
        {
          id: "no-negative-inventory",
          label: "the remaining count never goes below zero",
          scope: "safety",
          expr: gte(counter("inventory"), lit(0)),
          message:
            "The counter went negative, so at least one allocation had nothing behind it. Whatever the page displayed as 'remaining' was a lie.",
        },
        {
          id: "one-claim-per-person",
          label: "at most one pizza per person",
          scope: "safety",
          expr: eq(distinctOf("claims", "userId"), countOf("claims")),
          message:
            "Somebody got two. Because supply is fixed, that means somebody else who was entitled to one got none.",
        },
        {
          id: "inventory-accounting",
          label: "pizzas are never created out of nothing",
          // A POSTCONDITION, and it has to be.
          //
          // As a safety invariant it is transiently false in every correct design: a
          // handler that records the claim before decrementing the counter momentarily
          // shows one remaining and one allocated against a stock of one. Checked after
          // every transition it would fail all seven candidates including the three that
          // are right.
          //
          // `<=` rather than `==` because a worker that died between its decrement and its
          // claim leaves the sum BELOW the stock: a pizza is stranded and nobody has it.
          // That is waste, not an oversell, and it is measured as `strandedReservations`
          // instead of failing a safety gate.
          scope: "postcondition",
          expr: lte(plus(counter("inventory"), countOf("claims")), counter("initialInventory")),
          message:
            "Once everything settled, allocated plus remaining came to more than we started with. Some pizza was counted twice.",
        },
      ],
      faults: {
        duplicateRequest: true,
        retrySameKey: true,
        retryNewKey: true,
        workerCrash: true,
        queueRedelivery: true,
        leaseExpiry: true,
        reservationExpiry: true,
      },
      bounds: { actors: 3, faults: 1, transitions: 40, states: 100_000, timeMs: 30_000 },
      // Two people, two attempts each. Enough for a duplicate submission, a lost update
      // and a stale-lease write; more would find the same bugs with more witnesses.
      identityDomains: { userId: ["u1", "u2"], claimId: ["c1", "c2"] },
      // ONE pizza during exploration.
      //
      // Overselling 200 pizzas needs 201 concurrent actors and the search is bounded at
      // three, so against the real stock the oversell invariant is unfalsifiable and every
      // candidate -- including the broken ones -- would come back NO_VIOLATION_WITHIN_BOUNDS.
      // The initial state is therefore part of the bounds, stated here, and reported in the
      // claim.
      stateOverrides: { inventory: 1, initialInventory: 1 },
    },
    candidates: CANDIDATES.map((spec) => ({
      id: spec.id,
      label: spec.label,
      pattern: spec.pattern,
      origin: "library",
      revision: 0,
      notes: spec.notes,
      intent: spec.intent,
      design: designFor(spec),
    })),
    activeCandidateId: CANDIDATES[0]!.id,
    // Nothing is promoted. Promotion is a human decision and the library must not make it
    // on the user's behalf -- not even to the candidate it believes is right.
    promotedCandidateId: null,
  });
}

/**
 * Which outcome labels mean what, for the performance engine's business tallies.
 *
 * Derived from the contract rather than duplicated, so a label renamed in one place cannot
 * quietly stop being counted in the other.
 */
export function pizzaOutcomeMeaning(study: Study): {
  valid: string[];
  duplicate: string[];
  oversell: string[];
  expired: string[];
  rejected: string[];
} {
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

/**
 * Worked examples, offered on request.
 *
 * EXAMPLES, not defaults. The studio opens on an empty study, because the problem is the
 * user's input and a tool that boots into a pizza giveaway implies the opposite -- that the
 * problem ships with the product and only the architecture is yours to choose. Real use is
 * a study written for a real problem, by hand or by an agent through WebMCP.
 *
 * These stay because they earn their keep elsewhere: they are what the browser checks and
 * the CLI run against, and what someone reads to learn the shape of a study before writing
 * one. `teaches` is the reason to open a given example rather than a description of it.
 */
export interface StudyExample {
  id: string;
  label: string;
  /** One line: the problem, in the words of someone who has it. */
  summary: string;
  /** What opening this teaches that reading the schema does not. */
  teaches: string;
  build: () => Study;
}

export const STUDY_EXAMPLES: readonly StudyExample[] = [
  {
    id: "limited-free-pizza",
    label: "two hundred free pizzas",
    summary: "Give away exactly two hundred pizzas, one per customer, under a launch-day rush.",
    teaches:
      "Seven architectures for one problem, four broken on purpose: a non-atomic check, a mutex that " +
      "excludes nothing across replicas, an unfenced lease, and a queue with a racy consumer. Shows what " +
      "a counterexample looks like and why a fast design can still be wrong.",
    build: pizzaStudy,
  },
];

/** @deprecated Use {@link STUDY_EXAMPLES}. Kept so the CLI's older flag spelling still resolves. */
export const STUDIES = STUDY_EXAMPLES;
