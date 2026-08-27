import { describe, expect, it } from "vitest";
import { DesignSchema, type Design } from "@sds/schema";
import { defaultDesign } from "@sds/models";
import { runSimulation } from "@sds/core";
import { previewDesign } from "../src/preview";
import { durationForRho, meanOf, relError, runReplications, SEEDS } from "./harness";

/**
 * ANALYTIC PREVIEW vs SIMULATION
 *
 * The studio shows an instant closed-form estimate while you drag a slider, and
 * runs the full simulation when you press Run. Two numbers for the same quantity,
 * produced by different code paths, shown in the same UI. If they can disagree
 * without anyone noticing, the preview is a liar with a fast response time.
 *
 * This file is the contract between them. It is the reason the closed-form solver
 * is a shared package rather than duplicated in the frontend: one implementation,
 * two consumers, and a test that pins them together.
 */

const MEAN_TOLERANCE = 0.03;
const TAIL_TOLERANCE = 0.05;

function chain(
  stations: Array<{ serviceMeanMs: number; c: number }>,
  lambda: number,
  edgeLatencyMs = 0
): Design {
  const nodes: unknown[] = [
    {
      id: "client",
      kind: "client",
      label: "client",
      x: 0,
      y: 0,
      client: { arrival: { kind: "poisson", ratePerSec: lambda }, timeoutMs: null },
    },
  ];
  const edges: unknown[] = [];
  let prev = "client";
  stations.forEach((s, i) => {
    const id = `s${i}`;
    nodes.push({
      id,
      kind: "server",
      label: id,
      x: 200 * (i + 1),
      y: 0,
      server: {
        concurrency: s.c,
        queueCapacity: null,
        serviceTime: { kind: "exponential", mean: s.serviceMeanMs },
        admissionPolicy: "block",
        queueDiscipline: "fifo",
        replicas: 1,
        blocksOnDependencies: false,
      },
    });
    edges.push({
      id: `e${i}`,
      from: prev,
      to: id,
      latency: { kind: "deterministic", value: edgeLatencyMs },
      lossProbability: 0,
    });
    prev = id;
  });
  return DesignSchema.parse({
    version: 2,
    name: "chain",
    nodes,
    edges,
    scenario: { durationSec: 400, warmupSec: 40, seed: 1, traceLimit: 0 },
    slo: { p99LatencyMs: null, maxErrorRatePct: null },
  });
}

function sized(design: Design, rho: number, lambda: number): Design {
  const { durationSec, warmupSec } = durationForRho(lambda, rho);
  return DesignSchema.parse({ ...design, scenario: { ...design.scenario, durationSec, warmupSec } });
}

describe("preview agrees with simulation: single station", () => {
  const cases = [
    { serviceMeanMs: 40, c: 1, rho: 0.5 },
    { serviceMeanMs: 40, c: 4, rho: 0.8 },
    { serviceMeanMs: 20, c: 8, rho: 0.85 },
  ];

  for (const { serviceMeanMs, c, rho } of cases) {
    const lambda = (rho * c * 1000) / serviceMeanMs;
    const design = sized(chain([{ serviceMeanMs, c }], lambda), rho, lambda);
    const preview = previewDesign(design);
    const results = () => runReplications(design, SEEDS);

    it(`utilization agrees for c=${c}, rho=${rho}`, () => {
      const node = preview.nodes.find((n) => n.nodeId === "s0")!;
      expect(relError(node.rho, rho)).toBeLessThan(1e-9);
      const measured = meanOf(
        results().map((r) => r.nodes.find((n) => n.nodeId === "s0")!.utilization)
      );
      expect(relError(measured, node.utilization)).toBeLessThan(MEAN_TOLERANCE);
    });

    it(`end-to-end mean agrees for c=${c}, rho=${rho}`, () => {
      expect(preview.endToEndMeanMs).not.toBeNull();
      const measured = meanOf(results().map((r) => r.endToEnd.mean));
      expect(relError(measured, preview.endToEndMeanMs!)).toBeLessThan(MEAN_TOLERANCE);
    });

    it(`end-to-end p99 agrees for c=${c}, rho=${rho}`, () => {
      // Exact for a single M/M/c station, so the preview is entitled to show it.
      expect(preview.endToEndP99Ms).not.toBeNull();
      const measured = meanOf(results().map((r) => r.endToEnd.p99));
      expect(relError(measured, preview.endToEndP99Ms!)).toBeLessThan(TAIL_TOLERANCE);
    });

    it(`throughput agrees for c=${c}, rho=${rho}`, () => {
      const measured = meanOf(results().map((r) => r.throughputPerSec));
      expect(relError(measured, preview.throughputPerSec)).toBeLessThan(MEAN_TOLERANCE);
    });
  }
});

describe("preview agrees with simulation: multi-station chain", () => {
  const stations = [
    { serviceMeanMs: 30, c: 1 },
    { serviceMeanMs: 20, c: 1 },
    { serviceMeanMs: 40, c: 2 },
  ];
  const lambda = 20;
  const edgeLatencyMs = 2;
  const design = sized(chain(stations, lambda, edgeLatencyMs), 0.6, lambda);
  const preview = previewDesign(design);

  it("end-to-end mean includes network latency and agrees with the simulation", () => {
    const measured = meanOf(runReplications(design, SEEDS).map((r) => r.endToEnd.mean));
    expect(preview.endToEndMeanMs).not.toBeNull();
    expect(relError(measured, preview.endToEndMeanMs!)).toBeLessThan(MEAN_TOLERANCE);
    // Network latency is real, not decorative: three 2ms hops must be in there.
    expect(preview.endToEndMeanMs!).toBeGreaterThan(3 * edgeLatencyMs);
  });

  it("per-station utilization agrees with the simulation", () => {
    const rs = runReplications(design, SEEDS);
    for (const node of preview.nodes) {
      const measured = meanOf(
        rs.map((r) => r.nodes.find((n) => n.nodeId === node.nodeId)!.utilization)
      );
      expect(relError(measured, node.utilization)).toBeLessThan(MEAN_TOLERANCE);
    }
  });

  it("withholds the end-to-end p99 rather than guessing at it", () => {
    /**
     * The agreed rule: the preview never shows a number it cannot defend. Summing
     * per-station p99s is the obvious shortcut and it materially overstates the
     * tail, so the preview declines and says why.
     */
    expect(preview.endToEndP99Ms).toBeNull();
    expect(preview.p99Reason).toMatch(/convolution/);
  });

  it("identifies the bottleneck station", () => {
    // s0 at 30ms/1 server carries rho = 0.6; s2 at 40ms/2 servers only 0.4.
    expect(preview.bottleneckNodeId).toBe("s0");
    expect(preview.bottleneckUtilization).toBeCloseTo(0.6, 9);
  });
});

describe("preview refuses to report on an unstable design", () => {
  it("reports instability rather than a latency estimate", () => {
    const lambda = 60;
    const design = chain([{ serviceMeanMs: 20, c: 1 }], lambda);
    const preview = previewDesign(design);
    expect(preview.stable).toBe(false);
    expect(preview.nodes[0]!.rho).toBeCloseTo(1.2, 9);
    expect(preview.endToEndMeanMs).toBeNull();
    expect(preview.endToEndP99Ms).toBeNull();
    expect(preview.notes.join(" ")).toMatch(/saturated/);
  });

  it("the simulation independently agrees the design is unstable", () => {
    const design = sized(chain([{ serviceMeanMs: 20, c: 1 }], 60), 0.99, 60);
    const r = runSimulation(design, { collectTrace: false });
    expect(r.stability.stable).toBe(false);
    expect(previewDesign(design).stable).toBe(false);
  });
});

describe("preview flags its own approximations", () => {
  it("marks non-exponential multi-server stations as approximate", () => {
    // Allen-Cunneen is an approximation for M/G/c and is labelled as one. A number
    // whose accuracy is unknown to its reader is worse than no number.
    const design = DesignSchema.parse({
      version: 2,
      name: "lognormal service",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 100 } } },
        {
          id: "s0",
          kind: "server",
          label: "s0",
          x: 1,
          y: 0,
          server: { concurrency: 8, serviceTime: { kind: "lognormal", mean: 40, p99: 200 } },
        },
      ],
      edges: [{ id: "e0", from: "client", to: "s0" }],
      scenario: {},
      slo: {},
    });
    const preview = previewDesign(design);
    expect(preview.approximate).toBe(true);
    expect(preview.nodes[0]!.model).toBe("M/G/c (approx)");
    expect(preview.nodes[0]!.p99Ms).toBeNull();
    expect(preview.notes.join(" ")).toMatch(/Allen-Cunneen/);
  });

  it("uses exact Pollaczek-Khinchine for a single-server non-exponential station", () => {
    const design = DesignSchema.parse({
      version: 2,
      name: "deterministic service",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 25 } } },
        {
          id: "s0",
          kind: "server",
          label: "s0",
          x: 1,
          y: 0,
          server: { concurrency: 1, serviceTime: { kind: "deterministic", value: 20 } },
        },
      ],
      edges: [{ id: "e0", from: "client", to: "s0" }],
      scenario: { durationSec: 800, warmupSec: 80 },
      slo: {},
    });
    const preview = previewDesign(design);
    expect(preview.nodes[0]!.model).toBe("M/G/1");
    expect(preview.approximate).toBe(false);
    // P-K: Wq = rho/(1-rho) * (1+0)/2 * E[S], rho = 0.5 => 10ms.
    expect(preview.nodes[0]!.wqMs).toBeCloseTo(10, 6);
    const measured = meanOf(
      runReplications(design, SEEDS).map((r) => r.nodes.find((n) => n.nodeId === "s0")!.avgWaitMs)
    );
    expect(relError(measured, 10)).toBeLessThan(MEAN_TOLERANCE);
  });

  it("uses M/M/c/K for a shedding station and predicts the rejection rate", () => {
    const design = DesignSchema.parse({
      version: 2,
      name: "shedding",
      nodes: [
        { id: "client", kind: "client", label: "c", x: 0, y: 0, client: { arrival: { kind: "poisson", ratePerSec: 150 } } },
        {
          id: "s0",
          kind: "server",
          label: "s0",
          x: 1,
          y: 0,
          server: {
            concurrency: 4,
            queueCapacity: 10,
            admissionPolicy: "shed",
            serviceTime: { kind: "exponential", mean: 40 },
          },
        },
      ],
      edges: [{ id: "e0", from: "client", to: "s0" }],
      scenario: { durationSec: 600, warmupSec: 60 },
      slo: {},
    });
    const preview = previewDesign(design);
    expect(preview.nodes[0]!.model).toBe("M/M/c/K");
    // Offered load exceeds capacity, yet the design is stable: the queue is
    // bounded, so latency stays finite and the excess turns into rejections.
    expect(preview.stable).toBe(true);
    expect(preview.nodes[0]!.rho).toBeGreaterThan(1);
    expect(preview.nodes[0]!.blockingProbability).toBeGreaterThan(0);

    const rs = runReplications(design, SEEDS);
    const measuredBlocking = meanOf(
      rs.map((r) => {
        const st = r.nodes.find((n) => n.nodeId === "s0")!;
        return st.shed / st.arrivals;
      })
    );
    expect(relError(measuredBlocking, preview.nodes[0]!.blockingProbability)).toBeLessThan(
      MEAN_TOLERANCE
    );
    expect(
      relError(meanOf(rs.map((r) => r.throughputPerSec)), preview.throughputPerSec)
    ).toBeLessThan(MEAN_TOLERANCE);
  });
});

describe("preview handles the shipped default design", () => {
  it("agrees with the simulation on the design the app opens with", () => {
    // The default is deliberately at rho = 0.8, just past the knee, so the first
    // thing a new user sees is a system under real pressure rather than a flat
    // green dashboard.
    const design = defaultDesign();
    const preview = previewDesign(design);
    expect(preview.nodes[0]!.rho).toBeCloseTo(0.8, 6);

    const r = runSimulation(design, { collectTrace: false });
    expect(relError(r.endToEnd.mean, preview.endToEndMeanMs!)).toBeLessThan(0.06);
    expect(relError(r.endToEnd.p99, preview.endToEndP99Ms!)).toBeLessThan(0.1);
  });
});
