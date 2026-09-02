import { collectionById, type Expr, type Literal, type Workflow } from "@sds/schema";
import type { Row, WorldState } from "./state";

/**
 * The expression evaluator.
 *
 * TOTAL. NEVER THROWS. NEVER RETURNS NaN OR Infinity.
 *
 * That is not defensive programming, it is a correctness requirement of the explorer.
 * A transition either happens or does not; there is no third outcome in which the
 * state is half-changed because an expression blew up two operations into a
 * transaction. So every partial operation -- a missing row, a missing local, a division
 * by zero, a comparison between a string and a number -- resolves to a value rather
 * than to an exception.
 *
 * The value it resolves to is ABSENT, written `null` here, and absent is deliberately
 * contagious in arithmetic and deliberately false in logic:
 *
 *   null + 1        => null      arithmetic on nothing is nothing
 *   null == 1       => false     nothing is not one
 *   null == null    => true      nothing is nothing
 *   isNull(null)    => true      the only way to test for it
 *   not(null)       => true      absent is falsy, so its negation is true
 *
 * SQL made the other choice for comparison -- NULL = NULL is unknown -- and it is the
 * right choice for a query language answering questions about data whose absence is
 * meaningful. It is the wrong choice here, because a three-valued logic in an invariant
 * means an invariant can be neither satisfied nor violated, and the tool would have to
 * report a third correctness verdict that nobody could act on. Two values, and
 * `isNull` for when the distinction matters.
 *
 * WHY DIVISION BY ZERO IS ABSENT RATHER THAN AN ERROR
 *
 * Because Infinity and NaN both break canonical hashing -- NaN is not equal to itself,
 * so a state containing one would never be recognised as already visited, and the
 * search would run forever finding "new" states that are the same state.
 */

/** The absent value. Distinct from `false` and from `0`. */
export type Value = Literal | null;

export interface EvalContext {
  wf: Workflow;
  world: WorldState;
  /** Locals bound by this actor. */
  locals: Record<string, Literal>;
  /** Generated fields of the request, message body, or timer args this actor carries. */
  request: Row;
  /** Row bound by an enclosing aggregate filter, if any. */
  row: Row | null;
}

export function evaluate(expr: Expr, ctx: EvalContext): Value {
  switch (expr.kind) {
    case "lit":
      return expr.value;

    case "counter": {
      const v = ctx.world.counters[expr.collection];
      return v === undefined ? null : v;
    }

    case "request": {
      const v = ctx.request[expr.field];
      return v === undefined ? null : v;
    }

    case "local": {
      const v = ctx.locals[expr.name];
      return v === undefined ? null : v;
    }

    case "row": {
      const key = evaluate(expr.key, ctx);
      if (key === null) return null;
      const row = ctx.world.tables[expr.collection]?.[String(key)];
      if (!row) return null;
      const v = row[expr.field];
      return v === undefined ? null : v;
    }

    case "exists": {
      const key = evaluate(expr.key, ctx);
      if (key === null) return false;
      return ctx.world.tables[expr.collection]?.[String(key)] !== undefined;
    }

    case "count": {
      const table = ctx.world.tables[expr.collection];
      if (!table) return 0;
      // Unfiltered count is the row count, with no array built and nothing sorted. Reached on
      // every safety check of every state, so this is not a micro-optimisation: aggregate
      // evaluation was the dominant cost of the entire search before this path existed.
      if (expr.where === null) return countRows(table);
      let n = 0;
      forEachRow(table, expr.where, ctx, () => {
        n++;
      });
      return n;
    }

    case "distinct": {
      const table = ctx.world.tables[expr.collection];
      if (!table) return 0;
      const seen = new Set<string>();
      forEachRow(table, expr.where, ctx, (r) => {
        const v = r[expr.field];
        // Rows missing the field are not counted as a distinct value. Counting them
        // as one shared "absent" bucket would make "at most one claim per user" pass
        // for a table full of rows with no user at all.
        if (v !== undefined) seen.add(`${typeof v}:${String(v)}`);
      });
      return seen.size;
    }

    case "sum": {
      const table = ctx.world.tables[expr.collection];
      if (!table) return 0;
      let total = 0;
      forEachRow(table, expr.where, ctx, (r) => {
        const v = r[expr.field];
        if (typeof v === "number") total += v;
      });
      return total;
    }

    case "field": {
      if (!ctx.row) return null;
      const v = ctx.row[expr.name];
      return v === undefined ? null : v;
    }

    case "arith": {
      const l = evaluate(expr.left, ctx);
      const r = evaluate(expr.right, ctx);
      if (typeof l !== "number" || typeof r !== "number") return null;
      switch (expr.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          // Integer division, truncated toward zero. State is integral by design (see
          // `FieldType`) because floating point would make canonical hashing depend on
          // the order arithmetic happened to be performed in.
          return r === 0 ? null : Math.trunc(l / r);
        case "%":
          return r === 0 ? null : l % r;
      }
      return null;
    }

    case "compare": {
      const l = evaluate(expr.left, ctx);
      const r = evaluate(expr.right, ctx);
      switch (expr.op) {
        case "==":
          return sameValue(l, r);
        case "!=":
          return !sameValue(l, r);
        default:
          break;
      }
      if (typeof l !== "number" || typeof r !== "number") return false;
      switch (expr.op) {
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case ">":
          return l > r;
        case ">=":
          return l >= r;
      }
      return false;
    }

    case "and": {
      // Short-circuits, which matters: `and([exists(k), row(k).confirmed])` is the
      // idiomatic guard, and evaluating the second term against a missing row would
      // yield absent -- falsy, so the result is the same either way, but the
      // short-circuit keeps the aggregate scans off the hot path.
      for (const a of expr.args) if (!truthy(evaluate(a, ctx))) return false;
      return true;
    }

    case "or": {
      for (const a of expr.args) if (truthy(evaluate(a, ctx))) return true;
      return false;
    }

    case "not":
      return !truthy(evaluate(expr.arg, ctx));

    case "isNull":
      return evaluate(expr.arg, ctx) === null;

    case "now":
      return ctx.world.nowMs;
  }
}

/**
 * Absent and `false` are both falsy; everything else including `0` and `""` is truthy.
 *
 * `0` being truthy is the surprising one and it is correct: a guard is written as an
 * explicit comparison (`counter > 0`), never as a bare number, and treating zero as
 * false would silently turn `read inventory into n; branch on n` into a check that
 * passes for every value except the one that matters.
 */
export function truthy(v: Value): boolean {
  return v !== null && v !== false;
}

/** Equality across the value domain. Different types are never equal. */
export function sameValue(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  return a === b;
}

/**
 * Visit the rows of a table that match an optional filter.
 *
 * NOT SORTED, AND THAT IS SOUND RATHER THAN SLOPPY.
 *
 * An earlier version sorted the keys, on the reasoning that an aggregate must not depend on
 * which interleaving inserted first. The reasoning was right and the sort was the wrong fix:
 * `count`, `distinct` and `sum` are commutative, so their results do not depend on visit
 * order at all, and the filter is side-effect free. The sort bought nothing and cost an array
 * allocation plus a comparison sort on every evaluation of every invariant at every state --
 * which measured as most of the search's running time.
 *
 * The visitor form rather than a returned array is the same argument: the aggregates never
 * need the rows collected, only folded.
 */
function forEachRow(
  table: Record<string, Row>,
  where: Expr | null,
  ctx: EvalContext,
  visit: (row: Row) => void
): void {
  if (where === null) {
    for (const key in table) visit(table[key]!);
    return;
  }
  // One reused context object rather than one per row. `evaluate` never retains it, so
  // mutating `row` between calls is safe and saves an allocation per row per evaluation.
  const scoped: EvalContext = { ...ctx, row: null };
  for (const key in table) {
    const row = table[key]!;
    scoped.row = row;
    if (truthy(evaluate(where, scoped))) visit(row);
  }
}

function countRows(table: Record<string, Row>): number {
  let n = 0;
  for (const _ in table) n++;
  return n;
}

/**
 * Evaluate an invariant, treating absent as VIOLATED.
 *
 * The asymmetry is on purpose and it is the only safe direction. An invariant that
 * cannot be evaluated -- because it names a collection this candidate does not have,
 * or reads a field that is missing -- has not been satisfied. Treating it as satisfied
 * would let a candidate pass a gate by failing to be checkable, which is the cheapest
 * possible way to game a correctness tool.
 */
export function invariantHolds(expr: Expr, ctx: EvalContext): boolean {
  const v = evaluate(expr, ctx);
  return v === true;
}

/** Used by the trace renderer, so a counterexample can print what an actor saw. */
export function describeValue(v: Value): string {
  if (v === null) return "absent";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

export function collectionKind(wf: Workflow, id: string): "counter" | "table" | null {
  return collectionById(wf, id)?.kind ?? null;
}
