import { FailureEventSchema, type FailureEvent } from "@sds/schema";
import type { Sim } from "./sim";

export type FailureTransitionListener = (event: FailureEvent, active: boolean) => void;

/**
 * Deterministic virtual-time failure state.
 *
 * Configured scenarios and live injections both enter through `add`. Effects are
 * queried from the active set, so overlapping degradations compose without one event
 * overwriting another and every end boundary restores the remaining composition.
 */
export class FailureController {
  private readonly events = new Map<string, FailureEvent>();
  private readonly active = new Map<string, FailureEvent>();
  private readonly listeners = new Set<FailureTransitionListener>();
  private readonly nextChangeWaiters = new Set<() => void>();

  constructor(private readonly sim: Sim) {}

  onTransition(listener: FailureTransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Register a one-shot wake-up used by capacity-gated asynchronous consumers. */
  onNextChange(resume: () => void): void {
    this.nextChangeWaiters.add(resume);
  }

  add(input: FailureEvent): FailureEvent {
    const event = FailureEventSchema.parse(input);
    if (this.events.has(event.id)) throw new Error(`failure event "${event.id}" already exists`);

    const startMs = event.startSec * 1000;
    const endMs = startMs + event.durationSec * 1000;
    if (startMs < this.sim.now - 1e-9) {
      throw new Error(`failure event "${event.id}" starts before current virtual time`);
    }
    this.events.set(event.id, event);

    if (startMs <= this.sim.now + 1e-9) this.activate(event);
    else this.sim.at(startMs, () => this.activate(event));
    this.sim.at(endMs, () => this.deactivate(event));
    return event;
  }

  isNodeOut(nodeId: string): boolean {
    return this.matchNode(nodeId, "node-outage").length > 0;
  }

  isGatewayDisconnected(nodeId: string): boolean {
    return this.matchNode(nodeId, "gateway-disconnection").length > 0;
  }

  capacityFactor(nodeId: string): number {
    if (this.isNodeOut(nodeId)) return 0;
    return product(this.matchNode(nodeId, "capacity-reduction").map((event) => event.factor));
  }

  effectiveCapacity(nodeId: string, baseline: number): number {
    return Math.max(0, Math.floor(baseline * this.capacityFactor(nodeId)));
  }

  serviceFactor(nodeId: string): number {
    return product(this.matchNode(nodeId, "service-degradation").map((event) => event.factor));
  }

  latencyFactor(edgeId: string): number {
    return product(this.matchEdge(edgeId, "edge-latency").map((event) => event.factor));
  }

  /** Independent loss causes compose by multiplying their survival probabilities. */
  lossProbability(edgeId: string, baseline: number): number {
    let survival = 1 - baseline;
    for (const event of this.matchEdge(edgeId, "request-loss")) {
      survival *= 1 - event.lossProbability;
    }
    return Math.min(1, Math.max(0, 1 - survival));
  }

  snapshot(): FailureEvent[] {
    return [...this.active.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  timeline(): FailureEvent[] {
    return [...this.events.values()].sort(
      (a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id)
    );
  }

  private activate(event: FailureEvent): void {
    if (this.active.has(event.id)) return;
    this.active.set(event.id, event);
    this.changed(event, true);
  }

  private deactivate(event: FailureEvent): void {
    if (!this.active.delete(event.id)) return;
    this.changed(event, false);
  }

  private changed(event: FailureEvent, active: boolean): void {
    for (const listener of this.listeners) listener(event, active);
    const waiters = [...this.nextChangeWaiters];
    this.nextChangeWaiters.clear();
    for (const resume of waiters) resume();
  }

  private matchNode<K extends FailureEvent["kind"]>(
    nodeId: string,
    kind: K
  ): Extract<FailureEvent, { kind: K; targetNodeId: string }>[] {
    return [...this.active.values()].filter(
      (event): event is Extract<FailureEvent, { kind: K; targetNodeId: string }> =>
        event.kind === kind && "targetNodeId" in event && event.targetNodeId === nodeId
    );
  }

  private matchEdge<K extends FailureEvent["kind"]>(
    edgeId: string,
    kind: K
  ): Extract<FailureEvent, { kind: K; targetEdgeId: string }>[] {
    return [...this.active.values()].filter(
      (event): event is Extract<FailureEvent, { kind: K; targetEdgeId: string }> =>
        event.kind === kind && "targetEdgeId" in event && event.targetEdgeId === edgeId
    );
  }
}

function product(values: number[]): number {
  return values.reduce((result, value) => result * value, 1);
}
