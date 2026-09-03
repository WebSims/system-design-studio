import * as Comlink from "comlink";
import { runSimulation, type RunOptions, type RunResult } from "@sds/core";
import {
  analyse,
  checkErrorModel,
  compare,
  findKnee,
  replicate,
  searchConfig,
  sensitivity,
  type AnalysisReport,
  type Comparison,
  type ConfigSearchResult,
  type KneeResult,
  type MetricIntervals,
  type SensitivityReport,
} from "@sds/analyze";
import type {
  Candidate,
  CandidateEvaluation,
  CorrectnessResult,
  Design,
  PortfolioResult,
  Study,
} from "@sds/schema";
import { checkCandidate } from "@sds/explore";
import { assemblePortfolio, cachedEvaluation, evaluateCandidate } from "@sds/study";

/**
 * The simulation worker.
 *
 * The engine runs here and nowhere else. It has no access to the DOM and no
 * relationship to the frame loop, which is the entire architectural point: the
 * legacy engine drove its model from `requestAnimationFrame`, so a 60-second
 * experiment took 60 seconds and a parameter sweep was impossible.
 *
 * The analyzer makes that separation pay off twice. A single run is one simulation;
 * an analysis is hundreds -- a knee search, two probes per parameter, and a config
 * search on top. All of it off the main thread, so the canvas never drops a frame
 * while the answer is being computed.
 */

/** Everything the analyzer produces, in one round trip. */
export interface FullAnalysis {
  report: AnalysisReport;
  knee: KneeResult;
  sensitivity: SensitivityReport;
  configSearch: ConfigSearchResult | null;
  wallMs: number;
}

/**
 * Replication results, stripped of the per-seed runs.
 *
 * The runs themselves are large and every one carries a full design and time series;
 * sending eight of them across the worker boundary would cost more than the
 * simulation did. Only the intervals cross.
 */
export interface ReplicationSummary {
  seeds: number[];
  intervals: MetricIntervals;
  sloPassCount: number;
  modelledTailError: number;
  measuredTailError: number;
  errorModel: { agrees: boolean; ratio: number; detail: string };
  simulations: number;
  wallMs: number;
}

/** A comparison, likewise stripped of per-seed runs. */
export interface ComparisonSummary {
  metrics: Comparison["metrics"];
  sloSummary: string;
  paired: boolean;
  notes: string[];
  simulations: number;
  wallMs: number;
  baselineName: string;
  candidateName: string;
}

const api = {
  run(design: Design, opts?: RunOptions): RunResult {
    return runSimulation(design, opts);
  },

  replicate(design: Design, replications: number): ReplicationSummary {
    const rep = replicate(design, { replications });
    return {
      seeds: rep.seeds,
      intervals: rep.intervals,
      sloPassCount: rep.sloPassCount,
      modelledTailError: rep.modelledTailError,
      measuredTailError: rep.measuredTailError,
      errorModel: checkErrorModel(rep),
      simulations: rep.simulations,
      wallMs: rep.wallMs,
    };
  },

  compare(baseline: Design, candidate: Design, replications: number): ComparisonSummary {
    const cmp = compare(baseline, candidate, { replications });
    return {
      metrics: cmp.metrics,
      sloSummary: cmp.sloSummary,
      paired: cmp.paired,
      notes: cmp.notes,
      simulations: cmp.simulations,
      wallMs: cmp.wallMs,
      baselineName: baseline.name,
      candidateName: candidate.name,
    };
  },

  /**
   * The bounded correctness search for one candidate.
   *
   * Separate from `evaluate` because the two have very different costs and an agent -- or a
   * person iterating on an invariant -- wants one without the other. The search is a second or
   * two; eight replicated simulations are tens of seconds.
   */
  check(study: Study, candidateId: string): CorrectnessResult {
    const candidate = requireCandidate(study, candidateId);
    return checkCandidate(study, candidate);
  },

  /**
   * Correctness and/or replicated performance for one candidate.
   *
   * Returns the evaluation rather than the updated study: the store owns the study and merging a
   * result into it on the main thread keeps the worker free of any notion of document identity.
   */
  evaluate(
    study: Study,
    candidateId: string,
    opts: { correctness: boolean; performance: boolean; scenarios: boolean }
  ): CandidateEvaluation {
    const candidate = requireCandidate(study, candidateId);
    return evaluateCandidate(study, candidate, {
      skipCorrectness: !opts.correctness,
      skipPerformance: !opts.performance,
      runScenarios: opts.scenarios,
    });
  },

  /** Assemble the portfolio from whatever the study already has cached. Cheap. */
  portfolio(study: Study): PortfolioResult {
    return assemblePortfolio(study);
  },

  /** Whether a candidate has a usable cached evaluation at the study's current settings. */
  cached(study: Study, candidateId: string): CandidateEvaluation | null {
    const candidate = study.candidates.find((c) => c.id === candidateId);
    return candidate ? cachedEvaluation(study, candidate) : null;
  },

  analyze(design: Design): FullAnalysis {
    const t0 = Date.now();
    const result = runSimulation(design, { collectTrace: false });
    const report = analyse(design, result);
    const knee = findKnee(design);
    const sens = sensitivity(design);
    // Only search for a fix when there is something to fix. The search is the most
    // expensive step by far, and running it on a passing design would spend dozens
    // of simulations to report "no changes needed".
    const configSearch = result.sloPassed === false ? searchConfig(design) : null;
    return { report, knee, sensitivity: sens, configSearch, wallMs: Date.now() - t0 };
  },
};

function requireCandidate(study: Study, id: string): Candidate {
  const candidate = study.candidates.find((c) => c.id === id);
  if (!candidate) throw new Error(`no candidate "${id}" in this project`);
  return candidate;
}

export type SimWorkerApi = typeof api;

Comlink.expose(api);
