import type { Catalog } from "./tools";
import { NODE_GAP } from "../canvas/layout"
import { NODE_HEIGHT, NODE_WIDTH } from "../canvas/geometry"

/**
 * The modelling vocabulary, as an agent needs to read it.
 *
 * WHY THIS IS STATIC DATA AND NOT GENERATED FROM THE SCHEMA
 *
 * Because the schema says what fields exist and this has to say what they MEAN. A generated
 * catalogue would tell an agent that `conditionalWrite` takes a guard and a value; it would not
 * tell it that `conditionalWrite` is the difference between a design that oversells and one that
 * does not. The second is the only sentence that changes what the agent writes.
 *
 * It is also the one place in the tool surface where the studio gets to be opinionated, and the
 * opinions are load-bearing: an agent that does not know which operations are indivisible will
 * reach for a lock, because that is what the training data is full of.
 */
export function buildCatalog(): Catalog {
  return {
    componentKinds: [
      {
        kind: "client",
        whatItModels: "Where work comes from. Carries the arrival process and the caller's timeout.",
        capabilities: ["originates requests", "holds long-lived connections"],
      },
      {
        kind: "loadbalancer",
        whatItModels: "Picks exactly one backend per request, by algorithm and weight.",
        capabilities: ["round-robin", "random", "least-connections", "power-of-two-choices", "passive health checking"],
      },
      {
        kind: "server",
        whatItModels:
          "A request handler. `concurrency x replicas` slots. Holds its slot across dependency calls unless blocksOnDependencies is false, which is the mechanism by which a slow dependency exhausts a caller.",
        capabilities: ["runs workflow handlers", "shed or block on a full queue", "load-correlated failure"],
      },
      {
        kind: "cache",
        whatItModels: "A read-through LRU. The hit ratio is an OUTPUT of capacity and keyspace, never an input.",
        capabilities: ["LRU eviction", "TTL expiry", "Zipf or fixed keyspace"],
      },
      {
        kind: "database",
        whatItModels:
          "The authoritative store. TWO nested capacities: a connection pool and an execution parallelism. Raising the pool past parallelism converts pool-wait into execution-wait and does not raise throughput.",
        capabilities: [
          "holds every state collection",
          "serves read, write, conditionalWrite, insertUnique and atomic",
          "linearizable within one region",
        ],
      },
      {
        kind: "queue",
        whatItModels:
          "An asynchronous boundary. Publishing returns immediately. Delivery is at-least-once or at-most-once; there is no exactly-once option because none is implementable.",
        capabilities: ["at-least-once delivery with a visibility timeout", "bounded redelivery then abandonment", "consumer pool"],
      },
      {
        kind: "lock",
        whatItModels:
          "A lease service. A lease is NOT a mutex: it is held until released OR until it expires, and expiry happens on the lock service's clock rather than the holder's, so a holder cannot know it still holds one.",
        capabilities: [
          "acquireLease and releaseLease",
          "optional fencing tokens, which the datastore checks and which are the only thing that makes lease-based exclusion safe",
        ],
      },
      {
        kind: "gateway",
        whatItModels: "Holds sockets. Connection capacity and work concurrency are different scarcities.",
        capabilities: ["long-lived connections", "fan-out delivery"],
      },
    ],

    operations: [
      {
        op: "read",
        indivisible: false,
        whatItDoes:
          "Load state into a local. A SCHEDULING POINT: another actor may run before the local is used, so anything read may already be stale.",
      },
      {
        op: "write",
        indivisible: false,
        whatItDoes:
          "Unguarded mutation, `set` or `delta`. Also a scheduling point. A `set` computed from an earlier `read` is a lost update waiting to happen.",
      },
      {
        op: "conditionalWrite",
        indivisible: true,
        whatItDoes:
          "Indivisible check-and-set. The guard is evaluated and the write applied with no interleaving between them. This is the compare-and-set primitive and it is usually the smallest correct fix for a lost update.",
      },
      {
        op: "insertUnique",
        indivisible: true,
        whatItDoes:
          "Indivisible insert that fails if the key already exists. The unique-index primitive, and the only thing that enforces at-most-one-per-key under arbitrary interleaving without a lock. Keying it on an idempotency key is how a retry becomes safe; keying it on a user is how a duplicate claim becomes impossible.",
      },
      {
        op: "atomic",
        indivisible: true,
        whatItDoes:
          "A serializable transaction. Everything inside commits together or not at all. Nesting is refused rather than flattened. Costs conflict retries under contention.",
      },
      {
        op: "acquireLease",
        indivisible: true,
        whatItDoes:
          "Take a lease with a TTL. Set `fencing: true` to receive a monotonic token that the datastore checks on every subsequent write; without one, a holder whose lease expired and was reassigned can still write, and the design has a mutual-exclusion property it does not possess. Does not block: `onBusy` decides whether a contended acquire rejects the request or proceeds without the lease.",
      },
      { op: "releaseLease", indivisible: true, whatItDoes: "Give up a lease. A no-op if somebody else now holds it." },
      { op: "publish", indivisible: false, whatItDoes: "Enqueue a message and continue. The caller does not wait." },
      {
        op: "ack",
        indivisible: false,
        whatItDoes:
          "Acknowledge the message that triggered this handler. Until this runs the message is eligible for redelivery, so a consumer that mutates state and then dies before its ack applies that mutation twice.",
      },
      { op: "branch", indivisible: false, whatItDoes: "Conditional. Local only; not a scheduling point." },
      { op: "assign", indivisible: false, whatItDoes: "Bind a local. Local only." },
      {
        op: "scheduleExpiry",
        indivisible: false,
        whatItDoes:
          "Arm a timer that runs an expiry-triggered handler with the arguments given. The handler cannot see the arming request's locals -- arguments are the only channel. A handler that schedules itself is refused, because it could not be bounded.",
      },
      {
        op: "respond",
        indivisible: false,
        whatItDoes:
          "Terminate the handler with success, rejected or error, and optionally record a business outcome label. The label must be one the project's product contract defines, or its meaning is unknown and it is not counted as valid or duplicate.",
      },
    ],

    patterns: [
      {
        id: "non-atomic-check-then-write",
        label: "read the count, decide, then write",
        expectation:
          "BROKEN with no fault injected. Two requests read the same value before either writes. This is what the obvious implementation looks like.",
      },
      {
        id: "process-local-mutex",
        label: "a mutex inside the handler, behind several replicas",
        expectation:
          "BROKEN, and invisible in code review. A process-local mutex is not shared state, so it excludes nothing between replicas and the model shows the same counterexample as no lock at all.",
      },
      {
        id: "unfenced-lease",
        label: "a shared lease with no fencing token",
        expectation:
          "BROKEN only under lease expiry. A genuine improvement on the above and still wrong, because a lease can expire without its holder finding out.",
      },
      {
        id: "at-least-once-queue-no-idempotency",
        label: "accept now, do the work on a queue, no unique key",
        expectation:
          "BROKEN under redelivery, and the fastest design of all on the request path. Note that it also changes what the response promises the user.",
      },
      {
        id: "fenced-lease",
        label: "a shared lease with fencing, checked by the datastore",
        expectation:
          "Expected sound. Costs a second round trip on every request and makes the lock service a serialisation point.",
      },
      {
        id: "serializable-transaction",
        label: "one serializable transaction plus a unique constraint",
        expectation:
          "Expected sound, and the shortest correct answer. Costs transaction conflicts under contention.",
      },
      {
        id: "atomic-decrement-unique-claim",
        label: "an atomic guarded decrement plus a unique claim",
        expectation:
          "Expected sound. No lock service, no transaction, no serialisation point. Carries the most machinery: the failure paths have to give the unit back or it is stranded.",
      },
    ],

    faults: [
      { kind: "duplicateRequest", whatItModels: "The same person submits twice, with a fresh idempotency key." },
      { kind: "retrySameKey", whatItModels: "A caller times out and retries carrying the SAME key. Deduplicable." },
      {
        kind: "retryNewKey",
        whatItModels:
          "A caller times out and retries carrying a FRESH key. NOT deduplicable, and the case people forget: a key must be generated once per logical request, not once per attempt.",
      },
      {
        kind: "workerCrash",
        whatItModels:
          "A worker dies after a durable write and before its response or ack. Nothing rolls back: its writes stand, its lease stays held, its message stays unacknowledged.",
      },
      { kind: "queueRedelivery", whatItModels: "An at-least-once queue delivers a message again before it was acked." },
      { kind: "leaseExpiry", whatItModels: "A lease expires while its holder is still working and still believes it holds one." },
      { kind: "reservationExpiry", whatItModels: "A scheduled expiry fires, possibly racing the request that armed it." },
    ],

    layoutGuide: {
      coordinateSystem: "x increases to the right; y increases downward",
      nodeSize: { width: NODE_WIDTH, height: NODE_HEIGHT },
      minimumGap: NODE_GAP,
      suggestedStep: { x: 320, y: 240 },
      rules: [
        "Plan the full topology before placing the first node; coordinates communicate architecture and are not auto-generated.",
        "Put callers and clients in the leftmost column, then increase x by dependency depth toward services, queues, stores and external systems.",
        "Keep the primary request path on one row. Put parallel or asynchronous branches on separate y rows.",
        "Center a shared dependency vertically between its callers when practical.",
        "Use update-node with x/y to improve the layout when a newly discovered dependency changes the topology.",
        "Never overlap node boxes. Avoid edge crossings and long edges through unrelated nodes.",
      ],
    },

    notes: [
      "Operations are a closed set. There are no loops, no function calls and no recursion, because a workflow that could loop an unbounded number of times has no bounded state space and the only possible verdict would be 'inconclusive'.",
      "`read` followed by `write` is TWO transitions and another actor may run in between. That is the point of the model, not a limitation of it.",
      "There is no exactly-once queue setting. Exactly-once EFFECTS are reachable, and the only routes are insertUnique or a guarded conditionalWrite in the consumer.",
      "State must live on a database node. A workflow that claims a transaction against a cache is refused, because it would otherwise be reported safe on the strength of a capability the topology does not have.",
      "A resource profile left absent is reported as UNKNOWN and excludes that axis from the comparison for every candidate. It is never treated as zero, so an unmeasured design cannot win on cost.",
      "The correctness search is bounded. NO_VIOLATION_WITHIN_BOUNDS means the search exhausted the configured actors, faults and transitions without finding a counterexample. It is not a proof, and raising any bound may change the answer.",
    ],
  };
}
