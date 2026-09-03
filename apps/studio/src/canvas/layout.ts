import type { SdsNode } from "@sds/schema"
import { NODE_HEIGHT, NODE_WIDTH } from "./geometry"

export const NODE_GAP = 48
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

/**
 * Return the first pair that violates the canvas spacing contract.
 * Agent mutations use this to reject a poor layout rather than silently moving authored nodes.
 */
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

/**
 * Where a node lands when nobody said.
 *
 * This is only for the human palette. WebMCP agents must author x/y from architecture topology.
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
