import type { Design, SdsNode } from "@sds/schema"
import { NODE_HEIGHT, NODE_WIDTH } from "./geometry"

/**
 * Canvas layout: the one place that knows how far apart nodes must be and where an unplaced
 * node goes.
 *
 * Coordinates are part of an agent-authored design, not cosmetic metadata: a diagram whose
 * columns follow dependency depth is readable, a grid is not. So the rules an agent is asked to
 * follow (studio_get_catalog.layoutGuide) and the layered layout it can ask for instead
 * (`auto-layout`) live here, next to the overlap check that refuses a bad one. The engine never
 * reads any of this.
 */

export const NODE_GAP = 48
const HORIZONTAL_STEP = NODE_WIDTH + NODE_GAP
const VERTICAL_STEP = NODE_HEIGHT + NODE_GAP

/** Where laid-out and palette-added nodes start. */
export const LAYOUT_ORIGIN = { x: 120, y: 120 } as const
/** Column and row pitch for a layered layout: a node box plus room for a legible link. */
export const LAYOUT_STEP = { x: 320, y: 240 } as const
/** Columns of the palette grid: wide enough to read as a diagram, narrow enough for one screen. */
const GRID_COLUMNS = 4

type Box = Pick<SdsNode, "x" | "y">

/** What the layered layout needs from a node, so it can run on a raw draft before parsing. */
export interface LayoutNode {
  id: string
  kind?: string
}
export interface LayoutEdge {
  from: string
  to: string
}

const nodesOverlap = (first: Box, second: Box): boolean => {
  const horizontallyClear =
    first.x + NODE_WIDTH + NODE_GAP <= second.x ||
    second.x + NODE_WIDTH + NODE_GAP <= first.x
  const verticallyClear =
    first.y + NODE_HEIGHT + NODE_GAP <= second.y ||
    second.y + NODE_HEIGHT + NODE_GAP <= first.y

  return !horizontallyClear && !verticallyClear
}

/** The first pair of node boxes closer than the spacing contract allows, or null. */
export const overlappingNodePair = (
  nodes: readonly SdsNode[]
): readonly [SdsNode, SdsNode] | null => {
  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    const first = nodes[firstIndex]
    if (!first) continue

    for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
      const second = nodes[secondIndex]
      if (second && nodesOverlap(first, second)) return [first, second]
    }
  }

  return null
}

export interface LayoutIssue {
  code: "node-overlap"
  message: string
  nodeIds: readonly [string, string]
}

/**
 * The one description of an overlap, so the validator, the mutation refusal and the tool text
 * cannot drift apart. Names both nodes with their coordinates and both ways out.
 */
export const layoutIssue = (nodes: readonly SdsNode[]): LayoutIssue | null => {
  const pair = overlappingNodePair(nodes)
  if (!pair) return null

  const [first, second] = pair
  return {
    code: "node-overlap",
    nodeIds: [first.id, second.id],
    message:
      `nodes "${first.id}" at (${first.x}, ${first.y}) and "${second.id}" at (${second.x}, ${second.y}) overlap. ` +
      `Node boxes are ${NODE_WIDTH}x${NODE_HEIGHT} and need a ${NODE_GAP}px gap: choose x/y from the topology ` +
      `(x by dependency depth, parallel branches on separate y rows, about ${LAYOUT_STEP.x}x${LAYOUT_STEP.y} apart), ` +
      'or add { op: "auto-layout" } to the patch and the studio places every node by dependency depth.',
  }
}

/**
 * Where a palette node lands when nobody said: the first free slot of a grid, left to right, top
 * to bottom. Agents do not get this; their coordinates come from the topology or from `auto-layout`.
 */
export const nextNodePosition = (placed: readonly Box[]): Box => {
  let slot = 0

  while (true) {
    const candidate = {
      x: LAYOUT_ORIGIN.x + (slot % GRID_COLUMNS) * HORIZONTAL_STEP,
      y: LAYOUT_ORIGIN.y + Math.floor(slot / GRID_COLUMNS) * VERTICAL_STEP,
    }

    if (!placed.some((node) => nodesOverlap(candidate, node))) return candidate

    slot += 1
  }
}

/**
 * Column of every node: the longest caller chain that reaches it.
 *
 * Clients are the leftmost column whatever points at them. A back edge in a cycle is ignored for
 * depth so the walk terminates; the topology validator reports the cycle itself.
 */
const dependencyDepths = (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, number> => {
  const callersOf = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    callersOf.get(edge.to)?.push(edge.from)
  }

  const isClient = new Set(nodes.filter((node) => node.kind === "client").map((node) => node.id))
  const depths = new Map<string, number>()
  const onStack = new Set<string>()

  const depthOf = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    if (isClient.has(id)) {
      depths.set(id, 0)
      return 0
    }

    onStack.add(id)
    let depth = 0
    for (const caller of callersOf.get(id) ?? []) {
      if (onStack.has(caller) || !callersOf.has(caller)) continue
      depth = Math.max(depth, depthOf(caller) + 1)
    }
    onStack.delete(id)
    depths.set(id, depth)
    return depth
  }

  for (const node of nodes) depthOf(node.id)
  return depths
}

/**
 * A layered layout of the dependency graph.
 *
 * Callers left, dependencies right, one column per dependency depth. Within a column each node
 * wants to sit level with the middle of its callers, so a shared store lands between the services
 * that use it and the main request path stays on one row; nodes are then pushed down only as far
 * as the spacing contract needs. Deterministic: ties keep the order the nodes were added in.
 */
export const layeredPositions = (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, Box> => {
  const ids = new Set(nodes.map((node) => node.id))
  const knownEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const depths = dependencyDepths(nodes, knownEdges)

  const columns = new Map<number, LayoutNode[]>()
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0
    columns.set(depth, [...(columns.get(depth) ?? []), node])
  }

  const positions = new Map<string, Box>()
  const columnDepths = [...columns.keys()].sort((a, b) => a - b)

  for (const depth of columnDepths) {
    const column = columns.get(depth) ?? []
    const x = LAYOUT_ORIGIN.x + depth * LAYOUT_STEP.x

    const wanted = column.map((node, index) => {
      const callerYs = knownEdges
        .filter((edge) => edge.to === node.id)
        .map((edge) => positions.get(edge.from)?.y)
        .filter((y): y is number => y !== undefined)
      const target =
        callerYs.length > 0 ? callerYs.reduce((sum, y) => sum + y, 0) / callerYs.length : LAYOUT_ORIGIN.y
      return { node, target, index }
    })
    wanted.sort((a, b) => a.target - b.target || a.index - b.index)

    let floor = -Infinity
    for (const { node, target } of wanted) {
      const y = Math.round(Math.max(target, floor))
      positions.set(node.id, { x, y })
      floor = y + LAYOUT_STEP.y
    }
  }

  return positions
}

/** The same design with every node moved to its layered position. */
export const layoutDesign = (design: Design): Design => {
  const positions = layeredPositions(design.nodes, design.edges)
  return {
    ...design,
    nodes: design.nodes.map((node) => ({ ...node, ...(positions.get(node.id) ?? { x: node.x, y: node.y }) })),
  }
}
