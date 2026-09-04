import type { Design } from "@sds/schema";
import {
  createSimulationRuntime,
  type RunOptions,
  type RuntimeOccupancy,
  type SimulationRuntime,
} from "./run";
import type { RunResult, Trace, TraceHop, TraceVisit } from "./result";

export type SimulationMode = "manual" | "full";
export type SimulationSessionStatus =
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "invalidated";

export interface SimulationSessionOptions
  extends Omit<RunOptions, "enabledSourceIds" | "manualRequests"> {
  mode?: SimulationMode;
  enabledSourceIds?: string[];
  paused?: boolean;
  /** Presentation-only multiplier. It is never passed to the engine or its RNG. */
  presentationSpeed?: number;
}

export interface OccupancyChange {
  nodeId: string;
  before: RuntimeOccupancy;
  after: RuntimeOccupancy;
}

export interface SimulationSessionDelta {
  fromTimeMs: number;
  toTimeMs: number;
  eventsExecuted: number;
  trace: { hops: TraceHop[]; visits: TraceVisit[] };
  occupancy: OccupancyChange[];
}

export interface SimulationSessionSnapshot {
  mode: SimulationMode;
  status: SimulationSessionStatus;
  virtualTimeMs: number;
  durationMs: number;
  progress: number;
  paused: boolean;
  presentationSpeed: number;
  enabledSourceIds: string[];
  injectedRequests: number;
  eventsExecuted: number;
  pendingEvents: number;
  trace: Trace;
  occupancy: Record<string, RuntimeOccupancy>;
  resultAvailable: boolean;
  replayAvailable: boolean;
  invalidationReason: string | null;
}

export interface SimulationSessionUpdate {
  snapshot: SimulationSessionSnapshot;
  delta: SimulationSessionDelta;
  /** Present exactly when the session has completed. */
  result?: RunResult;
}

const EMPTY_OCCUPANCY: RuntimeOccupancy = { queued: 0, inService: 0, total: 0 };

/**
 * A deterministic, incremental simulation run.
 *
 * The runtime owns the real event queue. Advancing ten events ten times is therefore
 * the same execution as advancing one hundred once; batching controls only when state
 * crosses the worker boundary. Pause and speed live on this facade and never reach the
 * event queue, random streams, or model inputs.
 */
export class SimulationSession {
  private readonly mode: SimulationMode;
  private readonly sourceIds: string[];
  private readonly enabledSources: Set<string>;
  private runtime: SimulationRuntime;
  private paused: boolean;
  private presentationSpeed: number;
  private injectedRequests = 0;
  private eventsExecuted = 0;
  private deliveredHops = 0;
  private deliveredVisits = 0;
  private previousOccupancy: Record<string, RuntimeOccupancy>;
  private lastDeltaTimeMs = 0;
  private invalidationReason: string | null = null;
  private completedResult: RunResult | null = null;

  constructor(
    private readonly design: Design,
    private readonly options: SimulationSessionOptions = {}
  ) {
    this.mode = options.mode ?? "full";
    this.sourceIds = design.nodes
      .filter((node) => node.kind === "client" && node.client)
      .map((node) => node.id);
    const requested = options.enabledSourceIds ?? this.sourceIds;
    const unknown = requested.filter((id) => !this.sourceIds.includes(id));
    if (unknown.length > 0) {
      throw new Error(`unknown client/work source: ${unknown.join(", ")}`);
    }
    this.enabledSources = new Set(requested);
    this.paused = options.paused ?? this.mode === "manual";
    this.presentationSpeed = positiveSpeed(options.presentationSpeed ?? 1);
    this.runtime = this.createRuntime();
    this.previousOccupancy = this.runtime.occupancy();
  }

  /** Sources can be configured until the first event/request, then the run is immutable. */
  setSourceEnabled(sourceNodeId: string, enabled: boolean): SimulationSessionUpdate {
    this.assertUsable();
    if (!this.sourceIds.includes(sourceNodeId)) {
      throw new Error(`node "${sourceNodeId}" is not a client/work source`);
    }
    if (this.runtime.now > 0 || this.eventsExecuted > 0 || this.injectedRequests > 0) {
      throw new Error("sources cannot change after a simulation session has started");
    }
    if (enabled) this.enabledSources.add(sourceNodeId);
    else this.enabledSources.delete(sourceNodeId);
    this.runtime = this.createRuntime();
    this.previousOccupancy = this.runtime.occupancy();
    return this.capture(0);
  }

  /** Inject exactly one request from a client/work-source node at the current virtual time. */
  injectRequest(sourceNodeId: string): SimulationSessionUpdate {
    this.assertUsable();
    if (this.mode !== "manual") throw new Error("single requests can only be injected in manual mode");
    this.runtime.injectRequest(sourceNodeId);
    this.injectedRequests++;
    return this.capture(0);
  }

  advanceBy(deltaMs: number): SimulationSessionUpdate {
    this.assertUsable();
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error("virtual-time advance must be a non-negative finite number");
    }
    const count = this.runtime.advanceTo(
      Math.min(this.runtime.durationMs, this.runtime.now + deltaMs)
    );
    this.eventsExecuted += count;
    return this.capture(count);
  }

  advanceEvents(count: number): SimulationSessionUpdate {
    this.assertUsable();
    const executed = this.runtime.advanceEvents(count);
    this.eventsExecuted += executed;
    return this.capture(executed);
  }

  setPaused(paused: boolean): SimulationSessionUpdate {
    this.assertUsable();
    this.paused = paused;
    return this.capture(0);
  }

  setPresentationSpeed(speed: number): SimulationSessionUpdate {
    this.assertUsable();
    this.presentationSpeed = positiveSpeed(speed);
    return this.capture(0);
  }

  /** Finish all remaining virtual work and return the same RunResult as runSimulation. */
  finalize(): SimulationSessionUpdate {
    this.assertUsable();
    const count = this.runtime.advanceTo(this.runtime.durationMs);
    this.eventsExecuted += count;
    return this.capture(count);
  }

  /** Read state without consuming the next trace/occupancy delta. */
  snapshot(): SimulationSessionSnapshot {
    return this.makeSnapshot(this.runtime.trace(), this.runtime.occupancy());
  }

  /** Completed sessions remain useful as immutable trace-replay sources. */
  replayResult(): RunResult {
    if (!this.completedResult && this.runtime.complete && !this.invalidationReason) {
      this.completedResult = this.runtime.result();
    }
    if (!this.completedResult) throw new Error("the session has no completed result to replay");
    return this.completedResult;
  }

  /** Stop accepting work while retaining the latest snapshot for an explicit stale-state UI. */
  invalidate(reason = "executable design changed"): SimulationSessionSnapshot {
    if (!this.invalidationReason) this.invalidationReason = reason;
    this.paused = true;
    return this.snapshot();
  }

  private createRuntime(): SimulationRuntime {
    const { mode: _mode, paused: _paused, presentationSpeed: _speed, ...runOptions } =
      this.options;
    return createSimulationRuntime(this.design, {
      ...runOptions,
      enabledSourceIds: [...this.enabledSources],
      ...(this.mode === "manual" ? { manualRequests: [], warmupSec: 0 } : {}),
    });
  }

  private capture(eventsExecuted: number): SimulationSessionUpdate {
    const trace = this.runtime.trace();
    const occupancy = this.runtime.occupancy();
    const snapshot = this.makeSnapshot(trace, occupancy);
    const fromTimeMs = this.lastDeltaTimeMs;
    const delta: SimulationSessionDelta = {
      fromTimeMs,
      toTimeMs: snapshot.virtualTimeMs,
      eventsExecuted,
      trace: {
        hops: trace.hops.slice(this.deliveredHops),
        visits: trace.visits.slice(this.deliveredVisits),
      },
      occupancy: occupancyChanges(this.previousOccupancy, occupancy),
    };
    this.deliveredHops = trace.hops.length;
    this.deliveredVisits = trace.visits.length;
    this.previousOccupancy = occupancy;
    this.lastDeltaTimeMs = snapshot.virtualTimeMs;

    if (this.runtime.complete && !this.completedResult) {
      this.completedResult = this.runtime.result();
    }
    return {
      snapshot: this.makeSnapshot(trace, occupancy),
      delta,
      ...(this.completedResult ? { result: this.completedResult } : {}),
    };
  }

  private makeSnapshot(
    trace: Trace,
    occupancy: Record<string, RuntimeOccupancy>
  ): SimulationSessionSnapshot {
    const complete = this.runtime.complete && !this.invalidationReason;
    return {
      mode: this.mode,
      status: this.invalidationReason
        ? "invalidated"
        : complete
          ? "completed"
          : this.runtime.now === 0 && this.eventsExecuted === 0 && this.injectedRequests === 0
            ? "ready"
            : this.paused
              ? "paused"
              : "running",
      virtualTimeMs: this.runtime.now,
      durationMs: this.runtime.durationMs,
      progress:
        complete
          ? 1
          : this.runtime.durationMs > 0
          ? Math.min(1, this.runtime.now / this.runtime.durationMs)
          : 1,
      paused: this.paused,
      presentationSpeed: this.presentationSpeed,
      enabledSourceIds: this.sourceIds.filter((id) => this.enabledSources.has(id)),
      injectedRequests: this.injectedRequests,
      eventsExecuted: this.eventsExecuted,
      pendingEvents: this.runtime.pendingEvents,
      trace,
      occupancy,
      resultAvailable: complete,
      replayAvailable: complete,
      invalidationReason: this.invalidationReason,
    };
  }

  private assertUsable(): void {
    if (this.invalidationReason) {
      throw new Error(`simulation session is invalidated: ${this.invalidationReason}`);
    }
    if (this.runtime.complete) throw new Error("the simulation session has completed");
  }
}

function positiveSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error("presentation speed must be a positive finite number");
  }
  return speed;
}

function occupancyChanges(
  before: Record<string, RuntimeOccupancy>,
  after: Record<string, RuntimeOccupancy>
): OccupancyChange[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: OccupancyChange[] = [];
  for (const nodeId of [...ids].sort()) {
    const previous = before[nodeId] ?? EMPTY_OCCUPANCY;
    const current = after[nodeId] ?? EMPTY_OCCUPANCY;
    if (
      previous.queued !== current.queued ||
      previous.inService !== current.inService ||
      previous.total !== current.total
    ) {
      changes.push({ nodeId, before: previous, after: current });
    }
  }
  return changes;
}
