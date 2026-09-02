import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pizzaStudy } from "@sds/models";
import { checkCandidate } from "@sds/explore";
import { StudySchema, blankStudy, validateStudy, type Counterexample } from "@sds/schema";
import {
  layoutCounterexample,
  verdictHeadline,
  describeFault,
  SYSTEM_LANE,
} from "../src/correctness/layout";
import {
  buildInvariant,
  describeInvariant,
  invariantTemplates,
  readExpr,
  templateFor,
} from "../src/correctness/builder";
import { NODE_HEIGHT, NODE_WIDTH } from "../src/canvas/geometry";
import { exportStudy, importStudy, studyFilename, STUDY_EXTENSION } from "../src/persist";

/**
 * The studio's own logic, tested in node.
 *
 * Everything here is DOM-free by construction, which is the same discipline the packet choreography
 * follows and for the same reason: the layout of a counterexample, the construction of an invariant
 * and the derivation of a study from a questionnaire are all arithmetic over data, and arithmetic
 * should not need a browser to be checked.
 *
 * The counterexample layout in particular is tested against a REAL counterexample from the shipped
 * portfolio rather than a fixture, because the property that matters is that it can render what the
 * engine actually produces.
 */

const study = pizzaStudy();

describe("worked-example canvas layout", () => {
  it("keeps every pizza-study node clear of every other node", () => {
    const minimumGap = 48;

    for (const candidate of study.candidates) {
      for (let i = 0; i < candidate.design.nodes.length; i++) {
        const a = candidate.design.nodes[i]!;
        for (let j = i + 1; j < candidate.design.nodes.length; j++) {
          const b = candidate.design.nodes[j]!;
          const horizontallyClear =
            a.x + NODE_WIDTH + minimumGap <= b.x ||
            b.x + NODE_WIDTH + minimumGap <= a.x;
          const verticallyClear =
            a.y + NODE_HEIGHT + minimumGap <= b.y ||
            b.y + NODE_HEIGHT + minimumGap <= a.y;

          expect(
            horizontallyClear || verticallyClear,
            `${candidate.id}: ${a.id} overlaps ${b.id}`
          ).toBe(true);
        }
      }
    }
  });
});

function realCounterexample(candidateId: string): Counterexample {
  const result = checkCandidate(study, study.candidates.find((c) => c.id === candidateId)!);
  expect(result.counterexample, `${candidateId} should be violated`).not.toBeNull();
  return result.counterexample!;
}

// ---------------------------------------------------------------------------
// counterexample layout
// ---------------------------------------------------------------------------

describe("counterexample layout", () => {
  const ce = realCounterexample("c1-check-then-write");

  it("gives every step a column, so nothing silently vanishes from the swimlanes", () => {
    const layout = layoutCounterexample(ce);
    expect(layout.steps.length).toBe(ce.steps.length);
    for (const laid of layout.steps) {
      expect(laid.column).toBeGreaterThanOrEqual(0);
      expect(laid.column).toBeLessThan(layout.lanes.length);
    }
  });

  it("orders request lanes before consumers, timers and the environment", () => {
    const queueCe = realCounterexample("c4-queue-no-idempotency");
    const layout = layoutCounterexample(queueCe);
    const kinds = layout.lanes.map((l) => l.kind);
    const rank = { request: 0, "queue-consumer": 1, "expiry-timer": 2, system: 3 } as const;
    for (let i = 1; i < kinds.length; i++) {
      expect(rank[kinds[i]!]).toBeGreaterThanOrEqual(rank[kinds[i - 1]!]);
    }
  });

  it("invents a lane for an environment event rather than dropping the step", () => {
    // A redelivery or a lease expiry has no owning actor. If the layout dropped it, the trace would
    // no longer add up: the pivotal event in the stale-owner counterexample is exactly the one with
    // no actor behind it.
    const synthetic: Counterexample = {
      ...ce,
      lanes: [],
      steps: [
        { index: 0, laneId: "system", opId: "fault:expire-lease", opKind: "expire-lease", label: "the lease expires", fault: "lease-expiry", diffs: [], observed: {} },
      ],
    };
    const layout = layoutCounterexample(synthetic);
    expect(layout.lanes.map((l) => l.id)).toContain(SYSTEM_LANE.id);
    expect(layout.steps.length).toBe(1);
  });

  it("builds a state timeline that agrees with the trace it came from", () => {
    const layout = layoutCounterexample(ce);
    expect(layout.timeline.length).toBe(ce.steps.length);
    // The consistency check is why `before` is carried in every diff. A scrubber built on a fold
    // that disagreed with the trace would show a reader a state the system was never in.
    expect(layout.inconsistencies).toEqual([]);
  });

  it("the timeline's last frame shows the state that violated the invariant", () => {
    const layout = layoutCounterexample(ce);
    const last = layout.timeline.at(-1)!;
    // The lost update drives the counter below zero, and that is what the reader must see.
    expect(last.values.inventory).toBe("-1");
  });

  it("reports what each actor observed, which is the whole content of a lost update", () => {
    const layout = layoutCounterexample(ce);
    const observations = layout.steps.filter((s) => s.observedSummary.length > 0);
    expect(observations.length).toBeGreaterThanOrEqual(2);
    // Both actors read the same value before either wrote.
    expect(observations.filter((s) => s.observedSummary.includes("= 1")).length).toBeGreaterThanOrEqual(2);
  });

  it("explains it in prose, generated from the structure", () => {
    const layout = layoutCounterexample(ce);
    const prose = layout.explanation.join(" ");
    expect(prose).toContain("no shorter one exists");
    // No fault was needed for this one, and the explanation has to say so plainly, because that is
    // the difference between a bug that needs bad luck and one that needs traffic.
    expect(prose).toContain("NO FAULT WAS INJECTED");
    expect(prose).toContain("what it costs".toLowerCase().replace("what it costs", "What it costs"));
  });

  it("names the shared identity when two requests come from one person", () => {
    const layout = layoutCounterexample(ce);
    const prose = layout.explanation.join(" ");
    expect(prose).toMatch(/share the same userId|from different people/);
  });

  it("explains a fault-driven counterexample in terms of the fault", () => {
    const leaseCe = realCounterexample("c3-unfenced-lease");
    const prose = layoutCounterexample(leaseCe).explanation.join(" ");
    expect(prose).toContain("a lease expires while its holder is still working");
    expect(prose).toContain("ordinary event");
  });

  it("translates every fault kind into something a person can read", () => {
    for (const kind of [
      "duplicate-request",
      "retry-same-key",
      "retry-new-key",
      "worker-crash",
      "queue-redelivery",
      "lease-expiry",
      "reservation-expiry",
      "caller-timeout",
    ]) {
      const text = describeFault(kind);
      expect(text).not.toBe(kind);
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

describe("verdict headlines", () => {
  it("never call a bounded search a proof", () => {
    const ok = verdictHeadline("NO_VIOLATION_WITHIN_BOUNDS", { statesVisited: 700, capHit: "none" });
    expect(ok.tone).toBe("ok");
    expect(ok.text).toContain("not a proof of safety");
  });

  it("say plainly that an inconclusive run established nothing", () => {
    const inconclusive = verdictHeadline("INCONCLUSIVE_BOUND_REACHED", { statesVisited: 120, capHit: "states" });
    expect(inconclusive.tone).toBe("warn");
    // "Inconclusive" is the word people skim past, so the sentence says what it means instead of
    // naming it.
    expect(inconclusive.text).toContain("Nothing was established, in either direction");
  });

  it("distinguish a violated design from an unevaluable model", () => {
    expect(verdictHeadline("VIOLATED", { statesVisited: 26, capHit: "none" }).tone).toBe("crit");
    expect(verdictHeadline("INVALID_MODEL", { statesVisited: 0, capHit: "none" }).tone).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// the guided invariant builder
// ---------------------------------------------------------------------------

describe("the guided invariant builder", () => {
  it("offers the accounting identity as a POSTCONDITION by default", () => {
    // The mistake the wizard exists to prevent. As a safety invariant this property is transiently
    // false in every correct design, so a learner who built it that way would see all seven
    // candidates fail and conclude the tool was broken.
    const template = templateFor("accounting-not-exceeded")!;
    expect(template.defaultScope).toBe("postcondition");
    expect(template.explanation).toContain("halfway through");
  });

  it("offers scarcity and uniqueness as safety invariants", () => {
    expect(templateFor("counter-non-negative")!.defaultScope).toBe("safety");
    expect(templateFor("one-per-key")!.defaultScope).toBe("safety");
  });

  it("says what is missing instead of throwing while a form is half filled in", () => {
    const result = buildInvariant({
      templateId: "one-per-key",
      label: "",
      message: "",
      scope: "safety",
      args: { table: "claims" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("field that identifies the person");
  });

  it("builds the same expression the shipped study uses, from two clicks", () => {
    const built = buildInvariant({
      templateId: "one-per-key",
      label: "at most one pizza per person",
      message: "somebody got two",
      scope: "safety",
      args: { table: "claims", field: "userId" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const shipped = study.correctness.invariants.find((i) => i.id === "one-claim-per-person")!;
    // Identical expression. The guided form is a constructor, not a second representation, which is
    // why switching to expert mode mid-edit loses nothing.
    expect(built.invariant.expr).toEqual(shipped.expr);
  });

  it("defaults a message, because a counterexample with none states a fact and no cost", () => {
    const built = buildInvariant({
      templateId: "counter-non-negative",
      label: "",
      message: "",
      scope: "safety",
      args: { collection: "inventory" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.invariant.message.length).toBeGreaterThan(20);
    expect(built.invariant.label).toContain("inventory");
  });

  it("produces invariants the study validator accepts against a real candidate", () => {
    const built = invariantTemplates
      .map((t) =>
        buildInvariant({
          templateId: t.id,
          label: `test ${t.id}`,
          message: "test",
          scope: t.defaultScope,
          args: {
            collection: "inventory",
            counter: "inventory",
            table: "claims",
            field: "userId",
            limit: "initialInventory",
            remaining: "inventory",
            start: "initialInventory",
            max: 200,
          },
        })
      )
      .filter((r): r is { ok: true; invariant: never } => r.ok) as unknown as Array<{
      invariant: (typeof study)["correctness"]["invariants"][number];
    }>;

    expect(built.length).toBe(invariantTemplates.length);

    // The contract's promises are cleared alongside the invariants they cite. Leaving them would
    // produce `promise-invariant-missing` errors, which is the validator being right about a
    // different thing than this test is about -- and is itself worth knowing: swapping a study's
    // invariants without revisiting its promises leaves promises nothing checks.
    const withAll = StudySchema.parse({
      ...study,
      contract: { ...study.contract, promises: [] },
      correctness: { ...study.correctness, invariants: built.map((b) => b.invariant) },
    });
    const errors = validateStudy(withAll).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("reads an expression back into English, so a stale label is visible", () => {
    // The real failure mode: somebody edits the expression in expert mode and leaves the label. The
    // only way to catch it is to render the expression next to the label.
    const shipped = study.correctness.invariants.find((i) => i.id === "one-claim-per-person")!;
    const reading = describeInvariant(shipped);
    expect(reading).toContain("after every transition");
    expect(reading).toContain("distinct userId values in claims");
  });

  it("reads every expression node without falling back to JSON", () => {
    for (const invariant of study.correctness.invariants) {
      const reading = readExpr(invariant.expr);
      expect(reading).not.toContain("{");
      expect(reading.length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// import and export
// ---------------------------------------------------------------------------

describe("study import and export", () => {
  it("round-trips a study exactly", () => {
    const json = exportStudy(study);
    expect(JSON.stringify(importStudy(json))).toBe(JSON.stringify(StudySchema.parse(study)));
  });

  it("accepts a bare design file and wraps it", () => {
    const design = study.candidates[0]!.design;
    const imported = importStudy(JSON.stringify(design));
    expect(imported.candidates.length).toBe(1);
    // No correctness contract, which is the honest treatment of a document with no invariants.
    expect(imported.correctness.invariants).toEqual([]);
  });

  it("uses its own extension, so a study is not mistaken for a design", () => {
    expect(studyFilename(study)).toBe(`two-hundred-free-pizzas${STUDY_EXTENSION}`);
    expect(STUDY_EXTENSION).toBe(".sds-study.json");
  });

  it("copes with a name that has no usable characters", () => {
    expect(studyFilename({ ...study, name: "!!!" })).toBe(`study${STUDY_EXTENSION}`);
  });

  it("rejects a file that is neither", () => {
    expect(() => importStudy('{"hello":"world"}')).toThrow();
    expect(() => importStudy("not json")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// the app owns no problem of its own
// ---------------------------------------------------------------------------

describe("nothing in the app is wired to one domain", () => {
  const appSources = () => {
    const root = new URL("../src/", import.meta.url);
    const out: Array<{ path: string; text: string }> = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) walk(child);
        else if (/\.tsx?$/.test(entry.name)) {
          out.push({ path: child.pathname.split("/src/")[1]!, text: readFileSync(child, "utf8") });
        }
      }
    };
    walk(root);
    return out;
  };

  it("never imports the pizza study, which is an example and not a default", () => {
    // The regression this exists for shipped twice. The store booted into the pizza study, and
    // "new study" cloned its seven candidates and swapped the stock number -- so whatever problem
    // a user typed, they got a limited-inventory giveaway and somebody else's architectures.
    const offenders = appSources()
      .filter((f) => /\bpizzaStudy\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("reaches examples only through the registry, so every example is listed and openable", () => {
    // STUDY_EXAMPLES is the one door. An example imported directly would be reachable without
    // appearing in the menu, which is how a "default" grows back.
    const importers = appSources()
      .filter((f) => /from "@sds\/models"/.test(f.text))
      .filter((f) => /STUDY_EXAMPLES/.test(f.text))
      .map((f) => f.path);
    expect(importers.length).toBeGreaterThan(0);
  });

  it("creates an empty study with no invariants, candidates or domain assumptions", () => {
    const study = blankStudy({ id: "s1", name: "ticket sales", problem: "each seat once" });
    expect(study.candidates).toEqual([]);
    expect(study.correctness.invariants).toEqual([]);
    expect(study.targets.businessGoals).toEqual([]);
    expect(study.contract.outcomes ?? []).toEqual([]);
    // No collection names, no counters, nothing that presumes what is being built.
    expect(JSON.stringify(study)).not.toMatch(/inventory|pizza|claims/i);
  });
});
