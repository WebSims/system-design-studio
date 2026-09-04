import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");

describe("user-facing add and remove parity", () => {
  it.each([
    ["panels/IssueRegistry.tsx", /add issue/, /Confirm permanent issue deletion/],
    ["panels/WorkloadEditor.tsx", /add step/, /Remove workload step/],
    ["panels/WorkloadEditor.tsx", /add class/, /Remove class/],
    ["panels/BehaviourRail.tsx", /add a rule/, /title="remove"/],
    ["panels/BehaviourEditor.tsx", /\+ add step/, /title="remove step"/],
    ["panels/BehaviourEditor.tsx", /\+ request handler/, /title="remove this handler"/],
    ["panels/BehaviourEditor.tsx", /\+ counter/, /function CollectionCard[\s\S]*title="remove"/],
    ["panels/SimulationControls.tsx", /Add to scenario/, /title="Remove failure"/],
    ["canvas/CanvasEditingToolbar.tsx", /Add frame/, /Delete selection/],
    ["canvas/CanvasEditingToolbar.tsx", /Add text note/, /Delete selection/],
    ["panels/CandidateBar.tsx", /New version/, /className="chip-remove"/],
    ["chrome/StartScreen.tsx", /New project/, /Delete this project/],
  ])("keeps a removal path for additions in %s", (path, addControl, removeControl) => {
    const text = source(path);
    expect(text).toMatch(addControl);
    expect(text).toMatch(removeControl);
  });
});
