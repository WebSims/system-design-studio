import {
  DESIGN_SCHEMA_VERSION,
  DesignSchema,
  MAX_EFFECTIVE_CONCURRENCY,
  classesOf,
  distributionHasPositiveMean,
  isTimeVarying,
  nodeTimingInputs,
  type Design,
  type NodeKind,
  type SdsNode,
} from "./design";
import {
  MAX_NESTING_DEPTH,
  MAX_TABLE_ROWS,
  collectionById,
  exprDepth,
  walkExpr,
  walkOperations,
  type Collection,
  type Expr,
  type Operation,
  type Workflow,
} from "./domain";
import {
  STUDY_SCHEMA_VERSION,
  StudySchema,
  candidateById,
  type Study,
} from "./study";

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
  /** Set when the issue concerns the workflow rather than the topology. */
  handlerId?: string;
  opId?: string;
}

/** Which config object each kind requires. */
const CONFIG_KEY: Record<NodeKind, keyof SdsNode> = {
  client: "client",
  server: "server",
  loadbalancer: "loadbalancer",
  cache: "cache",
  database: "database",
  queue: "queue",
  gateway: "gateway",
  lock: "lock",
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
      continue;
    }

    for (const timing of nodeTimingInputs(n)) {
      if (distributionHasPositiveMean(timing.distribution)) continue;
      issues.push({
        severity: "warning",
        code: "zero-node-service-time",
        message:
          `component "${n.label}" has no usable positive mean for ${timing.field}. ` +
          "Treat 0ms as an unknown schema placeholder, not free work; replace it with measured data or an explicitly assumed non-zero benchmark before load testing.",
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

    const zeroLatency =
      (e.latency.kind === "deterministic" && e.latency.value === 0) ||
      (e.latency.kind === "uniform" && e.latency.min === 0 && e.latency.max === 0);
    if (zeroLatency) {
      issues.push({
        severity: "warning",
        code: "zero-edge-latency",
        message:
          "this connection uses 0ms latency. Treat zero as an uncalibrated schema placeholder, not a physical measurement; " +
          "replace it with a measured value or an explicitly assumed non-zero benchmark before load testing.",
        edgeId: e.id,
      });
    }

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

  // Every active station needs a causal path from a work source. An orphan service may look
  // connected to its own dependencies while still receiving exactly zero simulated load.
  const clientIds = design.nodes.filter((node) => node.kind === "client").map((node) => node.id);
  if (clientIds.length > 0) {
    const adjacency = new Map<string, string[]>();
    for (const edge of design.edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to) || edge.probability <= 0) continue;
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    }
    const reachable = new Set(clientIds);
    const pending = [...clientIds];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const next of adjacency.get(current) ?? []) {
        if (reachable.has(next)) continue;
        reachable.add(next);
        pending.push(next);
      }
    }
    for (const node of design.nodes) {
      if (node.kind === "client" || reachable.has(node.id)) continue;
      issues.push({
        severity: "warning",
        code: "unreachable-from-client",
        message:
          `component "${node.label}" is not reachable from any client/work source, so it receives no simulated load. ` +
          "Connect its real external entrypoint, timer, poller or consumer source, or remove it from the active topology.",
        nodeId: node.id,
      });
    }
  }

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

      case "lock":
        // A lock service is a leaf by construction: it answers "may I", it does not
        // go and ask anybody else. An outgoing edge means the drawing says something
        // the model cannot represent.
        if (out > 0) {
          issues.push({
            severity: "error",
            code: "lock-outbound",
            message: `lock service "${n.label}" cannot call downstream services`,
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

  // ---- connections and gateways ----
  for (const n of design.nodes) {
    const pop = n.client?.connections;
    if (!pop) continue;

    const targets = design.edges
      .filter((e) => e.from === n.id)
      .map((e) => byId.get(e.to))
      .filter((t): t is SdsNode => Boolean(t));

    // A connection has to be held by something that can hold it.
    const reachesGateway = targets.some(
      (t) => t.kind === "gateway" || t.kind === "loadbalancer"
    );
    if (!reachesGateway) {
      issues.push({
        severity: "error",
        code: "connections-without-gateway",
        message:
          `client "${n.label}" holds ${pop.count.toLocaleString()} connections but is not wired to a ` +
          `gateway (directly or through a load balancer). Only a gateway can hold a connection.`,
        nodeId: n.id,
      });
    }

    if (pop.disruption) {
      if (pop.disruption.atSec >= design.scenario.durationSec) {
        issues.push({
          severity: "warning",
          code: "disruption-after-end",
          message: `the disruption on "${n.label}" is scheduled after the run ends, so it never happens.`,
          nodeId: n.id,
        });
      } else if (pop.disruption.atSec < pop.establishOverSec) {
        issues.push({
          severity: "warning",
          code: "disruption-during-establish",
          message:
            `the disruption on "${n.label}" fires while the initial connections are still being ` +
            `established, so the two bursts overlap and the result measures neither cleanly.`,
          nodeId: n.id,
        });
      }
    }
  }

  // Total connection demand against total gateway capacity, which is the whole
  // question behind "N concurrent users".
  const totalConnections = design.nodes.reduce(
    (sum, n) => sum + (n.client?.connections?.count ?? 0),
    0
  );
  if (totalConnections > 0) {
    const capacity = design.nodes.reduce(
      (sum, n) => sum + (n.gateway ? n.gateway.connectionCapacity * n.gateway.replicas : 0),
      0
    );
    if (capacity > 0 && totalConnections > capacity) {
      issues.push({
        severity: "warning",
        code: "connection-capacity-exceeded",
        message:
          `${totalConnections.toLocaleString()} connections are offered against ` +
          `${capacity.toLocaleString()} of gateway capacity. The excess will be refused, which is a ` +
          `hard failure rather than a slow response.`,
      });
    }
  }

  for (const e of design.edges) {
    if (e.fanoutFactor > 1) {
      const to = byId.get(e.to);
      if (to?.kind === "database") {
        issues.push({
          severity: "warning",
          code: "fanout-into-database",
          message:
            `this connection fans one call into ${e.fanoutFactor} calls against a database. ` +
            `Fan-out multiplies load by that factor, and a database is rarely the right place to ` +
            `absorb it.`,
          edgeId: e.id,
        });
      }
    }
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

  /**
   * Effective concurrency has to be checked here rather than in the schema, because it
   * is a product of two independently-bounded fields and the closed-form solvers are
   * linear in it. Bounding `concurrency` and `replicas` separately still permits
   * `1e6 * 1e4`, which would hang the live preview on the main thread with no recovery.
   */
  for (const n of design.nodes) {
    const effective =
      n.kind === "server" && n.server
        ? n.server.concurrency * n.server.replicas
        : n.kind === "gateway" && n.gateway
          ? n.gateway.pushConcurrency * n.gateway.replicas
          : null;
    if (effective !== null && effective > MAX_EFFECTIVE_CONCURRENCY) {
      issues.push({
        severity: "error",
        code: "concurrency-intractable",
        message:
          `"${n.label}" has an effective concurrency of ${effective.toLocaleString()} ` +
          `(concurrency x replicas), beyond the ${MAX_EFFECTIVE_CONCURRENCY.toLocaleString()} ` +
          `the closed-form solver evaluates exactly. Reduce either factor.`,
        nodeId: n.id,
      });
    }
  }

  return issues;
}

export function isRunnable(design: Design): boolean {
  return !validateDesign(design).some((i) => i.severity === "error");
}

// ---------------------------------------------------------------------------
// workflow validation
// ---------------------------------------------------------------------------

/**
 * Kinds of node that can serve each operation role.
 *
 * A workflow may only claim a capability the topology actually contains. Without this
 * check a candidate could declare a serializable transaction against a cache, and the
 * explorer would faithfully report it safe -- a false negative produced by the
 * modelling layer rather than by the search, which is the worst kind because no bound
 * disclosure warns you about it.
 */
const ROLE_KINDS: Record<"datastore" | "lock" | "queue", NodeKind[]> = {
  datastore: ["database"],
  lock: ["lock"],
  queue: ["queue"],
};

/**
 * Type of an expression, as far as static checking can tell.
 *
 * `unknown` is a real answer, not a failure: a row field's type depends on which
 * collection was addressed, and when the collection reference is itself dynamic there
 * is nothing honest to report. Unknown propagates and suppresses downstream type
 * errors rather than guessing.
 */
type StaticType = "int" | "bool" | "string" | "unknown";

function fieldStaticType(t: string): StaticType {
  switch (t) {
    case "int":
    case "timestamp":
      return "int";
    case "bool":
      return "bool";
    case "string":
    case "enum":
      return "string";
    default:
      return "unknown";
  }
}

interface WorkflowScope {
  wf: Workflow;
  /** Locals bound so far, with their inferred types. */
  locals: Map<string, StaticType>;
  /** Fields of the row bound by an enclosing `where`, if any. */
  rowFields: Map<string, StaticType> | null;
  requestFields: Map<string, StaticType>;
}

function typeOfExpr(expr: Expr, scope: WorkflowScope, issues: DesignIssue[], where: DesignIssue): StaticType {
  const bad = (message: string): StaticType => {
    issues.push({ ...where, severity: "error", code: "expr-invalid", message });
    return "unknown";
  };

  switch (expr.kind) {
    case "lit":
      if (expr.value === null) return "unknown";
      return typeof expr.value === "number"
        ? "int"
        : typeof expr.value === "boolean"
          ? "bool"
          : "string";

    case "counter": {
      const c = collectionById(scope.wf, expr.collection);
      if (!c) return bad(`expression reads unknown collection "${expr.collection}"`);
      if (c.kind !== "counter") return bad(`"${expr.collection}" is a table, not a counter`);
      return "int";
    }

    case "request": {
      const t = scope.requestFields.get(expr.field);
      if (!t) return bad(`expression reads unknown request field "${expr.field}"`);
      return t;
    }

    case "local": {
      const t = scope.locals.get(expr.name);
      // Not an error: locals bound in a sibling branch are legitimately absent here,
      // and the kernel resolves an unbound local to the absent value rather than
      // throwing. Reported as a warning so a genuine typo is still visible.
      if (!t) {
        issues.push({
          ...where,
          severity: "warning",
          code: "local-unbound",
          message: `local "${expr.name}" is read before anything on this path binds it; it will read as absent`,
        });
        return "unknown";
      }
      return t;
    }

    case "row": {
      const c = collectionById(scope.wf, expr.collection);
      if (!c) return bad(`expression reads unknown collection "${expr.collection}"`);
      if (c.kind !== "table") return bad(`"${expr.collection}" is a counter and has no rows`);
      typeOfExpr(expr.key, scope, issues, where);
      const f = c.fields.find((x) => x.name === expr.field);
      if (!f) return bad(`table "${expr.collection}" has no field "${expr.field}"`);
      return fieldStaticType(f.type);
    }

    case "exists": {
      const c = collectionById(scope.wf, expr.collection);
      if (!c) return bad(`expression reads unknown collection "${expr.collection}"`);
      if (c.kind !== "table") return bad(`"${expr.collection}" is a counter and has no rows`);
      typeOfExpr(expr.key, scope, issues, where);
      return "bool";
    }

    case "count":
    case "distinct":
    case "sum": {
      const c = collectionById(scope.wf, expr.collection);
      if (!c) return bad(`aggregate reads unknown collection "${expr.collection}"`);
      if (c.kind !== "table") return bad(`aggregate over "${expr.collection}", which is a counter`);
      if (expr.kind !== "count") {
        const f = c.fields.find((x) => x.name === expr.field);
        if (!f) return bad(`table "${expr.collection}" has no field "${expr.field}"`);
        if (expr.kind === "sum" && fieldStaticType(f.type) !== "int") {
          return bad(`sum over non-numeric field "${expr.field}"`);
        }
      }
      if (expr.where) {
        const inner: WorkflowScope = {
          ...scope,
          rowFields: new Map(c.fields.map((f) => [f.name, fieldStaticType(f.type)])),
        };
        const t = typeOfExpr(expr.where, inner, issues, where);
        if (t !== "bool" && t !== "unknown") {
          bad(`aggregate filter on "${expr.collection}" is not a boolean`);
        }
      }
      return "int";
    }

    case "field": {
      if (!scope.rowFields) {
        return bad(`"${expr.name}" refers to a row field outside an aggregate filter`);
      }
      const t = scope.rowFields.get(expr.name);
      if (!t) return bad(`filtered rows have no field "${expr.name}"`);
      return t;
    }

    case "arith": {
      const l = typeOfExpr(expr.left, scope, issues, where);
      const r = typeOfExpr(expr.right, scope, issues, where);
      if ((l !== "int" && l !== "unknown") || (r !== "int" && r !== "unknown")) {
        return bad(`arithmetic "${expr.op}" applied to a non-numeric value`);
      }
      return "int";
    }

    case "compare": {
      const l = typeOfExpr(expr.left, scope, issues, where);
      const r = typeOfExpr(expr.right, scope, issues, where);
      if (l !== "unknown" && r !== "unknown" && l !== r) {
        // Not fatal -- the kernel's comparison is total and returns false across
        // types -- but almost always a mistake worth surfacing.
        issues.push({
          ...where,
          severity: "warning",
          code: "compare-mixed-types",
          message: `comparing ${l} with ${r}; this can never be equal`,
        });
      }
      if (expr.op !== "==" && expr.op !== "!=") {
        if ((l !== "int" && l !== "unknown") || (r !== "int" && r !== "unknown")) {
          return bad(`ordering comparison "${expr.op}" applied to a non-numeric value`);
        }
      }
      return "bool";
    }

    case "and":
    case "or": {
      for (const a of expr.args) {
        const t = typeOfExpr(a, scope, issues, where);
        if (t !== "bool" && t !== "unknown") bad(`"${expr.kind}" applied to a non-boolean`);
      }
      return "bool";
    }

    case "not": {
      const t = typeOfExpr(expr.arg, scope, issues, where);
      if (t !== "bool" && t !== "unknown") bad("`not` applied to a non-boolean");
      return "bool";
    }

    case "isNull":
      typeOfExpr(expr.arg, scope, issues, where);
      return "bool";

    case "now":
      return "int";
  }
}

/**
 * Validate a workflow against the topology it is attached to.
 *
 * The three classes of problem this catches, in descending order of how badly they
 * would corrupt a result:
 *
 *  1. A capability claimed that the topology does not have (a transaction against a
 *     cache). This produces a false SAFE verdict, with no bound disclosure to warn a
 *     reader -- the only genuinely dangerous failure in the tool.
 *  2. A reference that does not resolve (unknown collection, handler, field). This
 *     produces INVALID_MODEL, which is honest but useless.
 *  3. A shape the explorer cannot bound (nested atomic, unbounded expiry chains).
 */
export function validateWorkflow(design: Design): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const wf = design.workflow;
  if (!wf) return issues;

  const byId = new Map(design.nodes.map((n) => [n.id, n]));

  // ---- collections ----
  const seenCollection = new Set<string>();
  for (const c of wf.collections) {
    if (seenCollection.has(c.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-collection",
        message: `two state collections share the id "${c.id}"`,
      });
    }
    seenCollection.add(c.id);

    const node = byId.get(c.node);
    if (!node) {
      issues.push({
        severity: "error",
        code: "collection-node-missing",
        message: `collection "${c.id}" is stored on node "${c.node}", which does not exist`,
        nodeId: c.node,
      });
    } else if (!ROLE_KINDS.datastore.includes(node.kind)) {
      issues.push({
        severity: "error",
        code: "collection-node-kind",
        message: `collection "${c.id}" is stored on "${node.label}", which is a ${node.kind}; state must live on a database`,
        nodeId: c.node,
      });
    }

    if (c.kind === "table") {
      if (!c.fields.some((f) => f.name === c.key)) {
        issues.push({
          severity: "error",
          code: "table-key-missing",
          message: `table "${c.id}" declares key "${c.key}", which is not one of its fields`,
        });
      }
      const seenField = new Set<string>();
      for (const f of c.fields) {
        if (seenField.has(f.name)) {
          issues.push({
            severity: "error",
            code: "duplicate-field",
            message: `table "${c.id}" declares "${f.name}" twice`,
          });
        }
        seenField.add(f.name);
        if (f.type === "enum" && f.values.length === 0) {
          issues.push({
            severity: "error",
            code: "enum-no-values",
            message: `enum field "${c.id}.${f.name}" lists no permitted values`,
          });
        }
      }
      if (c.seed.length > MAX_TABLE_ROWS) {
        issues.push({
          severity: "error",
          code: "seed-too-large",
          message: `table "${c.id}" seeds more rows than the ${MAX_TABLE_ROWS}-row limit`,
        });
      }
    }
  }

  // ---- request fields ----
  const requestFields = new Map<string, StaticType>();
  for (const f of wf.requestFields) {
    if (requestFields.has(f.name)) {
      issues.push({
        severity: "error",
        code: "duplicate-request-field",
        message: `two request fields are both named "${f.name}"`,
      });
    }
    requestFields.set(f.name, fieldStaticType(f.type));
  }
  for (const f of wf.requestFields) {
    const s = f.strategy;
    const derived = s.kind === "idempotencyKey" ? s.of : [];
    for (const dep of derived) {
      if (!requestFields.has(dep)) {
        issues.push({
          severity: "error",
          code: "idempotency-key-source",
          message: `request field "${f.name}" derives from "${dep}", which is not a request field`,
        });
      } else if (dep === f.name) {
        issues.push({
          severity: "error",
          code: "idempotency-key-self",
          message: `request field "${f.name}" derives from itself`,
        });
      }
    }
  }

  // ---- handlers ----
  const seenHandler = new Set<string>();
  const roots = wf.handlers.filter((h) => h.trigger.kind === "request");
  if (roots.length === 0) {
    issues.push({
      severity: "error",
      code: "no-root-handler",
      message: "the workflow has no request-triggered handler, so nothing runs when a request arrives",
    });
  } else if (roots.length > 1) {
    issues.push({
      severity: "error",
      code: "multiple-root-handlers",
      message: `${roots.length} handlers are request-triggered; exactly one is the entry point`,
    });
  }

  for (const h of wf.handlers) {
    if (seenHandler.has(h.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-handler",
        message: `two handlers share the id "${h.id}"`,
        handlerId: h.id,
      });
    }
    seenHandler.add(h.id);

    const node = byId.get(h.node);
    if (!node) {
      issues.push({
        severity: "error",
        code: "handler-node-missing",
        message: `handler "${h.id}" runs on node "${h.node}", which does not exist`,
        handlerId: h.id,
      });
    } else if (node.kind === "client") {
      issues.push({
        severity: "error",
        code: "handler-on-client",
        message: `handler "${h.id}" runs on a client; clients originate work, they do not execute it`,
        handlerId: h.id,
      });
    }

    if (h.trigger.kind === "queue") {
      const q = byId.get(h.trigger.queue);
      if (!q) {
        issues.push({
          severity: "error",
          code: "handler-queue-missing",
          message: `handler "${h.id}" consumes queue "${h.trigger.queue}", which does not exist`,
          handlerId: h.id,
        });
      } else if (q.kind !== "queue") {
        issues.push({
          severity: "error",
          code: "handler-queue-kind",
          message: `handler "${h.id}" consumes "${q.label}", which is a ${q.kind}, not a queue`,
          handlerId: h.id,
        });
      }
    }

    validateHandlerSteps(design, wf, h.id, h.steps, requestFields, issues);
  }

  // A queue that nothing consumes is a leak, and it is silent: publishes succeed,
  // latency looks great, and the work never happens.
  const consumed = new Set(
    wf.handlers.flatMap((h) => (h.trigger.kind === "queue" ? [h.trigger.queue] : []))
  );
  for (const op of allWorkflowOps(wf)) {
    if (op.op === "publish" && !consumed.has(op.queue)) {
      issues.push({
        severity: "warning",
        code: "queue-unconsumed",
        message: `messages are published to "${op.queue}" but no handler consumes it`,
        opId: op.id,
      });
    }
  }

  return issues;
}

function allWorkflowOps(wf: Workflow): Operation[] {
  const out: Operation[] = [];
  for (const h of wf.handlers) walkOperations(h.steps, (op) => out.push(op));
  return out;
}

function validateHandlerSteps(
  design: Design,
  wf: Workflow,
  handlerId: string,
  steps: readonly Operation[],
  requestFields: Map<string, StaticType>,
  issues: DesignIssue[]
): void {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const handler = wf.handlers.find((h) => h.id === handlerId)!;
  const locals = new Map<string, StaticType>();
  const seenOpIds = new Set<string>();
  let insideAtomic = false;

  const checkNode = (
    nodeId: string,
    role: "datastore" | "lock" | "queue",
    op: Operation
  ): void => {
    const node = byId.get(nodeId);
    if (!node) {
      issues.push({
        severity: "error",
        code: "op-node-missing",
        message: `operation "${op.id}" targets node "${nodeId}", which does not exist`,
        handlerId,
        opId: op.id,
      });
      return;
    }
    if (!ROLE_KINDS[role].includes(node.kind)) {
      issues.push({
        severity: "error",
        code: "op-node-kind",
        message: `operation "${op.id}" needs a ${role} but "${node.label}" is a ${node.kind}`,
        handlerId,
        opId: op.id,
        nodeId,
      });
    }
  };

  const requireCollection = (
    id: string,
    kind: Collection["kind"] | null,
    op: Operation
  ): Collection | null => {
    const c = collectionById(wf, id);
    if (!c) {
      issues.push({
        severity: "error",
        code: "op-collection-missing",
        message: `operation "${op.id}" writes collection "${id}", which is not declared`,
        handlerId,
        opId: op.id,
      });
      return null;
    }
    if (kind && c.kind !== kind) {
      issues.push({
        severity: "error",
        code: "op-collection-kind",
        message: `operation "${op.id}" treats "${id}" as a ${kind}, but it is a ${c.kind}`,
        handlerId,
        opId: op.id,
      });
      return null;
    }
    checkNode(c.node, "datastore", op);
    return c;
  };

  const scope = (): WorkflowScope => ({ wf, locals, rowFields: null, requestFields });

  const checkExpr = (expr: Expr, op: Operation, expected: StaticType | null): void => {
    const where: DesignIssue = {
      severity: "error",
      code: "expr-invalid",
      message: "",
      handlerId,
      opId: op.id,
    };
    if (exprDepth(expr) > MAX_NESTING_DEPTH) {
      issues.push({
        ...where,
        code: "expr-too-deep",
        message: `operation "${op.id}" has an expression nested deeper than ${MAX_NESTING_DEPTH}`,
      });
      return;
    }
    const t = typeOfExpr(expr, scope(), issues, where);
    if (expected && t !== "unknown" && t !== expected) {
      issues.push({
        ...where,
        code: "expr-type",
        message: `operation "${op.id}" expects a ${expected} here but the expression is a ${t}`,
      });
    }
  };

  const checkTableFields = (c: Collection, fields: Record<string, Expr>, op: Operation): void => {
    if (c.kind !== "table") return;
    for (const [name, expr] of Object.entries(fields)) {
      const f = c.fields.find((x) => x.name === name);
      if (!f) {
        issues.push({
          severity: "error",
          code: "op-field-missing",
          message: `operation "${op.id}" writes "${name}", which table "${c.id}" does not declare`,
          handlerId,
          opId: op.id,
        });
        continue;
      }
      checkExpr(expr, op, fieldStaticType(f.type));
    }
  };

  const visit = (list: readonly Operation[], depth: number): void => {
    if (depth > MAX_NESTING_DEPTH) {
      issues.push({
        severity: "error",
        code: "handler-too-deep",
        message: `handler "${handlerId}" nests operations deeper than ${MAX_NESTING_DEPTH}`,
        handlerId,
      });
      return;
    }

    for (const op of list) {
      if (seenOpIds.has(op.id)) {
        issues.push({
          severity: "error",
          code: "duplicate-op-id",
          message: `handler "${handlerId}" uses the operation id "${op.id}" twice; counterexample traces address operations by id`,
          handlerId,
          opId: op.id,
        });
      }
      seenOpIds.add(op.id);

      switch (op.op) {
        case "read":
          checkExpr(op.value, op, null);
          locals.set(op.into, typeOfExpr(op.value, scope(), [], {
            severity: "error",
            code: "expr-invalid",
            message: "",
          }));
          break;

        case "write": {
          const c = requireCollection(op.collection, null, op);
          if (!c) break;
          if (c.kind === "counter") {
            if (op.key) {
              issues.push({
                severity: "error",
                code: "counter-keyed",
                message: `operation "${op.id}" supplies a row key for counter "${c.id}"`,
                handlerId,
                opId: op.id,
              });
            }
            if (!op.value) {
              issues.push({
                severity: "error",
                code: "counter-no-value",
                message: `operation "${op.id}" writes counter "${c.id}" with no value`,
                handlerId,
                opId: op.id,
              });
            } else checkExpr(op.value, op, "int");
          } else {
            if (!op.key) {
              issues.push({
                severity: "error",
                code: "table-no-key",
                message: `operation "${op.id}" writes table "${c.id}" with no row key`,
                handlerId,
                opId: op.id,
              });
            } else checkExpr(op.key, op, null);
            checkTableFields(c, op.fields, op);
          }
          break;
        }

        case "conditionalWrite": {
          const c = requireCollection(op.collection, null, op);
          checkExpr(op.guard, op, "bool");
          if (!c) break;
          if (c.kind === "counter") {
            if (op.value) checkExpr(op.value, op, "int");
          } else {
            if (op.key) checkExpr(op.key, op, null);
            checkTableFields(c, op.fields, op);
          }
          if (op.into) locals.set(op.into, "bool");
          break;
        }

        case "insertUnique": {
          const c = requireCollection(op.collection, "table", op);
          checkExpr(op.key, op, null);
          if (c) checkTableFields(c, op.fields, op);
          if (op.into) locals.set(op.into, "bool");
          break;
        }

        case "atomic":
          if (insideAtomic) {
            // Flattening would be the convenient choice and the wrong one: a reader
            // would be unable to tell whether the inner block was meant to be a
            // separate transaction, and the two readings have different safety.
            issues.push({
              severity: "error",
              code: "nested-atomic",
              message: `operation "${op.id}" opens a transaction inside a transaction; state one boundary explicitly`,
              handlerId,
              opId: op.id,
            });
            break;
          }
          insideAtomic = true;
          visit(op.body, depth + 1);
          insideAtomic = false;
          break;

        case "acquireLease":
          checkNode(op.lock, "lock", op);
          checkExpr(op.key, op, null);
          locals.set(op.into, op.fencing ? "int" : "bool");
          if (op.fencing) {
            const node = byId.get(op.lock);
            if (node?.lock && !node.lock.fencingTokens) {
              issues.push({
                severity: "error",
                code: "fencing-unsupported",
                message: `operation "${op.id}" asks for a fencing token but lock service "${node.label}" does not issue them`,
                handlerId,
                opId: op.id,
                nodeId: op.lock,
              });
            }
          }
          break;

        case "releaseLease":
          checkNode(op.lock, "lock", op);
          checkExpr(op.key, op, null);
          break;

        case "publish": {
          checkNode(op.queue, "queue", op);
          for (const expr of Object.values(op.message)) checkExpr(expr, op, null);
          break;
        }

        case "ack":
          if (handler.trigger.kind !== "queue") {
            issues.push({
              severity: "error",
              code: "ack-outside-consumer",
              message: `operation "${op.id}" acknowledges a message, but handler "${handlerId}" is not queue-triggered`,
              handlerId,
              opId: op.id,
            });
          }
          break;

        case "branch": {
          checkExpr(op.cond, op, "bool");
          // Both arms are validated against the same incoming locals, and both
          // arms' bindings are merged afterwards. That is deliberately permissive:
          // reading a local bound only on the other arm is a warning, not an error,
          // because the kernel resolves it to absent rather than misbehaving.
          const before = new Map(locals);
          visit(op.then, depth + 1);
          const afterThen = new Map(locals);
          for (const [k, v] of before) locals.set(k, v);
          for (const k of [...locals.keys()]) if (!before.has(k)) locals.delete(k);
          visit(op.else, depth + 1);
          for (const [k, v] of afterThen) if (!locals.has(k)) locals.set(k, v);
          break;
        }

        case "assign":
          checkExpr(op.value, op, null);
          locals.set(
            op.name,
            typeOfExpr(op.value, scope(), [], {
              severity: "error",
              code: "expr-invalid",
              message: "",
            })
          );
          break;

        case "scheduleExpiry": {
          const target = wf.handlers.find((h) => h.id === op.handler);
          if (!target) {
            issues.push({
              severity: "error",
              code: "expiry-handler-missing",
              message: `operation "${op.id}" schedules handler "${op.handler}", which does not exist`,
              handlerId,
              opId: op.id,
            });
          } else if (target.trigger.kind !== "expiry") {
            issues.push({
              severity: "error",
              code: "expiry-handler-kind",
              message: `operation "${op.id}" schedules "${op.handler}", which is ${target.trigger.kind}-triggered`,
              handlerId,
              opId: op.id,
            });
          } else if (target.id === handlerId) {
            // A timer that re-arms itself has no bounded state space, so the only
            // possible verdict would be "inconclusive" forever. Refused up front.
            issues.push({
              severity: "error",
              code: "expiry-self-schedule",
              message: `handler "${handlerId}" schedules itself, which cannot be bounded`,
              handlerId,
              opId: op.id,
            });
          }
          for (const expr of Object.values(op.args)) checkExpr(expr, op, null);
          break;
        }

        case "respond":
          if (insideAtomic) {
            issues.push({
              severity: "error",
              code: "respond-inside-atomic",
              message: `operation "${op.id}" responds from inside a transaction; a response is not part of a commit`,
              handlerId,
              opId: op.id,
            });
          }
          break;
      }
    }
  };

  visit(steps, 0);

  // An expiry handler that reads `local` values from the request that armed it is a
  // common and wrong mental model: the arming request is gone. Args are the only
  // channel, and the schema makes that explicit, so this only needs to be stated.
  if (handler.trigger.kind !== "request" && handler.steps.length === 0) {
    issues.push({
      severity: "warning",
      code: "handler-empty",
      message: `handler "${handler.id}" has no steps, so its trigger does nothing`,
      handlerId: handler.id,
    });
  }
}

// ---------------------------------------------------------------------------
// study validation
// ---------------------------------------------------------------------------

export interface StudyIssue extends DesignIssue {
  candidateId?: string;
  invariantId?: string;
}

/**
 * Validate a study: internal references, and every candidate as a design.
 *
 * Note what is checked and what is not. Every candidate is validated as a design and
 * as a workflow, and every invariant is type-checked against every candidate that has
 * a workflow -- because an invariant that references a collection candidate 3 does not
 * declare cannot be evaluated on candidate 3, and silently skipping it would let
 * candidate 3 pass a gate it was never actually tested against. That specific hole is
 * how a portfolio comparison becomes fiction.
 */
export function validateStudy(study: Study): StudyIssue[] {
  const issues: StudyIssue[] = [];

  const seen = new Set<string>();
  for (const c of study.candidates) {
    if (seen.has(c.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-candidate-id",
        message: `two candidates share the id "${c.id}"`,
        candidateId: c.id,
      });
    }
    seen.add(c.id);

    if (c.basedOnCandidateId === c.id) {
      issues.push({
        severity: "error",
        code: "candidate-self-parent",
        message: `candidate "${c.label}" cannot be based on itself`,
        candidateId: c.id,
      });
    } else if (c.basedOnCandidateId && !candidateById(study, c.basedOnCandidateId)) {
      issues.push({
        severity: "error",
        code: "candidate-parent-missing",
        message: `candidate "${c.label}" is based on missing candidate "${c.basedOnCandidateId}"`,
        candidateId: c.id,
      });
    }

    const nodeIds = new Set(c.design.nodes.map((node) => node.id));
    const edgeIds = new Set(c.design.edges.map((edge) => edge.id));
    const evidenceIds = new Set<string>();
    for (const evidence of c.evidence) {
      if (evidenceIds.has(evidence.id)) {
        issues.push({
          severity: "error",
          code: "duplicate-evidence-id",
          message: `candidate "${c.label}" has two evidence records named "${evidence.id}"`,
          candidateId: c.id,
        });
      }
      evidenceIds.add(evidence.id);
      const targetExists =
        evidence.targetKind === "node"
          ? nodeIds.has(evidence.targetId)
          : edgeIds.has(evidence.targetId);
      if (!targetExists) {
        issues.push({
          severity: "error",
          code: "evidence-target-missing",
          message: `evidence "${evidence.id}" cites missing ${evidence.targetKind} "${evidence.targetId}"`,
          candidateId: c.id,
        });
      }
    }

    for (const issue of validateDesign(c.design)) {
      issues.push({ ...issue, candidateId: c.id });
    }
    for (const issue of validateWorkflow(c.design)) {
      issues.push({ ...issue, candidateId: c.id });
    }
  }

  if (study.activeCandidateId && !candidateById(study, study.activeCandidateId)) {
    issues.push({
      severity: "error",
      code: "active-candidate-missing",
      message: `the active candidate "${study.activeCandidateId}" is not in this project`,
    });
  }
  if (study.promotedCandidateId && !candidateById(study, study.promotedCandidateId)) {
    issues.push({
      severity: "error",
      code: "promoted-candidate-missing",
      message: `the promoted candidate "${study.promotedCandidateId}" is not in this project`,
    });
  }
  if (study.approval) {
    const approved = candidateById(study, study.approval.candidateId);
    if (!approved) {
      issues.push({
        severity: "error",
        code: "approved-candidate-missing",
        message: `the approved candidate "${study.approval.candidateId}" is not in this project`,
      });
    } else if (approved.revision !== study.approval.candidateRevision) {
      issues.push({
        severity: "error",
        code: "approved-candidate-revision-mismatch",
        message: `the approved candidate is at revision ${approved.revision}, not approved revision ${study.approval.candidateRevision}`,
        candidateId: approved.id,
      });
    }
    if (study.promotedCandidateId !== study.approval.candidateId) {
      issues.push({
        severity: "error",
        code: "approval-promotion-mismatch",
        message: "the approval receipt does not match the promoted candidate",
      });
    }
    if (study.approval.baselineCandidateId !== null) {
      const baseline = candidateById(study, study.approval.baselineCandidateId);
      if (!baseline) {
        issues.push({
          severity: "error",
          code: "approved-baseline-missing",
          message: `the approved baseline "${study.approval.baselineCandidateId}" is not in this project`,
        });
      } else if (baseline.revision !== study.approval.baselineRevision) {
        issues.push({
          severity: "error",
          code: "approved-baseline-revision-mismatch",
          message: `the approved baseline is at revision ${baseline.revision}, not approved revision ${study.approval.baselineRevision}`,
          candidateId: baseline.id,
        });
      }
    }
  }

  // ---- invariants ----
  const invariantIds = new Set<string>();
  for (const inv of study.correctness.invariants) {
    if (invariantIds.has(inv.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-invariant-id",
        message: `two invariants share the id "${inv.id}"`,
        invariantId: inv.id,
      });
    }
    invariantIds.add(inv.id);

    for (const c of study.candidates) {
      const wf = c.design.workflow;
      if (!wf) continue;
      const scope: WorkflowScope = {
        wf,
        locals: new Map(),
        rowFields: null,
        requestFields: new Map(wf.requestFields.map((f) => [f.name, fieldStaticType(f.type)])),
      };
      const local: DesignIssue[] = [];
      const t = typeOfExpr(inv.expr, scope, local, {
        severity: "error",
        code: "invariant-invalid",
        message: "",
      });
      for (const i of local) {
        issues.push({
          ...i,
          candidateId: c.id,
          invariantId: inv.id,
          message: `invariant "${inv.label}" cannot be evaluated on candidate "${c.label}": ${i.message}`,
        });
      }
      if (t !== "bool" && t !== "unknown") {
        issues.push({
          severity: "error",
          code: "invariant-not-boolean",
          message: `invariant "${inv.label}" evaluates to ${t}, not a boolean`,
          invariantId: inv.id,
          candidateId: c.id,
        });
      }
    }
  }

  if (study.correctness.invariants.length === 0 && study.candidates.some((c) => c.design.workflow)) {
    // Not an error: a study may legitimately be mid-construction. But it must never
    // be mistaken for a study whose candidates passed, so it is stated loudly and the
    // eligibility gate refuses candidates with no invariants regardless.
    issues.push({
      severity: "warning",
      code: "no-invariants",
      message:
        "this project declares no invariants, so a correctness run can only report that nothing was checked",
    });
  }

  // ---- contract ----
  for (const promise of study.contract.promises) {
    if (promise.invariantId && !invariantIds.has(promise.invariantId)) {
      issues.push({
        severity: "error",
        code: "promise-invariant-missing",
        message: `promise "${promise.id}" cites invariant "${promise.invariantId}", which does not exist`,
      });
    } else if (!promise.invariantId) {
      issues.push({
        severity: "warning",
        code: "promise-unverified",
        message: `promise "${promise.statement}" has no invariant, so nothing checks it`,
      });
    }
  }

  const outcomeLabels = new Set(study.contract.outcomes.map((o) => o.label));
  for (const c of study.candidates) {
    const wf = c.design.workflow;
    if (!wf) continue;
    for (const h of wf.handlers) {
      walkOperations(h.steps, (op) => {
        if (op.op === "respond" && op.outcome && !outcomeLabels.has(op.outcome)) {
          issues.push({
            severity: "warning",
            code: "outcome-uncontracted",
            message: `candidate "${c.label}" records outcome "${op.outcome}", which the product contract does not define, so its meaning is unknown`,
            candidateId: c.id,
            handlerId: h.id,
            opId: op.id,
          });
        }
      });
    }
  }

  // ---- goals ----
  for (const goal of study.targets.businessGoals) {
    if (!Number.isFinite(goal.value)) {
      issues.push({
        severity: "error",
        code: "goal-value",
        message: `business goal "${goal.label}" has a non-finite target`,
      });
    }
  }

  if (study.workload.warmupSec >= study.workload.durationSec) {
    issues.push({
      severity: "error",
      code: "warmup-too-long",
      message: "the study's warm-up consumes the entire run, so nothing would be measured",
    });
  }

  return issues;
}

export function studyIsEvaluable(study: Study): boolean {
  return !validateStudy(study).some((i) => i.severity === "error");
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

  // 4 -> 5: gateways, connection populations and edge fan-out. `connections`
  // defaults to null and `fanoutFactor` to 1, so a request/response design behaves
  // exactly as before.
  4: (doc) => ({ ...doc, version: 5 }),

  // 5 -> 6: state, workflows, lock services, resource profiles, and explicit queue
  // delivery semantics.
  //
  // This is the largest widening the schema has taken and it still changes no
  // behaviour, which is the property that makes it safe. `workflow` defaults to null,
  // so a v5 design remains a pure load model and produces byte-identical simulation
  // results. `resources` defaults to absent, which the portfolio reports as UNKNOWN
  // rather than as zero -- the one place where a default could have silently flattered
  // every existing design, and does not.
  //
  // The queue fields are the only ones with a judgement call in them. `delivery`
  // defaults to `at-least-once` and `requireAck` to true, which is a *description* of
  // what the v5 queue component already did: it delivered a message to a consumer and
  // nothing in the model prevented that happening again. Defaulting to
  // `at-most-once` would have been the choice that preserved the old *reported
  // numbers* most literally while quietly asserting a guarantee the old model never
  // provided. Between preserving arithmetic and preserving meaning, meaning wins.
  5: (doc) => ({ ...doc, version: 6 }),
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

// ---------------------------------------------------------------------------
// study migrations
// ---------------------------------------------------------------------------

type StudyMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Study migration registry. Present from v1 so widening the document never strands saved work.
 *
 * The design schema shipped four versions before it grew a migration path, and the
 * cost of that was paid in lost saved work. The study format starts with the
 * mechanism, so the first widening is a one-line change rather than a decision about
 * whether to bother.
 */
const STUDY_MIGRATIONS: Record<number, StudyMigration> = {
  1: (doc) => {
    const rawCandidates = Array.isArray(doc.candidates) ? doc.candidates : [];
    const candidates = rawCandidates.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return candidate;
      const raw = candidate as Record<string, unknown>;
      const isOnlyPromotedCandidate =
        rawCandidates.length === 1 &&
        typeof raw.id === "string" &&
        doc.promotedCandidateId === raw.id;
      return {
        ...raw,
        role: isOnlyPromotedCandidate ? "baseline" : "experiment",
        basedOnCandidateId: null,
        evidence: [],
      };
    });
    return { ...doc, version: 2, repository: null, candidates };
  },
};

/**
 * Parse a saved study, migrating as needed.
 *
 * A design document is accepted too, and becomes a one-candidate study with NO
 * correctness contract. That last part is not a limitation to be worked around: an
 * imported design has no invariants, so the only honest correctness verdict for it is
 * "nothing was checked", and manufacturing a plausible-looking contract on its behalf
 * would be the single most damaging convenience this tool could offer.
 */
export function migrateAndParseStudy(input: unknown): Study {
  if (typeof input !== "object" || input === null) {
    throw new Error("study document must be an object");
  }
  const raw = input as Record<string, unknown>;

  // A bare design, or anything with design-shaped keys and no study version.
  if (!("candidates" in raw) && ("nodes" in raw || "edges" in raw)) {
    return studyFromDesign(migrateAndParse(raw));
  }

  let doc = raw;
  let version = typeof doc.version === "number" ? doc.version : 0;

  while (version < STUDY_SCHEMA_VERSION) {
    const migrate = STUDY_MIGRATIONS[version];
    if (!migrate) throw new Error(`no migration from study version ${version}`);
    doc = migrate(doc);
    version = typeof doc.version === "number" ? doc.version : version + 1;
  }

  if (version > STUDY_SCHEMA_VERSION) {
    throw new Error(
      `document is study version ${version}; this build understands ${STUDY_SCHEMA_VERSION}`
    );
  }

  // Candidate designs migrate independently: a study saved last month may hold
  // designs at an older schema version than the study format itself.
  if (Array.isArray(doc.candidates)) {
    doc = {
      ...doc,
      candidates: doc.candidates.map((c) => {
        const cand = c as Record<string, unknown>;
        return cand.design ? { ...cand, design: migrateAndParse(cand.design) } : cand;
      }),
    };
  }

  return StudySchema.parse(doc);
}

/**
 * Wrap a standalone design as a single-candidate study.
 *
 * The workload is lifted from the design so that opening an existing design in the
 * studio measures exactly what it measured before. The correctness contract is left
 * empty, and `promotedCandidateId` is set, because a design a human has been editing
 * IS the promoted one -- there is nothing for it to have lost a comparison to.
 */
export function studyFromDesign(design: Design, id = "study-1"): Study {
  const client = design.nodes.find((n) => n.kind === "client" && n.client);
  const arrival = client?.client?.arrival ?? { kind: "poisson" as const, ratePerSec: 50 };
  return StudySchema.parse({
    version: STUDY_SCHEMA_VERSION,
    id,
    name: design.name,
    problem: "",
    workload: {
      arrival,
      durationSec: design.scenario.durationSec,
      warmupSec: design.scenario.warmupSec,
      traceLimit: design.scenario.traceLimit,
      seeds: [design.scenario.seed],
      classes: design.classes,
    },
    targets: { slo: design.slo },
    candidates: [
      {
        id: "candidate-1",
        label: design.name,
        origin: "human",
        role: "baseline",
        revision: 0,
        design,
      },
    ],
    activeCandidateId: "candidate-1",
    promotedCandidateId: "candidate-1",
  });
}
