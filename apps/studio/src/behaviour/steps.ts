import type { Expr, Handler, Operation } from "@sds/schema"

/**
 * Reading and editing request steps.
 *
 * A handler's steps are a tree: `branch` has a `then` and an `else`, `atomic` has a `body`.
 * The editor addresses a position in that tree by a `StepPath`, a list of segments that
 * alternate between an index into a block and the name of the block descended into.
 *
 * Everything here is pure and DOM-free. The Inspector renders what these return and calls
 * back in with paths; it never walks the tree itself.
 */

/** Which nested block of an operation a path descends into. */
export type BlockName = "then" | "else" | "body"

export type StepPath = Array<number | BlockName>

/** The block of operations a path points into, or null when the path is malformed. */
export const blockAt = (steps: Operation[], path: StepPath): Operation[] | null => {
  let block: Operation[] = steps
  for (let i = 0; i < path.length; i += 2) {
    const index = path[i]
    const name = path[i + 1]
    if (typeof index !== "number" || typeof name !== "string") return null
    const op = block[index]
    if (!op) return null
    if (op.op === "branch" && (name === "then" || name === "else")) block = op[name]
    else if (op.op === "atomic" && name === "body") block = op.body
    else return null
  }
  return block
}

/** Append an operation to the block a path points into. Mutates in place (call inside `edit`). */
export const appendAt = (steps: Operation[], path: StepPath, op: Operation): boolean => {
  const block = blockAt(steps, path)
  if (!block) return false
  block.push(op)
  return true
}

/** Remove the operation at `index` inside the block a path points into. */
export const removeAt = (steps: Operation[], path: StepPath, index: number): boolean => {
  const block = blockAt(steps, path)
  if (!block || index < 0 || index >= block.length) return false
  block.splice(index, 1)
  return true
}

/** Swap the operation at `index` with its neighbour. */
export const moveAt = (steps: Operation[], path: StepPath, index: number, delta: -1 | 1): boolean => {
  const block = blockAt(steps, path)
  if (!block) return false
  const target = index + delta
  if (index < 0 || index >= block.length || target < 0 || target >= block.length) return false
  const [moved] = block.splice(index, 1)
  if (!moved) return false
  block.splice(target, 0, moved)
  return true
}

/** Every operation id in a handler, including nested ones. */
export const allOpIds = (steps: Operation[]): string[] =>
  steps.flatMap((op) => {
    const nested =
      op.op === "branch" ? [...allOpIds(op.then), ...allOpIds(op.else)] : op.op === "atomic" ? allOpIds(op.body) : []
    return [op.id, ...nested]
  })

/** A fresh id that no operation in the handler already uses. */
export const freshOpId = (handler: Handler, base: string): string => {
  const taken = new Set(allOpIds(handler.steps))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** Local variable names bound before any step in the handler could read them. */
export const localsBound = (steps: Operation[]): string[] => {
  const names = new Set<string>()
  const walk = (ops: Operation[]) => {
    for (const op of ops) {
      if (op.op === "read" || op.op === "assign" || op.op === "acquireLease") names.add(op.op === "assign" ? op.name : op.into)
      if ((op.op === "conditionalWrite" || op.op === "insertUnique") && op.into) names.add(op.into)
      if (op.op === "branch") {
        walk(op.then)
        walk(op.else)
      }
      if (op.op === "atomic") walk(op.body)
    }
  }
  walk(steps)
  return [...names]
}

/**
 * Whether control can pass to another actor after this operation.
 *
 * `read` and `write` are scheduling points; the indivisible operations are not. The editor
 * marks these because they are the whole reason a race is possible: a design whose only
 * scheduling point is between a read and the write that depends on it is the lost-update
 * bug, and a reader should be able to see that from the step list alone.
 */
export const isSchedulingPoint = (op: Operation): boolean => op.op === "read" || op.op === "write"

// ---------------------------------------------------------------------------
// plain-language rendering
// ---------------------------------------------------------------------------

/** Compact rendering of an expression, for step labels. */
export const exprText = (expr: Expr): string => {
  switch (expr.kind) {
    case "lit":
      return expr.value === null ? "absent" : typeof expr.value === "string" ? `"${expr.value}"` : String(expr.value)
    case "counter":
      return expr.collection
    case "request":
      return `request.${expr.field}`
    case "local":
      return expr.name
    case "row":
      return `${expr.collection}[${exprText(expr.key)}].${expr.field}`
    case "exists":
      return `exists ${expr.collection}[${exprText(expr.key)}]`
    case "count":
      return expr.where ? `count(${expr.collection} where ${exprText(expr.where)})` : `count(${expr.collection})`
    case "distinct":
      return `distinct(${expr.collection}.${expr.field})`
    case "sum":
      return `sum(${expr.collection}.${expr.field})`
    case "field":
      return `row.${expr.name}`
    case "arith":
      return `(${exprText(expr.left)} ${expr.op} ${exprText(expr.right)})`
    case "compare":
      return `${exprText(expr.left)} ${expr.op} ${exprText(expr.right)}`
    case "and":
      return expr.args.map(exprText).join(" and ")
    case "or":
      return expr.args.map(exprText).join(" or ")
    case "not":
      return `not (${exprText(expr.arg)})`
    case "isNull":
      return `${exprText(expr.arg)} is absent`
    case "now":
      return "now"
  }
}

const fieldsText = (fields: Record<string, Expr>): string => {
  const entries = Object.entries(fields)
  if (entries.length === 0) return "{}"
  return `{ ${entries.map(([k, v]) => `${k}: ${exprText(v)}`).join(", ")} }`
}

const writeText = (op: {
  collection: string
  key: Expr | null
  mode: "set" | "delta"
  value: Expr | null
  fields: Record<string, Expr>
}): string => {
  if (op.key === null) {
    if (op.mode === "delta") {
      const delta = op.value ? exprText(op.value) : "?"
      return `${op.collection} ${delta.startsWith("-") ? "−" : "+"} ${delta.replace(/^-/, "")}`
    }
    return `${op.collection} = ${op.value ? exprText(op.value) : "?"}`
  }
  return `${op.collection}[${exprText(op.key)}] = ${fieldsText(op.fields)}`
}

/**
 * One sentence per operation, generated from its fields.
 *
 * Nested blocks are rendered by the caller, so `branch` and `atomic` describe only their
 * own line.
 */
export const describeStep = (op: Operation): string => {
  switch (op.op) {
    case "read":
      return `read ${exprText(op.value)} → ${op.into}`
    case "write":
      return writeText(op)
    case "conditionalWrite":
      return `if ${exprText(op.guard)} then ${writeText(op)}${op.into ? ` → ${op.into}` : ""}, indivisibly`
    case "insertUnique":
      return `insert ${op.collection}[${exprText(op.key)}] = ${fieldsText(op.fields)} unless present${op.into ? ` → ${op.into}` : ""}`
    case "atomic":
      return "in one transaction"
    case "acquireLease":
      return `acquire ${op.fencing ? "fenced " : ""}lease ${op.lock}[${exprText(op.key)}] for ${op.ttlMs}ms → ${op.into}`
    case "releaseLease":
      return `release lease ${op.lock}[${exprText(op.key)}]`
    case "publish":
      return `publish ${fieldsText(op.message)} to ${op.queue}`
    case "ack":
      return "acknowledge the message"
    case "branch":
      return `if ${exprText(op.cond)}`
    case "assign":
      return `${op.name} = ${exprText(op.value)}`
    case "scheduleExpiry":
      return `run ${op.handler} after ${op.afterMs}ms with ${fieldsText(op.args)}`
    case "respond":
      return `respond ${op.status}${op.outcome ? ` · ${op.outcome}` : ""}`
  }
}

/** What happens on the failure path of a guarded operation. */
export const conflictText = (op: Operation): string | null => {
  switch (op.op) {
    case "conditionalWrite":
      return op.onFail === "fail" ? "guard fails → request rejected" : "guard fails → continue"
    case "insertUnique":
      return op.onConflict === "fail" ? "already present → request rejected" : "already present → continue"
    case "acquireLease":
      return op.onBusy === "fail" ? "held by someone else → request rejected" : "held by someone else → continue"
    default:
      return null
  }
}

export const triggerText = (handler: Handler): string => {
  switch (handler.trigger.kind) {
    case "request":
      return "on each request"
    case "queue":
      return `on each message from ${handler.trigger.queue}`
    case "expiry":
      return "when a timer fires"
  }
}
