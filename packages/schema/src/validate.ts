import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  classesOf,
  isTimeVarying,
  type Design,
  type NodeKind,
  type SdsNode,
} from "./design";

/**
 * Structural problems that Zod cannot express, because they are relational
 * (they concern how nodes and edges refer to each other) rather than shape-level.
 */
export interface DesignIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/** Which config object each kind requires. */
const CONFIG_KEY: Record<NodeKind, keyof SdsNode> = {
  client: "client",
  server: "server",
  loadbalancer: "loadbalancer",
  cache: "cache",
  database: "database",
  queue: "queue",
};

/**
 * Detect a directed cycle.
 *
 * Cycles are rejected rather than truncated. The legacy engine tolerated them by
 * carrying an `ancestors` set and a hard depth cap of 8 (engine.jsx:186,193),
 * which silently produced a different topology from the one drawn. A cycle in a
 * request graph means a retry or a feedback path, and neither exists until Phase 3
 * -- so the honest response is to say so, not to quietly cut the graph.
 */
function findCycle(design: Design): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const e of design.edges) {
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }

  const state = new Map<string, 0 | 1 | 2>(); // unvisited / in progress / done
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id) ?? 0;
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (s === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const n of design.nodes) {
    const cycle = visit(n.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Validate a design's internal consistency.
 *
 * Returns issues rather than throwing: the editor wants to render problems
 * inline while the user is mid-edit, not blow up.
 */
export function validateDesign(design: Design): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const byId = new Map(design.nodes.map((n) => [n.id, n]));

  if (design.nodes.length !== byId.size) {
    issues.push({
      severity: "error",
      code: "duplicate-node-id",
      message: "two or more nodes share an id",
    });
  }

  for (const n of design.nodes) {
    if (!n[CONFIG_KEY[n.kind]]) {
      issues.push({
        severity: "error",
        code: "missing-config",
        message: `${n.kind} "${n.label}" has no ${n.kind} configuration`,
        nodeId: n.id,
      });
    }
  }

  // ---- edges ----
  const seenEdge = new Set<string>();
  const classIds = new Set(classesOf(design).map((c) => c.id));

  for (const e of design.edges) {
    if (!byId.has(e.from)) {
      issues.push({
        severity: "error",
        code: "dangling-edge",
        message: "connection starts at a node that does not exist",
        edgeId: e.id,
      });
    }
    if (!byId.has(e.to)) {
      issues.push({
        severity: "error",
        code: "dangling-edge",
        message: "connection ends at a node that does not exist",
        edgeId: e.id,
      });
    }
    const key = `${e.from}->${e.to}`;
    if (seenEdge.has(key)) {
      issues.push({
        severity: "warning",
        code: "duplicate-edge",
        message: "duplicate connection between the same pair of nodes",
        edgeId: e.id,
      });
    }
    seenEdge.add(key);

    if (byId.get(e.to)?.kind === "client") {
      issues.push({
        severity: "error",
        code: "client-inbound",
        message: "clients originate work; they cannot receive requests",
        edgeId: e.id,
      });
    }

    for (const c of e.classes) {
      if (!classIds.has(c)) {
        issues.push({
          severity: "error",
          code: "unknown-class",
          message: `connection restricts to request class "${c}", which is not defined`,
          edgeId: e.id,
        });
      }
    }
  }

  // ---- per-kind topology rules ----
  const outgoing = new Map<string, number>();
  for (const e of design.edges) outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);

  for (const n of design.nodes) {
    const out = outgoing.get(n.id) ?? 0;
    switch (n.kind) {
      case "client":
        if (out === 0) {
          issues.push({
            severity: "warning",
            code: "client-unwired",
            message: `client "${n.label}" is not connected to anything`,
            nodeId: n.id,
          });
        } else if (out > 1) {
          issues.push({
            severity: "warning",
            code: "client-fanout",
            message: `client "${n.label}" has ${out} connections; every request will traverse all of them`,
            nodeId: n.id,
          });
        }
        break;

      case "loadbalancer":
        if (out === 0) {
          issues.push({
            severity: "error",
            code: "lb-no-backends",
            message: `load balancer "${n.label}" has no backends to route to`,
            nodeId: n.id,
          });
        }
        break;

      case "cache":
        // A cache with no origin cannot read through, so a miss has nowhere to go.
        // Only valid when the hit ratio is exactly 1, which no real cache achieves.
        if (out === 0) {
          const ks = n.cache?.keyspace;
          const alwaysHits = ks?.kind === "fixed" && ks.hitRatio >= 1;
          if (!alwaysHits) {
            issues.push({
              severity: "error",
              code: "cache-no-origin",
              message: `cache "${n.label}" has no origin to read through to, so a miss has nowhere to go`,
              nodeId: n.id,
            });
          }
        } else if (out > 1) {
          issues.push({
            severity: "error",
            code: "cache-multi-origin",
            message: `cache "${n.label}" has ${out} origins; a read-through cache has exactly one`,
            nodeId: n.id,
          });
        }
        break;

      case "database":
        if (out > 0) {
          issues.push({
            severity: "warning",
            code: "database-outbound",
            message: `database "${n.label}" calls downstream services, which is unusual`,
            nodeId: n.id,
          });
        }
        break;

      default:
        break;
    }
  }

  // ---- classes ----
  if (design.classes.length > 0) {
    const seen = new Set<string>();
    for (const c of design.classes) {
      if (seen.has(c.id)) {
        issues.push({
          severity: "error",
          code: "duplicate-class",
          message: `two request classes share the id "${c.id}"`,
        });
      }
      seen.add(c.id);
    }
  }

  if (design.nodes.filter((n) => n.kind === "client").length === 0) {
    issues.push({
      severity: "warning",
      code: "no-client",
      message: "no client node, so no work will be generated",
    });
  }

  // ---- cycles ----
  const cycle = findCycle(design);
  if (cycle) {
    const labels = cycle.map((id) => byId.get(id)?.label ?? id).join(" \u2192 ");
    issues.push({
      severity: "error",
      code: "cycle",
      message: `request path loops: ${labels}. Loops require retry semantics, which arrive in Phase 3.`,
    });
  }

  // ---- time-varying arrival ----
  for (const n of design.nodes) {
    if (!n.client) continue;
    const arrival = n.client.arrival;
    if (!isTimeVarying(arrival)) continue;

    if (design.scenario.warmupSec > 0 && arrival.kind === "ramp") {
      issues.push({
        severity: "warning",
        code: "warmup-with-ramp",
        message:
          `client "${n.label}" ramps its load, so there is no steady state for the warm-up to ` +
          `reach. The discarded window just removes the start of the ramp; set warm-up to 0.`,
        nodeId: n.id,
      });
    }
    if (arrival.kind === "spike") {
      const endSec = arrival.atSec + arrival.durationSec;
      if (endSec >= design.scenario.durationSec) {
        issues.push({
          severity: "warning",
          code: "spike-truncated",
          message:
            `client "${n.label}" spikes until ${endSec}s but the run ends at ` +
            `${design.scenario.durationSec}s, so recovery after the spike is never observed. ` +
            `Recovery is usually the more interesting half.`,
          nodeId: n.id,
        });
      }
      if (arrival.atSec < design.scenario.warmupSec) {
        issues.push({
          severity: "warning",
          code: "spike-in-warmup",
          message: `the spike on "${n.label}" starts inside the discarded warm-up window.`,
          nodeId: n.id,
        });
      }
    }
    if (arrival.kind === "steps") {
      for (const step of arrival.steps) {
        if (step.atSec >= design.scenario.durationSec) {
          issues.push({
            severity: "warning",
            code: "step-after-end",
            message: `a load step on "${n.label}" is scheduled at ${step.atSec}s, after the run ends.`,
            nodeId: n.id,
          });
        }
      }
    }
  }

  if (design.scenario.warmupSec >= design.scenario.durationSec) {
    issues.push({
      severity: "error",
      code: "warmup-too-long",
      message: "warm-up consumes the entire run, leaving no measurement window",
    });
  }

  return issues;
}

export function isRunnable(design: Design): boolean {
  return !validateDesign(design).some((i) => i.severity === "error");
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

/**
 * Migration registry.
 *
 * Each entry upgrades a document from version N to N+1. The legacy app wrote
 * `sds.graph.v4` to localStorage with no version field and no migration path,
 * which meant any model change silently corrupted saved work. A public tool
 * cannot ship that.
 */
type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
  // 0 -> 1: the un-versioned legacy `{ nodes, edges }` shape.
  0: (doc) => ({
    version: 1,
    name: "imported design",
    nodes: (Array.isArray(doc.nodes) ? doc.nodes : []).map((raw, i) =>
      migrateLegacyNode(raw as Record<string, unknown>, i)
    ),
    edges: (Array.isArray(doc.edges) ? doc.edges : []).map((raw, i) =>
      migrateLegacyEdge(raw as Record<string, unknown>, i)
    ),
    scenario: {},
    slo: {},
  }),

  // 1 -> 2: request classes and per-kind components arrive. Phase 1 documents
  // only contained clients and servers, both of which carry over unchanged; the
  // new fields all have defaults.
  1: (doc) => ({ ...doc, version: 2, classes: [] }),

  // 2 -> 3: failure probabilities and per-edge call policies arrive. Every new
  // field defaults to "off", so a Phase 2 document keeps behaving identically --
  // which is the property that makes a schema bump safe.
  2: (doc) => ({ ...doc, version: 3 }),

  // 3 -> 4: time-varying arrival profiles and load-correlated failure. Existing
  // arrival processes are unchanged variants of the widened union, and the new
  // failure field defaults to null, so behaviour is again identical.
  3: (doc) => ({ ...doc, version: 4 }),
};

/**
 * Map the legacy taxonomy onto the Phase 2 component set.
 *
 * Phase 1 flattened every non-client node to a plain server because that was all
 * the engine had. With real components available, the legacy types now map to
 * their actual counterparts, so an imported design means what it looked like it
 * meant. Service times are starting points drawn from the benchmark library's
 * ranges, not measurements of the user's system, and the inspector says so.
 */
function migrateLegacyNode(raw: Record<string, unknown>, i: number): unknown {
  const type = typeof raw.type === "string" ? raw.type : "server";
  const id = typeof raw.id === "string" ? raw.id : `n${i}`;
  const label = typeof raw.label === "string" ? raw.label : type;
  const x = typeof raw.x === "number" ? raw.x : 0;
  const y = typeof raw.y === "number" ? raw.y : 0;
  const base = { id, label, x, y };
  const imported = { source: "imported from a legacy design; not measured" };

  switch (type) {
    case "client":
      return {
        ...base,
        kind: "client",
        client: { arrival: { kind: "poisson", ratePerSec: 50 } },
      };
    case "loadbalancer":
      return {
        ...base,
        kind: "loadbalancer",
        loadbalancer: {
          algorithm: "round-robin",
          serviceTime: { kind: "deterministic", value: 0.5 },
          concurrency: 1024,
          citation: imported,
        },
      };
    case "cache":
    case "cdn":
      return {
        ...base,
        kind: "cache",
        cache: {
          capacity: 10_000,
          keyspace: { kind: "zipf", keys: 100_000, skew: 0.9 },
          serviceTime: { kind: "exponential", mean: type === "cdn" ? 6 : 0.3 },
          concurrency: 512,
          ttlMs: null,
          citation: imported,
        },
      };
    case "database":
      return {
        ...base,
        kind: "database",
        database: {
          poolSize: 20,
          parallelism: 8,
          serviceTime: { kind: "lognormal", mean: 5, p99: 40 },
          citation: imported,
        },
      };
    case "queue":
      return {
        ...base,
        kind: "queue",
        queue: {
          maxDepth: null,
          consumers: 4,
          consumerServiceTime: { kind: "exponential", mean: 50 },
          publishTime: { kind: "deterministic", value: 1 },
          citation: imported,
        },
      };
    case "store":
      // An object store is a high-latency, very high-concurrency service.
      return {
        ...base,
        kind: "server",
        server: {
          concurrency: 256,
          serviceTime: { kind: "lognormal", mean: 24, p99: 180 },
          citation: imported,
        },
      };
    default:
      return {
        ...base,
        kind: "server",
        server: {
          concurrency: 8,
          serviceTime: { kind: "lognormal", mean: 20, p99: 120 },
          citation: imported,
        },
      };
  }
}

function migrateLegacyEdge(raw: Record<string, unknown>, i: number): unknown {
  return {
    id: typeof raw.id === "string" ? raw.id : `e${i}`,
    from: raw.from,
    to: raw.to,
    latency: { kind: "deterministic", value: 1 },
    lossProbability: 0,
  };
}

/**
 * Parse an arbitrary saved document into the current schema, migrating as needed.
 * Throws (via Zod) if the result is still not a valid design.
 */
export function migrateAndParse(input: unknown): Design {
  if (typeof input !== "object" || input === null) {
    throw new Error("design document must be an object");
  }
  let doc = input as Record<string, unknown>;
  let version = typeof doc.version === "number" ? doc.version : 0;

  while (version < DESIGN_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) {
      throw new Error(`no migration from schema version ${version}`);
    }
    doc = migrate(doc);
    version = typeof doc.version === "number" ? doc.version : version + 1;
  }

  if (version > DESIGN_SCHEMA_VERSION) {
    throw new Error(
      `document is schema version ${version}; this build understands ${DESIGN_SCHEMA_VERSION}`
    );
  }

  return DesignSchema.parse(doc);
}
