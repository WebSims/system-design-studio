import { readFileSync } from "node:fs";
import { PRESETS } from "@sds/models";
import { NodeSchema } from "@sds/schema";
import { describe, expect, it } from "vitest";
import { PRESET_GROUPS } from "../src/chrome/presetGroups";
import { parseNullableNumber } from "../src/panels/controls";

describe("component and option coverage", () => {
  it("keeps every component preset reachable from the palette exactly once", () => {
    const paletteIds = PRESET_GROUPS.flatMap((group) => group.presets.map((preset) => preset.id));
    expect(paletteIds).toHaveLength(PRESETS.length);
    expect(new Set(paletteIds).size).toBe(PRESETS.length);
    expect(new Set(paletteIds)).toEqual(new Set(PRESETS.map((preset) => preset.id)));

    for (const [index, preset] of PRESETS.entries()) {
      expect(NodeSchema.safeParse(preset.build(`${preset.id}-${index}`, index * 10, 20)).success).toBe(true);
    }
  });

  it("distinguishes an absent limit from a strict zero limit", () => {
    expect(parseNullableNumber("")).toBeNull();
    expect(parseNullableNumber("   ")).toBeNull();
    expect(parseNullableNumber("0", 0)).toBe(0);
    expect(parseNullableNumber("-5", 0)).toBe(0);
    expect(parseNullableNumber("120", 0, 100)).toBe(100);
    expect(parseNullableNumber("not-a-number")).toBeUndefined();
  });

  it("exposes every executable component and resilience setting in the Inspector", () => {
    const inspector = readFileSync(new URL("../src/panels/Inspector.tsx", import.meta.url), "utf8");
    const requiredModelFields = [
      "healthCheck.minimumRequests",
      "server.queueDiscipline",
      "queue.delivery",
      "queue.requireAck",
      "queue.visibilityTimeoutMs",
      "queue.maxRedeliveries",
      "lock.failureProbability",
      "backoff.maxMs",
      "circuitBreaker.minimumRequests",
      "circuitBreaker.windowMs",
      "circuitBreaker.halfOpenProbes",
      "resources.cpuUnits",
      "resources.memoryMb",
      "resources.storageMb",
      "resources.connectionSlots",
      "resources.networkBytesPerRequest",
    ];
    for (const field of requiredModelFields) expect(inspector, field).toContain(field);

    expect(inspector).toContain('hint="blank = unbounded"');
    expect(inspector).toContain('hint="% extra calls · blank = unlimited"');
    expect(inspector).not.toContain("budgetRatio = v <= 0 ? null");
    expect(inspector).not.toContain("onCapacity(v <= 0 ? null");
  });

  it("exposes the full project workload contract and preserves a zero-error SLO", () => {
    const workload = readFileSync(new URL("../src/panels/WorkloadEditor.tsx", import.meta.url), "utf8");
    expect(workload).toContain("w.traceLimit");
    expect(workload).toContain("value={slo.maxErrorRatePct}");
    expect(workload).toContain("onChange={(v) => setSlo({ maxErrorRatePct: v })}");
    expect(workload).not.toContain("maxErrorRatePct: v <= 0 ? null : v");
  });
});
