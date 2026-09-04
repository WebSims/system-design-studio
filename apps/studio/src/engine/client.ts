import * as Comlink from "comlink";
import type {
  RunOptions,
  RunResult,
  SimulationSessionOptions,
  SimulationSessionSnapshot,
  SimulationSessionUpdate,
} from "@sds/core";
import type {
  CandidateEvaluation,
  CorrectnessResult,
  Design,
  FailureEvent,
  PortfolioResult,
  Study,
} from "@sds/schema";
import type {
  ComparisonSummary,
  FullAnalysis,
  ReplicationSummary,
  SimWorkerApi,
} from "./worker";
import type { CreatedWorkerSession } from "./sessions";

/**
 * Main-thread handle to the simulation worker.
 *
 * Created lazily so the worker is not spun up until the first Run, and reused
 * afterwards. Comlink handles the structured-clone round trip; `RunResult` is
 * deliberately plain data (no classes, no functions) precisely so it survives it.
 */
let worker: Worker | null = null;
let api: Comlink.Remote<SimWorkerApi> | null = null;

function ensure(): Comlink.Remote<SimWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    api = Comlink.wrap<SimWorkerApi>(worker);
  }
  return api;
}

export async function runInWorker(design: Design, opts?: RunOptions): Promise<RunResult> {
  return ensure().run(design, opts);
}

export async function createSimulationSessionInWorker(
  design: Design,
  opts?: SimulationSessionOptions
): Promise<CreatedWorkerSession> {
  return ensure().createSession(design, opts);
}

export async function simulationSessionSnapshotInWorker(
  sessionId: string
): Promise<SimulationSessionSnapshot> {
  return ensure().sessionSnapshot(sessionId);
}

export async function setSimulationSourceInWorker(
  sessionId: string,
  sourceNodeId: string,
  enabled: boolean
): Promise<SimulationSessionUpdate> {
  return ensure().sessionSetSource(sessionId, sourceNodeId, enabled);
}

export async function injectSimulationRequestInWorker(
  sessionId: string,
  sourceNodeId: string
): Promise<SimulationSessionUpdate> {
  return ensure().sessionInject(sessionId, sourceNodeId);
}

export async function injectSimulationFailureInWorker(
  sessionId: string,
  event: FailureEvent
): Promise<SimulationSessionUpdate> {
  return ensure().sessionInjectFailure(sessionId, event);
}

export async function advanceSimulationTimeInWorker(
  sessionId: string,
  deltaMs: number
): Promise<SimulationSessionUpdate> {
  return ensure().sessionAdvanceBy(sessionId, deltaMs);
}

export async function advanceSimulationEventsInWorker(
  sessionId: string,
  count: number
): Promise<SimulationSessionUpdate> {
  return ensure().sessionAdvanceEvents(sessionId, count);
}

export async function setSimulationPausedInWorker(
  sessionId: string,
  paused: boolean
): Promise<SimulationSessionUpdate> {
  return ensure().sessionSetPaused(sessionId, paused);
}

export async function setSimulationSpeedInWorker(
  sessionId: string,
  speed: number
): Promise<SimulationSessionUpdate> {
  return ensure().sessionSetSpeed(sessionId, speed);
}

export async function finalizeSimulationSessionInWorker(
  sessionId: string
): Promise<SimulationSessionUpdate> {
  return ensure().sessionFinalize(sessionId);
}

export async function replaySimulationSessionInWorker(sessionId: string): Promise<RunResult> {
  return ensure().sessionReplay(sessionId);
}

export async function invalidateSimulationSessionInWorker(
  sessionId: string,
  reason?: string
): Promise<SimulationSessionSnapshot> {
  return ensure().sessionInvalidate(sessionId, reason);
}

export async function disposeSimulationSessionInWorker(sessionId: string): Promise<boolean> {
  return ensure().sessionDispose(sessionId);
}

export async function analyzeInWorker(design: Design): Promise<FullAnalysis> {
  return ensure().analyze(design);
}

export async function replicateInWorker(
  design: Design,
  replications: number
): Promise<ReplicationSummary> {
  return ensure().replicate(design, replications);
}

export async function compareInWorker(
  baseline: Design,
  candidate: Design,
  replications: number
): Promise<ComparisonSummary> {
  return ensure().compare(baseline, candidate, replications);
}

export async function checkInWorker(
  study: Study,
  candidateId: string
): Promise<CorrectnessResult> {
  return ensure().check(study, candidateId);
}

export async function evaluateInWorker(
  study: Study,
  candidateId: string,
  opts: { correctness: boolean; performance: boolean; scenarios: boolean }
): Promise<CandidateEvaluation> {
  return ensure().evaluate(study, candidateId, opts);
}

export async function portfolioInWorker(study: Study): Promise<PortfolioResult> {
  return ensure().portfolio(study);
}

/**
 * Cancel whatever the worker is doing, by killing it.
 *
 * THE ONLY RELIABLE CANCELLATION AVAILABLE, AND IT IS THE RIGHT ONE
 *
 * The correctness search checks a cooperative abort flag between expansions, and the replication
 * loop checks one between seeds. Neither can interrupt a single long simulation, because a
 * simulation is a tight generator loop with no yield point -- adding one would put a check in the
 * innermost loop of the engine and slow every run to make an occasional cancel prompter.
 *
 * So a cancel terminates the worker. It is spun up again lazily on the next call, and nothing is
 * lost: the study lives on the main thread and every result the worker had already returned is
 * already merged. This is also what `studio_run_evaluation`'s abort signal ends up doing.
 */
export function cancelWorker(): void {
  disposeWorker();
}

export type { ComparisonSummary, FullAnalysis, ReplicationSummary };

/** Tear down the worker, e.g. on hot reload. */
export function disposeWorker(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
