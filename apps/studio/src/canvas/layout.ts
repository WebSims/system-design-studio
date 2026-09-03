import type { Design, SdsNode } from "@sds/schema"
import { NODE_HEIGHT, NODE_WIDTH } from "./geometry"

const NODE_GAP = 48
const HORIZONTAL_STEP = NODE_WIDTH + NODE_GAP
const VERTICAL_STEP = NODE_HEIGHT + NODE_GAP

/** Where the grid of unplaced nodes starts. */
const GRID_ORIGIN = { x: 120, y: 120 }
/** Columns in that grid: wide enough to read as a diagram, narrow enough to stay on one screen. */
const GRID_COLUMNS = 4

type Box = Pick<SdsNode, "x" | "y">

const nodesOverlap = (first: Box, second: Box): boolean => {
  const horizontallyClear =
    first.x + NODE_WIDTH + NODE_GAP <= second.x ||
    second.x + NODE_WIDTH + NODE_GAP <= first.x
  const verticallyClear =
    first.y + NODE_HEIGHT + NODE_GAP <= second.y ||
    second.y + NODE_HEIGHT + NODE_GAP <= first.y

  return !horizontallyClear && !verticallyClear
}

const findOpenPosition = (
  node: SdsNode,
  positionedNodes: readonly SdsNode[],
  columnCount: number
): Pick<SdsNode, "x" | "y"> => {
  let slot = 1

  while (true) {
    const candidate = {
      ...node,
      x: node.x + (slot % columnCount) * HORIZONTAL_STEP,
      y: node.y + Math.floor(slot / columnCount) * VERTICAL_STEP,
    }

    if (!positionedNodes.some((positionedNode) => nodesOverlap(candidate, positionedNode))) {
      return { x: candidate.x, y: candidate.y }
    }

    slot += 1
  }
}

/**
 * Preserve intentional positions and move only nodes whose boxes collide.
 *
 * React Flow renders supplied coordinates verbatim. WebMCP-authored designs can therefore collapse
 * into one visible node when an agent satisfies the required x/y fields with repeated values.
 */
export const separateOverlappingNodePositions = (design: Design): Design => {
  const positionedNodes: SdsNode[] = []
  const columnCount = Math.max(2, Math.ceil(Math.sqrt(design.nodes.length)))
  let changed = false

  for (const node of design.nodes) {
    if (!positionedNodes.some((positionedNode) => nodesOverlap(node, positionedNode))) {
      positionedNodes.push(node)
      continue
    }

    const position = findOpenPosition(node, positionedNodes, columnCount)
    positionedNodes.push({ ...node, ...position })
    changed = true
  }

  if (!changed) return design
  return { ...design, nodes: positionedNodes }
}

/**
 * Where a node lands when nobody said.
 *
 * Two doors add nodes without coordinates: the palette, and an agent drawing an architecture one
 * `add-node` patch at a time. Both should produce a picture a person can read while it forms, so
 * both use the same rule: the first free slot of a grid, left to right, top to bottom.
 */
export const nextNodePosition = (placed: readonly Box[]): Box => {
  let slot = 0

  while (true) {
    const candidate = {
      x: GRID_ORIGIN.x + (slot % GRID_COLUMNS) * HORIZONTAL_STEP,
      y: GRID_ORIGIN.y + Math.floor(slot / GRID_COLUMNS) * VERTICAL_STEP,
    }

    if (!placed.some((node) => nodesOverlap(candidate, node))) return candidate

    slot += 1
  }
}

/** Nodes with usable coordinates, from a design that may still be raw agent input. */
export const placedBoxes = (nodes: ReadonlyArray<Record<string, unknown>>): Box[] =>
  nodes.flatMap((node) => (typeof node.x === "number" && typeof node.y === "number" ? [{ x: node.x, y: node.y }] : []))
