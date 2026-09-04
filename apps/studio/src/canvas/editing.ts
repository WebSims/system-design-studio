import type { CanvasObject, Design, SdsEdge, SdsNode } from "@sds/schema";
import { nextNodeId, protocolFreeEdgeId } from "../ids";
import { NODE_HEIGHT, NODE_WIDTH } from "./geometry";

export const CANVAS_PRESET_MIME = "application/x-system-design-studio-preset";

export interface CanvasSelectionState {
  nodeIds: string[];
  edgeIds: string[];
  objectIds: string[];
}

export type CanvasSelectionGroup = keyof CanvasSelectionState;

export interface CanvasSelectionDelta {
  group: CanvasSelectionGroup;
  id: string;
  selected: boolean;
}

export type CanvasPrimarySelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "canvas"; id: string };

export interface CanvasWorkspace {
  design: Design;
  objects: CanvasObject[];
}

export interface CanvasClipboard {
  nodes: SdsNode[];
  edges: SdsEdge[];
  objects: CanvasObject[];
}

export const EMPTY_CANVAS_SELECTION: CanvasSelectionState = {
  nodeIds: [],
  edgeIds: [],
  objectIds: [],
};

/**
 * Apply React Flow's controlled selection changes without losing selections of another kind.
 *
 * React Flow emits node and edge changes separately. Rebuilding the whole selection from either
 * callback drops the other half, while ignoring the changes means controlled elements can never
 * become selected. Folding small deltas into the Studio selection handles clicks, keyboard
 * selection, modifier multi-select and the marquee through the same path.
 */
export function applyCanvasSelectionDeltas(
  current: CanvasSelectionState,
  deltas: readonly CanvasSelectionDelta[]
): { selection: CanvasSelectionState; primary: CanvasPrimarySelection | null } {
  const groups: Record<CanvasSelectionGroup, Set<string>> = {
    nodeIds: new Set(current.nodeIds),
    edgeIds: new Set(current.edgeIds),
    objectIds: new Set(current.objectIds),
  };
  let primary: CanvasPrimarySelection | null = null;

  for (const delta of deltas) {
    if (delta.selected) {
      groups[delta.group].add(delta.id);
      primary = {
        kind:
          delta.group === "nodeIds"
            ? "node"
            : delta.group === "edgeIds"
              ? "edge"
              : "canvas",
        id: delta.id,
      };
    } else {
      groups[delta.group].delete(delta.id);
    }
  }

  return {
    selection: {
      nodeIds: [...groups.nodeIds],
      edgeIds: [...groups.edgeIds],
      objectIds: [...groups.objectIds],
    },
    primary,
  };
}

const clone = <T>(value: T): T => structuredClone(value);

export function selectionCount(selection: CanvasSelectionState): number {
  return selection.nodeIds.length + selection.edgeIds.length + selection.objectIds.length;
}

export function geometrySelectionCount(selection: CanvasSelectionState): number {
  return selection.nodeIds.length + selection.objectIds.length;
}

/**
 * Copy only executable objects and canvas presentation—not repository evidence.
 *
 * Edges are included when both endpoint nodes are selected. An edge on its own is
 * not copyable because creating a second identical route is invalid architecture.
 */
export function copyWorkspaceSelection(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState
): CanvasClipboard | null {
  const selectedNodes = new Set(selection.nodeIds);
  const nodes = workspace.design.nodes.filter((node) => selectedNodes.has(node.id)).map(clone);
  const edges = workspace.design.edges
    .filter((edge) => selectedNodes.has(edge.from) && selectedNodes.has(edge.to))
    .map(clone);
  const selectedObjects = new Set(selection.objectIds);
  const objects = workspace.objects.filter((object) => selectedObjects.has(object.id)).map(clone);
  return nodes.length > 0 || objects.length > 0 ? { nodes, edges, objects } : null;
}

function nextObjectId(kind: CanvasObject["kind"], taken: string[]): string {
  const ids = new Set(taken);
  for (let index = 1; ; index += 1) {
    const candidate = `${kind}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

/** Paste with fresh IDs and return exactly the newly-created selection. */
export function pasteWorkspaceSelection(
  workspace: CanvasWorkspace,
  clipboard: CanvasClipboard,
  offset = 32
): { workspace: CanvasWorkspace; selection: CanvasSelectionState } {
  const design = clone(workspace.design);
  const objects = clone(workspace.objects);
  const nodeIds = design.nodes.map((node) => node.id);
  const edgeIds = design.edges.map((edge) => edge.id);
  const objectIds = objects.map((object) => object.id);
  const nodeMap = new Map<string, string>();
  const pastedNodes: string[] = [];
  const pastedEdges: string[] = [];
  const pastedObjects: string[] = [];

  for (const source of clipboard.nodes) {
    const id = nextNodeId(source.kind, nodeIds);
    nodeIds.push(id);
    nodeMap.set(source.id, id);
    pastedNodes.push(id);
    design.nodes.push({ ...clone(source), id, x: source.x + offset, y: source.y + offset });
  }

  for (const source of clipboard.edges) {
    const from = nodeMap.get(source.from);
    const to = nodeMap.get(source.to);
    if (!from || !to) continue;
    const id = protocolFreeEdgeId(edgeIds);
    edgeIds.push(id);
    pastedEdges.push(id);
    design.edges.push({ ...clone(source), id, from, to });
  }

  for (const source of clipboard.objects) {
    const id = nextObjectId(source.kind, objectIds);
    objectIds.push(id);
    pastedObjects.push(id);
    objects.push({ ...clone(source), id, x: source.x + offset, y: source.y + offset });
  }

  return {
    workspace: { design, objects },
    selection: { nodeIds: pastedNodes, edgeIds: pastedEdges, objectIds: pastedObjects },
  };
}

/** Delete a selection as one topology transaction, including incident links. */
export function deleteWorkspaceSelection(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState
): CanvasWorkspace {
  const nodeIds = new Set(selection.nodeIds);
  const edgeIds = new Set(selection.edgeIds);
  const objectIds = new Set(selection.objectIds);
  return {
    design: {
      ...workspace.design,
      nodes: workspace.design.nodes.filter((node) => !nodeIds.has(node.id)),
      edges: workspace.design.edges.filter(
        (edge) =>
          !edgeIds.has(edge.id) && !nodeIds.has(edge.from) && !nodeIds.has(edge.to)
      ),
    },
    objects: workspace.objects.filter((object) => !objectIds.has(object.id)),
  };
}

interface GeometryItem {
  id: string;
  kind: "node" | "object";
  x: number;
  y: number;
  width: number;
  height: number;
}

const geometryKey = (kind: GeometryItem["kind"], id: string): string => `${kind}:${id}`;

function selectedGeometry(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState
): GeometryItem[] {
  const nodes = new Set(selection.nodeIds);
  const objects = new Set(selection.objectIds);
  return [
    ...workspace.design.nodes
      .filter((node) => nodes.has(node.id))
      .map((node) => ({
        id: node.id,
        kind: "node" as const,
        x: node.x,
        y: node.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
    ...workspace.objects
      .filter((object) => objects.has(object.id))
      .map((object) => ({
        id: object.id,
        kind: "object" as const,
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
      })),
  ];
}

function moveGeometry(
  workspace: CanvasWorkspace,
  positions: Map<string, { kind: GeometryItem["kind"]; x: number; y: number }>
): CanvasWorkspace {
  return {
    design: {
      ...workspace.design,
      nodes: workspace.design.nodes.map((node) => {
        const position = positions.get(geometryKey("node", node.id));
        return position?.kind === "node"
          ? { ...node, x: Math.round(position.x), y: Math.round(position.y) }
          : node;
      }),
    },
    objects: workspace.objects.map((object) => {
      const position = positions.get(geometryKey("object", object.id));
      return position?.kind === "object"
        ? { ...object, x: Math.round(position.x), y: Math.round(position.y) }
        : object;
    }),
  };
}

export function alignWorkspaceSelection(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState,
  edge: "left" | "top"
): CanvasWorkspace {
  const items = selectedGeometry(workspace, selection);
  if (items.length < 2) return workspace;
  const target = Math.min(...items.map((item) => (edge === "left" ? item.x : item.y)));
  return moveGeometry(
    workspace,
    new Map(
      items.map((item) => [
        geometryKey(item.kind, item.id),
        {
          kind: item.kind,
          x: edge === "left" ? target : item.x,
          y: edge === "top" ? target : item.y,
        },
      ])
    )
  );
}

export function distributeWorkspaceSelection(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState,
  axis: "horizontal" | "vertical"
): CanvasWorkspace {
  const items = selectedGeometry(workspace, selection).sort((first, second) => {
    const a = axis === "horizontal" ? first.x + first.width / 2 : first.y + first.height / 2;
    const b = axis === "horizontal" ? second.x + second.width / 2 : second.y + second.height / 2;
    return a - b || first.id.localeCompare(second.id);
  });
  if (items.length < 3) return workspace;
  const center = (item: GeometryItem) =>
    axis === "horizontal" ? item.x + item.width / 2 : item.y + item.height / 2;
  const start = center(items[0]!);
  const end = center(items.at(-1)!);
  const step = (end - start) / (items.length - 1);
  const positions = new Map<string, { kind: GeometryItem["kind"]; x: number; y: number }>();
  items.forEach((item, index) => {
    const wanted = start + step * index;
    positions.set(geometryKey(item.kind, item.id), {
      kind: item.kind,
      x: axis === "horizontal" ? wanted - item.width / 2 : item.x,
      y: axis === "vertical" ? wanted - item.height / 2 : item.y,
    });
  });
  return moveGeometry(workspace, positions);
}

export function nudgeWorkspaceSelection(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState,
  dx: number,
  dy: number
): CanvasWorkspace {
  const items = selectedGeometry(workspace, selection);
  return moveGeometry(
    workspace,
    new Map(
      items.map((item) => [
        geometryKey(item.kind, item.id),
        { kind: item.kind, x: item.x + dx, y: item.y + dy },
      ])
    )
  );
}

export function selectionRemovalIds(
  workspace: CanvasWorkspace,
  selection: CanvasSelectionState
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set(selection.nodeIds);
  const edgeIds = new Set(selection.edgeIds);
  for (const edge of workspace.design.edges) {
    if (nodeIds.has(edge.from) || nodeIds.has(edge.to)) edgeIds.add(edge.id);
  }
  return { nodeIds, edgeIds };
}
