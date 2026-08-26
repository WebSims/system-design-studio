import {
  type Design,
  type Distribution,
  type SdsEdge,
  type SdsNode,
  isRunnable,
  validateDesign,
} from "@sds/schema";
import { mean as distMean, sample, scv } from "./distribution";
import { LatencyHistogram } from "./histogram";
import { Resource } from "./resource";
import { RngBundle } from "./rng";
import { Sim, acquire, delay, type Process } from "./sim";
import { TimeSeries } from "./timeseries";
import { assessConfidence } from "./confidence";
import type {
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

interface Station {
  node: SdsNode;
  resource: Resource;
  serviceTime: Distribution;
  queueSeries: TimeSeries;
  utilSeries: TimeSeries;
  lastBusyIntegral: number;
  lastSampleT: number;
}

interface PathStep {
  edge: SdsEdge;
  station: Station;
}

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

class Recorder {
  readonly successLatency = new LatencyHistogram();
  /** All departures, success or failure. Used only for the Little's Law check. */
  readonly allDepartureLatency = new LatencyHistogram();
  /** Rolling window, reset each sample period, for the p99-over-time series. */
  windowLatency = new LatencyHistogram();

  created = 0;
  succeeded = 0;
  failed = 0;
  errShed = 0;
  errTimeout = 0;
  errNetwork = 0;
  windowCompletions = 0;

  reset(): void {
    this.successLatency.reset();
    this.allDepartureLatency.reset();
    this.windowLatency.reset();
    this.created = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.errShed = 0;
    this.errTimeout = 0;
    this.errNetwork = 0;
    this.windowCompletions = 0;
  }
}

/**
 * Resolve the linear chain of stations reachable from a client.
 *
 * Phase 1 deliberately refuses to guess at branching. The legacy engine sent
 * every request to *all* downstream dependencies of a node unconditionally
 * (engine.jsx:190-192), which silently invented a workload the user never
 * described. Refusing is more useful than inventing: per-class routing is a
 * Phase 2 schema feature, and until it exists a fan-out is an unanswered
 * question, not a default.
 */
function buildPath(design: Design, client: SdsNode, stations: Map<string, Station>): PathStep[] {
  const path: PathStep[] = [];
  const visited = new Set<string>([client.id]);
  let current = client.id;

  for (;;) {
    const outgoing = design.edges.filter((e) => e.from === current);
    if (outgoing.length === 0) return path;
    if (outgoing.length > 1) {
      throw new Error(
        `node "${current}" has ${outgoing.length} outgoing connections. ` +
          `Phase 1 models linear chains only; request-class routing arrives in Phase 2.`
      );
    }
    const edge = outgoing[0]!;
    if (visited.has(edge.to)) {
      throw new Error(
        `cycle detected at "${edge.to}". Loops require retry semantics, which arrive in Phase 3.`
      );
    }
    visited.add(edge.to);
    const station = stations.get(edge.to);
    if (!station) {
      throw new Error(`edge "${edge.id}" targets "${edge.to}", which is not a service station`);
    }
    path.push({ edge, station });
    current = edge.to;
  }
}

function summarize(h: LatencyHistogram): LatencySummary {
  const p = h.percentiles();
  return {
    count: h.count,
    mean: h.mean,
    min: h.min,
    max: h.max,
    relativeError: h.relativeError,
    ...p,
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
  const serviceRng = rng.stream("service");
  const networkRng = rng.stream("network");
  const lossRng = rng.stream("failure");

  const rec = new Recorder();
  const inSystem = new Integrator(sim);

  // ---- stations ----
  const stations = new Map<string, Station>();
  for (const node of design.nodes) {
    if (node.kind !== "server" || !node.server) continue;
    const cfg = node.server;
    stations.set(node.id, {
      node,
      resource: new Resource(sim, {
        id: node.id,
        capacity: cfg.concurrency * cfg.replicas,
        queueCapacity: cfg.queueCapacity,
        discipline: cfg.queueDiscipline,
        admissionPolicy: cfg.admissionPolicy,
      }),
      serviceTime: cfg.serviceTime,
      queueSeries: new TimeSeries(`${node.id}.queueLength`),
      utilSeries: new TimeSeries(`${node.id}.utilization`),
      lastBusyIntegral: 0,
      lastSampleT: 0,
    });
  }

  const clients = design.nodes.filter((n) => n.kind === "client" && n.client);
  const paths = new Map<string, PathStep[]>();
  for (const c of clients) {
    paths.set(c.id, buildPath(design, c, stations));
  }

  const offeredRatePerSec = clients.reduce(
    (sum, c) => sum + (c.client?.arrival.ratePerSec ?? 0),
    0
  );

  // ---- trace sampling ----
  const maxPathLen = Math.max(1, ...[...paths.values()].map((p) => p.length));
  const expectedRequests = Math.max(1, offeredRatePerSec * observedSec);
  const maxSampledRequests = Math.max(
    1,
    Math.floor(design.scenario.traceLimit / (maxPathLen * 2))
  );
  const sampleEvery = Math.max(1, Math.ceil(expectedRequests / maxSampledRequests));
  const hops: TraceHop[] = [];
  const visits: TraceVisit[] = [];
  let traceTruncated = false;

  const traceCapacity = design.scenario.traceLimit;
  const canTrace = () => collectTrace && hops.length + visits.length < traceCapacity;

  // ---- measurement window ----
  let measuring = warmupMs <= 0;
  const throughputSeries = new TimeSeries("throughput");
  const latencyP99Series = new TimeSeries("latencyP99");

  const measurementStart = () => (measuring ? warmupMs : 0);

  // ---- request lifecycle ----
  let nextRequestId = 0;

  function* requestProcess(client: SdsNode, path: PathStep[]): Process<void> {
    const requestId = nextRequestId++;
    const entryT = sim.now;
    const traced = measuring && canTrace() && requestId % sampleEvery === 0;
    const timeoutMs = client.client?.timeoutMs ?? null;
    const deadlineAt = timeoutMs === null ? null : entryT + timeoutMs;

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
     * came out at 37/s against a true capacity of 50/s. A capacity tool that
     * understates capacity by 25% in exactly the overloaded regime you consult it
     * about is worse than useless.
     *
     * Counting departures within the window instead matches both what a
     * monitoring system reports and the form of Little's Law used here: L over
     * everyone present, lambda over everyone departing, W over the same
     * departures. All three are then consistent by construction.
     */
    const finish = (reason: ErrorReason | null) => {
      inSystem.add(-1);
      if (!measuring) return;
      const sojourn = sim.now - entryT;
      rec.allDepartureLatency.record(sojourn);
      if (reason === null) {
        rec.succeeded++;
        rec.successLatency.record(sojourn);
        rec.windowLatency.record(sojourn);
        rec.windowCompletions++;
      } else {
        rec.failed++;
        if (reason === "shed") rec.errShed++;
        else if (reason === "timeout") rec.errTimeout++;
        else rec.errNetwork++;
      }
    };

    for (const step of path) {
      // ---- network hop ----
      const hopStart = sim.now;
      const latencyMs = sample(step.edge.latency, networkRng);
      const netWait = yield* delay(latencyMs, deadlineAt);
      if (netWait.timedOut) {
        if (traced) hops.push({ requestId, edgeId: step.edge.id, tStart: hopStart, tEnd: sim.now, delivered: false });
        finish("timeout");
        return;
      }
      // Loss is modelled as an immediate failure. Without transport-level retry
      // and retransmission (Phase 3) a dropped message has no honest recovery
      // path, so it is reported rather than quietly stalled.
      const dropped = lossRng.chance(step.edge.lossProbability);
      if (traced) {
        hops.push({
          requestId,
          edgeId: step.edge.id,
          tStart: hopStart,
          tEnd: sim.now,
          delivered: !dropped,
        });
      }
      if (dropped) {
        finish("network");
        return;
      }

      // ---- station ----
      const station = step.station;
      const enqueueT = sim.now;
      const slot = yield* acquire(station.resource, deadlineAt);
      if (!slot.granted) {
        const outcome = slot.reason === "shed" ? "shed" : "timeout";
        if (traced) {
          visits.push({
            requestId,
            nodeId: station.node.id,
            tEnqueue: enqueueT,
            tServiceStart: null,
            tExit: sim.now,
            outcome,
          });
        }
        finish(slot.reason ?? "timeout");
        return;
      }

      const serviceStart = sim.now;
      const serviceMs = sample(station.serviceTime, serviceRng);
      const served = yield* delay(serviceMs, deadlineAt);
      station.resource.release();

      if (traced) {
        visits.push({
          requestId,
          nodeId: station.node.id,
          tEnqueue: enqueueT,
          tServiceStart: serviceStart,
          tExit: sim.now,
          outcome: served.timedOut ? "timeout" : "served",
        });
      }
      if (served.timedOut) {
        finish("timeout");
        return;
      }
    }

    finish(null);
  }

  function* clientProcess(client: SdsNode): Process<void> {
    const arrival = client.client!.arrival;
    const path = paths.get(client.id)!;
    const meanGapMs = 1000 / arrival.ratePerSec;
    for (;;) {
      const gap =
        arrival.kind === "poisson"
          ? -Math.log(arrivalRng.nextNonZero()) * meanGapMs
          : meanGapMs;
      yield* delay(gap);
      if (sim.now > durationMs) return;
      sim.spawn(requestProcess(client, path));
    }
  }

  for (const c of clients) sim.spawn(clientProcess(c));

  // ---- warm-up boundary ----
  if (warmupMs > 0) {
    sim.at(warmupMs, () => {
      measuring = true;
      rec.reset();
      inSystem.reset();
      for (const st of stations.values()) {
        st.resource.resetStats();
        st.queueSeries.reset();
        st.utilSeries.reset();
        st.lastBusyIntegral = 0;
        st.lastSampleT = warmupMs;
      }
      throughputSeries.reset();
      latencyP99Series.reset();
    });
  }

  // ---- periodic sampler ----
  const samplePeriodMs = Math.max(100, durationMs / 600);
  const sampleTick = () => {
    if (measuring) {
      const tSec = (sim.now - measurementStart()) / 1000;
      for (const st of stations.values()) {
        st.queueSeries.push(tSec, st.resource.queueLength);
        const s = st.resource.stats();
        const busyIntegral = s.utilization * s.observedMs * st.resource.capacity;
        const dt = sim.now - st.lastSampleT;
        const windowUtil =
          dt > 0 ? (busyIntegral - st.lastBusyIntegral) / (dt * st.resource.capacity) : 0;
        st.utilSeries.push(tSec, Math.max(0, Math.min(1, windowUtil)));
        st.lastBusyIntegral = busyIntegral;
        st.lastSampleT = sim.now;
      }
      throughputSeries.push(tSec, (rec.windowCompletions * 1000) / samplePeriodMs);
      latencyP99Series.push(tSec, rec.windowLatency.count > 0 ? rec.windowLatency.quantile(0.99) : 0);
      rec.windowCompletions = 0;
      rec.windowLatency = new LatencyHistogram();
    }
    if (sim.now + samplePeriodMs <= durationMs) sim.after(samplePeriodMs, sampleTick);
  };
  sim.after(samplePeriodMs, sampleTick);

  // ---- go ----
  sim.run(durationMs);

  // ---- assemble ----
  const nodeResults: NodeResult[] = [];
  for (const node of design.nodes) {
    if (node.kind === "client") {
      nodeResults.push({
        nodeId: node.id,
        label: node.label,
        kind: "client",
        utilization: 0,
        capacity: 0,
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
        arrivalRatePerSec: node.client?.arrival.ratePerSec ?? 0,
        queueLengthSeries: { name: "queueLength", points: [] },
        utilizationSeries: { name: "utilization", points: [] },
      });
      continue;
    }
    const st = stations.get(node.id)!;
    const s = st.resource.stats();
    nodeResults.push({
      nodeId: node.id,
      label: node.label,
      kind: "server",
      utilization: s.utilization,
      capacity: st.resource.capacity,
      avgQueueLength: s.avgQueueLength,
      maxQueueLength: s.maxQueueLength,
      avgInStation: s.avgInStation,
      arrivals: s.arrivals,
      admitted: s.admitted,
      shed: s.shed,
      abandoned: s.abandoned,
      completed: s.completed,
      avgWaitMs: s.admitted > 0 ? s.totalWaitMs / s.admitted : 0,
      serviceMeanMs: distMean(st.serviceTime),
      serviceScv: scv(st.serviceTime),
      arrivalRatePerSec: observedSec > 0 ? s.arrivals / observedSec : 0,
      queueLengthSeries: series(st.queueSeries),
      utilizationSeries: series(st.utilSeries),
    });
  }

  const stability = checkStability(stations, observedSec);
  const invariants = [
    ...checkFlowConservation(rec, inSystem, stations),
    checkLittlesLaw(rec, inSystem, observedSec, stability.stable),
  ];

  const maxUtilization = nodeResults.reduce(
    (m, n) => (n.kind === "server" ? Math.max(m, n.utilization) : m),
    0
  );
  const confidence = assessConfidence(rec.succeeded + rec.failed, maxUtilization, observedSec);

  const endToEnd = summarize(rec.successLatency);
  const totalDepartures = rec.succeeded + rec.failed;
  const errors = {
    total: rec.failed,
    shed: rec.errShed,
    timeout: rec.errTimeout,
    network: rec.errNetwork,
    ratePct: totalDepartures > 0 ? (rec.failed / totalDepartures) * 100 : 0,
  };

  const trace: Trace = {
    hops,
    visits,
    sampleEvery,
    truncated: traceTruncated || (collectTrace && hops.length + visits.length >= traceCapacity),
  };

  const sloPassed = evaluateSlo(design, endToEnd, errors.ratePct, stability.stable);

  return {
    design,
    observedSec,
    throughputPerSec: observedSec > 0 ? rec.succeeded / observedSec : 0,
    offeredRatePerSec,
    endToEnd,
    errors,
    avgInSystem: inSystem.timeAverage(),
    nodes: nodeResults,
    invariants,
    stability,
    confidence,
    sloPassed,
    trace,
    throughputSeries: series(throughputSeries),
    latencyP99Series: series(latencyP99Series),
    wallMs: Date.now() - wallStart,
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
 */
function checkStability(stations: Map<string, Station>, observedSec: number): StabilityReport {
  let worstSlope = 0;
  let worstNodeId: string | null = null;

  for (const st of stations.values()) {
    // Ignore the first fifth of the window: even a stable queue has a trend
    // while it fills from the warm-up boundary.
    const slope = st.queueSeries.slopePerSec(observedSec * 0.2);
    if (slope > worstSlope) {
      worstSlope = slope;
      worstNodeId = st.node.id;
    }
  }

  const stable = worstSlope <= INSTABILITY_SLOPE_THRESHOLD;
  return {
    stable,
    worstQueueSlopePerSec: worstSlope,
    worstNodeId: stable ? null : worstNodeId,
    detail: stable
      ? "queue lengths are stationary; steady-state metrics are meaningful"
      : `queue at "${worstNodeId}" is growing by ${worstSlope.toFixed(2)} requests/s and will not converge. ` +
        `Arrivals exceed service capacity: latency figures below are a function of run length, not of the design.`,
  };
}

/**
 * Conservation of requests.
 *
 * Cheap to check and it catches the class of bug that is otherwise invisible: a
 * leaked capacity slot, a double release, a request resumed twice. Each produces
 * plausible-looking output that is quietly wrong.
 *
 * Every identity here carries the boundary occupancy explicitly. Measurement
 * starts at the warm-up boundary with requests already queued and in service, so
 * the naive forms (`created == departed`, `arrivals == admitted + shed`) are
 * simply false through no fault of the engine. Getting these identities right is
 * what makes a failure here mean something.
 */
function checkFlowConservation(
  rec: Recorder,
  inSystem: Integrator,
  stations: Map<string, Station>
): InvariantReport[] {
  const reports: InvariantReport[] = [];

  // created + present-at-start == departed + present-at-end
  const lhs = rec.created + inSystem.startValue;
  const rhs = rec.succeeded + rec.failed + inSystem.current;
  reports.push({
    name: "request conservation",
    passed: lhs === rhs,
    detail:
      lhs === rhs
        ? `${rec.created} arrived + ${inSystem.startValue} present at start = ` +
          `${rec.succeeded} succeeded + ${rec.failed} failed + ${inSystem.current} still in flight`
        : `in ${lhs} vs out ${rhs}: requests are being lost or duplicated`,
  });

  for (const st of stations.values()) {
    const s = st.resource.stats();
    // Queue balance: arrivals + queued-at-start = admitted + shed + abandoned + queued-now
    const arrivalsLhs = s.arrivals + s.queuedAtStart;
    const arrivalsRhs = s.admitted + s.shed + s.abandoned + s.currentQueueLength;
    // Service balance: admitted + in-service-at-start = completed + in-service-now
    const serviceLhs = s.admitted + s.inServiceAtStart;
    const serviceRhs = s.completed + s.currentInService;
    const ok = arrivalsLhs === arrivalsRhs && serviceLhs === serviceRhs;
    reports.push({
      name: `station "${st.node.id}" bookkeeping`,
      passed: ok,
      detail: ok
        ? `queue balance ${arrivalsLhs} = ${arrivalsRhs}; service balance ${serviceLhs} = ${serviceRhs}`
        : `queue balance ${arrivalsLhs} vs ${arrivalsRhs}; service balance ${serviceLhs} vs ${serviceRhs}`,
    });
  }

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
  const departures = rec.succeeded + rec.failed;
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
