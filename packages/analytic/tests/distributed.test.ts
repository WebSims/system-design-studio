import { describe, expect, it } from "vitest";
import { previewDesign } from "@sds/analytic";
import { DESIGN_SCHEMA_VERSION, DesignSchema } from "@sds/schema";

describe("bounded feedback preview", () => {
  it("expands expected async load to the configured hop budget without charging caller latency", () => {
    const design = DesignSchema.parse({
      version: DESIGN_SCHEMA_VERSION,
      name: "bounded feedback preview",
      nodes: [
        {
          id: "source",
          kind: "client",
          label: "source",
          x: 0,
          y: 0,
          client: { arrival: { kind: "poisson", ratePerSec: 1 } },
        },
        {
          id: "a",
          kind: "server",
          label: "A",
          x: 200,
          y: 0,
          server: {
            concurrency: 20,
            serviceTime: { kind: "deterministic", value: 1 },
            fanout: "sequential",
          },
        },
        {
          id: "b",
          kind: "server",
          label: "B",
          x: 400,
          y: 0,
          server: {
            concurrency: 20,
            serviceTime: { kind: "deterministic", value: 1 },
            fanout: "sequential",
          },
        },
      ],
      edges: [
        { id: "entry", from: "source", to: "a" },
        { id: "forward", from: "a", to: "b" },
        {
          id: "feedback",
          from: "b",
          to: "a",
          semantics: { kind: "asynchronous", channel: "event", maxHops: 2 },
        },
      ],
      scenario: { durationSec: 60, warmupSec: 10 },
      slo: {},
    });

    const preview = previewDesign(design);
    expect(preview.nodes.find((node) => node.nodeId === "a")?.arrivalRatePerSec).toBeCloseTo(3, 8);
    expect(preview.nodes.find((node) => node.nodeId === "b")?.arrivalRatePerSec).toBeCloseTo(3, 8);
    expect(preview.classes[0]?.endToEndMeanMs).toBeCloseTo(2, 8);
    expect(preview.notes.join(" ")).toMatch(/hop budget/);
  });
});
