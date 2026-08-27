import * as Comlink from "comlink";
import { runSimulation, type RunOptions, type RunResult } from "@sds/core";
import {
  analyse,
  findKnee,
  searchConfig,
  sensitivity,
  type AnalysisReport,
  type ConfigSearchResult,
  type KneeResult,
  type SensitivityReport,
} from "@sds/analyze";
import type { Design } from "@sds/schema";

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

const api = {
  run(design: Design, opts?: RunOptions): RunResult {
    return runSimulation(design, opts);
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

export type SimWorkerApi = typeof api;

Comlink.expose(api);
