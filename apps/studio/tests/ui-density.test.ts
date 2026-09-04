import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Guided and Expert interface density", () => {
  it("uses one global choice for visible progressive disclosure", () => {
    const topbar = readFileSync(new URL("../src/chrome/Topbar.tsx", import.meta.url), "utf8");
    const disclosure = readFileSync(new URL("../src/panels/DensitySection.tsx", import.meta.url), "utf8");
    const inspector = readFileSync(new URL("../src/panels/Inspector.tsx", import.meta.url), "utf8");
    const behaviour = readFileSync(new URL("../src/panels/BehaviourRail.tsx", import.meta.url), "utf8");
    const simulation = readFileSync(new URL("../src/panels/SimulationControls.tsx", import.meta.url), "utf8");
    const workload = readFileSync(new URL("../src/panels/WorkloadEditor.tsx", import.meta.url), "utf8");

    expect(topbar).toContain('"Core controls" : "All controls"');
    expect(disclosure).toContain('guided: false, expert: true');
    expect(disclosure).toContain('current[density] === nextOpen');
    expect(inspector.match(/<DensitySection/g)?.length).toBeGreaterThanOrEqual(3);
    expect(behaviour).toContain('uiDensity === "expert" && <ExpertExpression');
    expect(simulation).toContain('title="failure timeline"');
    expect(workload).toContain('title="advanced project controls"');
  });
});
