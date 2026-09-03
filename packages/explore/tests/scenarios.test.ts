import { describe, expect, it } from "vitest";
import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  type Design,
  type Expr,
  type Invariant,
  type Operation,
  type Workflow,
} from "@sds/schema";
import { explore } from "../src/explore";

/**
 * The correctness scenarios this engine exists to get right.
 *
 * Every test here is a claim about a KNOWN bug or a KNOWN fix, stated as the smallest
 * workflow that exhibits it. They are written as purpose-built two-operation designs
 * rather than against the shipped seven-candidate portfolio, deliberately: a test that
 * fails because the portfolio was edited tells you nothing about the engine, and a test
 * that passes because the portfolio happens to be safe in some unrelated way is worse.
 *
 * The pairing is the point. Each hazard appears twice -- once in the design that has it
 * and once in the design that fixes it -- because an explorer that reported VIOLATED for
 * everything would pass half of these, and one that reported NO_VIOLATION_WITHIN_BOUNDS
 * for everything would pass the other half. Only an engine that distinguishes them passes
 * both.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const lit = (value: number | string | boolean): Expr => ({ kind: "lit", value });
const counter = (collection: string): Expr => ({ kind: "counter", collection });
const req = (field: string): Expr => ({ kind: "request", field });
const local = (name: string): Expr => ({ kind: "local", name });
const gt = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: ">", left, right });
const gte = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: ">=", left, right });
const lte = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: "<=", left, right });
const eq = (left: Expr, right: Expr): Expr => ({ kind: "compare", op: "==", left, right });
const count = (collection: string): Expr => ({ kind: "count", collection, where: null });
const distinct = (collection: string, field: string): Expr => ({
  kind: "distinct",
  collection,
  field,
  where: null,
});
const add = (left: Expr, right: Expr): Expr => ({ kind: "arith", op: "+", left, right });

/** Topology shared by every fixture: one client, one service, one database. */
function baseNodes(extra: unknown[] = []): unknown[] {
  return [
    {
      id: "client",
      kind: "client",
      label: "contenders",
      x: 0,
      y: 0,
      client: { arrival: { kind: "poisson", ratePerSec: 200 } },
    },
    {
      id: "api",
      kind: "server",
      label: "api",
      x: 200,
      y: 0,
      server: { concurrency: 16, serviceTime: { kind: "deterministic", value: 1 } },
    },
    {
      id: "db",
      kind: "database",
      label: "store",
      x: 400,
      y: 0,
      database: { poolSize: 20, parallelism: 8, serviceTime: { kind: "deterministic", value: 1 } },
    },
    ...extra,
  ];
}

function baseEdges(extra: unknown[] = []): unknown[] {
  return [
    { id: "e1", from: "client", to: "api" },
    { id: "e2", from: "api", to: "db" },
    ...extra,
  ];
}

/** The state every fixture shares: an inventory, its immutable initial value, and claims. */
const COLLECTIONS = [
  { kind: "counter", id: "initialInventory", node: "db", initial: 1 },
  { kind: "counter", id: "inventory", node: "db", initial: 1 },
  {
    kind: "table",
    id: "claims",
    node: "db",
    key: "claimKey",
    fields: [
      { name: "claimKey", type: "string" },
      { name: "userId", type: "string" },
    ],
  },
];

const REQUEST_FIELDS = [
  {
    name: "userId",
    type: "string",
    strategy: { kind: "choice", values: ["u1", "u2"] },
    exploreDomain: ["u1", "u2"],
  },
  {
    name: "claimId",
    type: "string",
    strategy: { kind: "sequence", prefix: "c" },
    exploreDomain: ["c1", "c2"],
  },
  { name: "idemKey", type: "string", strategy: { kind: "idempotencyKey", of: ["claimId"] } },
];

function designWith(
  handlers: unknown[],
  opts: { extraNodes?: unknown[]; extraEdges?: unknown[]; collections?: unknown[]; requestFields?: unknown[] } = {}
): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "fixture",
    nodes: baseNodes(opts.extraNodes),
    edges: baseEdges(opts.extraEdges),
    scenario: { durationSec: 60, warmupSec: 10 },
    slo: {},
    workflow: {
      collections: opts.collections ?? COLLECTIONS,
      requestFields: opts.requestFields ?? REQUEST_FIELDS,
      handlers,
    },
  });
}

/** The four safety statements. Declaration order decides which one headlines a failure. */
const INVARIANTS: Invariant[] = [
  {
    id: "no-oversell",
    label: "never allocate more units than exist",
    scope: "safety",
    expr: lte(count("claims"), counter("initialInventory")),
    message: "two people are holding the same last pizza",
  },
  {
    id: "no-negative-inventory",
    label: "inventory never goes negative",
    scope: "safety",
    expr: gte(counter("inventory"), lit(0)),
    message: "the counter went below zero, so at least one allocation had nothing behind it",
  },
  {
    id: "one-per-user",
    label: "at most one claim per person",
    scope: "safety",
    expr: eq(distinct("claims", "userId"), count("claims")),
    message: "one person got two pizzas while somebody else got none",
  },
  {
    id: "no-conjured-inventory",
    label: "units are never created out of nothing",
    // A POSTCONDITION, not a safety invariant, and the distinction is instructive.
    //
    // As a safety invariant this is false transiently in every correct design: a handler
    // that inserts the claim row before decrementing the counter momentarily shows one
    // remaining and one allocated against an initial stock of one. Checking it after
    // every transition would report every candidate broken, including the ones that are
    // not, which is the failure mode of an over-eager invariant -- and it is worth
    // stating here because the guided builder in the studio will let a user make exactly
    // this mistake.
    //
    // The comparison is `<=` rather than `==` on purpose. A worker that crashed between
    // its decrement and its claim insert leaves the sum BELOW the initial stock: a unit
    // is stranded and nobody has it. That is a real cost and it is not a correctness
    // failure -- nobody was oversold -- so it is measured as `strandedReservations` in
    // the business metrics instead of failing a safety gate.
    scope: "postcondition",
    expr: lte(add(counter("inventory"), count("claims")), counter("initialInventory")),
    message: "remaining plus allocated exceeds what we started with",
  },
];

/** Faults all off, so a test opts in to exactly the hazard it is about. */
const NO_FAULTS = {
  duplicateRequest: false,
  retrySameKey: false,
  retryNewKey: false,
  workerCrash: false,
  queueRedelivery: false,
  leaseExpiry: false,
  reservationExpiry: false,
};

const TIGHT = { actors: 2, faults: 0, transitions: 30, states: 60_000, timeMs: 20_000 };

// ---------------------------------------------------------------------------
// operation builders for the two core shapes
// ---------------------------------------------------------------------------

/** read, decide, decrement, record. Four transitions, and the bug is between the first two. */
function checkThenWriteSteps(): Operation[] {
  return [
    { op: "read", id: "r1", value: counter("inventory"), into: "left" },
    {
      op: "branch",
      id: "b1",
      cond: gt(local("left"), lit(0)),
      then: [
        {
          op: "write",
          id: "w1",
          collection: "inventory",
          key: null,
          mode: "delta",
          value: lit(-1),
          fields: {},
        },
        {
          op: "write",
          id: "w2",
          collection: "claims",
          key: req("claimId"),
          mode: "set",
          value: null,
          fields: { userId: req("userId") },
        },
        { op: "respond", id: "ok", status: "success", outcome: "allocated" },
      ],
      else: [{ op: "respond", id: "no", status: "rejected", outcome: "soldOut" }],
    },
  ];
}

/** One indivisible guarded decrement, then a unique claim keyed by the person. */
function atomicDecrementSteps(): Operation[] {
  return [
    {
      op: "conditionalWrite",
      id: "cw1",
      collection: "inventory",
      key: null,
      guard: gt(counter("inventory"), lit(0)),
      mode: "delta",
      value: lit(-1),
      fields: {},
      onFail: "continue",
      into: "took",
    },
    {
      op: "branch",
      id: "b1",
      cond: eq(local("took"), lit(true)),
      then: [
        {
          op: "insertUnique",
          id: "iu1",
          collection: "claims",
          key: req("userId"),
          fields: { userId: req("userId") },
          onConflict: "continue",
          into: "mine",
        },
        {
          op: "branch",
          id: "b2",
          cond: eq(local("mine"), lit(true)),
          then: [{ op: "respond", id: "ok", status: "success", outcome: "allocated" }],
          else: [
            // Lost the uniqueness race: give the unit back, or it is stranded forever.
            {
              op: "write",
              id: "w3",
              collection: "inventory",
              key: null,
              mode: "delta",
              value: lit(1),
              fields: {},
            },
            { op: "respond", id: "dupe", status: "rejected", outcome: "alreadyClaimed" },
          ],
        },
      ],
      else: [{ op: "respond", id: "no", status: "rejected", outcome: "soldOut" }],
    },
  ];
}

function run(design: Design, opts: Partial<Parameters<typeof explore>[0]> = {}) {
  return explore({
    design,
    invariants: INVARIANTS,
    faults: NO_FAULTS,
    bounds: TIGHT,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// 1 & 2: check-then-write oversells; atomic conditional decrement does not
// ---------------------------------------------------------------------------

describe("check-then-write versus an atomic conditional decrement", () => {
  const checkThenWrite = designWith([
    { id: "claim", trigger: { kind: "request" }, node: "api", steps: checkThenWriteSteps() },
  ]);

  const atomic = designWith([
    { id: "claim", trigger: { kind: "request" }, node: "api", steps: atomicDecrementSteps() },
  ]);

  it("check-then-write oversells one item to two actors, with no fault injected", () => {
    const result = run(checkThenWrite);
    expect(result.status).toBe("VIOLATED");
    expect(result.counterexample).not.toBeNull();
    // No fault was needed. That is the finding: plain concurrency is enough.
    expect(result.counterexample!.faultsUsed).toEqual([]);
  });

  it("the counterexample shows both actors reading the same value before either writes", () => {
    const ce = run(checkThenWrite).counterexample!;
    const reads = ce.steps.filter((s) => s.opId === "r1");
    expect(reads.length).toBe(2);
    // Both observed one unit left. The whole bug, in one assertion.
    expect(reads.every((s) => s.observed.left === 1)).toBe(true);
    const firstWrite = ce.steps.findIndex((s) => s.opId === "w1");
    expect(reads.every((s) => s.index < firstWrite)).toBe(true);
  });

  it("the counterexample is minimal in transition count", () => {
    const result = run(checkThenWrite);
    const ce = result.counterexample!;
    // read, read, write, write... plus the claim insert that makes the second allocation
    // observable. Anything longer would mean breadth-first order was not respected.
    expect(ce.minimal).toBe(true);
    expect(ce.steps.length).toBeLessThanOrEqual(6);
    expect(result.claim).toContain("authored contract");
    expect(result.claim).not.toMatch(/production bug exists|explanation of this bug/i);
  });

  it("it names two distinct actor lanes, so the trace is readable as a race", () => {
    const ce = run(checkThenWrite).counterexample!;
    expect(new Set(ce.steps.map((s) => s.laneId)).size).toBeGreaterThanOrEqual(2);
    expect(ce.lanes.length).toBeGreaterThanOrEqual(2);
  });

  it("an atomic conditional decrement does not oversell", () => {
    const result = run(atomic);
    expect(result.status).toBe("NO_VIOLATION_WITHIN_BOUNDS");
    expect(result.counterexample).toBeNull();
    expect(result.stats.exhausted).toBe(true);
  });

  it("the safe verdict is never phrased as a proof", () => {
    const result = run(atomic);
    expect(result.claim).toContain("NOT A PROOF OF SAFETY");
    expect(result.claim.toLowerCase()).not.toContain("proved safe");
    expect(result.status).not.toBe("SAFE" as never);
  });
});

// ---------------------------------------------------------------------------
// 3: a unique user constraint blocks duplicate claims
// ---------------------------------------------------------------------------

describe("a unique constraint on the person", () => {
  /** Enough inventory that scarcity cannot mask the uniqueness question. */
  const roomyCollections = [
    { kind: "counter", id: "initialInventory", node: "db", initial: 4 },
    { kind: "counter", id: "inventory", node: "db", initial: 4 },
    COLLECTIONS[2],
  ];

  const withoutConstraint = designWith(
    [{ id: "claim", trigger: { kind: "request" }, node: "api", steps: checkThenWriteSteps() }],
    { collections: roomyCollections }
  );

  const withConstraint = designWith(
    [{ id: "claim", trigger: { kind: "request" }, node: "api", steps: atomicDecrementSteps() }],
    { collections: roomyCollections }
  );

  it("without it, one person claims twice", () => {
    const result = explore({
      design: withoutConstraint,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, duplicateRequest: true },
      bounds: { ...TIGHT, actors: 3 },
      // Both actors are the same person, so the ONLY thing that can go wrong is the
      // uniqueness rule. Inventory is not scarce here.
      identityDomains: { userId: ["u1"], claimId: ["c1", "c2"] },
    });
    expect(result.status).toBe("VIOLATED");
    expect(result.counterexample!.invariantId).toBe("one-per-user");
  });

  it("with it, the second claim is refused", () => {
    const result = explore({
      design: withConstraint,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, duplicateRequest: true },
      bounds: { ...TIGHT, actors: 3 },
      identityDomains: { userId: ["u1"], claimId: ["c1", "c2"] },
    });
    expect(result.status).toBe("NO_VIOLATION_WITHIN_BOUNDS");
  });
});

// ---------------------------------------------------------------------------
// 4: retry after commit duplicates an unprotected operation but not an idempotent one
// ---------------------------------------------------------------------------

describe("a retry after the write already committed", () => {
  const unprotected = designWith([
    {
      id: "claim",
      trigger: { kind: "request" },
      node: "api",
      steps: [
        // Keyed by the ATTEMPT, so a retry writes a second row. This is the bug.
        {
          op: "write",
          id: "w1",
          collection: "claims",
          key: req("claimId"),
          mode: "set",
          value: null,
          fields: { userId: req("userId") },
        },
        {
          op: "write",
          id: "w2",
          collection: "inventory",
          key: null,
          mode: "delta",
          value: lit(-1),
          fields: {},
        },
        { op: "respond", id: "ok", status: "success", outcome: "allocated" },
      ],
    },
  ]);

  const idempotent = designWith([
    {
      id: "claim",
      trigger: { kind: "request" },
      node: "api",
      steps: [
        // Keyed by the IDEMPOTENCY KEY, which a same-key retry shares.
        {
          op: "insertUnique",
          id: "iu1",
          collection: "claims",
          key: req("idemKey"),
          fields: { userId: req("userId") },
          onConflict: "continue",
          into: "fresh",
        },
        {
          op: "branch",
          id: "b1",
          cond: eq(local("fresh"), lit(true)),
          then: [
            {
              op: "write",
              id: "w2",
              collection: "inventory",
              key: null,
              mode: "delta",
              value: lit(-1),
              fields: {},
            },
            { op: "respond", id: "ok", status: "success", outcome: "allocated" },
          ],
          // The same answer as the first attempt, without doing the work twice.
          else: [{ op: "respond", id: "again", status: "success", outcome: "idempotentReplay" }],
        },
      ],
    },
  ]);

  const roomy = { userId: ["u1"], claimId: ["c1"] };

  it("an unprotected write is applied twice", () => {
    const result = explore({
      design: unprotected,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, retrySameKey: true },
      bounds: { ...TIGHT, actors: 1, faults: 1 },
      identityDomains: roomy,
    });
    expect(result.status).toBe("VIOLATED");
    expect(result.counterexample!.faultsUsed).toContain("retry-same-key");
  });

  it("an idempotent write keyed on the retry's own key is applied once", () => {
    const result = explore({
      design: idempotent,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, retrySameKey: true },
      bounds: { ...TIGHT, actors: 1, faults: 1 },
      identityDomains: roomy,
    });
    expect(result.status).toBe("NO_VIOLATION_WITHIN_BOUNDS");
  });

  it("but a retry with a FRESH key defeats that same idempotency", () => {
    // The detail everybody misses. The key has to be generated once per logical request,
    // not once per attempt, and a design is safe under one fault and broken under the
    // other -- which is why the two are separate faults rather than one "retry" flag.
    const result = explore({
      design: idempotent,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, retryNewKey: true },
      bounds: { ...TIGHT, actors: 1, faults: 1 },
      identityDomains: roomy,
    });
    expect(result.status).toBe("VIOLATED");
    expect(result.counterexample!.faultsUsed).toContain("retry-new-key");
  });
});

// ---------------------------------------------------------------------------
// 5: at-least-once redelivery duplicates an unprotected consumer
// ---------------------------------------------------------------------------

describe("at-least-once redelivery", () => {
  const queueNode = (id: string) => ({
    id,
    kind: "queue",
    label: "claims queue",
    x: 400,
    y: 200,
    queue: {
      consumers: 2,
      delivery: "at-least-once",
      requireAck: true,
      visibilityTimeoutMs: 1000,
      maxRedeliveries: 2,
    },
  });

  function queueDesign(consumerSteps: Operation[]): Design {
    return designWith(
      [
        {
          id: "accept",
          trigger: { kind: "request" },
          node: "api",
          steps: [
            {
              op: "publish",
              id: "p1",
              queue: "q",
              message: { userId: req("userId"), claimId: req("claimId"), idemKey: req("idemKey") },
            },
            { op: "respond", id: "acc", status: "success", outcome: "accepted" },
          ],
        },
        { id: "worker", trigger: { kind: "queue", queue: "q" }, node: "api", steps: consumerSteps },
      ],
      { extraNodes: [queueNode("q")], extraEdges: [{ id: "e3", from: "api", to: "q" }] }
    );
  }

  const unprotectedConsumer = queueDesign([
    {
      op: "write",
      id: "w1",
      collection: "claims",
      key: req("claimId"),
      mode: "set",
      value: null,
      fields: { userId: req("userId") },
    },
    {
      op: "write",
      id: "w2",
      collection: "inventory",
      key: null,
      mode: "delta",
      value: lit(-1),
      fields: {},
    },
    { op: "ack", id: "a1" },
  ]);

  const uniqueConsumer = queueDesign([
    {
      op: "insertUnique",
      id: "iu1",
      collection: "claims",
      key: req("idemKey"),
      fields: { userId: req("userId") },
      onConflict: "continue",
      into: "fresh",
    },
    {
      op: "branch",
      id: "b1",
      cond: eq(local("fresh"), lit(true)),
      then: [
        {
          op: "write",
          id: "w2",
          collection: "inventory",
          key: null,
          mode: "delta",
          value: lit(-1),
          fields: {},
        },
      ],
      else: [],
    },
    { op: "ack", id: "a1" },
  ]);

  const one = { userId: ["u1"], claimId: ["c1"] };

  it("duplicates the effect of an unprotected consumer", () => {
    const result = explore({
      design: unprotectedConsumer,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, queueRedelivery: true },
      bounds: { actors: 1, faults: 1, transitions: 30, states: 80_000, timeMs: 20_000 },
      identityDomains: one,
    });
    expect(result.status).toBe("VIOLATED");
    expect(result.counterexample!.faultsUsed).toContain("queue-redelivery");
  });

  it("does not duplicate the effect of a unique/idempotent consumer", () => {
    const result = explore({
      design: uniqueConsumer,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, queueRedelivery: true },
      bounds: { actors: 1, faults: 1, transitions: 30, states: 80_000, timeMs: 20_000 },
      identityDomains: one,
    });
    expect(result.status).toBe("NO_VIOLATION_WITHIN_BOUNDS");
  });

  it("a crash before the acknowledgement is enough on its own", () => {
    // No redelivery fault needed: the message is still in flight and unacked, so the
    // ordinary delivery of an available message picks it up again once the visibility
    // window releases it. This is why `worker-crash` and `queue-redelivery` are separate
    // faults and why the budget is per execution rather than per kind.
    const result = explore({
      design: unprotectedConsumer,
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, workerCrash: true, queueRedelivery: true },
      bounds: { actors: 1, faults: 2, transitions: 30, states: 120_000, timeMs: 25_000 },
      identityDomains: one,
    });
    expect(result.status).toBe("VIOLATED");
  });
});

// ---------------------------------------------------------------------------
// 6: lease expiry, with and without fencing
// ---------------------------------------------------------------------------

describe("a lease that expires under a holder still working", () => {
  function lockNode(fencing: boolean) {
    return {
      id: "lock",
      kind: "lock",
      label: fencing ? "fenced lock" : "advisory lock",
      x: 400,
      y: -200,
      lock: { concurrency: 8, defaultTtlMs: 1000, fencingTokens: fencing },
    };
  }

  function leaseDesign(fencing: boolean): Design {
    return designWith(
      [
        {
          id: "claim",
          trigger: { kind: "request" },
          node: "api",
          steps: [
            {
              op: "acquireLease",
              id: "acq",
              lock: "lock",
              key: lit("the-pizza"),
              ttlMs: 1000,
              fencing,
              into: "tok",
              onBusy: "fail",
            },
            ...checkThenWriteSteps(),
            { op: "releaseLease", id: "rel", lock: "lock", key: lit("the-pizza") },
          ],
        },
      ],
      { extraNodes: [lockNode(fencing)], extraEdges: [{ id: "e3", from: "api", to: "lock" }] }
    );
  }

  it("an unfenced lease permits stale-owner corruption", () => {
    const result = explore({
      design: leaseDesign(false),
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, leaseExpiry: true },
      bounds: { actors: 2, faults: 1, transitions: 40, states: 150_000, timeMs: 30_000 },
    });
    expect(result.status).toBe("VIOLATED");
    expect(result.counterexample!.faultsUsed).toContain("lease-expiry");
  });

  it("a fenced lease rejects the stale owner's write instead", () => {
    const result = explore({
      design: leaseDesign(true),
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, leaseExpiry: true },
      bounds: { actors: 2, faults: 1, transitions: 40, states: 150_000, timeMs: 30_000 },
    });
    expect(result.status).toBe("NO_VIOLATION_WITHIN_BOUNDS");
  });

  it("the unfenced counterexample names the expiry as the pivotal event", () => {
    const ce = explore({
      design: leaseDesign(false),
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, leaseExpiry: true },
      bounds: { actors: 2, faults: 1, transitions: 40, states: 150_000, timeMs: 30_000 },
    }).counterexample!;
    const expiry = ce.steps.find((s) => s.fault === "lease-expiry");
    expect(expiry).toBeDefined();
    expect(expiry!.label).toContain("expires while its holder is still working");
  });

  it("asking for fencing from a lock service that does not issue tokens is refused", () => {
    // Caught as INVALID_MODEL rather than silently ignored. A workflow that believed it
    // was fenced while running against an advisory lock would be reported safe on the
    // strength of a mechanism that is not there.
    const design = designWith(
      [
        {
          id: "claim",
          trigger: { kind: "request" },
          node: "api",
          steps: [
            {
              op: "acquireLease",
              id: "acq",
              lock: "lock",
              key: lit("k"),
              ttlMs: 1000,
              fencing: true,
              into: "tok",
              onBusy: "fail",
            },
            { op: "respond", id: "ok", status: "success", outcome: "allocated" },
          ],
        },
      ],
      { extraNodes: [lockNode(false)], extraEdges: [{ id: "e3", from: "api", to: "lock" }] }
    );
    const result = run(design);
    expect(result.status).toBe("INVALID_MODEL");
    expect(result.modelErrors.join(" ")).toContain("does not issue them");
  });
});

// ---------------------------------------------------------------------------
// 7: reservation expiry returns inventory and prevents late confirmation
// ---------------------------------------------------------------------------

describe("reservation expiry", () => {
  const reservationCollections = [
    { kind: "counter", id: "initialInventory", node: "db", initial: 1 },
    { kind: "counter", id: "inventory", node: "db", initial: 1 },
    {
      kind: "table",
      id: "claims",
      node: "db",
      key: "claimKey",
      fields: [
        { name: "claimKey", type: "string" },
        { name: "userId", type: "string" },
        { name: "status", type: "enum", values: ["reserved", "confirmed"], default: "reserved" },
      ],
    },
  ];

  /**
   * Reserve, arm an expiry, and confirm later. The expiry hands the unit back only if the
   * reservation is still unconfirmed -- guarded indivisibly, because the confirmation and
   * the expiry are exactly the two things that race.
   */
  function reservationDesign(guardExpiry: boolean): Design {
    return designWith(
      [
        {
          id: "reserve",
          trigger: { kind: "request" },
          node: "api",
          steps: [
            {
              op: "conditionalWrite",
              id: "cw1",
              collection: "inventory",
              key: null,
              guard: gt(counter("inventory"), lit(0)),
              mode: "delta",
              value: lit(-1),
              fields: {},
              onFail: "continue",
              into: "took",
            },
            {
              op: "branch",
              id: "b1",
              cond: eq(local("took"), lit(true)),
              then: [
                {
                  op: "insertUnique",
                  id: "iu1",
                  collection: "claims",
                  key: req("userId"),
                  fields: { userId: req("userId"), status: lit("reserved") },
                  onConflict: "continue",
                  into: "mine",
                },
                {
                  op: "branch",
                  id: "b2",
                  cond: eq(local("mine"), lit(true)),
                  then: [
                    {
                      op: "scheduleExpiry",
                      id: "sx",
                      handler: "expire",
                      afterMs: 500,
                      args: { userId: req("userId") },
                    },
                    { op: "respond", id: "ok", status: "success", outcome: "reserved" },
                  ],
                  else: [
                    {
                      op: "write",
                      id: "w9",
                      collection: "inventory",
                      key: null,
                      mode: "delta",
                      value: lit(1),
                      fields: {},
                    },
                    { op: "respond", id: "dupe", status: "rejected", outcome: "alreadyClaimed" },
                  ],
                },
              ],
              else: [{ op: "respond", id: "no", status: "rejected", outcome: "soldOut" }],
            },
          ],
        },
        {
          id: "expire",
          trigger: { kind: "expiry" },
          node: "api",
          steps: guardExpiry
            ? [
                // Guarded and indivisible: delete the row only while it is still reserved,
                // and hand the unit back in the same breath.
                {
                  op: "atomic",
                  id: "tx",
                  body: [
                    {
                      op: "conditionalWrite",
                      id: "cw2",
                      collection: "claims",
                      key: req("userId"),
                      guard: eq(
                        { kind: "row", collection: "claims", key: req("userId"), field: "status" },
                        lit("reserved")
                      ),
                      mode: "set",
                      fields: { status: lit("confirmed") },
                      onFail: "continue",
                      into: "reclaimed",
                    },
                  ],
                },
                { op: "respond", id: "done", status: "success", outcome: "expired" },
              ]
            : [
                // Unguarded: hands the unit back regardless of whether the reservation was
                // already confirmed, so a confirmed claim and a returned unit coexist.
                {
                  op: "write",
                  id: "w1",
                  collection: "inventory",
                  key: null,
                  mode: "delta",
                  value: lit(1),
                  fields: {},
                },
                { op: "respond", id: "done", status: "success", outcome: "expired" },
              ],
        },
      ],
      { collections: reservationCollections }
    );
  }

  it("an unguarded expiry conjures inventory that was already allocated", () => {
    const result = explore({
      design: reservationDesign(false),
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, reservationExpiry: true },
      bounds: { actors: 2, faults: 1, transitions: 40, states: 150_000, timeMs: 30_000 },
    });
    expect(result.status).toBe("VIOLATED");
    expect(["no-oversell", "no-conjured-inventory"]).toContain(result.counterexample!.invariantId);
  });

  it("a guarded expiry keeps the accounting straight", () => {
    const result = explore({
      design: reservationDesign(true),
      invariants: INVARIANTS,
      faults: { ...NO_FAULTS, reservationExpiry: true },
      bounds: { actors: 2, faults: 1, transitions: 40, states: 150_000, timeMs: 30_000 },
    });
    expect(result.status).toBe("NO_VIOLATION_WITHIN_BOUNDS");
  });
});

// ---------------------------------------------------------------------------
// 8: caps produce "inconclusive", never "safe"
// ---------------------------------------------------------------------------

describe("bounds are reported, never quietly absorbed", () => {
  const atomic = designWith([
    { id: "claim", trigger: { kind: "request" }, node: "api", steps: atomicDecrementSteps() },
  ]);

  it("a state cap yields INCONCLUSIVE_BOUND_REACHED, not a safe verdict", () => {
    const result = explore({
      design: atomic,
      invariants: INVARIANTS,
      faults: { duplicateRequest: true, retrySameKey: true, retryNewKey: true, workerCrash: true, queueRedelivery: true, leaseExpiry: true, reservationExpiry: true },
      bounds: { actors: 3, faults: 2, transitions: 40, states: 120, timeMs: 30_000 },
    });
    expect(result.status).toBe("INCONCLUSIVE_BOUND_REACHED");
    expect(result.stats.capHit).toBe("states");
    expect(result.claim).toContain("INCONCLUSIVE");
    expect(result.claim).toContain("says nothing about whether a violation exists");
  });

  it("a time cap yields INCONCLUSIVE_BOUND_REACHED", () => {
    // A clock that jumps past the budget on its first read, so the test does not depend
    // on how fast the machine running it happens to be.
    let ticks = 0;
    const result = explore({
      design: atomic,
      invariants: INVARIANTS,
      faults: { duplicateRequest: true, retrySameKey: true, retryNewKey: true, workerCrash: true, queueRedelivery: true, leaseExpiry: true, reservationExpiry: true },
      bounds: { actors: 3, faults: 2, transitions: 40, states: 5_000_000, timeMs: 50 },
      clock: () => (ticks++ === 0 ? 0 : 10_000),
    });
    expect(result.status).toBe("INCONCLUSIVE_BOUND_REACHED");
    expect(result.stats.capHit).toBe("time");
  });

  it("a design with no invariants is refused rather than passed", () => {
    const result = explore({ design: atomic, invariants: [], bounds: TIGHT, faults: NO_FAULTS });
    expect(result.status).toBe("INVALID_MODEL");
    expect(result.modelErrors.join(" ")).toContain("vacuous");
  });

  it("a design with no workflow is refused rather than passed", () => {
    const bare = DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "no workflow",
      nodes: baseNodes(),
      edges: baseEdges(),
      scenario: {},
      slo: {},
    });
    const result = run(bare);
    expect(result.status).toBe("INVALID_MODEL");
    expect(result.modelErrors.join(" ")).toContain("no correctness contract");
  });

  it("every result carries the bounds and assumptions it ran under", () => {
    const result = run(atomic);
    expect(result.bounds.actors).toBe(TIGHT.actors);
    expect(result.assumptions.join(" ")).toContain("no network partitions");
    expect(result.assumptions.join(" ")).toContain("one logical region");
    // Faults that were switched off are named, so a reader knows what was not tested.
    expect(result.assumptions.join(" ")).toContain("these faults were NOT injected");
  });

  it("an exploration override naming a collection that does not exist is refused", () => {
    const result = explore({
      design: atomic,
      invariants: INVARIANTS,
      faults: NO_FAULTS,
      bounds: TIGHT,
      stateOverrides: { inventry: 1 },
    });
    expect(result.status).toBe("INVALID_MODEL");
    expect(result.modelErrors.join(" ")).toContain("weaker than it looks");
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("the explorer is deterministic", () => {
  const checkThenWrite = designWith([
    { id: "claim", trigger: { kind: "request" }, node: "api", steps: checkThenWriteSteps() },
  ]);

  it("reports the identical counterexample on repeated runs", () => {
    const a = run(checkThenWrite);
    const b = run(checkThenWrite);
    expect(JSON.stringify(a.counterexample)).toBe(JSON.stringify(b.counterexample));
    expect(a.stats.statesVisited).toBe(b.stats.statesVisited);
    expect(a.stats.transitionsApplied).toBe(b.stats.transitionsApplied);
  });

  it("symmetry reduction actually prunes", () => {
    const result = run(checkThenWrite);
    // Two interchangeable actors: without actor symmetry the space would be roughly
    // doubled. The count is not asserted precisely -- that would pin an implementation
    // detail -- but it must be non-zero, or the reduction is not running at all.
    expect(result.stats.duplicatesPruned).toBeGreaterThan(0);
  });
});
