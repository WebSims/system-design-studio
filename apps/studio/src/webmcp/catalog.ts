import type { Catalog } from "./tools";
import { NETWORK_LATENCIES } from "@sds/models";
import { LAYOUT_STEP, NODE_GAP } from "../canvas/layout";
import { NODE_HEIGHT, NODE_WIDTH } from "../canvas/geometry";

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
        whatItModels:
          "Where work comes from. This includes users and APIs, but also autonomous timers, pollers, cron ticks and external deliveries. Every independent workload origin needs its own client so HTTP traffic is not made to trigger background work.",
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
          "A deployed runtime or independently bounded capacity/failure boundary, not an arbitrary package, handler, goroutine or class. `concurrency x replicas` slots. In-process work belongs on its host unless it has separately configured concurrency or lifecycle; when split for that reason, label it '(in-process)'. Holds its slot across dependency calls unless blocksOnDependencies is false.",
        capabilities: [
          "runs one or more workflow handlers",
          "models separately bounded in-process worker pools when labelled as such",
          "shed or block on a full queue",
          "load-correlated failure",
        ],
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
      suggestedStep: { x: LAYOUT_STEP.x, y: LAYOUT_STEP.y },
      rules: [
        "Coordinates communicate architecture. Either place every node yourself by the rules below, or include { op: \"auto-layout\" } in a studio_apply_architecture_patch and the studio applies them from the links.",
        "Put callers and clients in the leftmost column, then increase x by dependency depth toward services, queues, stores and external systems.",
        "Keep the primary request path on one row. Put parallel or asynchronous branches on separate y rows.",
        "Center a shared dependency vertically between its callers when practical.",
        "When a newly discovered dependency changes the topology, re-place with update-node x/y or one auto-layout operation.",
        "Never overlap node boxes. Avoid edge crossings and long edges through unrelated nodes.",
      ],
    },

    performanceGuide: {
      requirement:
        "Repository performance is calibrated only when every modeled node and link has usable positive inputs plus observed performance evidence from runtime measurements or the user. Code evidence that work exists does not measure its duration.",
      componentTiming:
        "Set every component timing field explicitly. Zero is an unknown-value sentinel, not free work. When no measurement exists, use a clearly assumed benchmark only as a visible estimate; it cannot unlock load evaluation.",
      edgeLatency:
        "Every link needs an explicit positive one-way latency and fanoutFactor (1 for one-to-one). Zero is an unknown-value sentinel used by old/test documents, never a physical latency default. Pick a benchmark only when its locality matches the available evidence, attach aspect=performance with confidence=assumed, and do not run load evaluation until measured.",
      placeholders: NETWORK_LATENCIES.map((benchmark) => ({
        id: benchmark.id,
        label: benchmark.label,
        note: benchmark.note,
        distribution: benchmark.distribution,
        rangeMs: benchmark.citation.range ?? null,
        source: benchmark.citation.source,
        asOf: benchmark.citation.asOf ?? "",
      })),
    },

    notes: [
      "Choose graph granularity from runtime, capacity and failure boundaries. Do not turn every source module, HTTP handler, goroutine, class or cron callback into a server. Keep ordinary responsibilities as workflow handlers on their deployed host; split an in-process subsystem only when an independently bounded resource is important to the question, label it '(in-process)', and cite the shared lifecycle.",
      "A link is executed work: every request reaching its source may traverse it according to classes and probability. Never draw an ownership, startup or shared-process relationship as a link. Give every traffic-bearing external entrypoint a client/work source; give autonomous polling, timers, cron and queue delivery their own source instead of routing them from an HTTP service. Every active component must be reachable from one of those sources.",
      "Define the unit of every source event. Set fanoutFactor=1 for one-to-one calls; for a batch, loop or broadcast, set the number of downstream calls it creates or model a separate bounded/volatile queue. Never collapse one timer tick into one downstream item when it actually expands to many.",
      "For every server with more than one outgoing dependency, read the implementation and set fanout deliberately. Sequential adds dependency time; parallel is fork-join and waits for the slowest. Never inherit parallel merely because it is the schema default.",
      "A codebase may support mutually exclusive providers. Draw the provider selected by checked-in deployment configuration; if no deployed choice is known, use the documented default and record alternatives as an evidence gap rather than drawing every option as active at once.",
      "Repository structure can establish topology but cannot establish production traffic, replica count, service time or dependency latency. Any schema-required placeholder for an unknown value is performance evidence with confidence assumed, and is not a basis for running or reporting performance results.",
      "An invariant is a required property of system state, not a description of the current mechanism. Do not encode 'uses a mutex' or 'one importer in this process' as safety goals. State the intended system-wide outcome when the source supports it; otherwise record the process-local guarantee as a risk or evidence gap.",
      "Safety invariants are checked after every workflow operation. If two values are allowed to differ while a handler is in flight and only have to agree once work finishes or crashes, use a postcondition and enable the relevant fault. A one-step safety failure before a later compensating operation is a contract mismatch, not by itself evidence of a production bug.",
      "A correctness invariant without a workflow that can change the state it reads is not executable evidence. For a code-derived baseline, trace the highest-risk representable state-changing flow. If the main source-backed risk cannot be represented, report the exact checked scope and leave that risk explicitly unmodeled; never substitute an easier flow and imply broad coverage.",
      "Operations are a closed set. There are no loops, no function calls and no recursion, because a workflow that could loop an unbounded number of times has no bounded state space and the only possible verdict would be 'inconclusive'.",
      "`read` followed by `write` is TWO transitions and another actor may run in between. That is the point of the model, not a limitation of it.",
      "There is no exactly-once queue setting. Exactly-once EFFECTS are reachable, and the only routes are insertUnique or a guarded conditionalWrite in the consumer.",
      "State must live on a database node. A workflow that claims a transaction against a cache is refused, because it would otherwise be reported safe on the strength of a capability the topology does not have.",
      "A resource profile left absent is reported as UNKNOWN and excludes that axis from the comparison for every candidate. It is never treated as zero, so an unmeasured design cannot win on cost.",
      "The correctness search is bounded. NO_VIOLATION_WITHIN_BOUNDS means the search exhausted the configured actors, faults and transitions without finding a counterexample. It is not a proof, and raising any bound may change the answer.",
    ],
  };
}
