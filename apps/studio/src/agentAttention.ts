import type { Design } from "@sds/schema"
import { NODE_HEIGHT, NODE_WIDTH } from "./canvas/geometry"
import type { ArchitecturePatchOperation } from "./study/mutations"

/**
 * What an agent call touched, derived so the interface can behave like a person did it.
 *
 * A person who adds a component has it selected and in view; a person who edits a field is looking
 * at the panel that holds it. The tools themselves know nothing of cameras or panels (they are
 * UI-agnostic on purpose), so this module turns a patch plus a before/after design into the ids to
 * reveal, the one element to select, and the fields whose values just changed.
 *
 * Pure functions on design data, no store access, so they are testable in isolation.
 */

export interface ElementRef {
  kind: "node" | "edge"
  id: string
}

export interface TouchedElements {
  nodeIds: string[]
  edgeIds: string[]
  /** The element the agent is "working on now": the last add/update target in the patch. */
  primary: ElementRef | null
  /** True when the patch reshaped the whole drawing (layout, workflow, rename, removals). */
  wholeDesign: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const idOf = (value: unknown): string | null =>
  isRecord(value) && typeof value.id === "string" ? value.id : null

/**
 * Which nodes and links a patch touched.
 *
 * Add operations name the element when the agent supplied an id; when it did not, the id is
 * recovered by comparing the design before and after, which is also how a link auto-named by the
 * schema is found.
 */
export const touchedByOperations = (
  operations: readonly ArchitecturePatchOperation[],
  before: Design,
  after: Design
): TouchedElements => {
  const beforeNodes = new Set(before.nodes.map((n) => n.id))
  const beforeEdges = new Set(before.edges.map((e) => e.id))
  const afterNodes = new Set(after.nodes.map((n) => n.id))
  const afterEdges = new Set(after.edges.map((e) => e.id))
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  let primary: ElementRef | null = null
  let wholeDesign = false

  for (const n of after.nodes) if (!beforeNodes.has(n.id)) nodeIds.add(n.id)
  for (const e of after.edges) if (!beforeEdges.has(e.id)) edgeIds.add(e.id)
  // An added link with no id in the request can still be named when it is the only new one.
  const soleNewEdge = edgeIds.size === 1 ? [...edgeIds][0]! : null

  for (const operation of operations) {
    switch (operation.op) {
      case "add-node": {
        const id = idOf(operation.node)
        if (id && afterNodes.has(id)) {
          nodeIds.add(id)
          primary = { kind: "node", id }
        }
        break
      }
      case "update-node":
        if (afterNodes.has(operation.nodeId)) {
          nodeIds.add(operation.nodeId)
          primary = { kind: "node", id: operation.nodeId }
        }
        break
      case "add-edge": {
        const given = idOf(operation.edge)
        const id = given && afterEdges.has(given) ? given : soleNewEdge
        if (id) {
          edgeIds.add(id)
          primary = { kind: "edge", id }
        }
        break
      }
      case "update-edge":
        if (afterEdges.has(operation.edgeId)) {
          edgeIds.add(operation.edgeId)
          primary = { kind: "edge", id: operation.edgeId }
        }
        break
      case "remove-node":
      case "remove-edge":
      case "set-workflow":
      case "set-design-name":
      case "auto-layout":
        wholeDesign = true
        break
    }
  }

  if (!primary && nodeIds.size === 1) primary = { kind: "node", id: [...nodeIds][0]! }

  return { nodeIds: [...nodeIds], edgeIds: [...edgeIds], primary, wholeDesign }
}

const MAX_CHANGED_PATHS = 8

const collectPaths = (before: unknown, after: unknown, prefix: string, out: string[]): void => {
  if (out.length >= MAX_CHANGED_PATHS) return
  if (Object.is(before, after)) return
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) collectPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key, out)
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after) && prefix) out.push(prefix)
    return
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return
  if (prefix) out.push(prefix)
}

/**
 * Dotted leaf paths whose value differs between two versions of an element, e.g.
 * `server.concurrency` or `latency.value`. Geometry is omitted: a person watching does not care
 * that `x` changed, only that the box moved. A brand-new element yields `["new"]`.
 */
export const changedPaths = (before: unknown, after: unknown): string[] => {
  if (before === undefined) return ["new"]
  const out: string[] = []
  collectPaths(before, after, "", out)
  return out.filter((path) => path !== "x" && path !== "y")
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Bounds of some nodes (every node when `nodeIds` is empty), from design coordinates and the
 * fixed node size. Computed, not measured, so a node added this frame already has a box.
 * Edges are expressed through their endpoints; pass them via `nodesForEdges`.
 */
export const designBounds = (design: Design, nodeIds: readonly string[] = []): Rect | null => {
  const wanted = nodeIds.length ? new Set(nodeIds) : null
  const nodes = design.nodes.filter((n) => !wanted || wanted.has(n.id))
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + NODE_WIDTH)
    maxY = Math.max(maxY, n.y + NODE_HEIGHT)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The touched nodes plus both ends of every touched link.
 *
 * No further hop: one more ring of neighbours is usually most of the graph, and the point of a
 * local fit is to be closer than the whole.
 */
export const neighbourhood = (design: Design, nodeIds: readonly string[], edgeIds: readonly string[]): string[] => {
  const ids = new Set(nodeIds)
  const edges = new Set(edgeIds)
  for (const e of design.edges) {
    if (!edges.has(e.id)) continue
    ids.add(e.from)
    ids.add(e.to)
  }
  return [...ids].filter((id) => design.nodes.some((n) => n.id === id))
}
