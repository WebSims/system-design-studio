import type { Expr, Invariant, InvariantScope } from "@sds/schema";

/**
 * The guided invariant builder.
 *
 * WHY TEMPLATES RATHER THAN AN EXPRESSION EDITOR
 *
 * Because the hard part of writing an invariant is not the syntax, it is knowing WHICH property to
 * assert and whether it belongs in safety or in postconditions. A tree editor over the expression
 * language would let a learner build `inventory + claims == initial` as a safety invariant in about
 * four clicks, and that invariant is false in every correct design -- it is transiently violated
 * whenever a handler is halfway through. They would then conclude the tool is broken, which is the
 * worst outcome available.
 *
 * So the guided path offers the properties that are actually worth asserting, each with the scope
 * that makes it true and an explanation of why. The expert path is the raw declarative JSON, which
 * is the same object. A template is a CONSTRUCTOR, not a second representation: there is nothing to
 * lose by switching, and nothing to keep in sync.
 *
 * DOM-FREE, so the templates and the expressions they produce are unit-testable in node.
 */

export interface TemplateParam {
  name: string;
  label: string;
  kind: "collection" | "field" | "number";
  /** Restrict a collection parameter to counters or to tables. */
  of?: "counter" | "table";
}

export interface InvariantTemplate {
  id: string;
  label: string;
  explanation: string;
  /** The scope this property is true in. Offered as a default, and changeable. */
  defaultScope: InvariantScope;
  params: TemplateParam[];
  build(args: Record<string, string | number>): Expr;
  suggestLabel(args: Record<string, string | number>): string;
  suggestMessage(args: Record<string, string | number>): string;
}

const lit = (value: number | string | boolean): Expr => ({ kind: "lit", value });
const counter = (collection: string): Expr => ({ kind: "counter", collection });
const countOf = (collection: string): Expr => ({ kind: "count", collection, where: null });
const distinctOf = (collection: string, field: string): Expr => ({
  kind: "distinct",
  collection,
  field,
  where: null,
});

export const invariantTemplates: InvariantTemplate[] = [
  {
    id: "counter-non-negative",
    label: "a counter never goes below zero",
    explanation:
      "The most basic scarcity statement. Catches a decrement applied more times than there was stock, which is what a lost update looks like from the outside.",
    defaultScope: "safety",
    params: [{ name: "collection", label: "counter", kind: "collection", of: "counter" }],
    build: (a) => ({ kind: "compare", op: ">=", left: counter(String(a.collection)), right: lit(0) }),
    suggestLabel: (a) => `${a.collection} never goes below zero`,
    suggestMessage: (a) =>
      `${a.collection} went negative, so at least one allocation had nothing behind it.`,
  },

  {
    id: "rows-within-counter",
    label: "no more rows than a starting count",
    explanation:
      "Compare a table's row count against a counter that is never written -- a recorded starting figure. Written this way the rule survives the exploration seeding the stock down to one, which is what makes it falsifiable at all.",
    defaultScope: "safety",
    params: [
      { name: "table", label: "table of allocations", kind: "collection", of: "table" },
      { name: "limit", label: "counter holding the starting figure", kind: "collection", of: "counter" },
    ],
    build: (a) => ({
      kind: "compare",
      op: "<=",
      left: countOf(String(a.table)),
      right: counter(String(a.limit)),
    }),
    suggestLabel: (a) => `never allocate more than ${a.limit}`,
    suggestMessage: (a) =>
      `More rows in ${a.table} than ${a.limit} allowed. Somebody is going to be told there is nothing for them.`,
  },

  {
    id: "one-per-key",
    label: "at most one row per person",
    explanation:
      "Every row's value in the chosen field is distinct. This is the rule half of the shipped portfolio gets wrong, and it cannot be written down at all without a distinct count.",
    defaultScope: "safety",
    params: [
      { name: "table", label: "table", kind: "collection", of: "table" },
      { name: "field", label: "field that identifies the person", kind: "field" },
    ],
    build: (a) => ({
      kind: "compare",
      op: "==",
      left: distinctOf(String(a.table), String(a.field)),
      right: countOf(String(a.table)),
    }),
    suggestLabel: (a) => `at most one ${a.table} row per ${a.field}`,
    suggestMessage: (a) =>
      `One ${a.field} has two rows in ${a.table}. Because supply is fixed, somebody else got none.`,
  },

  {
    id: "accounting-not-exceeded",
    label: "allocated plus remaining never exceeds the start",
    explanation:
      "The accounting identity, as an inequality and as a POSTCONDITION. Both of those matter. As an equality it fails whenever a worker crashed between decrementing and recording, which is waste rather than an oversell. As a safety invariant it fails in every correct design, because a handler is briefly halfway through.",
    defaultScope: "postcondition",
    params: [
      { name: "remaining", label: "counter of what is left", kind: "collection", of: "counter" },
      { name: "table", label: "table of allocations", kind: "collection", of: "table" },
      { name: "start", label: "counter holding the starting figure", kind: "collection", of: "counter" },
    ],
    build: (a) => ({
      kind: "compare",
      op: "<=",
      left: {
        kind: "arith",
        op: "+",
        left: counter(String(a.remaining)),
        right: countOf(String(a.table)),
      },
      right: counter(String(a.start)),
    }),
    suggestLabel: () => "units are never created out of nothing",
    suggestMessage: (a) =>
      `Once everything settled, ${a.remaining} plus the rows in ${a.table} came to more than ${a.start}. Something was counted twice.`,
  },

  {
    id: "counter-at-most",
    label: "a counter never exceeds a fixed value",
    explanation:
      "A ceiling on a counter. Useful when a compensating path can add back, because an over-eager refund shows up here and nowhere else.",
    defaultScope: "safety",
    params: [
      { name: "collection", label: "counter", kind: "collection", of: "counter" },
      { name: "max", label: "ceiling", kind: "number" },
    ],
    build: (a) => ({
      kind: "compare",
      op: "<=",
      left: counter(String(a.collection)),
      right: lit(Number(a.max)),
    }),
    suggestLabel: (a) => `${a.collection} never exceeds ${a.max}`,
    suggestMessage: (a) => `${a.collection} rose above ${a.max}, so something was credited twice.`,
  },
];

export function templateFor(id: string): InvariantTemplate | undefined {
  return invariantTemplates.find((t) => t.id === id);
}

export interface InvariantDraft {
  templateId: string;
  label: string;
  message: string;
  scope: InvariantScope;
  args: Record<string, string | number>;
}

export type BuildResult =
  | { ok: true; invariant: Invariant }
  | { ok: false; reason: string };

/**
 * Turn a draft into an invariant, or say what is missing.
 *
 * Returns a reason rather than throwing, because this runs on every keystroke while a form is half
 * filled in. "choose a counter" is a prompt; an exception is a bug report.
 *
 * The label and message fall back to the template's suggestions. The message in particular is worth
 * defaulting: an invariant with no message produces a counterexample that states a mechanical fact
 * and says nothing about what it costs, and a reader who cannot see the cost will not act on the
 * finding.
 */
export function buildInvariant(draft: InvariantDraft): BuildResult {
  const template = templateFor(draft.templateId);
  if (!template) return { ok: false, reason: `unknown rule "${draft.templateId}"` };

  for (const param of template.params) {
    const value = draft.args[param.name];
    if (value === undefined || value === "" || (param.kind === "number" && !Number.isFinite(Number(value)))) {
      return { ok: false, reason: `choose ${param.label}` };
    }
  }

  const expr = template.build(draft.args);
  const label = draft.label.trim() || template.suggestLabel(draft.args);
  const message = draft.message.trim() || template.suggestMessage(draft.args);

  return {
    ok: true,
    invariant: {
      id: slugify(label) || `invariant-${Date.now().toString(36)}`,
      label,
      scope: draft.scope,
      expr,
      message,
    },
  };
}

/**
 * A one-line reading of an invariant, in English.
 *
 * Generated from the expression, so it describes what will actually be checked rather than what the
 * label claims. A label and an expression that disagree is a real failure mode -- somebody edits the
 * expression in expert mode and leaves the label -- and the only way to catch it is to render the
 * expression back into words next to the label.
 */
export function describeInvariant(invariant: Invariant): string {
  const when =
    invariant.scope === "safety" ? "after every transition" : "once everything has finished";
  return `${when}: ${readExpr(invariant.expr)}`;
}

export function readExpr(expr: Expr): string {
  switch (expr.kind) {
    case "lit":
      return expr.value === null ? "absent" : JSON.stringify(expr.value);
    case "counter":
      return expr.collection;
    case "request":
      return `the request's ${expr.field}`;
    case "local":
      return `the local ${expr.name}`;
    case "row":
      return `${expr.collection}[${readExpr(expr.key)}].${expr.field}`;
    case "exists":
      return `a row exists in ${expr.collection} for ${readExpr(expr.key)}`;
    case "count":
      return expr.where
        ? `the number of rows in ${expr.collection} where ${readExpr(expr.where)}`
        : `the number of rows in ${expr.collection}`;
    case "distinct":
      return `the number of distinct ${expr.field} values in ${expr.collection}`;
    case "sum":
      return `the total of ${expr.field} across ${expr.collection}`;
    case "field":
      return `the row's ${expr.name}`;
    case "arith":
      return `(${readExpr(expr.left)} ${expr.op} ${readExpr(expr.right)})`;
    case "compare":
      return `${readExpr(expr.left)} ${readCompare(expr.op)} ${readExpr(expr.right)}`;
    case "and":
      return expr.args.map(readExpr).join(" and ");
    case "or":
      return expr.args.map(readExpr).join(" or ");
    case "not":
      return `not (${readExpr(expr.arg)})`;
    case "isNull":
      return `${readExpr(expr.arg)} is absent`;
    case "now":
      return "the current logical time";
  }
}

function readCompare(op: string): string {
  switch (op) {
    case "==":
      return "equals";
    case "!=":
      return "is not";
    case "<":
      return "is less than";
    case "<=":
      return "is at most";
    case ">":
      return "is more than";
    case ">=":
      return "is at least";
    default:
      return op;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
