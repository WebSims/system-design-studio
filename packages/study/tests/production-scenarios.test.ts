import { describe, expect, it } from "vitest";
import { cachedReadPath, defaultDesign } from "@sds/models";
import { CandidateSchema, StudySchema, blankStudy } from "@sds/schema";
import {
  PRODUCTION_SCENARIO_RECIPES,
  chooseFailureTarget,
  runProductionScenarioSuite,
} from "../src/index";

describe("the standard production suite", () => {
  it("reports every named probe, including model gaps rather than hiding them", () => {
    const candidate = CandidateSchema.parse({
      id: "baseline",
      label: "as-is",
      role: "baseline",
      design: defaultDesign(),
    });
    const study = StudySchema.parse({
      ...blankStudy({ id: "production-suite", now: 1 }),
      candidates: [candidate],
      activeCandidateId: candidate.id,
    });

    const results = runProductionScenarioSuite({ study, candidate });

    expect(results.map((result) => result.kind)).toEqual(
      PRODUCTION_SCENARIO_RECIPES.map((recipe) => recipe.kind)
    );
    expect(results.find((result) => result.kind === "concurrency-race")?.status).toBe(
      "inconclusive"
    );
    expect(results.find((result) => result.kind === "traffic-spike")?.metrics).toEqual(
      expect.objectContaining({ peakRatePerSec: expect.any(Number) })
    );
    expect(results.find((result) => result.kind === "dependency-degradation")).toEqual(
      expect.objectContaining({ targetNodeId: "api", status: expect.any(String) })
    );
    expect(() => results.map((result) => JSON.stringify(result))).not.toThrow();
  });

  it("chooses the shared datastore before an entry service as the degradation target", () => {
    const target = chooseFailureTarget(cachedReadPath());
    expect(target?.node?.kind).toBe("database");
    expect(target?.edge).toBeNull();
  });
});
