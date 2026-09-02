import { describe, expect, it } from "vitest";
import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  type Design,
  type Expr,
  type Operation,
} from "@sds/schema";
import {
  generateRequest,
  initialWorld,
  newGenState,
  startRequestFrame,
  step,
  stepEnvFor,
  type Frame,
  type Row,
  type WorldState,
} from "@sds/kernel";
import { RngBundle, runSimulation } from "@sds/core";

/**
 * SEMANTIC CONFORMANCE: the explorer and the simulator apply every operation identically.
 *
 * WHY THIS TEST IS THE MOST IMPORTANT ONE IN THE REPOSITORY
 *
 * The product makes two claims about the same design: a correctness claim from the
 * breadth-first explorer, and a performance claim from the discrete-event simulator. Those
 * claims are only compatible if the two engines agree about what the design DOES. If they
 * do not, then a user is shown a counterexample about one system and a latency figure
 * about another, and no amount of care in either engine can recover from that -- the
 * incoherence is at the level of the product, not the implementation.
 *
 * The architectural answer is that there is exactly one implementation of every operation,
 * in `@sds/kernel`, and both engines call it. That is a claim about the code and this test
 * is what turns it into a checked fact: it drives the same workflow through a bare
 * sequential kernel driver (which is what the explorer does, minus the search) and through
 * the full simulator (arrival process, stations, queues, timers), and asserts the resulting
 * world states are equal field for field.
 *
 * WHAT IT DELIBERATELY DOES NOT TEST
 *
 * That the two engines produce the same INTERLEAVINGS. They must not: the explorer
 * enumerates all of them and the simulator samples one. So the workload here is arranged so
 * that requests do not overlap -- a low arrival rate against fast stations -- which makes
 * the interleaving unique and the comparison meaningful. Concurrency is what the other test
 * files are about.
 */

const lit = (value: number | string | boolean): Expr => ({ kind: "lit", value });
const counter = (collection: string): Expr => ({ kind: "counter", collection });
const req = (field: string): Expr => ({ kind: "request", field });
const local = (name: string): Expr => ({ kind: "local", name });
const row = (collection: string, key: Expr, field: string): Expr => ({
  kind: "row",
  collection,
  key,
  field,
});
const gt = (l: Expr, r: Expr): Expr => ({ kind: "compare", op: ">", left: l, right: r });
const eq = (l: Expr, r: Expr): Expr => ({ kind: "compare", op: "==", left: l, right: r });

/** Requests arrive slowly enough, and are served fast enough, never to overlap. */
const NON_OVERLAPPING = {
  ratePerSec: 4,
  durationSec: 6,
  warmupSec: 0,
  serviceMs: 0.5,
};

function design(handlers: unknown[], collections: unknown[], extraNodes: unknown[] = [], extraEdges: unknown[] = []): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "conformance",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "client",
        x: 0,
        y: 0,
        client: { arrival: { kind: "deterministic", ratePerSec: NON_OVERLAPPING.ratePerSec } },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 200,
        y: 0,
        server: {
          concurrency: 1,
          serviceTime: { kind: "deterministic", value: NON_OVERLAPPING.serviceMs },
        },
      },
      {
        id: "db",
        kind: "database",
        label: "db",
        x: 400,
        y: 0,
        database: {
          poolSize: 8,
          parallelism: 8,
          serviceTime: { kind: "deterministic", value: NON_OVERLAPPING.serviceMs },
        },
      },
      ...extraNodes,
    ],
    edges: [
      { id: "e1", from: "client", to: "api" },
      { id: "e2", from: "api", to: "db" },
      ...extraEdges,
    ],
    scenario: {
      durationSec: NON_OVERLAPPING.durationSec,
      warmupSec: NON_OVERLAPPING.warmupSec,
      seed: 7,
      traceLimit: 0,
    },
    slo: {},
    workflow: { collections, requestFields: REQUEST_FIELDS, handlers },
  });
}

const REQUEST_FIELDS = [
  { name: "userId", type: "string", strategy: { kind: "choice", values: ["u1", "u2", "u3"] } },
  { name: "claimId", type: "string", strategy: { kind: "sequence", prefix: "c" } },
  { name: "amount", type: "int", strategy: { kind: "uniform", min: 1, max: 3 } },
  { name: "idemKey", type: "string", strategy: { kind: "idempotencyKey", of: ["claimId"] } },
];

const COLLECTIONS = [
  { kind: "counter", id: "stock", node: "db", initial: 1000 },
  { kind: "counter", id: "audit", node: "db", initial: 0 },
  {
    kind: "table",
    id: "claims",
    node: "db",
    key: "claimKey",
    fields: [
      { name: "claimKey", type: "string" },
      { name: "userId", type: "string" },
      { name: "amount", type: "int", default: 0 },
      { name: "status", type: "enum", values: ["reserved", "confirmed"], default: "reserved" },
    ],
  },
];

/**
 * The sequential kernel driver: what the explorer does with the search removed.
 *
 * One actor at a time, run to completion, no faults, no concurrency. Every state change
 * goes through `step`, which is the same function the simulator calls. If this and the
 * simulator disagree, the disagreement is in the scheduling layer of one of them, and that
 * is exactly what this test is for.
 */
function driveSequentially(d: Design, requestCount: number, seed: number): WorldState {
  const env = stepEnvFor(d)!;
  const wf = d.workflow!;
  let world = initialWorld(wf);

  // The SAME generator, seeded from the SAME stream, as `run.ts` uses. Identity is an
  // input to the workflow, so two engines that generated it differently would diverge for
  // reasons that had nothing to do with the operations under test -- and the divergence
  // would look like an operation bug.
  const rng = new RngBundle(seed).stream("routing");
  const genState = newGenState();

  for (let i = 0; i < requestCount; i++) {
    const identity: Row = generateRequest(wf, genState, rng);
    let frame: Frame = startRequestFrame(env, `r${i}`, identity);
    let guard = 0;
    while (frame.status === "running" && guard++ < 1000) {
      const result = step(env, world, frame, world.nowMs + 1);
      world = result.world;
      frame = result.frame;
      if (result.terminal) break;
    }
    // Drain any queue consumers and timers the request created, in id order. The simulator
    // runs them concurrently; with non-overlapping requests the resulting order is the same.
    world = drain(env, world);
  }

  return world;
}

function drain(env: ReturnType<typeof stepEnvFor> & object, world: WorldState): WorldState {
  const e = env as NonNullable<ReturnType<typeof stepEnvFor>>;
  let w = world;
  let guard = 0;
  for (;;) {
    if (guard++ > 500) break;
    const message = w.messages.find((m) => !m.acked && !m.abandoned && m.inflightOwner === null);
    if (message) {
      const handlerId = (e.cw.consumers[message.queue] ?? [])[0];
      if (!handlerId) break;
      w = {
        ...w,
        messages: w.messages.map((m) =>
          m.id === message.id ? { ...m, deliveries: m.deliveries + 1, inflightOwner: `c${m.id}` } : m
        ),
      };
      const delivered = w.messages.find((m) => m.id === message.id)!;
      let frame: Frame = {
        id: `c${message.id}`,
        kind: "queue-consumer",
        handlerId,
        pc: 0,
        locals: {},
        request: { ...delivered.body },
        messageId: delivered.id,
        timerId: null,
        tokens: {},
        leaseHeldAt: {},
        status: "running",
        responseStatus: null,
        responseOutcome: null,
      };
      let inner = 0;
      while (frame.status === "running" && inner++ < 1000) {
        const r = step(e, w, frame, w.nowMs + 1);
        w = r.world;
        frame = r.frame;
        if (r.terminal) break;
      }
      continue;
    }

    const timer = w.timers.find((t) => !t.fired);
    if (timer) {
      w = { ...w, timers: w.timers.map((t) => (t.id === timer.id ? { ...t, fired: true } : t)) };
      let frame: Frame = {
        id: `x${timer.id}`,
        kind: "expiry-timer",
        handlerId: timer.handler,
        pc: 0,
        locals: {},
        request: { ...timer.args },
        messageId: null,
        timerId: timer.id,
        tokens: {},
        leaseHeldAt: {},
        status: "running",
        responseStatus: null,
        responseOutcome: null,
      };
      let inner = 0;
      while (frame.status === "running" && inner++ < 1000) {
        const r = step(e, w, frame, w.nowMs + 1);
        w = r.world;
        frame = r.frame;
        if (r.terminal) break;
      }
      continue;
    }

    break;
  }
  return w;
}

/**
 * Compare only what both engines are claiming to agree about.
 *
 * Not the clock: the explorer's is a transition count and the simulator's is milliseconds,
 * and the difference is documented rather than accidental. Not message or timer ids: they
 * are allocation order. Not lease deadlines, which are derived from the clock. What is left
 * is what a user is shown -- counters, rows, and outcome tallies -- and it must match
 * exactly.
 */
function comparable(world: WorldState) {
  const tables: Record<string, Array<[string, Row]>> = {};
  for (const [id, table] of Object.entries(world.tables)) {
    tables[id] = Object.keys(table)
      .sort()
      .map((k) => [k, table[k]!] as [string, Row]);
  }
  return {
    counters: world.counters,
    tables,
    outcomes: world.outcomes,
    unacked: world.messages.filter((m) => !m.acked && !m.abandoned).length,
    heldLeases: Object.keys(world.leases).length,
  };
}

function simulate(d: Design) {
  const result = runSimulation(d, { collectTrace: false });
  expect(result.business).not.toBeNull();
  return result;
}

/** The simulator's own view of its final state, in the same comparable shape. */
function comparableFromRun(d: Design) {
  const result = simulate(d);
  const state = result.business!.state;
  const tables: Record<string, Array<[string, Row]>> = {};
  for (const [id, table] of Object.entries(state.tables)) {
    tables[id] = Object.keys(table)
      .sort()
      .map((k) => [k, table[k]! as Row] as [string, Row]);
  }
  return {
    comparable: {
      counters: state.counters,
      tables,
      outcomes: result.business!.outcomes,
      unacked: state.unackedMessages,
      heldLeases: state.heldLeases,
    },
    result,
  };
}

/** How many root requests the simulator actually admitted, so the driver matches it. */
function requestCount(d: Design): number {
  const result = simulate(d);
  return result.errors.total + result.throughputPerSec * result.observedSec;
}

// ---------------------------------------------------------------------------

describe("the explorer and the simulator apply every operation identically", () => {
  /**
   * One handler exercising every operation the language has, in one pass.
   *
   * Written as one long handler rather than one test per operation because the operations
   * that break conformance are the ones that interact -- a `read` whose local is used by a
   * `conditionalWrite` guard, an `insertUnique` whose result drives a `branch`. Testing them
   * in isolation would pass while the combination diverged.
   */
  const everyOperation: Operation[] = [
    { op: "read", id: "r1", value: counter("stock"), into: "left" },
    { op: "assign", id: "a1", value: { kind: "arith", op: "*", left: req("amount"), right: lit(2) }, name: "double" },
    {
      op: "branch",
      id: "b1",
      cond: gt(local("left"), lit(0)),
      then: [
        {
          op: "conditionalWrite",
          id: "cw1",
          collection: "stock",
          key: null,
          guard: gt(counter("stock"), lit(0)),
          mode: "delta",
          value: { kind: "arith", op: "-", left: lit(0), right: req("amount") },
          fields: {},
          onFail: "continue",
          into: "took",
        },
        {
          op: "branch",
          id: "b2",
          cond: eq(local("took"), lit(true)),
          then: [
            {
              op: "insertUnique",
              id: "iu1",
              collection: "claims",
              key: req("idemKey"),
              fields: { userId: req("userId"), amount: local("double") },
              onConflict: "continue",
              into: "fresh",
            },
            {
              op: "atomic",
              id: "tx1",
              body: [
                {
                  op: "write",
                  id: "w1",
                  collection: "audit",
                  key: null,
                  mode: "delta",
                  value: lit(1),
                  fields: {},
                },
                {
                  op: "conditionalWrite",
                  id: "cw2",
                  collection: "claims",
                  key: req("idemKey"),
                  guard: eq(row("claims", req("idemKey"), "status"), lit("reserved")),
                  mode: "set",
                  value: null,
                  fields: { status: lit("confirmed") },
                  onFail: "continue",
                  into: "confirmed",
                },
              ],
            },
            { op: "respond", id: "ok", status: "success", outcome: "allocated" },
          ],
          else: [{ op: "respond", id: "dup", status: "rejected", outcome: "alreadyClaimed" }],
        },
      ],
      else: [{ op: "respond", id: "no", status: "rejected", outcome: "soldOut" }],
    },
  ];

  const d = design(
    [{ id: "claim", trigger: { kind: "request" }, node: "api", steps: everyOperation }],
    COLLECTIONS
  );

  it("produces the same final state for reads, writes, guards, uniques and transactions", () => {
    const { comparable: fromSim } = comparableFromRun(d);
    const n = Math.round(requestCount(d));
    const fromKernel = comparable(driveSequentially(d, n, d.scenario.seed));
    expect(fromSim).toEqual(fromKernel);
  });

  it("agrees about the number of rows and the content of every one", () => {
    const { comparable: fromSim } = comparableFromRun(d);
    const n = Math.round(requestCount(d));
    const fromKernel = comparable(driveSequentially(d, n, d.scenario.seed));
    expect(fromSim.tables.claims).toEqual(fromKernel.tables.claims);
    expect(fromSim.tables.claims!.length).toBeGreaterThan(0);
  });

  it("agrees about outcome tallies", () => {
    const { comparable: fromSim, result } = comparableFromRun(d);
    const n = Math.round(requestCount(d));
    const fromKernel = comparable(driveSequentially(d, n, d.scenario.seed));
    expect(fromSim.outcomes).toEqual(fromKernel.outcomes);
    // And the tallies must be the ones the business metrics reported, or the summary is
    // describing a different run from the state.
    expect(result.business!.outcomes).toEqual(fromKernel.outcomes);
  });

  it("the transaction's counter and its guarded row move together in both engines", () => {
    const { comparable: fromSim } = comparableFromRun(d);
    const rows = fromSim.tables.claims!;
    // Every row the transaction touched is confirmed, and the audit counter equals the
    // number of transactions that ran. If the two engines disagreed about atomicity, one
    // of these two would drift from the other.
    expect(fromSim.counters.audit).toBe(rows.length);
    expect(rows.every(([, r]) => r.status === "confirmed")).toBe(true);
  });
});

describe("queues and timers conform too", () => {
  const queueNode = {
    id: "q",
    kind: "queue",
    label: "work",
    x: 400,
    y: 200,
    queue: {
      consumers: 1,
      delivery: "at-least-once",
      requireAck: true,
      // Long enough that the consumer always finishes first, so the simulator's
      // interleaving is the same one the sequential driver produces.
      visibilityTimeoutMs: 600_000,
      maxRedeliveries: 3,
      publishTime: { kind: "deterministic", value: 0.1 },
      consumerServiceTime: { kind: "deterministic", value: 0.1 },
    },
  };

  const d = design(
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
            message: { userId: req("userId"), idemKey: req("idemKey"), amount: req("amount") },
          },
          { op: "respond", id: "acc", status: "success", outcome: "accepted" },
        ],
      },
      {
        id: "worker",
        trigger: { kind: "queue", queue: "q" },
        node: "api",
        steps: [
          {
            op: "insertUnique",
            id: "iu1",
            collection: "claims",
            key: req("idemKey"),
            fields: { userId: req("userId"), amount: req("amount") },
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
                id: "w1",
                collection: "stock",
                key: null,
                mode: "delta",
                value: { kind: "arith", op: "-", left: lit(0), right: req("amount") },
                fields: {},
              },
            ],
            else: [],
          },
          { op: "ack", id: "ack1" },
        ],
      },
    ],
    COLLECTIONS,
    [queueNode],
    [{ id: "e3", from: "api", to: "q" }]
  );

  it("a published message is consumed once, with the same effect, in both engines", () => {
    const { comparable: fromSim } = comparableFromRun(d);
    const n = Math.round(requestCount(d));
    const fromKernel = comparable(driveSequentially(d, n, d.scenario.seed));
    expect(fromSim.counters.stock).toBe(fromKernel.counters.stock);
    expect(fromSim.tables.claims).toEqual(fromKernel.tables.claims);
  });

  it("no message is left unacknowledged in either engine", () => {
    const { comparable: fromSim } = comparableFromRun(d);
    expect(fromSim.unacked).toBe(0);
  });

  const withExpiry = design(
    [
      {
        id: "reserve",
        trigger: { kind: "request" },
        node: "api",
        steps: [
          {
            op: "insertUnique",
            id: "iu1",
            collection: "claims",
            key: req("idemKey"),
            fields: { userId: req("userId"), amount: req("amount") },
            onConflict: "continue",
            into: "fresh",
          },
          {
            op: "scheduleExpiry",
            id: "sx",
            handler: "expire",
            afterMs: 5,
            args: { idemKey: req("idemKey") },
          },
          { op: "respond", id: "ok", status: "success", outcome: "reserved" },
        ],
      },
      {
        id: "expire",
        trigger: { kind: "expiry" },
        node: "api",
        steps: [
          {
            op: "conditionalWrite",
            id: "cw1",
            collection: "claims",
            key: req("idemKey"),
            guard: eq(row("claims", req("idemKey"), "status"), lit("reserved")),
            mode: "set",
            value: null,
            fields: { status: lit("confirmed") },
            onFail: "continue",
            into: "changed",
          },
          {
            op: "write",
            id: "w1",
            collection: "audit",
            key: null,
            mode: "delta",
            value: lit(1),
            fields: {},
          },
          { op: "respond", id: "done", status: "success", outcome: "expired" },
        ],
      },
    ],
    COLLECTIONS
  );

  it("an expiry handler runs exactly once per armed timer in both engines", () => {
    const { comparable: fromSim } = comparableFromRun(withExpiry);
    const n = Math.round(requestCount(withExpiry));
    const fromKernel = comparable(driveSequentially(withExpiry, n, withExpiry.scenario.seed));
    expect(fromSim.counters.audit).toBe(fromKernel.counters.audit);
    expect(fromSim.counters.audit).toBeGreaterThan(0);
    expect(fromSim.tables.claims).toEqual(fromKernel.tables.claims);
  });
});

describe("leases conform", () => {
  const lockNode = {
    id: "lock",
    kind: "lock",
    label: "lease",
    x: 400,
    y: -200,
    // A TTL far longer than the run, so no lease expires and the interleaving is unique.
    lock: { concurrency: 4, defaultTtlMs: 600_000, fencingTokens: true },
  };

  const d = design(
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
            key: req("userId"),
            ttlMs: 600_000,
            fencing: true,
            into: "tok",
            onBusy: "fail",
          },
          {
            op: "write",
            id: "w1",
            collection: "stock",
            key: null,
            mode: "delta",
            value: lit(-1),
            fields: {},
          },
          { op: "releaseLease", id: "rel", lock: "lock", key: req("userId") },
          { op: "respond", id: "ok", status: "success", outcome: "allocated" },
        ],
      },
    ],
    COLLECTIONS,
    [lockNode],
    [{ id: "e3", from: "api", to: "lock" }]
  );

  it("acquire, fenced write and release have the same effect in both engines", () => {
    const { comparable: fromSim, result } = comparableFromRun(d);
    const n = Math.round(requestCount(d));
    const fromKernel = comparable(driveSequentially(d, n, d.scenario.seed));
    expect(fromSim.counters.stock).toBe(fromKernel.counters.stock);
    expect(fromSim.heldLeases).toBe(0);
    // The lock station recorded the traffic, which is the half the kernel cannot know.
    const lock = result.nodes.find((x) => x.nodeId === "lock");
    expect(lock?.lock?.acquired).toBeGreaterThan(0);
    expect(lock?.lock?.released).toBe(lock?.lock?.acquired);
    expect(lock?.lock?.fencingEnabled).toBe(true);
  });

  it("no stale-owner rejection occurs when no lease expires", () => {
    const { result } = comparableFromRun(d);
    expect(result.business!.staleOwnerRejections).toBe(0);
    expect(result.business!.leaseExpiries).toBe(0);
  });
});

describe("a design with no workflow is untouched by any of this", () => {
  it("reports no business metrics rather than zeroed ones", () => {
    const bare = DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "stateless",
      nodes: [
        {
          id: "client",
          kind: "client",
          label: "c",
          x: 0,
          y: 0,
          client: { arrival: { kind: "poisson", ratePerSec: 50 } },
        },
        {
          id: "api",
          kind: "server",
          label: "api",
          x: 1,
          y: 0,
          server: { concurrency: 8, serviceTime: { kind: "exponential", mean: 10 } },
        },
      ],
      edges: [{ id: "e1", from: "client", to: "api" }],
      scenario: { durationSec: 30, warmupSec: 5, traceLimit: 0 },
      slo: {},
    });
    const result = runSimulation(bare, { collectTrace: false });
    // Null, not zero. A zeroed metrics object would let a design with no correctness
    // contract appear to have passed one.
    expect(result.business).toBeNull();
    expect(result.throughputPerSec).toBeGreaterThan(0);
  });
});
