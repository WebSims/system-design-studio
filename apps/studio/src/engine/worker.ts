import * as Comlink from "comlink";
import { runSimulation, type RunOptions, type RunResult } from "@sds/core";
import type { Design } from "@sds/schema";

/**
 * The simulation worker.
 *
 * The engine runs here and nowhere else. It has no access to the DOM and no
 * relationship to the frame loop, which is the entire architectural point: the
 * legacy engine drove its model from `requestAnimationFrame`, so a 60-second
 * experiment took 60 seconds and a parameter sweep was impossible. Off the main
 * thread, a 1200-second run finishes in a fraction of a second and the UI never
 * drops a frame while it happens.
 */
const api = {
  run(design: Design, opts?: RunOptions): RunResult {
    return runSimulation(design, opts);
  },
};

export type SimWorkerApi = typeof api;

Comlink.expose(api);
