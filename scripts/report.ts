/**
 * CLI verification tool.
 *
 * Exists so the engine's claims can be checked without a browser and without
 * reading test source. Three modes:
 *
 *   pnpm sim                    run a design, print the full report
 *   pnpm sim --analyze          findings, critical path, knee, sensitivity, config search
 *   pnpm sim --validate         cross-check the run against closed-form theory
 *   pnpm sim --sweep            sweep arrival rate and find where the design breaks
 *   pnpm sim --replicate        run independent seeds and report measured confidence intervals
 *   pnpm sim --compare FILE     paired comparison against another design, on shared seeds
 *   pnpm sim --ramp             one ramping run: where does the SLO first break
 *   pnpm sim --spike            a burst, and how long recovery takes
 *                               (--multiple N, --spike-sec N)
 *
 * The sweep is included deliberately: it is the clearest demonstration of why the
 * engine had to be headless. It runs dozens of full simulations in a couple of
 * seconds, which was structurally impossible when the model was driven by
 * requestAnimationFrame.
 */
import { readFileSync } from "node:fs";
import { previewDesign, solveMMc } from "@sds/analytic";
import {
  analyse,
  checkErrorModel,
  compare,
  criticalPath,
  findKnee,
  rampToFailure,
  replicate,
  searchConfig,
  sensitivity,
  spikeTest,
} from "@sds/analyze";
import { runSimulation, type RunResult } from "@sds/core";
import {
  DesignSchema,
  meanRate,
  migrateAndParse,
  scaleArrival,
  validateDesign,
  type Design,
} from "@sds/schema";
import { EXAMPLES, defaultDesign } from "@sds/models";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const OFF = "\x1b[0m";

const ms = (v: number): string =>
  !isFinite(v) ? "inf" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`;
const pctOf = (v: number): string => `${(v * 100).toFixed(1)}%`;
const pad = (s: string, n: number): string => s.padEnd(n);
const rpad = (s: string, n: number): string => s.padStart(n);

function loadDesign(): Design {
  const file = value("file");
  if (file) return migrateAndParse(JSON.parse(readFileSync(file, "utf8")));

  const example = value("example");
  if (example) {
    const found = EXAMPLES.find((e) => e.id === example);
    if (!found) {
      console.log(`${RED}unknown example "${example}"${OFF}. available:`);
      for (const e of EXAMPLES) console.log(`  ${pad(e.id, 20)} ${DIM}${e.blurb}${OFF}`);
      process.exit(1);
    }
    return found.build();
  }
  return defaultDesign();
}

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${OFF}`);
  console.log(DIM + "─".repeat(Math.max(20, text.length)) + OFF);
}

function report(design: Design, result: RunResult): void {
  const preview = previewDesign(design);

  heading("design");
  console.log(`  ${design.name}`);
  console.log(
    `  ${design.nodes.length} nodes, ${design.edges.length} links, ` +
      `${design.scenario.durationSec}s simulated (${design.scenario.warmupSec}s warm-up), seed ${design.scenario.seed}`
  );
  console.log(
    `  ${DIM}simulated ${result.observedSec}s of measurement in ${result.wallMs}ms of wall clock ` +
      `(${Math.round(result.observedSec / (result.wallMs / 1000)).toLocaleString()}x real time)${OFF}`
  );

  if (!result.steadyState) {
    heading("time-varying load");
    console.log(`  ${YELLOW}${result.aggregateCaveat}${OFF}`);
    if (result.firstBreach) {
      console.log(
        `  ${RED}${BOLD}SLO first broke at ${result.firstBreach.atSec.toFixed(0)}s${OFF}, ` +
          `with ${BOLD}${result.firstBreach.offeredRatePerSec.toFixed(0)}/s${OFF} offered ` +
          `(${result.firstBreach.breach}).`
      );
      console.log(
        `  ${DIM}That is the capacity limit this run found. A ramp reads slightly HIGH, because ` +
          `queues\n  take time to fill and the system is always catching up with a load that has ` +
          `already moved on.${OFF}`
      );
    } else {
      console.log(`  ${GREEN}the SLO held for the whole run.${OFF}`);
    }
    const rates = result.offeredRateSeries.points;
    if (rates.length > 1) {
      console.log(
        `  ${DIM}offered load went ${rates[0]!.value.toFixed(0)}/s \u2192 ` +
          `${Math.max(...rates.map((r) => r.value)).toFixed(0)}/s peak \u2192 ` +
          `${rates.at(-1)!.value.toFixed(0)}/s${OFF}`
      );
    }
  }

  if (!result.stability.stable) {
    heading("VERDICT: does not scale");
    console.log(`  ${RED}${result.stability.detail}${OFF}`);
    console.log(
      `  ${DIM}Latency figures below are a function of run length, not of the design.${OFF}`
    );
  }

  if (result.stability.retryStormWarning) {
    // Separate from saturation because the symptom misleads: the dependency looks
    // overloaded, so the instinct is to add capacity, when the load is being
    // manufactured by the callers' own retry policies.
    heading("VERDICT: retry amplification");
    console.log(`  ${RED}${result.stability.retryStormWarning}${OFF}`);
  }

  if (result.stability.asyncBacklogWarning) {
    // Called out separately because it is invisible in every percentile: the
    // request path is genuinely healthy while the work silently piles up.
    heading("VERDICT: async backlog growing");
    console.log(`  ${RED}${result.stability.asyncBacklogWarning}${OFF}`);
  }

  if (result.largestFanout > 1 || result.connectionsHeld > 0) {
    heading("realtime");
    if (result.connectionsHeld > 0) {
      console.log(
        `  connections held  ${BOLD}${Math.round(result.connectionsHeld).toLocaleString()}${OFF}` +
          (result.connectionsRefused > 0
            ? `  ${RED}${result.connectionsRefused.toLocaleString()} refused${OFF}`
            : "")
      );
    }
    if (result.largestFanout > 1) {
      console.log(
        `  largest fan-out   ${BOLD}${result.largestFanout}x${OFF} ` +
          `${DIM}one message becomes ${result.largestFanout} deliveries${OFF}`
      );
      console.log(
        `  total work        ${BOLD}${result.callsPerMessage.toFixed(1)}${OFF} ` +
          `${DIM}downstream calls per message, across every hop${OFF}`
      );
      console.log(
        `  ${DIM}The write path costs ${result.largestFanout}x what the message rate suggests. Room ` +
          `size is a product\n  decision that is also a capacity decision, and it rarely appears in ` +
          `one.${OFF}`
      );
    }
  }

  heading("throughput");
  console.log(`  offered      ${rpad(result.offeredRatePerSec.toFixed(1), 10)} req/s`);
  console.log(`  completed    ${rpad(result.throughputPerSec.toFixed(1), 10)} req/s`);
  console.log(
    `  errors       ${rpad(result.errors.ratePct.toFixed(2), 10)} %   ` +
      `${DIM}shed ${result.errors.shed} · timeout ${result.errors.timeout} · network ${result.errors.network}${OFF}`
  );

  heading("latency of successful requests");
  const e = result.endToEnd;
  console.log(`  p50          ${rpad(ms(e.p50), 10)}`);
  console.log(`  p90          ${rpad(ms(e.p90), 10)}`);
  console.log(`  p99          ${rpad(ms(e.p99), 10)}`);
  console.log(`  p99.9        ${rpad(ms(e.p999), 10)}`);
  console.log(`  mean         ${rpad(ms(e.mean), 10)}`);
  console.log(`  max          ${rpad(ms(e.max), 10)}`);
  console.log(`  ${DIM}over ${e.count.toLocaleString()} requests${OFF}`);

  heading("precision (the tool's own error estimate)");
  const c = result.confidence;
  const tone = c.sufficient ? GREEN : YELLOW;
  console.log(`  ${tone}${c.sufficient ? "adequate" : "TOO LOOSE TO ACT ON"}${OFF}`);
  console.log(`  mean         ±${pctOf(c.approxRelativeError)}`);
  console.log(`  p99          ±${pctOf(c.approxTailRelativeError)}   ${DIM}tails are noisier${OFF}`);
  console.log(`  ${DIM}${c.samples.toLocaleString()} samples at ${pctOf(c.drivingUtilization)} utilization${OFF}`);

  if (result.classes.length > 1) {
    heading("request classes");
    console.log(
      `  ${DIM}${pad("class", 14)}${rpad("share", 8)}${rpad("rate", 9)}${rpad("p50", 9)}${rpad("p99", 10)}${rpad("errors", 9)}${OFF}`
    );
    for (const c of result.classes) {
      console.log(
        `  ${pad(c.label.slice(0, 13), 14)}${rpad(pctOf(c.share), 8)}` +
          `${rpad(c.throughputPerSec.toFixed(0) + "/s", 9)}${rpad(ms(c.latency.p50), 9)}` +
          `${rpad(ms(c.latency.p99), 10)}${rpad(c.errors.ratePct.toFixed(2) + "%", 9)}`
      );
    }
    console.log(
      `  ${DIM}A blended percentile hides both a fast path and a slow one, which is why` +
        `\n  per-class figures exist.${OFF}`
    );
  }

  const policyEdges = result.edges.filter((e) => e.hasPolicy);
  if (policyEdges.length > 0) {
    heading("calls and failure policies");
    console.log(
      `  ${DIM}${pad("call", 30)}${rpad("calls", 10)}${rpad("attempts", 10)}${rpad("amp", 7)}${rpad("fail", 8)}  policy${OFF}`
    );
    for (const e of policyEdges) {
      const ampColor = e.amplification > 1.5 ? RED : e.amplification > 1.15 ? YELLOW : GREEN;
      const failRate = e.calls > 0 ? e.failures / e.calls : 0;
      const bits: string[] = [];
      if (e.retries > 0) bits.push(`${e.retries.toLocaleString()} retries`);
      if (e.budgetRejections > 0) bits.push(`${e.budgetRejections.toLocaleString()} budget-capped`);
      if (e.breakerTrips > 0) {
        bits.push(`breaker ${e.breakerTrips}x, open ${pctOf(e.breakerOpenFraction)}`);
      }
      if (e.bulkheadRejections > 0) bits.push(`${e.bulkheadRejections.toLocaleString()} bulkhead-rejected`);
      console.log(
        `  ${pad(`${e.fromLabel} \u2192 ${e.toLabel}`.slice(0, 29), 30)}` +
          `${rpad(e.calls.toLocaleString(), 10)}${rpad(e.attempts.toLocaleString(), 10)}` +
          `${ampColor}${rpad(e.amplification.toFixed(2) + "x", 7)}${OFF}` +
          `${rpad(pctOf(failRate), 8)}  ${DIM}${bits.join(" \u00b7 ") || "\u2014"}${OFF}`
      );
      if (e.bulkheadUtilization !== null) {
        console.log(
          `    ${DIM}bulkhead ${pctOf(e.bulkheadUtilization)} of ${e.bulkheadMaxInUse !== null ? Math.round(e.bulkheadMaxInUse) : "?"} slots peak \u00b7 ` +
            `outstanding calls avg ${e.avgConcurrency.toFixed(1)}${OFF}`
        );
      }
    }
    console.log(
      `  ${DIM}system-wide amplification ${result.retryAmplification.toFixed(2)}x. ` +
        `Each tier multiplies, so layered retries compound.${OFF}`
    );
  }

  heading("stations");
  console.log(
    `  ${DIM}${pad("station", 16)}${pad("kind", 14)}${rpad("c", 4)}${rpad("util", 8)}${rpad("Lq", 8)}${rpad("wait", 9)}${rpad("shed", 8)}${OFF}`
  );
  for (const n of result.nodes.filter((x) => x.kind !== "client")) {
    const util = n.utilization;
    const utilColor = util >= 0.85 ? RED : util >= 0.7 ? YELLOW : GREEN;
    console.log(
      `  ${pad(n.label.slice(0, 15), 16)}${DIM}${pad(n.kind, 14)}${OFF}${rpad(String(n.capacity), 4)}` +
        `${utilColor}${rpad(pctOf(util), 8)}${OFF}` +
        `${rpad(n.avgQueueLength.toFixed(2), 8)}` +
        `${rpad(ms(n.avgWaitMs), 9)}${rpad(n.shed.toLocaleString(), 8)}`
    );

    if (n.loadbalancer) {
      const lb = n.loadbalancer;
      console.log(
        `    ${DIM}${lb.algorithm}: ` +
          lb.perBackend.map((b) => `${b.label} ${b.sharePct.toFixed(1)}%`).join(" \u00b7 ") +
          `${OFF}`
      );
      if (lb.healthCheckEnabled) {
        const ejected = lb.perBackend.filter((b) => b.ejections > 0);
        console.log(
          `    ${DIM}health checking on \u00b7 ` +
            (ejected.length > 0
              ? ejected
                  .map(
                    (b) =>
                      `${YELLOW}${b.label} ejected ${b.ejections}x (${pctOf(b.ejectedFraction)} of window, ${pctOf(b.failureRate)} failing)${OFF}${DIM}`
                  )
                  .join(" \u00b7 ")
              : "no backends ejected") +
            (lb.ejectionsWithheld > 0
              ? ` \u00b7 ${lb.ejectionsWithheld} ejections withheld to preserve capacity`
              : "") +
            `${OFF}`
        );
      }
    }
    if (n.cache) {
      const c = n.cache;
      console.log(
        `    ${DIM}hit ratio ${CYAN}${pctOf(c.hitRatio)}${OFF}${DIM} ` +
          `(${c.hits.toLocaleString()} hits, ${c.misses.toLocaleString()} misses) \u00b7 ` +
          `${c.evictions.toLocaleString()} evictions, ${c.expirations.toLocaleString()} expirations \u00b7 ` +
          `${c.residentKeys.toLocaleString()} keys resident${OFF}`
      );
    }
    if (n.database) {
      const db = n.database;
      const binding = db.poolSize < db.parallelism ? "pool" : "execution";
      console.log(
        `    ${DIM}pool ${db.poolSize} at ${pctOf(db.poolUtilization)} \u00b7 ` +
          `execution ${db.parallelism} at ${pctOf(db.executionUtilization)} \u00b7 ` +
          `waits: pool ${ms(db.avgPoolWaitMs)}, execution ${ms(db.avgExecutionWaitMs)}${OFF}`
      );
      console.log(
        `    ${DIM}ceiling ${db.maxThroughputPerSec.toFixed(0)}/s \u2014 set by ${binding}. ` +
          `Raising the pool past parallelism moves the wait, it does not remove it.${OFF}`
      );
    }
    if (n.connections) {
      const c = n.connections;
      if (c.capacity > 1) {
        const utilColour = c.utilization >= 0.85 ? RED : c.utilization >= 0.7 ? YELLOW : GREEN;
        console.log(
          `    ${DIM}connections ${utilColour}${Math.round(c.avgHeld).toLocaleString()} of ` +
            `${c.capacity.toLocaleString()}${OFF}${DIM} (${pctOf(c.utilization)}) \u00b7 ` +
            `peak ${Math.round(c.peakHeld).toLocaleString()} \u00b7 ` +
            `${c.memoryMb.toFixed(0)} MB (peak ${c.peakMemoryMb.toFixed(0)} MB)${OFF}`
        );
        console.log(
          `    ${DIM}accepts ${c.acceptRatePerSec.toFixed(1)}/s at p99 ${ms(c.acceptLatency.p99)} \u00b7 ` +
            `${c.closed.toLocaleString()} closed` +
            (c.droppedByFault > 0 ? ` (${c.droppedByFault.toLocaleString()} by fault)` : "") +
            `${OFF}`
        );
        if (c.refused > 0) {
          console.log(
            `    ${RED}${c.refused.toLocaleString()} connections REFUSED \u2014 a hard failure, not a ` +
              `slow response${OFF}`
          );
        }
      }
      if (c.pushes > 0) {
        console.log(
          `    ${DIM}pushes ${CYAN}${c.pushRatePerSec.toFixed(0)}/s${OFF}${DIM} \u00b7 ` +
            `delivery latency p50 ${ms(c.pushLatency.p50)} / p99 ${ms(c.pushLatency.p99)} \u00b7 ` +
            `work pool ${pctOf(c.workUtilization)} busy${OFF}`
        );
      }
    }

    if (n.queue) {
      const q = n.queue;
      const growing = q.backlogGrowthPerSec > 0.05;
      console.log(
        `    ${DIM}backlog avg ${q.avgBacklog.toFixed(0)}, max ${q.maxBacklog.toLocaleString()} \u00b7 ` +
          `age p50 ${ms(q.backlogAge.p50)} / p99 ${ms(q.backlogAge.p99)} \u00b7 ` +
          `${q.consumers} consumers draining ${q.drainCapacityPerSec.toFixed(0)}/s${OFF}`
      );
      if (growing) {
        console.log(
          `    ${RED}backlog growing ${q.backlogGrowthPerSec.toFixed(1)}/s \u2014 consumers are losing${OFF}`
        );
      }
      if (q.dropped > 0) {
        console.log(`    ${YELLOW}${q.dropped.toLocaleString()} messages dropped (queue full)${OFF}`);
      }
    }
  }

  heading("invariants (checked on every run)");
  for (const inv of result.invariants) {
    const mark = inv.passed ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`;
    console.log(`  ${mark}  ${pad(inv.name, 32)} ${DIM}${inv.detail}${OFF}`);
  }

  heading("closed-form estimate vs simulation");
  console.log(
    `  ${DIM}The analytic solver and the simulator are independent code paths. ` +
      `Disagreement beyond the\n  reported precision means one of them is wrong.${OFF}`
  );
  const rows: Array<[string, number | null, number]> = [
    ["mean latency", preview.endToEndMeanMs, result.endToEnd.mean],
    ["p99 latency", preview.endToEndP99Ms, result.endToEnd.p99],
    ["throughput", preview.throughputPerSec, result.throughputPerSec],
    [
      "bottleneck util",
      preview.stable ? preview.bottleneckUtilization : null,
      Math.max(...result.nodes.map((n) => n.utilization), 0),
    ],
  ];
  console.log(`  ${DIM}${pad("quantity", 18)}${rpad("analytic", 12)}${rpad("simulated", 12)}${rpad("delta", 10)}${OFF}`);
  for (const [label, analytic, simulated] of rows) {
    if (analytic === null) {
      console.log(
        `  ${pad(label, 18)}${rpad("withheld", 12)}${rpad(simulated.toFixed(2), 12)}${DIM}  n/a${OFF}`
      );
      continue;
    }
    const delta = analytic === 0 ? 0 : (simulated / analytic - 1) * 100;
    const within = Math.abs(delta) < result.confidence.approxTailRelativeError * 100 * 2;
    const color = within ? GREEN : YELLOW;
    console.log(
      `  ${pad(label, 18)}${rpad(analytic.toFixed(2), 12)}${rpad(simulated.toFixed(2), 12)}` +
        `${color}${rpad(`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`, 10)}${OFF}`
    );
  }
  if (preview.p99Reason) {
    console.log(`  ${DIM}p99 withheld: ${preview.p99Reason}${OFF}`);
  }
  if (!preview.converged) {
    console.log(
      `  ${RED}retry feedback has no fixed point after ${preview.iterations} iterations.${OFF}` +
        `\n  ${DIM}Each round of retries causes more failures than it recovers. That divergence` +
        `\n  is the retry storm, not a numerical problem.${OFF}`
    );
  } else if (preview.retryStormWarning) {
    console.log(`  ${YELLOW}predicted: ${preview.retryStormWarning}${OFF}`);
  }

  if (result.sloPassed !== null) {
    heading("slo");
    const ok = result.sloPassed;
    console.log(`  ${ok ? GREEN + "MEETS SLO" : RED + "MISSES SLO"}${OFF}`);
    if (design.slo.p99LatencyMs !== null) {
      console.log(`  p99 ${ms(result.endToEnd.p99)} against a ${design.slo.p99LatencyMs}ms target`);
      const margin = result.endToEnd.p99 * result.confidence.approxTailRelativeError;
      if (Math.abs(result.endToEnd.p99 - design.slo.p99LatencyMs) < margin) {
        console.log(
          `  ${YELLOW}This verdict sits inside the run's own error bar (±${ms(margin)}) and is not robust.${OFF}`
        );
      }
    }
  }
}

/**
 * Cross-check against theory for the case where an exact answer exists.
 *
 * Only meaningful for a single station with exponential service; anything else and
 * the tool says so rather than comparing against a formula that does not apply.
 */
function validate(design: Design): void {
  heading("closed-form validation");
  const servers = design.nodes.filter((n) => n.kind === "server");
  const clients = design.nodes.filter((n) => n.kind === "client");
  if (servers.length !== 1 || clients.length !== 1) {
    console.log(
      `  ${YELLOW}Skipped: exact validation applies to a single station with a single client.${OFF}`
    );
    console.log(`  ${DIM}Run \`pnpm test\` for the full suite, which covers chains and finite queues.${OFF}`);
    return;
  }
  const s = servers[0]!.server!;
  if (s.serviceTime.kind !== "exponential") {
    console.log(`  ${YELLOW}Skipped: exact M/M/c results need exponential service time.${OFF}`);
    return;
  }

  const arrival = clients[0]!.client!.arrival;
  if (arrival.kind !== "poisson" && arrival.kind !== "deterministic") {
    console.log(
      `  ${YELLOW}Skipped: exact M/M/c results assume a stationary arrival rate, and this client ` +
        `varies its load over the run.${OFF}`
    );
    return;
  }
  const lambda = arrival.ratePerSec;
  const mu = 1000 / s.serviceTime.mean;
  const c = s.concurrency * s.replicas;
  const exact = solveMMc({ lambda, mu, c });

  if (!exact.stable) {
    console.log(`  ${RED}rho = ${exact.rho.toFixed(3)} >= 1: no steady state, nothing to compare against.${OFF}`);
    return;
  }

  // Average over independent seeds: a single run is one draw from a distribution
  // of outcomes, so comparing it to an exact value tests luck as much as accuracy.
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const runs = seeds.map((seed) => runSimulation(design, { seed, collectTrace: false }));
  const avg = (pick: (r: RunResult) => number) =>
    runs.reduce((a, r) => a + pick(r), 0) / runs.length;

  const checks: Array<[string, number, number]> = [
    ["W (mean sojourn)", exact.wMs, avg((r) => r.endToEnd.mean)],
    ["L (in system)", exact.l, avg((r) => r.avgInSystem)],
    ["Lq (queued)", exact.lq, avg((r) => r.nodes.find((n) => n.kind === "server")!.avgQueueLength)],
    ["Wq (queue wait)", exact.wqMs, avg((r) => r.nodes.find((n) => n.kind === "server")!.avgWaitMs)],
    ["utilization", exact.rho, avg((r) => r.nodes.find((n) => n.kind === "server")!.utilization)],
    ["p99", exact.quantileMs(0.99)!, avg((r) => r.endToEnd.p99)],
  ];

  console.log(
    `  M/M/${c} with lambda=${lambda}/s, mu=${mu.toFixed(2)}/s per server, rho=${exact.rho.toFixed(3)}`
  );
  console.log(`  ${DIM}averaged over ${seeds.length} independent seeds${OFF}\n`);
  console.log(`  ${DIM}${pad("quantity", 20)}${rpad("exact", 12)}${rpad("simulated", 12)}${rpad("error", 10)}${OFF}`);

  let worst = 0;
  for (const [label, exactValue, measured] of checks) {
    const err = Math.abs(measured / exactValue - 1);
    worst = Math.max(worst, err);
    const color = err < 0.03 ? GREEN : err < 0.06 ? YELLOW : RED;
    console.log(
      `  ${pad(label, 20)}${rpad(exactValue.toFixed(3), 12)}${rpad(measured.toFixed(3), 12)}` +
        `${color}${rpad(`${(err * 100).toFixed(2)}%`, 10)}${OFF}`
    );
  }
  console.log(
    `\n  ${worst < 0.05 ? GREEN + "agrees with theory" : YELLOW + "check run length"}${OFF} ` +
      `${DIM}(worst ${(worst * 100).toFixed(2)}%)${OFF}`
  );
  if (worst >= 0.05) {
    console.log(
      `  ${DIM}Samples needed for a given accuracy scale as 1/(1-rho)^2. Raise --duration.${OFF}`
    );
  }
}

/**
 * Independent replications with measured confidence intervals.
 *
 * Replaces a modelled precision figure with an observed one, and checks the model
 * against it. Two independent routes to the same quantity is the discipline the
 * engine itself is held to.
 */
function replicateMode(design: Design): void {
  heading("replications");
  const count = Number(value("replications") ?? 8);
  const rep = replicate(design, { replications: count });
  console.log(
    `  ${DIM}${rep.seeds.length} independent seeds, ${rep.wallMs}ms. ` +
      `Intervals are 95% (Student's t).${OFF}`
  );
  console.log(
    `  ${DIM}${pad("metric", 20)}${rpad("mean", 12)}${rpad("95% interval", 24)}${rpad("+/-", 9)}${OFF}`
  );

  const rows: Array<[string, keyof typeof rep.intervals, string]> = [
    ["p50 latency", "p50Ms", "ms"],
    ["p99 latency", "p99Ms", "ms"],
    ["p99.9 latency", "p999Ms", "ms"],
    ["mean latency", "meanMs", "ms"],
    ["throughput", "throughputPerSec", "/s"],
    ["error rate", "errorRatePct", "%"],
    ["peak utilization", "maxUtilization", ""],
    ["retry amplification", "retryAmplification", "x"],
  ];
  for (const [label, key, unit] of rows) {
    const iv = rep.intervals[key];
    const rel = Number.isFinite(iv.relativeHalfWidth)
      ? `${(iv.relativeHalfWidth * 100).toFixed(1)}%`
      : "\u2014";
    console.log(
      `  ${pad(label, 20)}${rpad(iv.mean.toFixed(2) + unit, 12)}` +
        `${rpad(`[${iv.low.toFixed(2)}, ${iv.high.toFixed(2)}]`, 24)}${rpad(rel, 9)}`
    );
  }

  console.log(
    `\n  SLO met in ${rep.sloPassCount}/${rep.seeds.length} runs` +
      (rep.sloPassCount > 0 && rep.sloPassCount < rep.seeds.length
        ? ` ${YELLOW}\u2014 on the boundary. A single run would have reported whichever answer ` +
          `its seed gave.${OFF}`
        : ".")
  );

  const check = checkErrorModel(rep);
  console.log(`\n  ${check.agrees ? GREEN + "error model holds" : YELLOW + "error model off"}${OFF}`);
  console.log(`  ${DIM}${check.detail}${OFF}`);
}

/** Paired comparison of two designs on shared seeds. */
function compareMode(design: Design, otherFile: string): void {
  const other = migrateAndParse(JSON.parse(readFileSync(otherFile, "utf8")));
  heading("paired comparison");
  const count = Number(value("replications") ?? 8);
  const cmp = compare(design, other, { replications: count });

  console.log(
    `  ${DIM}baseline "${design.name}" against candidate "${other.name}", ` +
      `${cmp.baseline.seeds.length} shared seeds, ${cmp.simulations} simulations in ${cmp.wallMs}ms${OFF}`
  );
  console.log(
    `  ${DIM}Paired: both sides saw a bit-identical workload, so the per-seed difference removes\n` +
      `  the workload variance and only the effect of the change remains.${OFF}\n`
  );
  console.log(
    `  ${DIM}${pad("metric", 22)}${rpad("baseline", 12)}${rpad("candidate", 12)}${rpad("change", 12)}  verdict${OFF}`
  );
  for (const m of cmp.metrics) {
    const colour =
      m.verdict === "better" ? GREEN : m.verdict === "worse" ? RED : DIM;
    const pct = (m.improvementFraction * 100).toFixed(1);
    console.log(
      `  ${pad(m.label, 22)}${rpad(m.difference.baselineMean.toFixed(2), 12)}` +
        `${rpad(m.difference.candidateMean.toFixed(2), 12)}` +
        `${colour}${rpad(`${m.improvementFraction >= 0 ? "+" : ""}${pct}%`, 12)}${OFF}` +
        `  ${colour}${m.verdict}${OFF}`
    );
  }
  console.log(`\n  ${cmp.sloSummary}`);
  for (const n of cmp.notes) console.log(`  ${YELLOW}${n}${OFF}`);
  console.log(
    `  ${DIM}"no detectable change" means the 95% interval for the difference contains zero \u2014 ` +
      `not that\n  the change did nothing, but that this many replications cannot tell.${OFF}`
  );
}

/** One ramping run: where does the SLO first break. */
function rampMode(design: Design): void {
  heading("ramp to failure");
  const knee = rampToFailure(design, {
    fromRatePerSec: value("from") ? Number(value("from")) : undefined,
    toRatePerSec: value("to") ? Number(value("to")) : undefined,
    durationSec: value("duration") ? Number(value("duration")) : undefined,
  });

  if (knee.unavailableReason) {
    console.log(`  ${YELLOW}${knee.unavailableReason}${OFF}`);
    return;
  }
  console.log(
    `  ${BOLD}SLO first broke at ${knee.breachRatePerSec!.toFixed(0)}/s${OFF} ` +
      `(${knee.breachAtSec!.toFixed(0)}s in, ${knee.breach})`
  );
  console.log(`  ${DIM}${knee.note}${OFF}`);
  console.log(
    `  ${DIM}one simulation in ${knee.result.wallMs}ms, against about ten for a binary search.${OFF}`
  );

  const series = knee.result.latencyP99Series.points;
  const rates = knee.result.offeredRateSeries.points;
  if (series.length > 4) {
    console.log(`\n  ${DIM}${rpad("t", 8)}${rpad("offered", 10)}${rpad("p99", 10)}${OFF}`);
    const step = Math.max(1, Math.floor(series.length / 14));
    for (let i = 0; i < series.length; i += step) {
      const rate = rates[i]?.value ?? 0;
      const p99 = series[i]!.value;
      const breached = knee.breachAtSec !== null && series[i]!.t >= knee.breachAtSec;
      console.log(
        `  ${rpad(series[i]!.t.toFixed(0) + "s", 8)}${rpad(rate.toFixed(0) + "/s", 10)}` +
          `${breached ? RED : GREEN}${rpad(ms(p99), 10)}${OFF}`
      );
    }
  }
}

/** A burst, and how long recovery takes. */
function spikeMode(design: Design): void {
  heading("spike test");
  // `--spike` is a boolean flag, so the burst length needs its own option name;
  // reading the flag as a value picks up whatever argument follows it.
  const spike = spikeTest(design, {
    multiple: value("multiple") ? Number(value("multiple")) : undefined,
    durationSec: value("spike-sec") ? Number(value("spike-sec")) : undefined,
  });
  console.log(
    `  base ${spike.baseRatePerSec.toFixed(0)}/s, peak ${BOLD}${spike.peakRatePerSec.toFixed(0)}/s${OFF}`
  );
  console.log(
    `  p99 baseline ${ms(spike.baselineP99Ms)} \u2192 worst ` +
      `${spike.survivedSpike ? GREEN : RED}${ms(spike.worstP99Ms)}${OFF}`
  );
  console.log(
    `  recovery ${spike.recoverySec === null ? RED + "never" + OFF : GREEN + spike.recoverySec.toFixed(0) + "s" + OFF}`
  );
  console.log(`  ${DIM}${spike.note}${OFF}`);
}

/**
 * The analyzer: findings, critical path, knee, sensitivity, and a config search.
 *
 * Everything here is a question about the space AROUND the design rather than about
 * one run of it, which is why it needs hundreds of simulations and why that is
 * affordable at all.
 */
function analyze(design: Design): void {
  const t0 = Date.now();
  const result = runSimulation(design, { collectTrace: false });
  const report = analyse(design, result);

  heading("summary");
  console.log(`  ${report.summary}`);

  heading("findings");
  if (report.findings.length === 0) {
    console.log(`  ${GREEN}nothing to report${OFF}`);
  }
  for (const f of report.findings) {
    const colour = f.severity === "critical" ? RED : f.severity === "warning" ? YELLOW : DIM;
    console.log(`\n  ${colour}${BOLD}[${f.severity}]${OFF} ${BOLD}${f.title}${OFF}`);
    console.log(`    ${DIM}evidence${OFF}    ${f.evidence}`);
    console.log(`    ${CYAN}fix${OFF}         ${f.remediation}`);
  }

  const path = report.criticalPath;
  if (path) {
    heading("where the latency goes");
    console.log(
      `  ${DIM}end-to-end mean ${ms(path.endToEndMeanMs)}, accounted ${ms(path.accountedMs)} ` +
        `(residual ${(path.residualFraction * 100).toFixed(1)}%)${OFF}`
    );
    console.log(
      `  ${DIM}${pad("component", 26)}${rpad("share", 8)}${rpad("total", 10)}${rpad("per visit", 11)}${rpad("visits", 8)}  queueing${OFF}`
    );
    for (const c of path.contributions.slice(0, 12)) {
      const bar = "\u2588".repeat(Math.max(0, Math.round(c.share * 20)));
      console.log(
        `  ${pad(c.label.slice(0, 25), 26)}${rpad((c.share * 100).toFixed(1) + "%", 8)}` +
          `${rpad(ms(c.totalMs), 10)}${rpad(ms(c.perVisitMs), 11)}` +
          `${rpad(c.visitsPerRequest.toFixed(2), 8)}  ${DIM}${(c.queueShare * 100).toFixed(0)}% ${bar}${OFF}`
      );
    }
    if (path.caveat) console.log(`  ${YELLOW}${path.caveat}${OFF}`);
    console.log(`  ${DIM}p99 attribution withheld: ${path.p99Reason}${OFF}`);
  }

  heading("where it breaks");
  const knee = findKnee(design);
  if (knee.unavailableReason) {
    console.log(`  ${YELLOW}${knee.unavailableReason}${OFF}`);
  } else {
    const dir = knee.headroomFraction >= 0 ? "headroom" : "OVER by";
    const colour = knee.headroomFraction >= 0.2 ? GREEN : knee.headroomFraction >= 0 ? YELLOW : RED;
    console.log(
      `  currently ${knee.currentRatePerSec.toFixed(0)}/s, holds to ` +
        `${BOLD}${knee.maxRatePerSec.toFixed(0)}/s${OFF} \u2014 ` +
        `${colour}${dir} ${Math.abs(knee.headroomFraction * 100).toFixed(0)}%${OFF}`
    );
    console.log(`  ${DIM}first breach: ${knee.breach ?? "none"} at ${knee.firstFailingRatePerSec?.toFixed(0) ?? "?"}/s${OFF}`);
    console.log(`  ${DIM}${knee.precisionNote}${OFF}`);
    if (knee.nonMonotonic) {
      console.log(
        `  ${YELLOW}a lower rate also failed, so this boundary is not a boundary (usually shedding).${OFF}`
      );
    }
    console.log(`  ${DIM}${knee.simulations} simulations in ${knee.wallMs}ms${OFF}`);
  }

  heading("which knob matters");
  const sens = sensitivity(design);
  console.log(
    `  ${DIM}each parameter improved by ${(sens.perturbation * 100).toFixed(0)}%, then re-simulated. ` +
      `baseline p99 ${ms(sens.baseP99Ms)}${OFF}`
  );
  console.log(
    `  ${DIM}${pad("parameter", 30)}${rpad("change", 16)}${rpad("p99", 10)}${rpad("gain", 10)}${rpad("elasticity", 11)}${OFF}`
  );
  for (const r of sens.results.slice(0, 10)) {
    const colour = r.improvementMs > sens.baseP99Ms * 0.05 ? GREEN : DIM;
    console.log(
      `  ${pad(r.label.slice(0, 29), 30)}` +
        `${rpad(`${fmtNum(r.baseValue)}\u2192${fmtNum(r.improvedValue)}`, 16)}` +
        `${rpad(ms(r.improvedP99Ms), 10)}` +
        `${colour}${rpad(r.improvementMs >= 0 ? "-" + ms(r.improvementMs) : "+" + ms(-r.improvementMs), 10)}${OFF}` +
        `${rpad(r.elasticity === null ? "\u2014" : r.elasticity.toFixed(2), 11)}` +
        (r.fixesSlo ? `  ${GREEN}fixes SLO${OFF}` : "")
    );
  }
  for (const n of sens.notes) console.log(`  ${DIM}${n}${OFF}`);
  console.log(`  ${DIM}${sens.simulations} simulations in ${sens.wallMs}ms${OFF}`);

  if (result.sloPassed === false) {
    heading("smallest change that meets the SLO");
    const search = searchConfig(design);
    if (!search.found) {
      console.log(`  ${YELLOW}${search.reason}${OFF}`);
    } else if (search.changes.length === 0) {
      console.log(`  ${GREEN}no changes needed${OFF}`);
    } else {
      for (const c of search.changes) {
        console.log(
          `  ${pad(c.label.slice(0, 34), 35)}${rpad(fmtNum(c.from), 8)}\u2192 ` +
            `${GREEN}${fmtNum(c.to)}${OFF} ${DIM}(${c.factor.toFixed(1)}\u00d7)${OFF}`
        );
      }
      console.log(
        `  ${DIM}p99 ${ms(search.beforeP99Ms)} \u2192 ${ms(search.afterP99Ms)} \u00b7 ` +
          `${search.simulations} simulations in ${search.wallMs}ms${OFF}`
      );
      console.log(
        `  ${DIM}Minimal in one step: dialling any single change back breaks the SLO again. ` +
          `\n  No cost model, so this is the smallest SET of changes, not the cheapest.${OFF}`
      );
    }
    for (const n of search.notes) console.log(`  ${DIM}${n}${OFF}`);
  }

  console.log(`\n${DIM}total ${Date.now() - t0}ms${OFF}`);
}

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(v < 10 ? 2 : 1);
}

/**
 * Sweep arrival rate to find where the design breaks.
 *
 * A preview of the Phase 4 analyzer, and the clearest evidence for the headless
 * split: this runs dozens of complete simulations in seconds. Under the previous
 * architecture, where the model advanced only on animation frames, it would have
 * taken as many minutes as the runs were long.
 */
function sweep(design: Design): void {
  heading("capacity sweep");
  const clients = design.nodes.filter((n) => n.kind === "client");
  if (clients.length !== 1) {
    console.log(`  ${YELLOW}Skipped: sweeping needs exactly one client to vary.${OFF}`);
    return;
  }
  const base = meanRate(clients[0]!.client!.arrival, design.scenario.durationSec * 1000);
  const target = design.slo.p99LatencyMs;

  // Shorter runs than a headline measurement: a sweep is looking for the shape of
  // the curve and the location of the knee, not a publication-grade p99 at each
  // point. Precision per point is reported so the tradeoff is visible.
  const durationSec = Math.max(120, Math.round(design.scenario.durationSec / 6));
  const warmupSec = Math.round(durationSec * 0.2);

  const rates: number[] = [];
  for (let f = 0.2; f <= 1.8001; f += 0.1) rates.push(Math.round(base * f));

  console.log(
    `  ${DIM}varying offered load around ${base}/s · ${durationSec}s per point · ` +
      `${target !== null ? `p99 target ${target}ms` : "no p99 target"}${OFF}\n`
  );
  console.log(
    `  ${DIM}${rpad("offered", 9)}${rpad("done", 9)}${rpad("util", 8)}${rpad("p99", 10)}${rpad("errors", 9)}  state${OFF}`
  );

  const t0 = Date.now();
  let knee: number | null = null;
  let runs = 0;

  for (const rate of rates) {
    const d = DesignSchema.parse({
      ...design,
      nodes: design.nodes.map((n) =>
        n.kind === "client" && n.client
          ? { ...n, client: { ...n.client, arrival: scaleArrival(n.client.arrival, rate / base) } }
          : n
      ),
      scenario: { ...design.scenario, durationSec, warmupSec },
    });
    const r = runSimulation(d, { collectTrace: false });
    runs++;

    const util = Math.max(...r.nodes.map((n) => n.utilization), 0);
    const breaches = target !== null && r.endToEnd.p99 > target;
    if (knee === null && (breaches || !r.stability.stable)) knee = rate;

    const state = !r.stability.stable
      ? `${RED}unstable${OFF}`
      : breaches
        ? `${YELLOW}over slo${OFF}`
        : `${GREEN}ok${OFF}`;

    console.log(
      `  ${rpad(String(rate), 9)}${rpad(r.throughputPerSec.toFixed(0), 9)}` +
        `${rpad(pctOf(util), 8)}${rpad(ms(r.endToEnd.p99), 10)}` +
        `${rpad(r.errors.ratePct.toFixed(1) + "%", 9)}  ${state}`
    );
  }

  console.log(
    `\n  ${DIM}${runs} full simulations in ${Date.now() - t0}ms${OFF}`
  );
  if (knee !== null) {
    console.log(
      `  ${BOLD}breaks at approximately ${knee} req/s${OFF} ` +
        `${DIM}(${((knee / base - 1) * 100).toFixed(0)}% above current load)${OFF}`
    );
  } else {
    console.log(`  ${GREEN}holds across the whole swept range${OFF}`);
  }
  console.log(
    `  ${DIM}Per-point runs are short, so the knee is approximate. Phase 4 will binary-search it.${OFF}`
  );
}

// ---- main ----

const design = loadDesign();

const durationOverride = value("duration");
const seedOverride = value("seed");

/**
 * Scale warm-up with a `--duration` override, preserving the design's warm-up fraction.
 *
 * Overriding the duration alone is a trap: `--duration 60` against an example that
 * declares 900s with a 150s warm-up leaves warm-up longer than the whole run, and the
 * design is rejected as unrunnable — which reads as a problem with the example rather
 * than with the flag. Worse, the engine itself would have accepted it, clamping warm-up
 * to 90% of the run and quietly measuring a 6-second window.
 *
 * `--duration` means "run a shorter run", not "keep the long warm-up", so the fraction
 * is what carries over. `--sweep` already did this for the same reason.
 */
const scaledScenario = (() => {
  if (!durationOverride) return {};
  const durationSec = Number(durationOverride);
  const fraction = design.scenario.warmupSec / design.scenario.durationSec;
  // At least one second, and never more than half the run, so a measurement window
  // always survives even for a degenerate source design.
  const warmupSec = Math.max(1, Math.min(Math.round(durationSec * fraction), Math.floor(durationSec / 2)));
  return { durationSec, warmupSec };
})();

const effective = DesignSchema.parse({
  ...design,
  scenario: {
    ...design.scenario,
    ...scaledScenario,
    ...(seedOverride ? { seed: Number(seedOverride) } : {}),
  },
});

const issues = validateDesign(effective).filter((i) => i.severity === "error");
if (issues.length > 0) {
  console.log(`${RED}design is not runnable:${OFF}`);
  for (const i of issues) console.log(`  ${i.message}`);
  process.exit(1);
}

console.log(`${CYAN}${BOLD}system design studio${OFF} ${DIM}phase 5 verification${OFF}`);

try {
  if (flag("analyze") || flag("analyse")) {
    analyze(effective);
  } else if (flag("replicate")) {
    replicateMode(effective);
  } else if (value("compare")) {
    compareMode(effective, value("compare")!);
  } else if (flag("ramp")) {
    rampMode(effective);
  } else if (flag("spike")) {
    spikeMode(effective);
  } else if (flag("sweep")) {
    sweep(effective);
  } else if (flag("validate")) {
    validate(effective);
  } else {
    report(effective, runSimulation(effective));
  }
} catch (err) {
  console.log(`\n${RED}refused:${OFF} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log();
