import {
  classesOf,
  isRunnable,
  isTimeVarying,
  meanRate,
  peakRate,
  rateAt,
  validateDesign,
  type Design,
  type RequestClass,
  type SdsEdge,
  type SdsNode,
} from "@sds/schema";
import { CallSite } from "./callsite";
import {
  buildComponent,
  callDependencies,
  type Component,
  type ComponentEnv,
  type RequestCtx,
  type TraceSink,
} from "./components";
import { assessConfidence } from "./confidence";
import { LatencyHistogram } from "./histogram";
import { RngBundle } from "./rng";
import { Sim, type Process } from "./sim";
import { TimeSeries } from "./timeseries";
import type {
  ClassResult,
  EdgeResult,
  ErrorBreakdown,
  ErrorReason,
  InvariantReport,
  LatencySummary,
  NodeResult,
  RunResult,
  SeriesData,
  StabilityReport,
  Trace,
  TraceHop,
  TraceVisit,
} from "./result";

/** Tolerance on Little's Law. See `checkLittlesLaw` for why it is not tighter. */
const LITTLE_TOLERANCE = 0.05;

/**
 * Queue growth above this many items per second of simulated time is treated as
 * unbounded. Not zero, because a finite sample of a stable queue has non-zero
 * measured slope from noise alone.
 */
const INSTABILITY_SLOPE_THRESHOLD = 0.05;

/** Amplification above this is called out as a retry storm. */
const RETRY_AMPLIFICATION_THRESHOLD = 1.25;

/**
 * Time-weighted accumulator for a counting quantity (e.g. requests in system).
 *
 * Time-weighted, not event-weighted: Little's Law relates throughput and latency
 * to the time-average population. An average taken per arrival would weight an
 * idle second identically to a saturated one and the law would not hold.
 */
class Integrator {
  private value = 0;
  private integral = 0;
  private lastT: number;
  private startT: number;
  private _startValue = 0;

  constructor(private readonly sim: Sim) {
    this.lastT = sim.now;
    this.startT = sim.now;
  }

  private touch(): void {
    const dt = this.sim.now - this.lastT;
    if (dt > 0) {
      this.integral += this.value * dt;
      this.lastT = this.sim.now;
    }
  }

  add(n: number): void {
    this.touch();
    this.value += n;
  }

  get current(): number {
    return this.value;
  }

  /** Population at the moment measurement began. Needed for conservation. */
  get startValue(): number {
    return this._startValue;
  }

  reset(): void {
    this.touch();
    this.integral = 0;
    this.startT = this.sim.now;
    this._startValue = this.value;
  }

  timeAverage(): number {
    this.touch();
    const span = this.sim.now - this.startT;
    return span > 0 ? this.integral / span : 0;
  }
}

class ClassRecorder {
  readonly latency = new LatencyHistogram();
  succeeded = 0;
  failed = 0;
  shed = 0;
  timeout = 0;
  network = 0;
  queueFull = 0;
  error = 0;
  circuitOpen = 0;
  bulkheadFull = 0;

  reset(): void {
    this.latency.reset();
    this.succeeded = 0;
    this.failed = 0;
    this.shed = 0;
    this.timeout = 0;
    this.network = 0;
    this.queueFull = 0;
    this.error = 0;
    this.circuitOpen = 0;
    this.bulkheadFull = 0;
  }

  record(latencyMs: number, reason: ErrorReason | null): void {
    if (reason === null) {
      this.succeeded++;
      this.latency.record(latencyMs);
      return;
    }
    this.failed++;
    switch (reason) {
      case "shed":
        this.shed++;
        break;
      case "timeout":
        this.timeout++;
        break;
      case "network":
        this.network++;
        break;
      case "queue-full":
        this.queueFull++;
        break;
      case "error":
        this.error++;
        break;
      case "circuit-open":
        this.circuitOpen++;
        break;
      case "bulkhead-full":
        this.bulkheadFull++;
        break;
    }
  }

  errors(): ErrorBreakdown {
    const total = this.succeeded + this.failed;
    return {
      total: this.failed,
      shed: this.shed,
      timeout: this.timeout,
      network: this.network,
      queueFull: this.queueFull,
      error: this.error,
      circuitOpen: this.circuitOpen,
      bulkheadFull: this.bulkheadFull,
      ratePct: total > 0 ? (this.failed / total) * 100 : 0,
    };
  }
}

class Recorder {
  readonly overall = new ClassRecorder();
  /** All departures, success or failure. Used only for the Little's Law check. */
  readonly allDepartureLatency = new LatencyHistogram();
  readonly byClass = new Map<string, ClassRecorder>();
  /** Rolling window, reset each sample period, for the p99-over-time series. */
  windowLatency = new LatencyHistogram();
  created = 0;
  windowCompletions = 0;
  windowDepartures = 0;
  windowFailures = 0;

  constructor(classes: RequestClass[]) {
    for (const c of classes) this.byClass.set(c.id, new ClassRecorder());
  }

  reset(): void {
    this.overall.reset();
    this.allDepartureLatency.reset();
    for (const r of this.byClass.values()) r.reset();
    this.windowLatency.reset();
    this.created = 0;
    this.windowCompletions = 0;
    this.windowDepartures = 0;
    this.windowFailures = 0;
  }
}

function summarize(h: LatencyHistogram): LatencySummary {
  return {
    count: h.count,
    mean: h.mean,
    min: h.min,
    max: h.max,
    relativeError: h.relativeError,
    ...h.percentiles(),
  };
}

function series(ts: TimeSeries): SeriesData {
  return { name: ts.name, points: ts.values().map((p) => ({ t: p.t, value: p.value })) };
}

export interface RunOptions {
  /** Overrides the design's seed. Used by sweeps to average over replications. */
  seed?: number;
  /** Overrides the design's duration, simulated seconds. */
  durationSec?: number;
  /** Set false to skip trace collection entirely (sweeps do not need it). */
  collectTrace?: boolean;
}

/**
 * Run a discrete-event simulation of a design and return measured results.
 *
 * Fully deterministic: identical (design, seed) produces an identical result,
 * byte for byte. Nothing here reads a clock, touches the DOM, or depends on
 * frame timing.
 */
export function runSimulation(design: Design, opts: RunOptions = {}): RunResult {
  const wallStart = Date.now();

  if (!isRunnable(design)) {
    const errors = validateDesign(design)
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join("; ");
    throw new Error(`design is not runnable: ${errors}`);
  }

  const seed = opts.seed ?? design.scenario.seed;
  const durationSec = opts.durationSec ?? design.scenario.durationSec;
  const warmupSec = Math.min(design.scenario.warmupSec, durationSec * 0.9);
  const durationMs = durationSec * 1000;
  const warmupMs = warmupSec * 1000;
  const observedSec = durationSec - warmupSec;
  const collectTrace = opts.collectTrace ?? true;

  const sim = new Sim();
  const rng = new RngBundle(seed);
  const arrivalRng = rng.stream("arrival");
  const classRng = rng.stream("routing");

  const classes = classesOf(design);
  const totalWeight = classes.reduce((s, c) => s + c.weight, 0);
  const rec = new Recorder(classes);
  const inSystem = new Integrator(sim);

  // ---- trace collection ----
  const hops: TraceHop[] = [];
  const visits: TraceVisit[] = [];
  const traceCapacity = collectTrace ? design.scenario.traceLimit : 0;
  const trace: TraceSink = {
    canTrace: () => hops.length + visits.length < traceCapacity,
    hop: (requestId, edgeId, tStart, tEnd, delivered, forward) => {
      if (hops.length + visits.length < traceCapacity) {
        hops.push({ requestId, edgeId, tStart, tEnd, delivered, forward });
      }
    },
    visit: (requestId, nodeId, tEnqueue, tServiceStart, tExit, outcome) => {
      if (hops.length + visits.length < traceCapacity) {
        visits.push({ requestId, nodeId, tEnqueue, tServiceStart, tExit, outcome });
      }
    },
  };

  // ---- measurement window ----
  let measuring = warmupMs <= 0;
  const measuringFn = () => measuring;

  // ---- components ----
  const outgoing = new Map<string, SdsEdge[]>();
  for (const e of design.edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }

  /**
   * One CallSite per edge, holding the caller's circuit breaker, bulkhead and
   * retry budget. Created only where a policy is configured, so an edge with no
   * policy takes a path with no extra bookkeeping at all.
   */
  const callSites = new Map<string, CallSite>();
  for (const e of design.edges) {
    const p = e.policy;
    const hasPolicy =
      p.retry !== null || p.timeoutMs !== null || p.circuitBreaker.enabled || p.bulkhead.enabled;
    if (hasPolicy) callSites.set(e.id, new CallSite(e, sim));
  }

  const edgeTraversals = new Map<string, number>();
  const components = new Map<string, Component>();
  const env: ComponentEnv = {
    sim,
    rng,
    design,
    components,
    outgoing,
    callSites,
    edgeTraversals,
    trace,
    measuring: measuringFn,
  };
  for (const node of design.nodes) {
    const component = buildComponent(node, env);
    if (component) components.set(node.id, component);
  }

  const clients = design.nodes.filter((n) => n.kind === "client" && n.client);
  // Time-average offered rate: for a stationary process this is just the rate, and
  // for a ramp or a spike it is the mean over the run.
  const offeredRatePerSec = clients.reduce(
    (sum, c) => sum + (c.client ? meanRate(c.client.arrival, durationMs) : 0),
    0
  );
  /**
   * True when every client offers a constant rate.
   *
   * When false the run has no steady state by construction, and aggregate
   * percentiles average across regimes that never coexisted -- part of the sample
   * taken at one load and part at another. The result says so rather than printing a
   * number whose meaning depends on the shape of the ramp.
   */
  const steadyState = clients.every((c) => c.client && !isTimeVarying(c.client.arrival));

  // ---- trace sampling ----
  const expectedRequests = Math.max(1, offeredRatePerSec * observedSec);
  const estimatedEventsPerRequest = Math.max(2, design.edges.length * 3);
  const maxSampledRequests = Math.max(1, Math.floor(traceCapacity / estimatedEventsPerRequest));
  const sampleEvery = Math.max(1, Math.ceil(expectedRequests / maxSampledRequests));

  const throughputSeries = new TimeSeries("throughput");
  const latencyP99Series = new TimeSeries("latencyP99");
  const offeredRateSeries = new TimeSeries("offeredRate");

  /**
   * The first moment the SLO broke, and the offered rate then.
   *
   * The whole point of a ramp: one run that locates the capacity limit, rather than
   * a dozen runs bisecting for it. Recorded from the sampler's rolling window, so it
   * marks the first window that breached rather than the first individual slow
   * request -- a single unlucky request is not a breach.
   */
  let firstBreach: RunResult["firstBreach"] = null;

  /**
   * Recent window histograms, merged for breach detection.
   *
   * A p99 taken from a single sample window is close to useless: at a few dozen
   * samples the 99th percentile is essentially the maximum, and a lognormal service
   * time throws a large maximum often enough that a bare window would breach almost
   * immediately regardless of load. That would make a ramp report a limit far below
   * the truth, which is the opposite of the lag it is supposed to have.
   *
   * Merging the last few windows buys an order of magnitude more samples while
   * staying local in time, which is the property a ramp needs.
   */
  const BREACH_WINDOWS = 6;
  const BREACH_MIN_SAMPLES = 200;
  const recentLatency: LatencyHistogram[] = [];
  const recentDepartures: Array<{ departures: number; failures: number }> = [];

  // ---- request lifecycle ----
  let nextRequestId = 0;

  function pickClass(): RequestClass {
    if (classes.length === 1) return classes[0]!;
    let u = classRng.next() * totalWeight;
    for (const c of classes) {
      u -= c.weight;
      if (u <= 0) return c;
    }
    return classes[classes.length - 1]!;
  }

  function* requestProcess(client: SdsNode): Process<void> {
    const requestId = nextRequestId++;
    const entryT = sim.now;
    const cls = pickClass();
    const traced = measuring && collectTrace && trace.canTrace() && requestId % sampleEvery === 0;
    const timeoutMs = client.client?.timeoutMs ?? null;

    const ctx: RequestCtx = {
      requestId,
      classId: cls.id,
      serviceMultiplier: cls.serviceMultiplier,
      deadlineAt: timeoutMs === null ? null : entryT + timeoutMs,
      traced,
    };

    // Population is tracked unconditionally: it is a physical quantity, and
    // Little's Law compares it against a departure rate that is also measured
    // over everyone.
    inSystem.add(1);
    if (measuring) rec.created++;

    /**
     * MEASUREMENT IS FLOW-BASED, NOT COHORT-BASED.
     *
     * An earlier version recorded only requests that *entered* after warm-up.
     * That is defensible in isolation but produces a badly wrong throughput under
     * overload: with a long FIFO backlog, most requests completing during the
     * window entered before it, so they were excluded and measured throughput
     * came out at 37/s against a true capacity of 50/s.
     *
     * Counting departures within the window instead matches both what a
     * monitoring system reports and the form of Little's Law used here: L over
     * everyone present, lambda over everyone departing, W over the same
     * departures. All three are then consistent by construction.
     */
    const outcome = yield* callDependencies(env, client.id, ctx, "sequential");

    inSystem.add(-1);
    if (measuring) {
      const sojourn = sim.now - entryT;
      const reason = outcome.ok ? null : (outcome.reason ?? "timeout");
      rec.allDepartureLatency.record(sojourn);
      rec.overall.record(sojourn, reason);
      rec.byClass.get(cls.id)?.record(sojourn, reason);
      rec.windowDepartures++;
      if (reason === null) {
        rec.windowLatency.record(sojourn);
        rec.windowCompletions++;
      } else {
        rec.windowFailures++;
      }
    }
  }

  /**
   * Arrival generation, stationary and otherwise.
   *
   * A time-varying Poisson process is generated by THINNING (Lewis & Shedler):
   * propose candidate arrivals at the peak rate, then accept each with probability
   * rate(t)/peak. The result is an exact non-homogeneous Poisson process, which
   * matters because the obvious alternative -- recomputing an exponential gap from
   * the instantaneous rate -- is subtly wrong. That version assumes the rate holds
   * for the whole gap, so it lags a rising ramp and overshoots a falling one, and the
   * error grows with how fast the rate moves.
   *
   * Thinning costs some rejected candidates, which is why the peak rather than the
   * mean bounds the proposal rate: a spike ten times the base means most candidates
   * are rejected during the quiet period. That is a few wasted random draws, not a
   * few wasted simulations.
   */
  function* clientProcess(client: SdsNode): Process<void> {
    const arrival = client.client!.arrival;

    if (arrival.kind === "poisson" || arrival.kind === "deterministic") {
      const meanGapMs = 1000 / arrival.ratePerSec;
      for (;;) {
        const gap =
          arrival.kind === "poisson"
            ? -Math.log(arrivalRng.nextNonZero()) * meanGapMs
            : meanGapMs;
        yield { kind: "delay", ms: gap };
        if (sim.now > durationMs) return;
        sim.spawn(requestProcess(client));
      }
    }

    const peak = peakRate(arrival);
    const proposalGapMs = 1000 / peak;
    for (;;) {
      const gap = -Math.log(arrivalRng.nextNonZero()) * proposalGapMs;
      yield { kind: "delay", ms: gap };
      if (sim.now > durationMs) return;
      const rate = rateAt(arrival, sim.now, durationMs);
      // Accept with probability rate(t)/peak. Uses the arrival stream so that
      // thinning decisions stay part of the workload rather than perturbing any
      // other stream -- common random numbers still hold across design changes.
      if (rate >= peak || arrivalRng.next() < rate / peak) {
        sim.spawn(requestProcess(client));
      }
    }
  }

  for (const c of clients) sim.spawn(clientProcess(c));
  // Long-running component processes (queue consumers).
  for (const component of components.values()) {
    for (const p of component.processes?.() ?? []) sim.spawn(p);
  }

  // ---- warm-up boundary ----
  if (warmupMs > 0) {
    sim.at(warmupMs, () => {
      measuring = true;
      rec.reset();
      inSystem.reset();
      for (const component of components.values()) component.resetStats();
      for (const site of callSites.values()) site.resetStats();
      edgeTraversals.clear();
      throughputSeries.reset();
      latencyP99Series.reset();
      offeredRateSeries.reset();
      firstBreach = null;
      recentLatency.length = 0;
      recentDepartures.length = 0;
    });
  }

  // ---- periodic sampler ----
  const samplePeriodMs = Math.max(100, durationMs / 600);
  const sampleTick = () => {
    if (measuring) {
      const tSec = (sim.now - (warmupMs > 0 ? warmupMs : 0)) / 1000;
      for (const component of components.values()) component.sample(tSec);
      throughputSeries.push(tSec, (rec.windowCompletions * 1000) / samplePeriodMs);
      const windowP99 = rec.windowLatency.count > 0 ? rec.windowLatency.quantile(0.99) : 0;
      latencyP99Series.push(tSec, windowP99);

      const rateNow = clients.reduce(
        (sum, c) => sum + (c.client ? rateAt(c.client.arrival, sim.now, durationMs) : 0),
        0
      );
      offeredRateSeries.push(tSec, rateNow);

      recentLatency.push(rec.windowLatency);
      recentDepartures.push({ departures: rec.windowDepartures, failures: rec.windowFailures });
      if (recentLatency.length > BREACH_WINDOWS) recentLatency.shift();
      if (recentDepartures.length > BREACH_WINDOWS) recentDepartures.shift();

      if (firstBreach === null) {
        const target = design.slo.p99LatencyMs;
        const errorTarget = design.slo.maxErrorRatePct;

        const merged = new LatencyHistogram();
        for (const h of recentLatency) merged.merge(h);

        if (target !== null && merged.count >= BREACH_MIN_SAMPLES && merged.quantile(0.99) > target) {
          firstBreach = { atSec: tSec, offeredRatePerSec: rateNow, breach: "latency" };
        } else if (errorTarget !== null) {
          const departures = recentDepartures.reduce((s2, w) => s2 + w.departures, 0);
          const failures = recentDepartures.reduce((s2, w) => s2 + w.failures, 0);
          if (departures >= BREACH_MIN_SAMPLES && (failures / departures) * 100 > errorTarget) {
            firstBreach = { atSec: tSec, offeredRatePerSec: rateNow, breach: "errors" };
          }
        }
      }

      rec.windowCompletions = 0;
      rec.windowDepartures = 0;
      rec.windowFailures = 0;
      rec.windowLatency = new LatencyHistogram();
    }
    if (sim.now + samplePeriodMs <= durationMs) sim.after(samplePeriodMs, sampleTick);
  };
  sim.after(samplePeriodMs, sampleTick);

  // ---- go ----
  sim.run(durationMs);

  // ---- assemble ----
  const rootRequests = rec.overall.succeeded + rec.overall.failed;
  const nodeResults: NodeResult[] = design.nodes.map((node) => {
    const component = components.get(node.id);
    if (!component) return clientResult(node);
    const r = component.result(observedSec);
    // Visits per request, so a station called on every request is distinguishable
    // from one called on 5% of them -- which is what turns a per-visit self time
    // into a share of end-to-end latency.
    return {
      ...r,
      visitsPerRequest: rootRequests > 0 ? r.arrivals / rootRequests : 0,
    };
  });

  const labelOf = (id: string) => design.nodes.find((n) => n.id === id)?.label ?? id;
  const edgeResults: EdgeResult[] = design.edges.map((e) => {
    const site = callSites.get(e.id);
    const m = site?.metrics();
    return {
      edgeId: e.id,
      from: e.from,
      to: e.to,
      fromLabel: labelOf(e.from),
      toLabel: labelOf(e.to),
      traversals: edgeTraversals.get(e.id) ?? 0,
      calls: m?.calls ?? 0,
      attempts: m?.attempts ?? 0,
      retries: m?.retries ?? 0,
      amplification: m?.amplification ?? 1,
      successes: m?.successes ?? 0,
      failures: m?.failures ?? 0,
      budgetRejections: m?.budgetRejections ?? 0,
      circuitRejections: m?.circuitRejections ?? 0,
      bulkheadRejections: m?.bulkheadRejections ?? 0,
      breakerTrips: m?.breakerTrips ?? 0,
      breakerOpenFraction: m?.breakerOpenFraction ?? 0,
      breakerState: m?.breakerState ?? "closed",
      avgConcurrency: m?.avgConcurrency ?? 0,
      maxConcurrency: m?.maxConcurrency ?? 0,
      bulkheadUtilization: m?.bulkheadUtilization ?? null,
      bulkheadMaxInUse: m?.bulkheadMaxInUse ?? null,
      hasPolicy: site !== undefined,
    };
  });

  const totalCalls = edgeResults.reduce((s2, e) => s2 + e.calls, 0);
  const totalAttempts = edgeResults.reduce((s2, e) => s2 + e.attempts, 0);
  const retryAmplification = totalCalls > 0 ? totalAttempts / totalCalls : 1;

  const stability = checkStability(nodeResults, edgeResults, observedSec);
  const componentInvariants: InvariantReport[] = [];
  for (const component of components.values()) {
    componentInvariants.push(...component.invariants());
  }
  for (const site of callSites.values()) {
    componentInvariants.push(...site.invariants());
  }
  const invariants = [
    ...checkFlowConservation(rec, inSystem),
    ...componentInvariants,
    checkLittlesLaw(rec, inSystem, observedSec, stability.stable),
  ];

  const maxUtilization = nodeResults.reduce(
    (m, n) => (n.kind === "client" ? m : Math.max(m, n.utilization)),
    0
  );
  const departures = rec.overall.succeeded + rec.overall.failed;
  const confidence = assessConfidence(departures, maxUtilization, observedSec);

  const endToEnd = summarize(rec.overall.latency);
  const errors = rec.overall.errors();

  const classResults: ClassResult[] = classes.map((c) => {
    const r = rec.byClass.get(c.id)!;
    return {
      classId: c.id,
      label: c.label,
      share: totalWeight > 0 ? c.weight / totalWeight : 0,
      throughputPerSec: observedSec > 0 ? r.succeeded / observedSec : 0,
      latency: summarize(r.latency),
      errors: r.errors(),
    };
  });

  const traceResult: Trace = {
    hops,
    visits,
    sampleEvery,
    truncated: collectTrace && hops.length + visits.length >= traceCapacity,
  };

  const sloPassed = evaluateSlo(design, endToEnd, errors.ratePct, stability.stable);

  return {
    design,
    observedSec,
    steadyState,
    aggregateCaveat: steadyState
      ? null
      : `offered load varies over the run, so there is no steady state. The percentiles below ` +
        `average across regimes that never coexisted \u2014 read the time series and the first-breach ` +
        `figure instead.`,
    firstBreach,
    offeredRateSeries: series(offeredRateSeries),
    throughputPerSec: observedSec > 0 ? rec.overall.succeeded / observedSec : 0,
    offeredRatePerSec,
    endToEnd,
    errors,
    avgInSystem: inSystem.timeAverage(),
    nodes: nodeResults,
    edges: edgeResults,
    classes: classResults,
    retryAmplification,
    invariants,
    stability,
    confidence,
    sloPassed,
    trace: traceResult,
    throughputSeries: series(throughputSeries),
    latencyP99Series: series(latencyP99Series),
    wallMs: Date.now() - wallStart,
  };
}

const EMPTY_LATENCY: LatencySummary = {
  count: 0,
  mean: 0,
  min: 0,
  max: 0,
  relativeError: 0,
  p50: 0,
  p90: 0,
  p99: 0,
  p999: 0,
};

function clientResult(node: SdsNode): NodeResult {
  return {
    nodeId: node.id,
    label: node.label,
    kind: "client",
    capacity: 0,
    utilization: 0,
    avgQueueLength: 0,
    maxQueueLength: 0,
    avgInStation: 0,
    arrivals: 0,
    admitted: 0,
    shed: 0,
    abandoned: 0,
    completed: 0,
    avgWaitMs: 0,
    serviceMeanMs: 0,
    serviceScv: 0,
    arrivalRatePerSec: 0,
    residencyMs: EMPTY_LATENCY,
    selfTimeMs: EMPTY_LATENCY,
    visitsPerRequest: 0,
    queueLengthSeries: { name: "queueLength", points: [] },
    utilizationSeries: { name: "utilization", points: [] },
  };
}

function evaluateSlo(
  design: Design,
  endToEnd: LatencySummary,
  errorRatePct: number,
  stable: boolean
): boolean | null {
  const { p99LatencyMs, maxErrorRatePct } = design.slo;
  if (p99LatencyMs === null && maxErrorRatePct === null) return null;
  // An unstable system has no steady-state latency, so it cannot pass an SLO
  // regardless of what the truncated measurement happened to record.
  if (!stable) return false;
  if (p99LatencyMs !== null && endToEnd.p99 > p99LatencyMs) return false;
  if (maxErrorRatePct !== null && errorRatePct > maxErrorRatePct) return false;
  return true;
}

/**
 * Detect a system with no steady state.
 *
 * When arrivals exceed total service capacity the queue grows for as long as you
 * run it, so every latency statistic is a function of run length rather than of
 * the design. Reporting "p99 = 4.2s" in that regime is meaningless: run twice as
 * long and you get twice the number. The honest output is that the design does
 * not scale, plus where it breaks.
 *
 * Measured from the queue-length trend rather than from rho = lambda/(c*mu),
 * because the trend is an observation of the simulation while the ratio is an
 * assumption about it -- and the trend still works once Phase 3 adds retries,
 * which inflate effective arrivals in ways the ratio does not see.
 *
 * A GROWING QUEUE BACKLOG IS CALLED OUT SEPARATELY.
 *
 * An async queue whose consumers cannot keep up is a genuine outage in progress,
 * and yet every request percentile stays green because publishing returned
 * immediately. That combination -- healthy latency, unbounded backlog -- is
 * invisible in the headline numbers, so it gets its own warning.
 */
function checkStability(
  nodes: NodeResult[],
  edges: EdgeResult[],
  observedSec: number
): StabilityReport {
  let worstSlope = 0;
  let worstNodeId: string | null = null;
  let asyncBacklogWarning: string | null = null;

  for (const n of nodes) {
    if (n.kind === "client") continue;

    if (n.queue) {
      const growth = n.queue.backlogGrowthPerSec;
      if (growth > INSTABILITY_SLOPE_THRESHOLD) {
        asyncBacklogWarning =
          `queue "${n.label}" is falling behind: backlog growing by ${growth.toFixed(1)} messages/s. ` +
          `Consumers drain at most ${n.queue.drainCapacityPerSec.toFixed(0)}/s against ` +
          `${n.arrivalRatePerSec.toFixed(0)}/s arriving. Request latency looks healthy because ` +
          `publishing returns immediately, but the work is not getting done and the lag grows without bound.`;
      }
      // A queue's backlog is not a synchronous bottleneck: it does not make
      // requests slower, so it must not be reported as one.
      continue;
    }

    // Ignore the first fifth of the window: even a stable queue has a trend
    // while it fills from the warm-up boundary.
    const slope = slopeOf(n.queueLengthSeries, observedSec * 0.2);
    if (slope > worstSlope) {
      worstSlope = slope;
      worstNodeId = n.nodeId;
    }
  }

  /**
   * Retry amplification, reported separately from saturation.
   *
   * The symptom is easy to misread: the dependency looks overloaded, so the
   * instinct is to add capacity -- when in fact the load is being manufactured by
   * the callers' own retry policies. Above 1.5x on any edge that is worth saying
   * out loud, because the fix is a retry budget rather than a bigger machine.
   */
  let retryStormWarning: string | null = null;
  const worstEdge = edges.reduce<EdgeResult | null>(
    (worst, e) => (e.calls > 100 && (!worst || e.amplification > worst.amplification) ? e : worst),
    null
  );
  if (worstEdge && worstEdge.amplification > RETRY_AMPLIFICATION_THRESHOLD) {
    retryStormWarning =
      `retries on "${worstEdge.fromLabel}" \u2192 "${worstEdge.toLabel}" are multiplying load by ` +
      `${worstEdge.amplification.toFixed(2)}x (${worstEdge.attempts.toLocaleString()} attempts for ` +
      `${worstEdge.calls.toLocaleString()} calls). The dependency is doing more work than the ` +
      `workload asks for, and adding capacity there treats the symptom` +
      (worstEdge.budgetRejections === 0
        ? ". No retry budget is capping this."
        : `. The budget suppressed ${worstEdge.budgetRejections.toLocaleString()} further retries.`);
  }

  const stable = worstSlope <= INSTABILITY_SLOPE_THRESHOLD;
  const label = nodes.find((n) => n.nodeId === worstNodeId)?.label ?? worstNodeId;
  return {
    stable,
    worstQueueSlopePerSec: worstSlope,
    worstNodeId: stable ? null : worstNodeId,
    asyncBacklogWarning,
    retryStormWarning,
    detail: stable
      ? "queue lengths are stationary; steady-state metrics are meaningful"
      : `queue at "${label}" is growing by ${worstSlope.toFixed(2)} requests/s and will not converge. ` +
        `Arrivals exceed service capacity: latency figures below are a function of run length, not of the design.`,
  };
}

function slopeOf(data: SeriesData, fromT: number): number {
  const pts = data.points.filter((p) => p.t >= fromT);
  const n = pts.length;
  if (n < 3) return 0;
  let sumT = 0;
  let sumV = 0;
  for (const p of pts) {
    sumT += p.t;
    sumV += p.value;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    const dt = p.t - meanT;
    num += dt * (p.value - meanV);
    den += dt * dt;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * System-level conservation of requests.
 *
 * Per-station bookkeeping lives on the components, which own the boundary
 * occupancy the exact identity needs. This checks the whole-system balance and
 * that per-class attribution sums to the headline totals.
 */
function checkFlowConservation(rec: Recorder, inSystem: Integrator): InvariantReport[] {
  const reports: InvariantReport[] = [];

  const succeeded = rec.overall.succeeded;
  const failed = rec.overall.failed;
  const lhs = rec.created + inSystem.startValue;
  const rhs = succeeded + failed + inSystem.current;
  reports.push({
    name: "request conservation",
    passed: lhs === rhs,
    detail:
      lhs === rhs
        ? `${rec.created} arrived + ${inSystem.startValue} present at start = ` +
          `${succeeded} succeeded + ${failed} failed + ${inSystem.current} still in flight`
        : `in ${lhs} vs out ${rhs}: requests are being lost or duplicated`,
  });

  // Per-class totals must sum to the overall totals, or the class attribution is
  // wrong even though the headline figures look fine.
  let classSucceeded = 0;
  let classFailed = 0;
  for (const r of rec.byClass.values()) {
    classSucceeded += r.succeeded;
    classFailed += r.failed;
  }
  const classOk = classSucceeded === succeeded && classFailed === failed;
  reports.push({
    name: "class attribution",
    passed: classOk,
    detail: classOk
      ? `${classSucceeded} successes and ${classFailed} failures attributed across classes`
      : `classes account for ${classSucceeded}/${classFailed} against ${succeeded}/${failed} overall`,
  });

  return reports;
}

/**
 * Little's Law: L = lambda * W.
 *
 * The most powerful single check available, because it ties together three
 * quantities measured by completely independent mechanisms: L from a
 * time-weighted integral of population, lambda from a departure counter, W from a
 * latency histogram. If any of the three is computed wrongly, the identity
 * breaks. It holds for any arrival process and any service discipline, so it
 * remains valid as the component library grows.
 *
 * Tolerance is 5% rather than something tighter because of end-of-run
 * truncation: requests still in flight when the clock stops contributed to L but
 * never appear in lambda or W. That bias shrinks with run length; it does not
 * vanish.
 */
function checkLittlesLaw(
  rec: Recorder,
  inSystem: Integrator,
  observedSec: number,
  stable: boolean
): InvariantReport {
  const departures = rec.overall.succeeded + rec.overall.failed;
  if (departures < 100 || observedSec <= 0) {
    return {
      name: "Little's Law (L = \u03bbW)",
      passed: true,
      detail: `skipped: only ${departures} departures, too few to be meaningful`,
    };
  }
  if (!stable) {
    return {
      name: "Little's Law (L = \u03bbW)",
      passed: true,
      detail: "skipped: system is unstable, so there is no steady state to check against",
    };
  }

  const L = inSystem.timeAverage();
  const lambda = departures / observedSec;
  const W = rec.allDepartureLatency.mean / 1000;
  const predicted = lambda * W;
  const error = L === 0 ? 0 : Math.abs(predicted - L) / L;

  return {
    name: "Little's Law (L = \u03bbW)",
    passed: error <= LITTLE_TOLERANCE,
    error,
    tolerance: LITTLE_TOLERANCE,
    detail:
      `L=${L.toFixed(3)} vs \u03bbW=${predicted.toFixed(3)} ` +
      `(\u03bb=${lambda.toFixed(2)}/s, W=${(W * 1000).toFixed(1)}ms), ` +
      `error ${(error * 100).toFixed(2)}%`,
  };
}
