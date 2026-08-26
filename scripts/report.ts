/**
 * CLI verification tool.
 *
 * Exists so the engine's claims can be checked without a browser and without
 * reading test source. Three modes:
 *
 *   pnpm sim                    run a design, print the full report
 *   pnpm sim --validate         cross-check the run against closed-form theory
 *   pnpm sim --sweep            sweep arrival rate and find where the design breaks
 *
 * The sweep is included deliberately: it is the clearest demonstration of why the
 * engine had to be headless. It runs dozens of full simulations in a couple of
 * seconds, which was structurally impossible when the model was driven by
 * requestAnimationFrame.
 */
import { readFileSync } from "node:fs";
import { previewDesign, solveMMc } from "@sds/analytic";
import { runSimulation, type RunResult } from "@sds/core";
import {
  DesignSchema,
  defaultDesign,
  migrateAndParse,
  validateDesign,
  type Design,
} from "@sds/schema";

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
  if (!file) return defaultDesign();
  return migrateAndParse(JSON.parse(readFileSync(file, "utf8")));
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

  if (!result.stability.stable) {
    heading("VERDICT: does not scale");
    console.log(`  ${RED}${result.stability.detail}${OFF}`);
    console.log(
      `  ${DIM}Latency figures below are a function of run length, not of the design.${OFF}`
    );
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

  heading("stations");
  console.log(
    `  ${DIM}${pad("station", 16)}${rpad("c", 4)}${rpad("util", 8)}${rpad("Lq", 8)}${rpad("maxQ", 7)}${rpad("wait", 9)}${rpad("shed", 8)}${OFF}`
  );
  for (const n of result.nodes.filter((x) => x.kind === "server")) {
    const util = n.utilization;
    const utilColor = util >= 0.85 ? RED : util >= 0.7 ? YELLOW : GREEN;
    console.log(
      `  ${pad(n.label.slice(0, 15), 16)}${rpad(String(n.capacity), 4)}` +
        `${utilColor}${rpad(pctOf(util), 8)}${OFF}` +
        `${rpad(n.avgQueueLength.toFixed(2), 8)}${rpad(String(n.maxQueueLength), 7)}` +
        `${rpad(ms(n.avgWaitMs), 9)}${rpad(n.shed.toLocaleString(), 8)}`
    );
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

  const lambda = clients[0]!.client!.arrival.ratePerSec;
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
  const base = clients[0]!.client!.arrival.ratePerSec;
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
          ? { ...n, client: { ...n.client, arrival: { ...n.client.arrival, ratePerSec: rate } } }
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
const effective = DesignSchema.parse({
  ...design,
  scenario: {
    ...design.scenario,
    ...(durationOverride ? { durationSec: Number(durationOverride) } : {}),
    ...(seedOverride ? { seed: Number(seedOverride) } : {}),
  },
});

const issues = validateDesign(effective).filter((i) => i.severity === "error");
if (issues.length > 0) {
  console.log(`${RED}design is not runnable:${OFF}`);
  for (const i of issues) console.log(`  ${i.message}`);
  process.exit(1);
}

console.log(`${CYAN}${BOLD}system design studio${OFF} ${DIM}phase 1 verification${OFF}`);

try {
  if (flag("sweep")) {
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
