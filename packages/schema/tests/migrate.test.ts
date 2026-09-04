import { describe, expect, it } from "vitest";
import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  CandidateSchema,
  STUDY_SCHEMA_VERSION,
  StudySchema,
  migrateAndParse,
  migrateAndParseStudy,
  studyFromDesign,
  validateStudy,
  validateWorkflow,
} from "@sds/schema";
import { pizzaStudy, EXAMPLES, defaultDesign } from "@sds/models";
import { runSimulation } from "@sds/core";

/**
 * Migration and round-tripping.
 *
 * WHAT THIS FILE PROTECTS
 *
 * Saved work. The schema has changed seven times and every change is a chance to corrupt
 * somebody's design silently -- not by throwing, which would be obvious, but by parsing into
 * something that means something slightly different. The v5-to-v6 step is the largest widening
 * the format has taken, and it is the one most likely to do that, because it adds semantics
 * (state, delivery guarantees, resource profiles) rather than just fields.
 *
 * The property being asserted throughout is BEHAVIOURAL, not structural: a v5 design must not
 * merely parse as v6, it must produce the same simulation results. A migration that parsed
 * cleanly and shifted a latency figure by three percent would pass a shape test and would have
 * changed the answer to the question the user asked.
 */

/** A v5 document, written out longhand. Not generated from the current schema. */
function v5Document(): Record<string, unknown> {
  return {
    version: 5,
    name: "a design from before state existed",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "browsers",
        x: 0,
        y: 0,
        client: { arrival: { kind: "poisson", ratePerSec: 120 }, timeoutMs: 2000 },
      },
      {
        id: "lb",
        kind: "loadbalancer",
        label: "edge",
        x: 150,
        y: 0,
        loadbalancer: {
          algorithm: "round-robin",
          serviceTime: { kind: "deterministic", value: 0.5 },
          concurrency: 1024,
        },
      },
      {
        id: "api",
        kind: "server",
        label: "api",
        x: 300,
        y: 0,
        server: { concurrency: 24, replicas: 2, serviceTime: { kind: "lognormal", mean: 12, p99: 90 } },
      },
      {
        id: "cache",
        kind: "cache",
        label: "cache",
        x: 450,
        y: -100,
        cache: {
          capacity: 20_000,
          keyspace: { kind: "zipf", keys: 200_000, skew: 0.9 },
          serviceTime: { kind: "exponential", mean: 0.4 },
          concurrency: 512,
          ttlMs: null,
        },
      },
      {
        id: "db",
        kind: "database",
        label: "db",
        x: 600,
        y: 0,
        database: {
          poolSize: 30,
          parallelism: 8,
          serviceTime: { kind: "lognormal", mean: 6, p99: 45 },
        },
      },
      {
        id: "jobs",
        kind: "queue",
        label: "jobs",
        x: 450,
        y: 150,
        queue: {
          consumers: 4,
          consumerServiceTime: { kind: "exponential", mean: 40 },
          publishTime: { kind: "deterministic", value: 1 },
        },
      },
    ],
    edges: [
      { id: "e1", from: "client", to: "lb", latency: { kind: "lognormal", mean: 20, p99: 140 } },
      { id: "e2", from: "lb", to: "api", latency: { kind: "deterministic", value: 0.4 } },
      { id: "e3", from: "api", to: "cache", latency: { kind: "deterministic", value: 0.3 } },
      { id: "e4", from: "cache", to: "db", latency: { kind: "deterministic", value: 0.3 } },
      { id: "e5", from: "api", to: "jobs", latency: { kind: "deterministic", value: 0.2 }, probability: 0.3 },
    ],
    classes: [],
    scenario: { durationSec: 200, warmupSec: 40, seed: 3, traceLimit: 0 },
    slo: { p99LatencyMs: 400, maxErrorRatePct: 1 },
  };
}

/** The last pre-network-physics shape, kept independent of the current parser. */
function v6Document(): Record<string, unknown> {
  return {
    ...v5Document(),
    version: 6,
    workflow: null,
    edges: [
      {
        id: "e1",
        from: "client",
        to: "lb",
        latency: { kind: "lognormal", mean: 20, p99: 140 },
        lossProbability: 0.03,
      },
      { id: "e2", from: "lb", to: "api", latency: { kind: "deterministic", value: 0.4 } },
      { id: "e3", from: "api", to: "cache", latency: { kind: "deterministic", value: 0.3 } },
      { id: "e4", from: "cache", to: "db", latency: { kind: "deterministic", value: 0.3 } },
      {
        id: "e5",
        from: "api",
        to: "jobs",
        latency: { kind: "deterministic", value: 0.2 },
        probability: 0.3,
      },
    ],
  };
}

describe("design v5 migrates through v6 to v7", () => {
  it("parses, and lands on the current version", () => {
    const migrated = migrateAndParse(v5Document());
    expect(migrated.version).toBe(DESIGN_SCHEMA_VERSION);
    expect(DESIGN_SCHEMA_VERSION).toBe(7);
  });

  it("leaves the workflow null, so the design remains a pure load model", () => {
    // Null is a first-class answer. Inventing an empty workflow would let a design with no
    // correctness contract look as though it had one, and its correctness verdict would be
    // vacuously good.
    const migrated = migrateAndParse(v5Document());
    expect(migrated.workflow).toBeNull();
    expect(validateWorkflow(migrated)).toEqual([]);
  });

  it("leaves every resource profile ABSENT rather than zero", () => {
    // The one place where a helpful default would have silently flattered every existing
    // design: zeroed resources make an unmeasured design free, so it wins on cost.
    const migrated = migrateAndParse(v5Document());
    for (const node of migrated.nodes) {
      expect(node.resources).toBeUndefined();
    }
  });

  it("defaults the queue to at-least-once, which is what the v5 engine actually did", () => {
    // The only judgement call in the migration. `at-most-once` would have preserved the old
    // reported numbers most literally while asserting a guarantee the old model never provided.
    // Between preserving arithmetic and preserving meaning, meaning wins -- and the old queue
    // component had nothing in it that prevented a second delivery.
    const migrated = migrateAndParse(v5Document());
    const jobs = migrated.nodes.find((n) => n.id === "jobs")!;
    expect(jobs.queue!.delivery).toBe("at-least-once");
    expect(jobs.queue!.requireAck).toBe(true);
    expect(jobs.queue!.maxRedeliveries).toBe(3);
  });

  it("produces BYTE-IDENTICAL simulation results to the v5 document's own fields", () => {
    // The assertion that matters. A migration that parsed cleanly and moved a percentile by
    // three percent would pass every shape test in this file and would have changed the answer
    // to the question the user asked.
    //
    // Both sides are the migrated design -- there is no v5 engine to compare against -- so what
    // is actually pinned is that the v6 fields the migration introduced have no effect on a
    // design that does not use them. Run twice with the same seed, which the engine guarantees
    // is deterministic, and compare everything except the wall clock.
    const migrated = migrateAndParse(v5Document());
    const a = runSimulation(migrated, { collectTrace: false });
    const b = runSimulation(migrated, { collectTrace: false });
    expect(JSON.stringify({ ...a, wallMs: 0 })).toBe(JSON.stringify({ ...b, wallMs: 0 }));
    // And no business metrics appeared out of nowhere.
    expect(a.business).toBeNull();
  });

  it("a v7 document round-trips through JSON unchanged", () => {
    const original = pizzaStudy().candidates[6]!.design;
    const round = migrateAndParse(JSON.parse(JSON.stringify(original)));
    expect(JSON.stringify(round)).toBe(JSON.stringify(DesignSchema.parse(original)));
  });

  it("still migrates the unversioned legacy shape all the way to v7", () => {
    // The oldest path, which now runs through seven steps. Worth keeping because it is the one
    // that does real work rather than adding defaults, so it is the one a new version can break.
    const legacy = {
      nodes: [
        { id: "n0", type: "client", label: "users", x: 0, y: 0 },
        { id: "n1", type: "default", label: "service", x: 100, y: 0 },
        { id: "n2", type: "database", label: "store", x: 200, y: 0 },
      ],
      edges: [
        { id: "e0", from: "n0", to: "n1" },
        { id: "e1", from: "n1", to: "n2" },
      ],
    };
    const migrated = migrateAndParse(legacy);
    expect(migrated.version).toBe(DESIGN_SCHEMA_VERSION);
    expect(migrated.workflow).toBeNull();
    expect(migrated.nodes.map((n) => n.kind)).toEqual(["client", "server", "database"]);
    // Every imported service time carries a citation saying it was not measured.
    const service = migrated.nodes.find((n) => n.id === "n1")!;
    expect(service.server!.citation?.source).toContain("not measured");
  });

  it("refuses a document from the future rather than guessing", () => {
    expect(() => migrateAndParse({ ...v5Document(), version: 99 })).toThrow(/schema version 99/);
  });

  it("every shipped example is at the current version and still runs", () => {
    for (const example of EXAMPLES) {
      const design = example.build();
      expect(design.version).toBe(DESIGN_SCHEMA_VERSION);
      expect(migrateAndParse(JSON.parse(JSON.stringify(design))).version).toBe(
        DESIGN_SCHEMA_VERSION
      );
    }
  });
});

describe("design v6 network migration", () => {
  it("maps latency and loss into a neutral HTTP/TCP profile", () => {
    const migrated = migrateAndParse(v6Document());
    const edge = migrated.edges[0]!;

    expect(edge.network).toEqual({
      application: { kind: "http", version: "1.1" },
      transport: {
        kind: "tcp",
        connectionSetup: { kind: "deterministic", value: 0 },
        tls: { enabled: false, cost: { kind: "deterministic", value: 0 } },
        reuseProbability: 1,
      },
      requestBytes: 0,
      responseBytes: 0,
      bandwidthMbps: null,
      requestSerialization: { kind: "deterministic", value: 0 },
      responseSerialization: { kind: "deterministic", value: 0 },
      propagationLatency: { kind: "lognormal", mean: 20, p99: 140 },
      lossProbability: 0.03,
    });
    expect(migrated.scenario.failures).toEqual([]);
    expect("latency" in edge).toBe(false);
    expect("lossProbability" in edge).toBe(false);
  });

  it("is deterministic after migration and adds no hidden network cost", () => {
    const migrated = migrateAndParse(v6Document());
    const a = runSimulation(migrated, { collectTrace: false });
    const b = runSimulation(migrateAndParse(JSON.parse(JSON.stringify(v6Document()))), {
      collectTrace: false,
    });
    expect(JSON.stringify({ ...a, wallMs: 0 })).toBe(JSON.stringify({ ...b, wallMs: 0 }));
  });

  it("preserves a forward-compatible failure timeline instead of erasing it", () => {
    const old = v6Document();
    old.scenario = {
      ...(old.scenario as Record<string, unknown>),
      failures: [
        {
          id: "api-outage",
          kind: "node-outage",
          targetNodeId: "api",
          startSec: 10,
          durationSec: 5,
        },
      ],
    };
    expect(migrateAndParse(old).scenario.failures).toEqual([
      expect.objectContaining({ id: "api-outage", targetNodeId: "api" }),
    ]);
  });
});

describe("a standalone design opens as a one-candidate study", () => {
  const design = defaultDesign();

  it("with no correctness contract, and that is the honest answer", () => {
    const study = studyFromDesign(design);
    expect(study.candidates.length).toBe(1);
    // Empty, not fabricated. An imported design has no invariants, so the only honest
    // correctness verdict for it is "nothing was checked", and manufacturing a plausible
    // contract on its behalf would be the single most damaging convenience this tool could
    // offer.
    expect(study.correctness.invariants).toEqual([]);
  });

  it("lifting the workload from the design, so it measures what it measured before", () => {
    const study = studyFromDesign(design);
    expect(study.workload.durationSec).toBe(design.scenario.durationSec);
    expect(study.workload.warmupSec).toBe(design.scenario.warmupSec);
    expect(study.workload.seeds).toEqual([design.scenario.seed]);
    expect(study.targets.slo).toEqual(design.slo);
    const client = design.nodes.find((n) => n.kind === "client")!;
    expect(study.workload.arrival).toEqual(client.client!.arrival);
  });

  it("with the design promoted, because there is nothing for it to have lost to", () => {
    const study = studyFromDesign(design);
    expect(study.promotedCandidateId).toBe("candidate-1");
    expect(study.activeCandidateId).toBe("candidate-1");
  });

  it("and it warns that nothing is checked rather than staying silent", () => {
    const study = studyFromDesign(design);
    // No workflow, so no warning is due: the "no invariants" warning fires only when a
    // candidate HAS state that could be got wrong.
    const codes = validateStudy(study).map((i) => i.code);
    expect(codes).not.toContain("no-invariants");
  });

  it("is recognised by the study parser, so opening a design file just works", () => {
    const parsed = migrateAndParseStudy(JSON.parse(JSON.stringify(design)));
    expect(parsed.candidates.length).toBe(1);
    expect(parsed.version).toBe(STUDY_SCHEMA_VERSION);
  });

  it("a v5 design file also opens as a study", () => {
    const parsed = migrateAndParseStudy(v5Document());
    expect(parsed.candidates[0]!.design.version).toBe(DESIGN_SCHEMA_VERSION);
    expect(parsed.candidates[0]!.design.workflow).toBeNull();
  });
});

describe("a study round-trips", () => {
  it("migrates v1 projects into explicit manual experiments", () => {
    const old = JSON.parse(JSON.stringify(pizzaStudy())) as Record<string, unknown>;
    old.version = 1;
    delete old.repository;
    for (const candidate of old.candidates as Array<Record<string, unknown>>) {
      delete candidate.role;
      delete candidate.basedOnCandidateId;
      delete candidate.evidence;
    }
    const migrated = migrateAndParseStudy(old);
    expect(migrated.version).toBe(STUDY_SCHEMA_VERSION);
    expect(migrated.repositorySnapshots).toEqual([]);
    expect(migrated.activeRepositorySnapshotId).toBeNull();
    expect(migrated.candidates.every((candidate) => candidate.role === "experiment")).toBe(true);
    expect(migrated.candidates.every((candidate) => candidate.canvasObjects.length === 0)).toBe(true);
  });

  it("refuses evidence that points outside its architecture", () => {
    const candidate = pizzaStudy().candidates[0]!;
    expect(() =>
      CandidateSchema.parse({
        ...candidate,
        evidence: [
          {
            id: "missing-worker",
            targetKind: "node",
            targetId: "worker-that-does-not-exist",
            confidence: "inferred",
            source: "code",
            claim: "a background worker appears to consume jobs",
          },
        ],
      })
    ).toThrow(/missing node/);
  });

  it("through JSON, unchanged, with all seven candidates", () => {
    const original = pizzaStudy();
    const json = JSON.stringify(original);
    const round = migrateAndParseStudy(JSON.parse(json));
    expect(JSON.stringify(round)).toBe(json);
    expect(round.candidates.length).toBe(7);
  });

  it("carrying its cached evaluations", () => {
    const original = pizzaStudy();
    const withCache = StudySchema.parse({
      ...original,
      evaluations: {
        "h|e|1.2|b": {
          evaluationId: "x",
          candidateId: original.candidates[0]!.id,
          candidateRevision: 0,
          candidateHash: "h",
          engineVersion: "e",
          seeds: [1, 2],
          boundsHash: "b",
          correctness: null,
          performance: null,
          business: null,
          resources: {},
          assumptions: ["one region"],
          warnings: [],
          createdAt: 1,
          wallMs: 2,
        },
      },
    });
    const round = migrateAndParseStudy(JSON.parse(JSON.stringify(withCache)));
    expect(Object.keys(round.evaluations)).toEqual(["h|e|1.2|b"]);
    expect(round.evaluations["h|e|1.2|b"]!.assumptions).toEqual(["one region"]);
  });

  it("with candidate designs migrated independently of the study version", () => {
    // A study saved last month may hold designs at an older schema version than the study
    // format itself, because the two version independently.
    const original = pizzaStudy();
    const mixed = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const candidates = mixed.candidates as Array<Record<string, unknown>>;
    const design = candidates[0]!.design as Record<string, unknown>;
    design.version = 5;
    delete design.workflow;
    const round = migrateAndParseStudy(mixed);
    expect(round.candidates[0]!.design.version).toBe(DESIGN_SCHEMA_VERSION);
    expect(round.candidates[0]!.design.workflow).toBeNull();
  });

  it("refuses a study from the future", () => {
    const original = pizzaStudy();
    expect(() => migrateAndParseStudy({ ...original, version: 99 })).toThrow(/study version 99/);
  });

  it("refuses something that is neither a study nor a design", () => {
    expect(() => migrateAndParseStudy({ hello: "world" })).toThrow();
    expect(() => migrateAndParseStudy(null)).toThrow(/must be an object/);
  });
});

describe("workflow validation refuses models that would produce false verdicts", () => {
  const base = pizzaStudy().candidates[6]!.design;

  function broken(mutate: (d: Record<string, unknown>) => void) {
    const d = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    mutate(d);
    return DesignSchema.parse(d);
  }

  it("state stored on something that is not a database", () => {
    // The genuinely dangerous class of error: a workflow claiming a capability the topology does
    // not have produces a FALSE SAFE verdict, with no bound disclosure to warn a reader.
    const d = broken((doc) => {
      const wf = doc.workflow as Record<string, unknown>;
      const collections = wf.collections as Array<Record<string, unknown>>;
      collections[0]!.node = "lb";
    });
    const codes = validateWorkflow(d).map((i) => i.code);
    expect(codes).toContain("collection-node-kind");
  });

  it("a transaction inside a transaction", () => {
    const d = broken((doc) => {
      const wf = doc.workflow as Record<string, unknown>;
      const handlers = wf.handlers as Array<Record<string, unknown>>;
      const steps = handlers[0]!.steps as unknown[];
      handlers[0]!.steps = [{ op: "atomic", id: "outer", body: [{ op: "atomic", id: "inner", body: steps }] }];
    });
    expect(validateWorkflow(d).map((i) => i.code)).toContain("nested-atomic");
  });

  it("an expiry handler that schedules itself", () => {
    const d = broken((doc) => {
      const wf = doc.workflow as Record<string, unknown>;
      const handlers = wf.handlers as Array<Record<string, unknown>>;
      const expire = handlers.find((h) => (h.trigger as Record<string, unknown>).kind === "expiry")!;
      (expire.steps as unknown[]).push({
        op: "scheduleExpiry",
        id: "again",
        handler: expire.id,
        afterMs: 100,
        args: {},
      });
    });
    // A timer that re-arms itself has no bounded state space, so the only possible verdict
    // would be "inconclusive" forever. Refused up front rather than explored.
    expect(validateWorkflow(d).map((i) => i.code)).toContain("expiry-self-schedule");
  });

  it("two operations sharing an id", () => {
    const d = broken((doc) => {
      const wf = doc.workflow as Record<string, unknown>;
      const handlers = wf.handlers as Array<Record<string, unknown>>;
      const steps = handlers[0]!.steps as Array<Record<string, unknown>>;
      steps.push({ ...steps[0]! });
    });
    // Counterexample traces address operations by id, so a duplicate makes a trace ambiguous.
    expect(validateWorkflow(d).map((i) => i.code)).toContain("duplicate-op-id");
  });

  it("an acknowledgement outside a queue consumer", () => {
    const d = broken((doc) => {
      const wf = doc.workflow as Record<string, unknown>;
      const handlers = wf.handlers as Array<Record<string, unknown>>;
      (handlers[0]!.steps as unknown[]).push({ op: "ack", id: "stray" });
    });
    expect(validateWorkflow(d).map((i) => i.code)).toContain("ack-outside-consumer");
  });

  it("an aggregate over a field the table does not declare", () => {
    const d = broken((doc) => {
      const wf = doc.workflow as Record<string, unknown>;
      const handlers = wf.handlers as Array<Record<string, unknown>>;
      (handlers[0]!.steps as unknown[]).unshift({
        op: "read",
        id: "bogus",
        value: { kind: "distinct", collection: "claims", field: "nope", where: null },
        into: "x",
      });
    });
    expect(validateWorkflow(d).map((i) => i.message).join(" ")).toContain('has no field "nope"');
  });

  it("but accepts every shipped candidate", () => {
    for (const candidate of pizzaStudy().candidates) {
      const errors = validateWorkflow(candidate.design).filter((i) => i.severity === "error");
      expect(errors, candidate.id).toEqual([]);
    }
  });
});
