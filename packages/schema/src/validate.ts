import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  type Design,
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

function requiredConfigMissing(n: SdsNode): boolean {
  if (n.kind === "client") return !n.client;
  if (n.kind === "server") return !n.server;
  return false;
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
    if (requiredConfigMissing(n)) {
      issues.push({
        severity: "error",
        code: "missing-config",
        message: `${n.kind} "${n.label}" has no ${n.kind} configuration`,
        nodeId: n.id,
      });
    }
  }

  const seenEdge = new Set<string>();
  for (const e of design.edges) {
    if (!byId.has(e.from)) {
      issues.push({
        severity: "error",
        code: "dangling-edge",
        message: "edge starts at a node that does not exist",
        edgeId: e.id,
      });
    }
    if (!byId.has(e.to)) {
      issues.push({
        severity: "error",
        code: "dangling-edge",
        message: "edge ends at a node that does not exist",
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
  }

  const outDegree = new Map<string, number>();
  for (const e of design.edges) {
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
  }

  const clients = design.nodes.filter((n) => n.kind === "client");
  if (clients.length === 0) {
    issues.push({
      severity: "warning",
      code: "no-client",
      message: "no client node, so no work will be generated",
    });
  }
  for (const c of clients) {
    if (!outDegree.get(c.id)) {
      issues.push({
        severity: "warning",
        code: "client-unwired",
        message: `client "${c.label}" is not connected to anything`,
        nodeId: c.id,
      });
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
};

/**
 * The legacy taxonomy had 7 node types; Phase 1 models 2. Anything that is not
 * a client becomes a server, which is honest: a "database" with no pool model
 * is just a service station with a different service time.
 */
function migrateLegacyNode(raw: Record<string, unknown>, i: number): unknown {
  const type = typeof raw.type === "string" ? raw.type : "server";
  const id = typeof raw.id === "string" ? raw.id : `n${i}`;
  const label = typeof raw.label === "string" ? raw.label : type;
  const x = typeof raw.x === "number" ? raw.x : 0;
  const y = typeof raw.y === "number" ? raw.y : 0;

  if (type === "client") {
    return {
      id,
      kind: "client",
      label,
      x,
      y,
      client: { arrival: { kind: "poisson", ratePerSec: 10 } },
    };
  }
  // Legacy per-type processing means, carried over ONLY as a starting point.
  // These were invented constants in the old engine; they are marked for
  // replacement by the cited benchmark library in Phase 2.
  const legacyMeanMs: Record<string, number> = {
    loadbalancer: 4,
    server: 34,
    database: 22,
    cache: 6,
    store: 24,
    queue: 8,
    cdn: 6,
  };
  return {
    id,
    kind: "server",
    label,
    x,
    y,
    server: {
      concurrency: 8,
      serviceTime: {
        kind: "exponential",
        mean: legacyMeanMs[type] ?? 20,
      },
    },
  };
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
