import { previewDesign, type DesignPreview } from "@sds/analytic";
import type { NodeResult, RunResult } from "@sds/core";
import type { Design } from "@sds/schema";
import { criticalPath, type CriticalPath } from "./critical-path";
import { sloBreach } from "./knobs";

/**
 * THE FINDINGS ENGINE
 *
 * Turns measurements into a ranked list of things that are wrong and what to do
 * about them.
 *
 * TWO RULES, BOTH LOAD-BEARING
 *
 *  1. Every finding cites the numbers that produced it. A claim without its
 *     evidence cannot be checked, and an unfalsifiable warning is indistinguishable
 *     from a superstition. This is the difference between an analyzer and a linter
 *     with opinions.
 *
 *  2. Every finding names a specific change with specific values -- "pool 20 -> 60",
 *     not "consider tuning the pool". A recommendation the reader has to translate
 *     into an action is half a recommendation.
 *
 * Findings are ordered by severity and then by how much they explain, so the first
 * item is the one worth reading.
 */

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** What was measured, with numbers. */
  evidence: string;
  /** The specific change to make, with values. */
  remediation: string;
  nodeId?: string;
  edgeId?: string;
  /**
   * Rough share of the problem this explains, [0,1], where it can be estimated.
   * Used for ordering within a severity, not presented as precise.
   */
  weight: number;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface AnalysisReport {
  findings: Finding[];
  criticalPath: CriticalPath | null;
  preview: DesignPreview;
  /** Null when analysing a design that has not been simulated. */
  result: RunResult | null;
  summary: string;
}

const UTIL_CRITICAL = 0.85;
const UTIL_WARNING = 0.7;

/**
 * Analyse a design, optionally with a completed run.
 *
 * Works from the closed form alone when no run is supplied, which is what lets the
 * studio show findings while editing. Measured findings are strictly better and are
 * labelled as measured, because the two have different standing: a prediction is an
 * argument, a measurement is evidence.
 */
export function analyse(design: Design, result: RunResult | null = null): AnalysisReport {
  const preview = previewDesign(design);
  const findings: Finding[] = [];
  const path = result ? criticalPath(result) : null;

  const stations = (result?.nodes ?? []).filter((n) => n.kind !== "client");
  const measured = result !== null;

  // ---- instability ----
  if (result && !result.stability.stable) {
    const node = stations.find((n) => n.nodeId === result.stability.worstNodeId);
    findings.push({
      id: "instability",
      severity: "critical",
      title: "no steady state: the design does not scale at this load",
      evidence: result.stability.detail,
      remediation: node
        ? `"${node.label}" needs more capacity or less work per request. At c=${node.capacity} and ` +
          `${node.serviceMeanMs.toFixed(1)}ms of service it can serve about ` +
          `${((node.capacity * 1000) / Math.max(1e-9, node.serviceMeanMs)).toFixed(0)}/s against ` +
          `${node.arrivalRatePerSec.toFixed(0)}/s arriving. Nothing else in this report is ` +
          `meaningful until that gap closes.`
        : "reduce offered load or add capacity at the saturated station.",
      nodeId: node?.nodeId,
      weight: 1,
    });
  } else if (!preview.stable) {
    const b = preview.nodes.find((n) => n.nodeId === preview.bottleneckNodeId);
    const evidence = b
      ? `"${b.label}" is offered ${b.arrivalRatePerSec.toFixed(0)}/s with \u03c1 = ${b.rho.toFixed(2)}.`
      : "a station is offered more work than it can serve.";

    if (result) {
      /**
       * The closed form said unbounded; the simulation says bounded. Both are right,
       * and the reconciliation is the interesting part: a client deadline turns an
       * unbounded queue into a bounded one by abandoning requests. The queue stops
       * growing not because the design copes but because a fraction of the work is
       * being thrown away.
       *
       * Emitting the bare "predicted unstable" finding next to a run reporting
       * stability would look like the tool contradicting itself, when in fact it has
       * found something worth saying.
       */
      const timeouts = result.errors.timeout;
      const abandoning = timeouts > 0;
      findings.push({
        id: "instability-bounded-by-timeouts",
        severity: "critical",
        title: abandoning
          ? "over capacity, with the queue held down by abandonment"
          : "over capacity by the closed form, though the run stayed bounded",
        evidence:
          `${evidence} The measured run is nonetheless stable: ` +
          (abandoning
            ? `${timeouts.toLocaleString()} requests (${result.errors.ratePct.toFixed(1)}% of all ` +
              `traffic) gave up before completing, and p99 sits at ` +
              `${result.endToEnd.p99.toFixed(0)}ms against the client deadline. The deadline is what ` +
              `bounds the queue, not spare capacity.`
            : `queue lengths were stationary over the measurement window.`),
        remediation: abandoning
          ? `do not read the stable verdict as headroom. Removing the client deadline would let ` +
            `this queue grow without bound; keeping it means paying ` +
            `${result.errors.ratePct.toFixed(1)}% failures as the price of bounded latency. Add ` +
            `capacity at "${b?.label ?? "the bottleneck"}" or shed deliberately at the edge, where ` +
            `it is visible.`
          : `add capacity at "${b?.label ?? "the bottleneck"}"; the run is close enough to the ` +
            `boundary that the two methods disagree.`,
        nodeId: b?.nodeId,
        weight: 1,
      });
    } else {
      findings.push({
        id: "instability-predicted",
        severity: "critical",
        title: "predicted to have no steady state",
        evidence,
        remediation: "run the simulation to confirm, then add capacity at the named station.",
        nodeId: b?.nodeId,
        weight: 1,
      });
    }
  }

  // ---- retry amplification ----
  if (result?.stability.retryStormWarning) {
    const worst = [...result.edges]
      .filter((e) => e.calls > 100)
      .sort((a, b) => b.amplification - a.amplification)[0];
    if (worst) {
      const hasBudget = design.edges.find((e) => e.id === worst.edgeId)?.policy.retry?.budgetRatio;
      findings.push({
        id: "retry-amplification",
        severity: "critical",
        title: "retries are manufacturing load",
        evidence:
          `"${worst.fromLabel}" \u2192 "${worst.toLabel}" issued ${worst.attempts.toLocaleString()} ` +
          `attempts for ${worst.calls.toLocaleString()} calls (${worst.amplification.toFixed(2)}\u00d7). ` +
          `The dependency is doing ${((worst.amplification - 1) * 100).toFixed(0)}% more work than ` +
          `the workload asks for.`,
        remediation:
          hasBudget == null
            ? `set a retry budget of 10% on this call. That caps amplification near 1.10\u00d7 however ` +
              `bad things get. Adding capacity at the dependency treats the symptom, and each ` +
              `additional tier multiplies again.`
            : `the existing ${(hasBudget * 100).toFixed(0)}% budget is not holding. Lower it, or ` +
              `reduce max attempts from ` +
              `${design.edges.find((e) => e.id === worst.edgeId)?.policy.retry?.maxAttempts ?? "?"}.`,
        edgeId: worst.edgeId,
        weight: 0.9,
      });
    }
  }

  // ---- async backlog ----
  const backlogWarning = result?.stability.asyncBacklogWarning ?? preview.asyncBacklogWarning;
  if (backlogWarning) {
    const q = stations.find((n) => n.queue && n.queue.backlogGrowthPerSec > 0.05);
    const qp = preview.nodes.find((n) => n.queue && !n.queue.backlogStable);
    findings.push({
      id: "async-backlog",
      severity: "critical",
      title: "queue backlog grows without bound, and no percentile shows it",
      evidence: backlogWarning,
      remediation: q
        ? `raise consumers from ${q.queue!.consumers} to at least ` +
          `${Math.ceil(q.queue!.consumers * (q.arrivalRatePerSec / Math.max(1e-9, q.queue!.drainCapacityPerSec)) * 1.2)}, ` +
          `or bound the queue so the failure becomes visible as publish errors instead of silent lag.`
        : qp
          ? `raise consumers so drain capacity exceeds ${qp.arrivalRatePerSec.toFixed(0)}/s.`
          : "raise consumer capacity or bound the queue.",
      nodeId: q?.nodeId ?? qp?.nodeId,
      weight: 0.9,
    });
  }

  // ---- saturation ----
  for (const n of stations) {
    if (n.queue) continue; // a queue's own health is reported above
    if (n.utilization < UTIL_WARNING) continue;
    const critical = n.utilization >= UTIL_CRITICAL;
    const share = path?.contributions.find((c) => c.id === n.nodeId)?.share ?? 0;
    findings.push({
      id: `saturation:${n.nodeId}`,
      severity: critical ? "critical" : "warning",
      title: `"${n.label}" is at ${(n.utilization * 100).toFixed(0)}% utilization`,
      evidence:
        `c=${n.capacity}, ${n.arrivalRatePerSec.toFixed(0)}/s arriving, mean queue ` +
        `${n.avgQueueLength.toFixed(2)} and ${n.avgWaitMs.toFixed(1)}ms of wait per visit` +
        (share > 0 ? `. Accounts for ${(share * 100).toFixed(0)}% of end-to-end mean latency.` : "."),
      remediation:
        `queueing delay grows as 1/(1-\u03c1), so at ${(n.utilization * 100).toFixed(0)}% a small ` +
        `traffic increase produces a large latency increase. ` +
        `Raising capacity from ${n.capacity} to ${Math.ceil(n.capacity / 0.65)} would bring \u03c1 to ` +
        `about 0.65, where the curve is still flat.`,
      nodeId: n.nodeId,
      weight: critical ? 0.8 : 0.4,
    });
  }

  // ---- database pool vs parallelism ----
  for (const n of stations) {
    if (!n.database) continue;
    const db = n.database;
    if (db.poolSize > db.parallelism && db.avgExecutionWaitMs > db.avgPoolWaitMs * 2) {
      findings.push({
        id: `pool-oversized:${n.nodeId}`,
        severity: "info",
        title: `"${n.label}" pool is larger than its execution capacity`,
        evidence:
          `pool ${db.poolSize} at ${(db.poolUtilization * 100).toFixed(0)}%, execution ` +
          `${db.parallelism} at ${(db.executionUtilization * 100).toFixed(0)}%. Waits are ` +
          `${db.avgPoolWaitMs.toFixed(1)}ms at the pool against ${db.avgExecutionWaitMs.toFixed(1)}ms ` +
          `inside it.`,
        remediation:
          `throughput is capped at ${db.maxThroughputPerSec.toFixed(0)}/s by parallelism, not by ` +
          `connections. Raising the pool moves waiting inside the database, where it is harder to ` +
          `see; a SMALLER pool (try ${Math.max(2, db.parallelism)}) pushes the queue upstream where ` +
          `it is visible and shed-able.`,
        nodeId: n.nodeId,
        weight: 0.2,
      });
    }
    if (db.poolSize < db.parallelism) {
      findings.push({
        id: `pool-undersized:${n.nodeId}`,
        severity: "warning",
        title: `"${n.label}" pool is below its execution capacity`,
        evidence: `pool ${db.poolSize} against parallelism ${db.parallelism}: connections are the constraint.`,
        remediation: `raise the pool from ${db.poolSize} to ${db.parallelism} to use the capacity that is already there.`,
        nodeId: n.nodeId,
        weight: 0.5,
      });
    }
  }

  // ---- cache effectiveness ----
  for (const n of stations) {
    if (!n.cache) continue;
    const c = n.cache;
    if (c.hits + c.misses < 100) continue;
    if (c.hitRatio < 0.5) {
      findings.push({
        id: `cache-ineffective:${n.nodeId}`,
        severity: "warning",
        title: `"${n.label}" hit ratio is only ${(c.hitRatio * 100).toFixed(0)}%`,
        evidence:
          `${c.hits.toLocaleString()} hits against ${c.misses.toLocaleString()} misses, with ` +
          `${c.evictions.toLocaleString()} evictions and ${c.expirations.toLocaleString()} expirations.`,
        remediation:
          `a read-through miss costs a lookup PLUS the origin call, so a low hit ratio makes ` +
          `things worse than no cache, not neutral. ` +
          (c.evictions > c.expirations
            ? `Evictions dominate: raise capacity (try ${(c.residentKeys * 4).toLocaleString()} entries).`
            : `Expiry dominates: raise the TTL, or accept that this key population is not cacheable.`),
        nodeId: n.nodeId,
        weight: 0.4,
      });
    }
  }

  // ---- blocking caller without a bulkhead ----
  for (const n of stations) {
    const cfg = design.nodes.find((x) => x.id === n.nodeId)?.server;
    if (!cfg?.blocksOnDependencies) continue;
    if (n.residencyMs.count === 0 || n.selfTimeMs.count === 0) continue;
    const dependencyShare = 1 - n.selfTimeMs.mean / Math.max(1e-9, n.residencyMs.mean);
    if (dependencyShare < 0.6) continue;

    const outgoing = design.edges.filter((e) => e.from === n.nodeId);
    const unprotected = outgoing.filter((e) => !e.policy.bulkhead.enabled);
    if (unprotected.length === 0) continue;

    findings.push({
      id: `unbulkheaded:${n.nodeId}`,
      severity: n.utilization > UTIL_WARNING ? "warning" : "info",
      title: `"${n.label}" holds workers waiting on dependencies, unprotected`,
      evidence:
        `a slot is held for ${n.residencyMs.mean.toFixed(1)}ms of which only ` +
        `${n.selfTimeMs.mean.toFixed(1)}ms is its own work \u2014 ` +
        `${(dependencyShare * 100).toFixed(0)}% is spent waiting downstream, at ` +
        `${(n.utilization * 100).toFixed(0)}% utilization.`,
      remediation:
        `add a bulkhead on ${unprotected.map((e) => `"${e.to}"`).join(", ")} so one slow dependency ` +
        `cannot consume all ${n.capacity} workers. Alternatively make this station non-blocking, ` +
        `which removes the coupling entirely.`,
      nodeId: n.nodeId,
      weight: 0.5,
    });
  }

  // ---- retries without a budget ----
  for (const e of design.edges) {
    const retry = e.policy.retry;
    if (!retry || retry.budgetRatio !== null) continue;
    const measuredEdge = result?.edges.find((x) => x.edgeId === e.id);
    if (measuredEdge && measuredEdge.calls < 100) continue;
    findings.push({
      id: `no-retry-budget:${e.id}`,
      severity: "warning",
      title: `retries on ${e.from} \u2192 ${e.to} have no budget`,
      evidence: measuredEdge
        ? `${retry.maxAttempts} attempts allowed; currently running at ` +
          `${measuredEdge.amplification.toFixed(2)}\u00d7 amplification.`
        : `${retry.maxAttempts} attempts allowed with no cap on the share of retried traffic.`,
      remediation:
        `set a budget of 10%. It caps amplification near 1.10\u00d7 in the worst case while leaving ` +
        `retries free in the healthy case. Without one, load on this dependency can rise ` +
        `${retry.maxAttempts}\u00d7 exactly when it is least able to absorb it.`,
      edgeId: e.id,
      weight: 0.4,
    });
  }

  // ---- retrying a shed request ----
  for (const e of design.edges) {
    if (!e.policy.retry?.retryOn.includes("shed")) continue;
    findings.push({
      id: `retry-on-shed:${e.id}`,
      severity: "warning",
      title: `${e.from} \u2192 ${e.to} retries shed requests`,
      evidence:
        `\`shed\` is listed as retryable with up to ${e.policy.retry.maxAttempts} attempts, so a ` +
        `station that reports no capacity can receive up to ${e.policy.retry.maxAttempts}\u00d7 the calls.`,
      remediation:
        "remove `shed` from the retryable reasons. A shed request means the dependency just " +
        "reported that it had no capacity; retrying adds load to exactly the thing that is " +
        "already over capacity.",
      edgeId: e.id,
      weight: 0.5,
    });
  }

  // ---- retries without jitter ----
  for (const e of design.edges) {
    const retry = e.policy.retry;
    if (!retry || retry.backoff.kind === "none" || retry.backoff.jitter) continue;
    findings.push({
      id: `no-jitter:${e.id}`,
      severity: "info",
      title: `${e.from} \u2192 ${e.to} retries without jitter`,
      evidence: `${retry.backoff.kind} backoff from ${retry.backoff.baseMs}ms, unjittered.`,
      remediation:
        "enable jitter. Without it every client that failed at the same instant retries at the " +
        "same instant, so a recovering dependency is hit by a synchronised wave and fails again. " +
        "It costs nothing.",
      edgeId: e.id,
      weight: 0.2,
    });
  }

  // ---- load balancer hygiene ----
  for (const n of stations) {
    const lb = n.loadbalancer;
    const cfg = design.nodes.find((x) => x.id === n.nodeId)?.loadbalancer;
    if (!lb || !cfg) continue;
    const backends = lb.perBackend.length;

    if (backends > 1 && !cfg.healthCheck.enabled) {
      findings.push({
        id: `no-health-check:${n.nodeId}`,
        severity: "warning",
        title: `"${n.label}" has ${backends} backends and no health checking`,
        evidence:
          `outlier detection is off across ${backends} backends, so a failing one keeps its ` +
          `${(100 / backends).toFixed(0)}% share of ${lb.dispatched.toLocaleString()} dispatched requests.`,
        remediation:
          `enable outlier detection. With ${backends} backends, one broken instance sends ` +
          `${(100 / backends).toFixed(0)}% of requests to a known-bad target indefinitely.`,
        nodeId: n.nodeId,
        weight: 0.45,
      });
    }

    if (backends > 2 && cfg.algorithm === "random") {
      findings.push({
        id: `weak-lb-algorithm:${n.nodeId}`,
        severity: "info",
        title: `"${n.label}" uses random selection across ${backends} backends`,
        evidence: `worst observed share deviation \u00b1${lb.worstImbalancePct.toFixed(1)} points from an even split.`,
        remediation:
          "switch to power-of-two-choices. Sampling two backends and taking the shorter queue " +
          "reduces maximum load from about log n / log log n above average to log log n \u2014 an " +
          "exponential improvement from one extra probe, and it shows up in the tail.",
        nodeId: n.nodeId,
        weight: 0.25,
      });
    }
  }

  // ---- single points of failure ----
  for (const n of stations) {
    const cfg = design.nodes.find((x) => x.id === n.nodeId)?.server;
    if (!cfg || cfg.replicas > 1) continue;
    const hasCallers = design.edges.some((e) => e.to === n.nodeId);
    if (!hasCallers) continue;
    findings.push({
      id: `single-replica:${n.nodeId}`,
      severity: "info",
      title: `"${n.label}" runs a single replica`,
      evidence: `replicas = 1 with concurrency ${cfg.concurrency}.`,
      remediation:
        "this model has no notion of an instance failing, so the simulation cannot show the " +
        "consequence. Raising replicas is still worth doing for availability, and it is the one " +
        "recommendation here that the tool cannot itself justify with a number.",
      nodeId: n.nodeId,
      weight: 0.1,
    });
  }

  // ---- measurement quality ----
  if (result && !result.confidence.sufficient) {
    findings.push({
      id: "low-confidence",
      severity: "warning",
      title: "this run is too short to draw conclusions from",
      evidence: result.confidence.note,
      remediation: `raise the run duration to about ${Math.ceil(
        (result.observedSec * result.confidence.requiredSamples) /
          Math.max(1, result.confidence.samples)
      )}s. Every figure above carries the error stated.`,
      weight: 0.6,
    });
  }

  if (result) {
    const breach = sloBreach(result);
    const target = design.slo.p99LatencyMs;
    if (breach === null && target !== null) {
      const margin = result.endToEnd.p99 * result.confidence.approxTailRelativeError;
      if (target - result.endToEnd.p99 < margin) {
        findings.push({
          id: "slo-borderline",
          severity: "warning",
          title: "the SLO passes, but inside its own error bar",
          evidence:
            `p99 ${result.endToEnd.p99.toFixed(1)}ms against a ${target}ms target, with a ` +
            `seed-to-seed spread of \u00b1${(result.confidence.approxTailRelativeError * 100).toFixed(1)}%.`,
          remediation:
            "a verdict inside the error bar is a coin toss dressed as a result. Lengthen the run, " +
            "or change the seed and see whether the verdict holds.",
          weight: 0.5,
        });
      }
    }
  }

  // ---- order and summarise ----
  findings.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return s !== 0 ? s : b.weight - a.weight;
  });

  return {
    findings,
    criticalPath: path,
    preview,
    result,
    summary: summarise(findings, result, measured),
  };
}

function summarise(findings: Finding[], result: RunResult | null, measured: boolean): string {
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const source = measured ? "measured" : "predicted from the closed form";

  if (findings.length === 0) {
    return `No findings (${source}). ${
      result?.sloPassed === true ? "The design meets its SLO." : ""
    }`.trim();
  }
  const first = findings[0]!;
  const counts = [
    critical > 0 ? `${critical} critical` : null,
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `${counts || `${findings.length} note${findings.length === 1 ? "" : "s"}`} (${source}). Start with: ${first.title}.`;
}
