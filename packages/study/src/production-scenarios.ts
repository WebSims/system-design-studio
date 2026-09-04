import { runSimulation } from "@sds/core";
import { offeredRate, rampToFailure, spikeTest } from "@sds/analyze";
import { checkCandidate } from "@sds/explore";
import {
  DesignSchema,
  validateDesign,
  type Candidate,
  type CorrectnessResult,
  type Design,
  type ProductionScenarioKind,
  type ProductionScenarioResult,
  type SdsEdge,
  type SdsNode,
  type Study,
} from "@sds/schema";

/** The user-facing contract for the standard production suite. */
export const PRODUCTION_SCENARIO_RECIPES: ReadonlyArray<{
  kind: ProductionScenarioKind;
  label: string;
  description: string;
}> = [
  {
    kind: "concurrency-race",
    label: "Concurrent requests + retries",
    description: "Search bounded interleavings for duplicate work, stale writes and crash windows.",
  },
  {
    kind: "traffic-spike",
    label: "3× traffic spike",
    description: "Hold three times normal traffic for 30 seconds, then measure whether the backlog drains.",
  },
  {
    kind: "capacity-ramp",
    label: "Ramp to the SLO boundary",
    description: "Raise offered load until latency or errors first cross the project target.",
  },
  {
    kind: "dependency-degradation",
    label: "30% dependency degradation",
    description: "Degrade a high-impact dependency and measure blast radius, retries and caller exhaustion.",
  },
];

interface SuiteInput {
  study: Study;
  candidate: Candidate;
  /** Reuse a correctness result when the same evaluation already produced one. */
  correctness?: CorrectnessResult | null;
}

/**
 * Run the fixed production suite against one already-synchronised candidate.
 *
 * Each probe fails independently. A model gap in one scenario must not erase the useful results
 * from the other three, which is why exceptions become explicit `inconclusive` results rather
 * than rejecting the whole evaluation.
 */
export function runProductionScenarioSuite({
  study,
  candidate,
  correctness,
}: SuiteInput): ProductionScenarioResult[] {
  const designErrors = validateDesign(candidate.design).filter((issue) => issue.severity === "error");
  const results = [
    safely("concurrency-race", () => concurrencyScenario(study, candidate, correctness)),
  ];

  if (designErrors.length > 0) {
    const reason = designErrors.map((issue) => issue.message).join("; ");
    for (const kind of [
      "traffic-spike",
      "capacity-ramp",
      "dependency-degradation",
    ] as const) {
      results.push(
        inconclusive(
          kind,
          `The performance model is invalid: ${reason}`,
          "Fix the model errors, then run this production scenario again."
        )
      );
    }
    return results;
  }

  results.push(
    safely("traffic-spike", () => trafficSpikeScenario(candidate.design)),
    safely("capacity-ramp", () => capacityRampScenario(candidate.design)),
    safely("dependency-degradation", () => dependencyDegradationScenario(candidate.design))
  );
  return results;
}

function concurrencyScenario(
  study: Study,
  candidate: Candidate,
  reused: CorrectnessResult | null | undefined
): ProductionScenarioResult {
  if (!candidate.design.workflow || study.correctness.invariants.length === 0) {
    return inconclusive(
      "concurrency-race",
      "No executable workflow and invariant set is available, so concurrency cannot be explored.",
      "Ask the agent to model the write workflow and define the business invariant that must remain true."
    );
  }

  const result = reused ?? checkCandidate(study, candidate);
  const metrics = {
    statesVisited: result.stats.statesVisited,
    transitionsApplied: result.stats.transitionsApplied,
    counterexampleSteps: result.counterexample?.steps.length ?? null,
    faultsUsed: result.counterexample?.faultsUsed.length ?? 0,
  };

  if (result.status === "VIOLATED" && result.counterexample) {
    return scenario({
      kind: "concurrency-race",
      status: "critical",
      summary: result.counterexample.message || `${result.counterexample.invariantLabel} is violated.`,
      evidence:
        `${result.claim} The minimal counterexample takes ${result.counterexample.steps.length} transitions` +
        (result.counterexample.faultsUsed.length > 0
          ? ` and uses ${result.counterexample.faultsUsed.join(", ")}.`
          : " with ordinary concurrency and no injected fault."),
      recommendation:
        "Open Correctness and step through the counterexample before changing the design. Make the violated state transition atomic or idempotent, then rerun the same bounds.",
      metrics,
      assumptions: result.assumptions,
    });
  }

  if (result.status === "NO_VIOLATION_WITHIN_BOUNDS") {
    return scenario({
      kind: "concurrency-race",
      status: "healthy",
      summary: "No invariant violation was found inside the configured concurrency and fault bounds.",
      evidence: result.claim,
      recommendation:
        "Keep this as bounded evidence, not a proof. Raise actors, transitions or fault depth when production risk justifies a wider search.",
      metrics,
      assumptions: result.assumptions,
    });
  }

  return scenario({
    kind: "concurrency-race",
    status: "inconclusive",
    summary:
      result.status === "INVALID_MODEL"
        ? "The workflow model is invalid, so the concurrency result establishes nothing."
        : "The search reached a configured bound before it exhausted the state space.",
    evidence: result.claim || result.modelErrors.join("; ") || "No defensible verdict was produced.",
    recommendation:
      result.status === "INVALID_MODEL"
        ? "Fix the workflow model errors, then rerun the scenario."
        : `Raise the ${result.stats.capHit} bound or narrow the fault model, then rerun.`,
    metrics,
    assumptions: result.assumptions,
  });
}

function trafficSpikeScenario(design: Design): ProductionScenarioResult {
  if (!design.nodes.some((node) => node.client)) {
    return inconclusive(
      "traffic-spike",
      "No client node offers load, so there is no traffic to spike.",
      "Add or identify the workload entrypoint and its normal request rate."
    );
  }

  const spike = spikeTest(design, {
    multiple: 3,
    durationSec: 30,
    runSec: 300,
    seed: design.scenario.seed,
  });
  const p99Multiple =
    spike.baselineP99Ms > 0 ? spike.worstP99Ms / spike.baselineP99Ms : null;
  const status =
    !spike.survivedSpike || spike.recoverySec === null
      ? "critical"
      : (p99Multiple ?? 1) >= 1.5 || spike.recoverySec > 30
        ? "warning"
        : "healthy";
  const recovery =
    spike.recoverySec === null ? "did not recover before the run ended" : `recovered in ${fmt(spike.recoverySec)}s`;

  return scenario({
    kind: "traffic-spike",
    status,
    summary: `At ${fmt(spike.peakRatePerSec)}/s, p99 reached ${fmt(spike.worstP99Ms)}ms and ${recovery}.`,
    evidence:
      `Normal load was ${fmt(spike.baseRatePerSec)}/s with ${fmt(spike.baselineP99Ms)}ms windowed p99. ` +
      `The 30-second spike raised load to ${fmt(spike.peakRatePerSec)}/s. ${spike.note}`,
    recommendation:
      status === "healthy"
        ? "Keep the measured recovery time as an operating threshold and alert before backlog age exceeds it."
        : "Add headroom or explicit load shedding at the named bottleneck, bound asynchronous queues, and rerun until recovery is finite and inside the incident budget.",
    metrics: {
      baseRatePerSec: spike.baseRatePerSec,
      peakRatePerSec: spike.peakRatePerSec,
      baselineP99Ms: spike.baselineP99Ms,
      worstP99Ms: spike.worstP99Ms,
      recoverySec: spike.recoverySec,
    },
    targetNodeId: spike.result.stability.worstNodeId,
    assumptions: [
      "The spike preserves the modeled traffic mix and lasts 30 simulated seconds.",
      design.slo.p99LatencyMs === null
        ? "No p99 SLO is set, so survival is judged relative to the pre-spike latency."
        : `Survival is judged against the ${fmt(design.slo.p99LatencyMs)}ms p99 target.`,
    ],
  });
}

function capacityRampScenario(design: Design): ProductionScenarioResult {
  const current = offeredRate(design);
  const ramp = rampToFailure(design, {
    fromRatePerSec: Math.max(0.1, current * 0.25),
    toRatePerSec: Math.max(1, current * 4),
    durationSec: 360,
    seed: design.scenario.seed,
  });

  if (ramp.unavailableReason && ramp.breachRatePerSec === null) {
    return inconclusive(
      "capacity-ramp",
      ramp.unavailableReason,
      design.slo.p99LatencyMs === null && design.slo.maxErrorRatePct === null
        ? "Set a p99 latency target or an error budget so the ramp has a boundary to cross."
        : "Add a modeled client workload, then run the ramp again."
    );
  }

  if (ramp.breachRatePerSec === null) {
    return scenario({
      kind: "capacity-ramp",
      status: "healthy",
      summary: `The project SLO held through the ${fmt(ramp.finalRatePerSec)}/s test ceiling.`,
      evidence: ramp.unavailableReason ?? ramp.note,
      recommendation:
        "Raise the ramp ceiling if the real peak could exceed this rate; this run establishes a lower bound, not the actual capacity limit.",
      metrics: {
        currentRatePerSec: current,
        breachRatePerSec: null,
        testedToRatePerSec: ramp.finalRatePerSec,
        headroomPct: null,
      },
      targetNodeId: ramp.result.stability.worstNodeId,
      assumptions: ["The ramp increases the modeled traffic mix linearly over 360 simulated seconds."],
    });
  }

  const headroom = current > 0 ? ramp.breachRatePerSec / current - 1 : null;
  const status = headroom !== null && headroom < 0 ? "critical" : headroom !== null && headroom < 0.3 ? "warning" : "healthy";
  return scenario({
    kind: "capacity-ramp",
    status,
    summary:
      `The first ${ramp.breach ?? "SLO"} breach appeared at ${fmt(ramp.breachRatePerSec)}/s` +
      (headroom === null ? "." : `, ${signedPct(headroom)} from the current ${fmt(current)}/s.`),
    evidence: `${ramp.note} The breach occurred ${fmt(ramp.breachAtSec ?? 0)}s into the ramp.`,
    recommendation:
      status === "healthy"
        ? "Use this measured boundary for capacity planning, leaving incident and growth headroom below it."
        : "Inspect the highlighted bottleneck and create an experiment that moves the boundary at least 30% above expected peak load.",
    metrics: {
      currentRatePerSec: current,
      breachRatePerSec: ramp.breachRatePerSec,
      breachAtSec: ramp.breachAtSec,
      testedToRatePerSec: ramp.finalRatePerSec,
      headroomPct: headroom === null ? null : headroom * 100,
    },
    targetNodeId: ramp.result.stability.worstNodeId,
    assumptions: [
      "A ramp slightly overstates sustainable capacity because queues lag behind rising load.",
      "The current modeled traffic mix is preserved while its total rate changes.",
    ],
  });
}

function dependencyDegradationScenario(design: Design): ProductionScenarioResult {
  const target = chooseFailureTarget(design);
  if (!target) {
    return inconclusive(
      "dependency-degradation",
      "No failure-capable dependency or network link exists in the current model.",
      "Model the service dependency or network edge whose failure should be contained."
    );
  }

  const seed = design.scenario.seed;
  const runDesign = DesignSchema.parse({
    ...design,
    scenario: { ...design.scenario, traceLimit: 0 },
  });
  const degradedDesign = degrade(runDesign, target);
  const baseline = runSimulation(runDesign, { seed, collectTrace: false });
  const degraded = runSimulation(degradedDesign, { seed, collectTrace: false });

  const errorIncreasePct = degraded.errors.ratePct - baseline.errors.ratePct;
  const throughputLossFraction =
    baseline.throughputPerSec > 0
      ? Math.max(0, 1 - degraded.throughputPerSec / baseline.throughputPerSec)
      : 0;
  const p99Multiple =
    baseline.endToEnd.p99 > 0 ? degraded.endToEnd.p99 / baseline.endToEnd.p99 : null;
  const retryAmplification = degraded.retryAmplification;
  const status =
    !degraded.stability.stable || retryAmplification >= 1.5 || errorIncreasePct >= 20
      ? "critical"
      : errorIncreasePct >= 5 || throughputLossFraction >= 0.2 || (p99Multiple ?? 1) >= 2
        ? "warning"
        : "healthy";
  const targetLabel = target.node?.label ?? `${target.edge!.from} → ${target.edge!.to}`;

  return scenario({
    kind: "dependency-degradation",
    status,
    summary:
      `${targetLabel} at 30% failure produced ${signed(errorIncreasePct)} percentage points of errors, ` +
      `${fmt(throughputLossFraction * 100)}% throughput loss and ${fmt(retryAmplification)}× retry load.`,
    evidence:
      `Baseline: ${fmt(baseline.errors.ratePct)}% errors, ${fmt(baseline.endToEnd.p99)}ms p99, ` +
      `${fmt(baseline.throughputPerSec)}/s. Degraded: ${fmt(degraded.errors.ratePct)}% errors, ` +
      `${fmt(degraded.endToEnd.p99)}ms p99, ${fmt(degraded.throughputPerSec)}/s. ` +
      (degraded.stability.retryStormWarning ?? degraded.stability.detail),
    recommendation:
      status === "healthy"
        ? "The modeled blast radius is contained. Verify the same breaker, bulkhead and fallback behavior exists in code and telemetry."
        : retryAmplification >= 1.5
          ? "Put a bounded retry budget on calls to this dependency, then add a circuit breaker and bulkhead so its failure cannot consume every caller slot."
          : "Add a circuit breaker and bulkhead on callers, define the degraded response, and rerun until the failure stays inside its traffic path.",
    metrics: {
      injectedFailurePct: 30,
      baselineErrorRatePct: baseline.errors.ratePct,
      degradedErrorRatePct: degraded.errors.ratePct,
      errorIncreasePct,
      baselineP99Ms: baseline.endToEnd.p99,
      degradedP99Ms: degraded.endToEnd.p99,
      p99Multiple,
      throughputLossPct: throughputLossFraction * 100,
      retryAmplification,
    },
    targetNodeId: target.node?.id ?? null,
    targetEdgeId: target.edge?.id ?? null,
    assumptions: [
      "The selected high-impact dependency or link fails independently on 30% of attempts.",
      "The baseline and degraded runs use the same random seed and workload.",
    ],
  });
}

type FailureTarget = { node: SdsNode; edge: null } | { node: null; edge: SdsEdge };

/** Choose a deterministic, high-fan-in failure target so repeated runs test the same dependency. */
export function chooseFailureTarget(design: Design): FailureTarget | null {
  const incoming = new Map<string, number>();
  for (const edge of design.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const kindWeight: Record<string, number> = { database: 4, lock: 3, server: 2 };
  const nodes = design.nodes
    .filter((node) => node.server || node.database || node.lock)
    .map((node) => ({
      node,
      score: (incoming.get(node.id) ?? 0) * 10 + (kindWeight[node.kind] ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  if (nodes[0]) return { node: nodes[0].node, edge: null };

  const edges = [...design.edges].sort(
    (a, b) => (incoming.get(b.to) ?? 0) - (incoming.get(a.to) ?? 0) || a.id.localeCompare(b.id)
  );
  return edges[0] ? { node: null, edge: edges[0] } : null;
}

function degrade(design: Design, target: FailureTarget): Design {
  if (target.node) {
    return DesignSchema.parse({
      ...design,
      nodes: design.nodes.map((node) => {
        if (node.id !== target.node.id) return node;
        if (node.server) {
          return { ...node, server: { ...node.server, failureProbability: Math.max(0.3, node.server.failureProbability) } };
        }
        if (node.database) {
          return { ...node, database: { ...node.database, failureProbability: Math.max(0.3, node.database.failureProbability) } };
        }
        if (node.lock) {
          return { ...node, lock: { ...node.lock, failureProbability: Math.max(0.3, node.lock.failureProbability) } };
        }
        return node;
      }),
    });
  }
  return DesignSchema.parse({
    ...design,
    edges: design.edges.map((edge) =>
      edge.id === target.edge.id
        ? {
            ...edge,
            network: {
              ...edge.network,
              lossProbability: Math.max(0.3, edge.network.lossProbability),
            },
          }
        : edge
    ),
  });
}

function safely(
  kind: ProductionScenarioKind,
  run: () => ProductionScenarioResult
): ProductionScenarioResult {
  try {
    return run();
  } catch (error) {
    return inconclusive(
      kind,
      `The scenario could not complete: ${error instanceof Error ? error.message : String(error)}`,
      "Check the model inputs and run this scenario again."
    );
  }
}

function inconclusive(
  kind: ProductionScenarioKind,
  evidence: string,
  recommendation: string
): ProductionScenarioResult {
  return scenario({
    kind,
    status: "inconclusive",
    summary: "This scenario needs more model information before it can make a claim.",
    evidence,
    recommendation,
    metrics: {},
  });
}

function scenario(
  input: Omit<ProductionScenarioResult, "id" | "label" | "targetNodeId" | "targetEdgeId" | "assumptions"> &
    Partial<Pick<ProductionScenarioResult, "targetNodeId" | "targetEdgeId" | "assumptions">>
): ProductionScenarioResult {
  const recipe = PRODUCTION_SCENARIO_RECIPES.find((item) => item.kind === input.kind)!;
  return {
    id: input.kind,
    label: recipe.label,
    targetNodeId: input.targetNodeId ?? null,
    targetEdgeId: input.targetEdgeId ?? null,
    assumptions: input.assumptions ?? [],
    ...input,
  };
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${fmt(value)}`;
}

function signedPct(fraction: number): string {
  return `${fraction >= 0 ? "+" : ""}${fmt(fraction * 100)}%`;
}
