import { describe, expect, it } from "vitest";
import { assumptionsFor, EXPLORER_VERSION } from "@sds/explore";
import { pizzaStudy } from "@sds/models";
import { FaultModelSchema } from "@sds/schema";

describe("replicated correctness scope", () => {
  it("states the exact logical-search boundary and excludes general liveness", () => {
    const design = structuredClone(pizzaStudy().candidates[0]!.design);
    const database = design.nodes.find((node) => node.kind === "database")!.database!;
    database.isolationLevel = "serializable";
    database.replicaGroup = {
      id: "primary-rg",
      replicas: 3,
      readQuorum: 2,
      writeQuorum: 2,
      replicationLag: { kind: "deterministic", value: 0 },
      maxClockSkewMs: 25,
    };

    const assumptions = assumptionsFor(design, FaultModelSchema.parse({})).join(" ");
    expect(assumptions).toContain("one logical state per database");
    expect(assumptions).toContain("quorum intersection");
    expect(assumptions).toContain("general liveness are out of scope");
    expect(assumptions).toContain("N=3, R=2, W=2");
    expect(EXPLORER_VERSION).toBe("explore-2");
  });
});
