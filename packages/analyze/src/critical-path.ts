import type { RunResult } from "@sds/core";
import { meanNetworkRoundTripMs } from "@sds/core";

/**
 * WHERE DOES THE LATENCY GO?
 *
 * The second question a review asks, after "where does it break". Answered by
 * attributing end-to-end mean latency to the stations and links that produced it.
 *
 * THE MEAN DECOMPOSES EXACTLY. THE P99 DOES NOT.
 *
 * Expectation is linear, so the mean end-to-end latency is exactly the sum over
 * stations of (visits per request) x (mean self time per visit), plus network. That
 * identity is checked here on every call and reported as a residual.
 *
 * A percentile is not linear. The p99 of a sum is not the sum of p99s -- summing
 * them overstates the tail badly, because it assumes every station has its bad day
 * on the same request. So p99 attribution is withheld, with the reason stated,
 * rather than computed by an appealing formula that is wrong.
 *
 * SELF TIME, NOT RESIDENCY
 *
 * A blocking station's residency contains its dependency's residency, so
 * attributing by residency would blame the deepest station once for every layer
 * above it and the shares would sum to several hundred percent. Self time -- own
 * queue wait plus own service -- is measured separately by the engine precisely so
 * this decomposition is possible.
 */

export interface PathContribution {
  kind: "station" | "network";
  id: string;
  label: string;
  /** Visits per client request. Below 1 means it is only sometimes called. */
  visitsPerRequest: number;
  /** Mean self time per visit, ms. */
  perVisitMs: number;
  /** visitsPerRequest x perVisitMs. Contribution to end-to-end mean, ms. */
  totalMs: number;
  /** Share of the accounted latency, [0,1]. */
  share: number;
  /** How much of this station's own time is queueing rather than working, [0,1]. */
  queueShare: number;
  /** This station's own p99 self time, for context. NOT a share of the p99. */
  ownP99Ms: number;
}

export interface CriticalPath {
  endToEndMeanMs: number;
  /** Sum of all contributions. Should equal the end-to-end mean. */
  accountedMs: number;
  /**
   * endToEndMean - accounted, as a fraction.
   *
   * Should be near zero for sequential paths. A large positive residual means time
   * is being spent somewhere the decomposition does not see; a large NEGATIVE one
   * means double counting. Either way the numbers below should not be trusted, and
   * saying so beats presenting a tidy pie chart that does not add up.
   */
  residualFraction: number;
  contributions: PathContribution[];
  /** Set when the decomposition cannot be exact, with the reason. */
  caveat: string | null;
  /** Always null: see the module comment. */
  p99Attribution: null;
  p99Reason: string;
}

const P99_REASON =
  "a percentile does not decompose: the p99 of a sum is not the sum of p99s, and adding them " +
  "assumes every station has its bad day on the same request. Per-station p99s are shown for " +
  "context, not as shares.";

export function criticalPath(result: RunResult): CriticalPath {
  const endToEndMeanMs = result.endToEnd.mean;
  const contributions: PathContribution[] = [];

  for (const node of result.nodes) {
    if (node.kind === "client") continue;
    if (node.selfTimeMs.count === 0 || node.visitsPerRequest <= 0) continue;

    const perVisitMs = node.selfTimeMs.mean;
    const totalMs = perVisitMs * node.visitsPerRequest;
    // How much of the station's own time is waiting rather than working. The
    // actionable distinction: queueing is fixed with capacity, service time is not.
    const queueShare = perVisitMs > 0 ? Math.min(1, node.avgWaitMs / perVisitMs) : 0;

    contributions.push({
      kind: "station",
      id: node.nodeId,
      label: node.label,
      visitsPerRequest: node.visitsPerRequest,
      perVisitMs,
      totalMs,
      share: 0,
      queueShare,
      ownP99Ms: node.selfTimeMs.p99,
    });
  }

  // ---- network ----
  //
  // Each traversal of an edge costs its latency, and a request/response pair crosses
  // twice. Traversals are COUNTED per edge by the engine rather than inferred from
  // the destination's visit count: several edges can share a target -- three services
  // calling one cache -- and inference would credit each with the cache's full
  // traffic, inflating the network share threefold. Retries are included, because a
  // retrying caller really does pay the network cost again.
  const rootRequests = result.endToEnd.count + result.errors.total;
  for (const e of result.design.edges) {
    const meanMs = meanNetworkRoundTripMs(e.network);
    if (meanMs <= 0) continue;
    const traversals = result.edges.find((x) => x.edgeId === e.id)?.traversals ?? 0;
    if (traversals <= 0) continue;

    const perRequest = rootRequests > 0 ? traversals / rootRequests : 0;
    const from = result.nodes.find((n) => n.nodeId === e.from)?.label ?? e.from;
    const to = result.nodes.find((n) => n.nodeId === e.to)?.label ?? e.to;
    contributions.push({
      kind: "network",
      id: e.id,
      label: `${from} \u2192 ${to}`,
      visitsPerRequest: perRequest,
      perVisitMs: meanMs,
      totalMs: meanMs * perRequest,
      share: 0,
      queueShare: 0,
      ownP99Ms: 0,
    });
  }

  const accountedMs = contributions.reduce((s, c) => s + c.totalMs, 0);
  for (const c of contributions) {
    c.share = accountedMs > 0 ? c.totalMs / accountedMs : 0;
  }
  contributions.sort((a, b) => b.totalMs - a.totalMs);

  const residualFraction =
    endToEndMeanMs > 0 ? (endToEndMeanMs - accountedMs) / endToEndMeanMs : 0;

  // ---- caveats ----
  let caveat: string | null = null;
  const forkJoin = result.design.nodes.filter(
    (n) =>
      n.server?.fanout === "parallel" &&
      result.design.edges.filter((e) => e.from === n.id).length > 1
  );
  if (forkJoin.length > 0) {
    caveat =
      `${forkJoin.map((n) => `"${n.label}"`).join(", ")} calls dependencies in parallel, so its ` +
      `request waits for the slowest rather than the sum. Shares below add up to more work than ` +
      `the request experienced, and the residual reflects that rather than an error.`;
  } else if (Math.abs(residualFraction) > 0.1) {
    caveat =
      `${(residualFraction * 100).toFixed(0)}% of the end-to-end mean is unaccounted for. ` +
      `Treat these shares as indicative only.`;
  }

  return {
    endToEndMeanMs,
    accountedMs,
    residualFraction,
    contributions,
    caveat,
    p99Attribution: null,
    p99Reason: P99_REASON,
  };
}
