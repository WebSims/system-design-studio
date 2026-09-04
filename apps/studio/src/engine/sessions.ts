import {
  SimulationSession,
  type RunResult,
  type SimulationSessionOptions,
  type SimulationSessionSnapshot,
  type SimulationSessionUpdate,
} from "@sds/core";
import type { Design } from "@sds/schema";

export interface CreatedWorkerSession {
  sessionId: string;
  snapshot: SimulationSessionSnapshot;
}

/** Worker-owned session registry. Completed sessions stay here until explicitly disposed. */
export class SimulationSessionRegistry {
  private readonly sessions = new Map<string, SimulationSession>();
  private nextId = 1;

  create(design: Design, options: SimulationSessionOptions = {}): CreatedWorkerSession {
    const sessionId = `simulation-${this.nextId++}`;
    const session = new SimulationSession(design, options);
    this.sessions.set(sessionId, session);
    return { sessionId, snapshot: session.snapshot() };
  }

  snapshot(sessionId: string): SimulationSessionSnapshot {
    return this.require(sessionId).snapshot();
  }

  setSourceEnabled(
    sessionId: string,
    sourceNodeId: string,
    enabled: boolean
  ): SimulationSessionUpdate {
    return this.require(sessionId).setSourceEnabled(sourceNodeId, enabled);
  }

  injectRequest(sessionId: string, sourceNodeId: string): SimulationSessionUpdate {
    return this.require(sessionId).injectRequest(sourceNodeId);
  }

  advanceBy(sessionId: string, deltaMs: number): SimulationSessionUpdate {
    return this.require(sessionId).advanceBy(deltaMs);
  }

  advanceEvents(sessionId: string, count: number): SimulationSessionUpdate {
    return this.require(sessionId).advanceEvents(count);
  }

  setPaused(sessionId: string, paused: boolean): SimulationSessionUpdate {
    return this.require(sessionId).setPaused(paused);
  }

  setPresentationSpeed(sessionId: string, speed: number): SimulationSessionUpdate {
    return this.require(sessionId).setPresentationSpeed(speed);
  }

  finalize(sessionId: string): SimulationSessionUpdate {
    return this.require(sessionId).finalize();
  }

  replay(sessionId: string): RunResult {
    return this.require(sessionId).replayResult();
  }

  invalidate(sessionId: string, reason?: string): SimulationSessionSnapshot {
    return this.require(sessionId).invalidate(reason);
  }

  dispose(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private require(sessionId: string): SimulationSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown simulation session "${sessionId}"`);
    return session;
  }
}
