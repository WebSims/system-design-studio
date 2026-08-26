import * as Comlink from "comlink";
import type { RunOptions, RunResult } from "@sds/core";
import type { Design } from "@sds/schema";
import type { SimWorkerApi } from "./worker";

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

/** Tear down the worker, e.g. on hot reload. */
export function disposeWorker(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
