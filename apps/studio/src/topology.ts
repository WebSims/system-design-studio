import type { Design, SdsEdge, SdsNode } from "@sds/schema";

/**
 * Reader-facing topology queries.
 *
 * These functions deliberately use only authored node and edge ids. They do not
 * inspect canvas geometry and they do not claim runtime impact: a connection in
 * the design is evidence of an authored route, not proof that production traffic
 * traverses it or that a failure propagates across it.
 */

export type ReachDirection = "upstream" | "downstream";

export interface ReachabilityResult {
  direction: ReachDirection;
  originId: string;
  nodeIds: string[];
  edgeIds: string[];
  depths: Record<string, number>;
  maxDepth: number;
}

export interface DirectedRoute {
  sourceId: string;
  targetId: string;
  nodeIds: string[];
  edgeIds: string[];
  hops: number;
}

function nodeIdsOf(design: Design): Set<string> {
  return new Set(design.nodes.map((node) => node.id));
}

function usableEdges(design: Design): SdsEdge[] {
  const nodeIds = nodeIdsOf(design);
  return design.edges.filter(
    (edge) => edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to)
  );
}

export function authoredReachability(
  design: Design,
  originId: string,
  direction: ReachDirection
): ReachabilityResult | null {
  if (!nodeIdsOf(design).has(originId)) return null;

  const edges = usableEdges(design);
  const depths: Record<string, number> = { [originId]: 0 };
  const queue = [originId];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const edge of edges) {
      const next =
        direction === "downstream"
          ? edge.from === current
            ? edge.to
            : null
          : edge.to === current
            ? edge.from
            : null;
      if (next === null || Object.hasOwn(depths, next)) continue;
      depths[next] = depths[current]! + 1;
      queue.push(next);
    }
  }

  const reached = new Set(queue);
  const edgeIds = edges
    .filter((edge) => reached.has(edge.from) && reached.has(edge.to))
    .map((edge) => edge.id);

  return {
    direction,
    originId,
    nodeIds: queue,
    edgeIds,
    depths,
    maxDepth: queue.reduce((maximum, id) => Math.max(maximum, depths[id]!), 0),
  };
}

function outgoingByNode(design: Design): Map<string, SdsEdge[]> {
  const outgoing = new Map<string, SdsEdge[]>();
  for (const edge of usableEdges(design)) {
    const current = outgoing.get(edge.from) ?? [];
    current.push(edge);
    outgoing.set(edge.from, current);
  }
  return outgoing;
}

/**
 * The first path found by breadth-first search is the shortest in authored hops.
 * Ties follow document edge order, keeping the result deterministic and easy to
 * reproduce after import/export.
 */
export function shortestDirectedRoute(
  design: Design,
  sourceId: string,
  targetId: string
): DirectedRoute | null {
  const nodeIds = nodeIdsOf(design);
  if (sourceId === targetId || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) return null;

  const outgoing = outgoingByNode(design);
  const queue = [sourceId];
  const previous = new Map<string, { from: string; edgeId: string } | null>([[sourceId, null]]);

  for (let cursor = 0; cursor < queue.length && !previous.has(targetId); cursor += 1) {
    for (const edge of outgoing.get(queue[cursor]!) ?? []) {
      if (previous.has(edge.to)) continue;
      previous.set(edge.to, { from: edge.from, edgeId: edge.id });
      queue.push(edge.to);
      if (edge.to === targetId) break;
    }
  }

  if (!previous.has(targetId)) return null;
  const routeNodeIds = [targetId];
  const routeEdgeIds: string[] = [];
  let current = targetId;
  while (current !== sourceId) {
    const step = previous.get(current);
    if (!step) return null;
    routeNodeIds.unshift(step.from);
    routeEdgeIds.unshift(step.edgeId);
    current = step.from;
  }

  return {
    sourceId,
    targetId,
    nodeIds: routeNodeIds,
    edgeIds: routeEdgeIds,
    hops: routeEdgeIds.length,
  };
}

export function reachableDestinations(
  design: Design,
  sourceId: string
): Array<{ id: string; hops: number }> {
  const outgoing = outgoingByNode(design);
  if (!nodeIdsOf(design).has(sourceId)) return [];

  const queue = [sourceId];
  const distances = new Map<string, number>([[sourceId, 0]]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const edge of outgoing.get(current) ?? []) {
      if (distances.has(edge.to)) continue;
      distances.set(edge.to, distances.get(current)! + 1);
      queue.push(edge.to);
    }
  }

  return queue.slice(1).map((id) => ({ id, hops: distances.get(id)! }));
}

// ---------------------------------------------------------------------------
// Exact-ID candidate comparison
// ---------------------------------------------------------------------------

export type DeltaStatus = "added" | "removed" | "changed" | "moved";

export interface NodeDelta {
  kind: "node";
  id: string;
  status: DeltaStatus;
  label: string;
  changedFields: string[];
  moved: boolean;
}

export interface EdgeDelta {
  kind: "edge";
  id: string;
  status: Exclude<DeltaStatus, "moved">;
  from: string;
  to: string;
  changedFields: string[];
}

export interface DesignDelta {
  comparable: boolean;
  sharedNodeIds: string[];
  nodes: NodeDelta[];
  edges: EdgeDelta[];
  summary: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesChanged: number;
    nodesMoved: number;
    edgesAdded: number;
    edgesRemoved: number;
    edgesChanged: number;
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  ignored: Set<string>
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !ignored.has(key) && canonical(before[key]) !== canonical(after[key]))
    .sort();
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function nodeLabel(before: SdsNode | undefined, after: SdsNode | undefined, id: string): string {
  return after?.label || before?.label || id;
}

export function compareDesignTopology(base: Design, head: Design): DesignDelta {
  const baseNodes = byId(base.nodes);
  const headNodes = byId(head.nodes);
  const baseEdges = byId(base.edges);
  const headEdges = byId(head.edges);
  const sharedNodeIds = [...baseNodes.keys()].filter((id) => headNodes.has(id)).sort();
  const nodes: NodeDelta[] = [];
  const edges: EdgeDelta[] = [];

  for (const id of [...new Set([...baseNodes.keys(), ...headNodes.keys()])].sort()) {
    const before = baseNodes.get(id);
    const after = headNodes.get(id);
    if (!before) {
      nodes.push({ kind: "node", id, status: "added", label: nodeLabel(before, after, id), changedFields: [], moved: false });
      continue;
    }
    if (!after) {
      nodes.push({ kind: "node", id, status: "removed", label: nodeLabel(before, after, id), changedFields: [], moved: false });
      continue;
    }

    const fields = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      new Set(["id", "x", "y"])
    );
    const moved = before.x !== after.x || before.y !== after.y;
    if (fields.length > 0 || moved) {
      nodes.push({
        kind: "node",
        id,
        status: fields.length > 0 ? "changed" : "moved",
        label: nodeLabel(before, after, id),
        changedFields: fields,
        moved,
      });
    }
  }

  for (const id of [...new Set([...baseEdges.keys(), ...headEdges.keys()])].sort()) {
    const before = baseEdges.get(id);
    const after = headEdges.get(id);
    if (!before) {
      edges.push({ kind: "edge", id, status: "added", from: after!.from, to: after!.to, changedFields: [] });
      continue;
    }
    if (!after) {
      edges.push({ kind: "edge", id, status: "removed", from: before.from, to: before.to, changedFields: [] });
      continue;
    }
    const fields = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      new Set(["id"])
    );
    if (fields.length > 0) {
      edges.push({ kind: "edge", id, status: "changed", from: after.from, to: after.to, changedFields: fields });
    }
  }

  return {
    comparable: sharedNodeIds.length > 0,
    sharedNodeIds,
    nodes,
    edges,
    summary: {
      nodesAdded: nodes.filter((change) => change.status === "added").length,
      nodesRemoved: nodes.filter((change) => change.status === "removed").length,
      nodesChanged: nodes.filter((change) => change.status === "changed").length,
      nodesMoved: nodes.filter((change) => change.moved).length,
      edgesAdded: edges.filter((change) => change.status === "added").length,
      edgesRemoved: edges.filter((change) => change.status === "removed").length,
      edgesChanged: edges.filter((change) => change.status === "changed").length,
    },
  };
}
