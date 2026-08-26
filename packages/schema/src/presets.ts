import { DESIGN_SCHEMA_VERSION, DesignSchema, type Design } from "./design";

/**
 * The Phase 1 slice: one Poisson client feeding one capacity-limited server.
 *
 * These exact numbers are chosen so the default view opens in a legible regime:
 * lambda = 80/s, c = 4, service mean 40ms => mu_total = 100/s, rho = 0.8.
 * That is deliberately just past the knee, so the tool's first impression is
 * "this is near saturation" rather than a flat green dashboard.
 */
export function defaultDesign(): Design {
  return DesignSchema.parse({
    version: DESIGN_SCHEMA_VERSION,
    name: "single service",
    nodes: [
      {
        id: "client",
        kind: "client",
        label: "web client",
        x: 80,
        y: 220,
        client: { arrival: { kind: "poisson", ratePerSec: 80 }, timeoutMs: null },
      },
      {
        id: "api",
        kind: "server",
        label: "api server",
        x: 460,
        y: 220,
        server: {
          concurrency: 4,
          queueCapacity: null,
          serviceTime: { kind: "exponential", mean: 40 },
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
        },
      },
    ],
    edges: [
      {
        id: "e1",
        from: "client",
        to: "api",
        latency: { kind: "deterministic", value: 1 },
        lossProbability: 0,
      },
    ],
    // 1200s of simulated time at 80 req/s gives ~80,000 measured requests, which
    // is what rho = 0.8 needs for ~1% accuracy. It costs a fraction of a second
    // of wall clock.
    scenario: { durationSec: 1200, warmupSec: 200, seed: 1, traceLimit: 5000 },
    slo: { p99LatencyMs: 250, maxErrorRatePct: 1 },
  });
}
