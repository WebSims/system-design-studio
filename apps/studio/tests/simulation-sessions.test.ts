import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultDesign } from "@sds/models";
import { DesignSchema } from "@sds/schema";
import { SimulationSessionRegistry } from "../src/engine/sessions";
import { executableDesignChanged } from "../src/engine/executableDesign";

function shortDesign() {
  const design = defaultDesign();
  return DesignSchema.parse({
    ...design,
    scenario: { ...design.scenario, durationSec: 1, warmupSec: 0, traceLimit: 500 },
  });
}

describe("worker simulation sessions", () => {
  it("retains a completed session for trace replay", () => {
    const registry = new SimulationSessionRegistry();
    const design = shortDesign();
    const source = design.nodes.find((node) => node.kind === "client")!;
    const created = registry.create(design, { mode: "manual" });

    registry.injectRequest(created.sessionId, source.id);
    const completed = registry.finalize(created.sessionId);

    expect(completed.snapshot.status).toBe("completed");
    expect(completed.result).toEqual(registry.replay(created.sessionId));
    expect(registry.has(created.sessionId)).toBe(true);
  });

  it("stops invalidated sessions and keeps their reason inspectable", () => {
    const registry = new SimulationSessionRegistry();
    const created = registry.create(shortDesign(), { mode: "full" });
    const snapshot = registry.invalidate(created.sessionId, "executable design changed");

    expect(snapshot.status).toBe("invalidated");
    expect(snapshot.invalidationReason).toBe("executable design changed");
    expect(() => registry.advanceBy(created.sessionId, 10)).toThrow(/invalidated/);
  });

  it("uses one FailureEvent contract for worker-owned live injection", () => {
    const registry = new SimulationSessionRegistry();
    const created = registry.create(shortDesign(), { mode: "manual" });
    const event = {
      id: "interactive-api-down",
      kind: "node-outage" as const,
      targetNodeId: "api",
      startSec: 0,
      durationSec: 0.5,
    };
    const update = registry.injectFailure(created.sessionId, event);
    expect(update.snapshot.activeFailures).toEqual([event]);
  });

  it("invalidates model edits but not canvas-only movement", () => {
    const before = shortDesign();
    const moved = structuredClone(before);
    moved.nodes[0]!.x += 40;
    moved.nodes[0]!.y -= 20;
    expect(executableDesignChanged(before, moved)).toBe(false);

    const changed = structuredClone(before);
    const server = changed.nodes.find((node) => node.kind === "server")!;
    server.server!.concurrency += 1;
    expect(executableDesignChanged(before, changed)).toBe(true);
  });
});

describe("manual canvas contract", () => {
  it("maps one client click to one manual injection action", () => {
    const source = readFileSync(
      new URL("../src/canvas/FlowCanvas.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain('sessionMode === "manual" && node.type === "client"');
    expect(source).toContain("void injectRequest(node.id)");
  });

  it("streams full sessions in presentation-only batches", () => {
    const controls = readFileSync(
      new URL("../src/panels/SimulationControls.tsx", import.meta.url),
      "utf8"
    );
    expect(controls).toContain("advanceBy(1000 * session.presentationSpeed)");
    expect(controls).toContain("session.paused");
    expect(controls).toContain('aria-label="Simulation progress"');
    expect(controls).toContain("Add to scenario");
    expect(controls).toContain("Inject now");
    expect(controls).toContain("draft.scenario.failures.push(event)");
    expect(controls).toContain("session.activeFailures");
    expect(controls).toContain("packet MTU, congestion control and packet reordering");
  });
});
