import { describe, expect, it } from "vitest";
import { PRESETS } from "@sds/models";
import { checkCandidate } from "@sds/explore";
import {
  HandlerSchema,
  WorkflowSchema,
  blankDesign,
  blankStudy,
  validateWorkflow,
  type Design,
  type Handler,
  type Operation,
} from "@sds/schema";

import {
  SUGGESTED_STATE_OVERRIDES,
  applyPattern,
  behaviourPatterns,
  emptyWorkflow,
  suggestBinding,
  suggestedRules,
} from "../src/behaviour/patterns";
import {
  appendAt,
  blockAt,
  describeStep,
  exprText,
  freshOpId,
  isSchedulingPoint,
  localsBound,
  moveAt,
  removeAt,
} from "../src/behaviour/steps";

/**
 * Request-steps authoring, tested in node.
 *
 * The property that matters is the hero loop with no agent attached: a person draws a
 * service, a database and (maybe) a lock or a queue from the palette, picks a pattern,
 * presses Play, and the broken ones break. If a template validated but the explorer found
 * nothing, the editor would be teaching that the obvious implementation is fine.
 */

const PRESET_FOR_ID: Record<string, string> = {
  client: "client",
  server: "app-server",
  database: "postgres",
  lock: "lock",
  queue: "queue",
};
const buildNode = (id: string, x: number) => PRESETS.find((p) => p.id === PRESET_FOR_ID[id])!.build(id, x, 240);

/** What a person gets by clicking palette entries: one of each, laid out left to right. */
function drawnDesign(extra: Array<"lock" | "queue"> = []): Design {
  const design = blankDesign({ name: "drawn by hand" });
  design.nodes = ["client", "server", "database", ...extra].map((id, i) => buildNode(id, i * 300));
  return design;
}

function studyFor(design: Design) {
  const study = blankStudy({ id: "test-behaviour", now: 0 });
  study.candidates[0] = { ...study.candidates[0]!, design };
  study.correctness = {
    ...study.correctness,
    invariants: suggestedRules(),
    stateOverrides: SUGGESTED_STATE_OVERRIDES,
  };
  return study;
}

describe("behaviour patterns", () => {
  it("every pattern binds to a palette drawing and produces a valid workflow", () => {
    for (const pattern of behaviourPatterns) {
      const design = drawnDesign(pattern.needs);
      const suggestion = suggestBinding(design, pattern, "server", 200);
      expect(suggestion.missing, pattern.id).toBeNull();
      applyPattern(design, pattern, suggestion.binding!);

      expect(() => WorkflowSchema.parse(design.workflow), pattern.id).not.toThrow();
      const errors = validateWorkflow(design).filter((i) => i.severity === "error");
      expect(errors, `${pattern.id}: ${errors.map((e) => e.message).join("; ")}`).toEqual([]);
    }
  });

  it("refuses to bind when the drawing lacks what the pattern needs, and says what", () => {
    const noStore = blankDesign();
    noStore.nodes = [buildNode("server", 0)];
    expect(suggestBinding(noStore, behaviourPatterns[0]!, null, 1).missing).toMatch(/database/);

    const lease = behaviourPatterns.find((p) => p.id === "fenced-lease")!;
    expect(suggestBinding(drawnDesign(), lease, null, 1).missing).toMatch(/lock/);

    const queue = behaviourPatterns.find((p) => p.id === "queue-worker")!;
    expect(suggestBinding(drawnDesign(), queue, null, 1).missing).toMatch(/queue/);
  });

  it("the suggested rules are the three the demo teaches", () => {
    expect(suggestedRules().map((r) => r.id)).toEqual([
      "inventory-never-goes-below-zero",
      "never-allocate-more-than-initialinventory",
      "at-most-one-claims-row-per-userid",
    ]);
  });

  it("the broken patterns break and the safe ones do not, with the suggested contract", () => {
    for (const pattern of behaviourPatterns) {
      const design = drawnDesign(pattern.needs);
      applyPattern(design, pattern, suggestBinding(design, pattern, "server", 200).binding!);
      const study = studyFor(design);
      const result = checkCandidate(study, study.candidates[0]!);

      if (pattern.verdict === "broken") {
        expect(result.status, pattern.id).toBe("VIOLATED");
        expect(result.counterexample, pattern.id).not.toBeNull();
      } else {
        expect(result.status, pattern.id).not.toBe("VIOLATED");
      }
    }
  }, 60_000);

  it("the empty workflow is valid, so 'start empty' never produces a red inspector", () => {
    const design = drawnDesign();
    design.workflow = emptyWorkflow(suggestBinding(design, behaviourPatterns[0]!, "server", 5).binding!);
    expect(validateWorkflow(design).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("step editing", () => {
  const handler = (): Handler => ({
    id: "h",
    label: "",
    trigger: { kind: "request" },
    node: "server",
    steps: [
      { op: "read", id: "read-stock", value: { kind: "counter", collection: "inventory" }, into: "left" },
      {
        op: "branch",
        id: "have-stock",
        cond: { kind: "compare", op: ">", left: { kind: "local", name: "left" }, right: { kind: "lit", value: 0 } },
        then: [{ op: "respond", id: "ok", status: "success", outcome: "allocated" }],
        else: [],
      },
    ],
  });

  it("addresses nested blocks by path", () => {
    const h = handler();
    expect(blockAt(h.steps, [])).toBe(h.steps);
    expect(blockAt(h.steps, [1, "then"])!.length).toBe(1);
    expect(blockAt(h.steps, [1, "else"])!.length).toBe(0);
    expect(blockAt(h.steps, [0, "then"])).toBeNull();
    expect(blockAt(h.steps, [1, "body"])).toBeNull();
  });

  it("appends, moves and removes inside the addressed block", () => {
    const h = handler();
    const soldOut: Operation = { op: "respond", id: "soldout", status: "rejected", outcome: "soldOut" };
    expect(appendAt(h.steps, [1, "else"], soldOut)).toBe(true);
    expect(blockAt(h.steps, [1, "else"])![0]!.id).toBe("soldout");

    expect(moveAt(h.steps, [], 1, -1)).toBe(true);
    expect(h.steps[0]!.id).toBe("have-stock");
    expect(moveAt(h.steps, [], 0, -1)).toBe(false);

    expect(removeAt(h.steps, [], 0)).toBe(true);
    expect(h.steps.map((s) => s.id)).toEqual(["read-stock"]);
    expect(removeAt(h.steps, [], 5)).toBe(false);

    expect(() => HandlerSchema.parse(h)).not.toThrow();
  });

  it("mints ids that collide with nothing, including nested ids", () => {
    const h = handler();
    expect(freshOpId(h, "decrement")).toBe("decrement");
    expect(freshOpId(h, "ok")).toBe("ok-2");
    expect(freshOpId(h, "have-stock")).toBe("have-stock-2");
  });

  it("knows which locals exist and which steps are scheduling points", () => {
    const h = handler();
    expect(localsBound(h.steps)).toEqual(["left"]);
    expect(isSchedulingPoint(h.steps[0]!)).toBe(true);
    expect(isSchedulingPoint(h.steps[1]!)).toBe(false);
  });

  it("describes steps from their fields, never from a label", () => {
    const h = handler();
    expect(describeStep(h.steps[0]!)).toBe("read inventory → left");
    expect(describeStep(h.steps[1]!)).toBe("if left > 0");
    expect(
      describeStep({ op: "write", id: "d", collection: "inventory", key: null, mode: "delta", value: { kind: "lit", value: -1 }, fields: {} })
    ).toBe("inventory − 1");
    expect(
      describeStep({
        op: "insertUnique",
        id: "i",
        collection: "claims",
        key: { kind: "request", field: "userId" },
        fields: { userId: { kind: "request", field: "userId" } },
        onConflict: "continue",
        into: "mine",
      })
    ).toBe("insert claims[request.userId] = { userId: request.userId } unless present → mine");
    expect(exprText({ kind: "compare", op: "==", left: { kind: "distinct", collection: "claims", field: "userId", where: null }, right: { kind: "count", collection: "claims", where: null } })).toBe(
      "distinct(claims.userId) == count(claims)"
    );
  });
});
