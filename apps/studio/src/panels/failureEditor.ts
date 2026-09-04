import type { Design, FailureEvent } from "@sds/schema";

export type FailureKind = FailureEvent["kind"];

export const FAILURE_KINDS: Array<{ value: FailureKind; label: string }> = [
  { value: "node-outage", label: "Node outage" },
  { value: "capacity-reduction", label: "Capacity reduction" },
  { value: "service-degradation", label: "Service degradation" },
  { value: "edge-latency", label: "Edge latency" },
  { value: "request-loss", label: "Request loss" },
  { value: "gateway-disconnection", label: "Gateway disconnection" },
  { value: "replica-partition", label: "Replica partition" },
  { value: "replica-divergence", label: "Replica divergence" },
  { value: "clock-skew", label: "Replica clock skew" },
];

export function failureTargetId(event: FailureEvent): string {
  if ("targetNodeId" in event) return event.targetNodeId;
  if ("targetEdgeId" in event) return event.targetEdgeId;
  return event.replicaGroupId;
}

export function failureSummary(event: FailureEvent): string {
  switch (event.kind) {
    case "node-outage":
      return "offline";
    case "capacity-reduction":
      return `${Math.round(event.factor * 100)}% capacity`;
    case "service-degradation":
    case "edge-latency":
      return `${event.factor.toFixed(1)}×`;
    case "request-loss":
      return `${Math.round(event.lossProbability * 100)}% loss`;
    case "gateway-disconnection":
      return `${Math.round(event.fraction * 100)}% disconnected`;
    case "replica-partition":
      return `${event.availableReplicas} reachable`;
    case "replica-divergence":
      return `${event.staleReplicas} stale · ${event.versionLag} version lag`;
    case "clock-skew":
      return `${event.maxSkewMs.toFixed(0)}ms max skew`;
  }
}

export function failureStrengthLabel(kind: FailureKind, strength: number): string {
  switch (kind) {
    case "capacity-reduction":
      return `remaining capacity · ${strength}%`;
    case "service-degradation":
    case "edge-latency":
      return `multiplier · ${(Math.max(1, strength / 10)).toFixed(1)}×`;
    case "request-loss":
      return `added loss · ${strength}%`;
    case "gateway-disconnection":
      return `connections dropped · ${strength}%`;
    case "node-outage":
      return "outage";
    case "replica-partition":
      return `reachable replicas · ${strength}% of group`;
    case "replica-divergence":
      return `stale replicas · ${strength}% of group`;
    case "clock-skew":
      return `maximum skew · ${strength * 10}ms`;
  }
}

export interface FailureTarget {
  id: string;
  label: string;
}

/** Return only targets that the engine accepts for this failure kind. */
export function failureTargetsFor(design: Design, kind: FailureKind): FailureTarget[] {
  if (kind === "edge-latency" || kind === "request-loss") {
    return design.edges.map((edge) => ({
      id: edge.id,
      label: `${design.nodes.find((node) => node.id === edge.from)?.label ?? edge.from} → ${design.nodes.find((node) => node.id === edge.to)?.label ?? edge.to}`,
    }));
  }
  if (kind === "gateway-disconnection") {
    return design.nodes
      .filter((node) => node.kind === "gateway")
      .map((node) => ({ id: node.id, label: node.label }));
  }
  if (kind === "replica-partition" || kind === "replica-divergence" || kind === "clock-skew") {
    return design.nodes.flatMap((node) => {
      const group = node.database?.replicaGroup;
      return group ? [{ id: group.id, label: `${group.id} · ${node.label}` }] : [];
    });
  }
  const nodes = kind === "node-outage" ? design.nodes : design.nodes.filter((node) => node.kind !== "client");
  return nodes.map((node) => ({ id: node.id, label: node.label }));
}

export function makeFailureEvent(input: {
  design: Design;
  kind: FailureKind;
  targetId: string;
  id: string;
  startSec: number;
  durationSec: number;
  strength: number;
}): FailureEvent {
  const { design, kind, targetId, id } = input;
  const strength = Math.min(100, Math.max(0, input.strength));
  const base = {
    id,
    startSec: Math.max(0, input.startSec),
    durationSec: Math.max(0.1, input.durationSec),
  };
  const selectedReplicaCount =
    design.nodes.find((node) => node.database?.replicaGroup?.id === targetId)?.database?.replicaGroup?.replicas ?? 1;

  switch (kind) {
    case "node-outage":
      return { ...base, kind, targetNodeId: targetId };
    case "capacity-reduction":
      return { ...base, kind, targetNodeId: targetId, factor: strength / 100 };
    case "service-degradation":
      return { ...base, kind, targetNodeId: targetId, factor: Math.max(1, strength / 10) };
    case "edge-latency":
      return { ...base, kind, targetEdgeId: targetId, factor: Math.max(1, strength / 10) };
    case "request-loss":
      return { ...base, kind, targetEdgeId: targetId, lossProbability: strength / 100 };
    case "gateway-disconnection":
      return {
        ...base,
        kind,
        targetNodeId: targetId,
        fraction: strength / 100,
        reconnectOverSec: Math.min(base.durationSec, 5),
      };
    case "replica-partition":
      return {
        ...base,
        kind,
        replicaGroupId: targetId,
        availableReplicas: Math.round((selectedReplicaCount * strength) / 100),
      };
    case "replica-divergence":
      return {
        ...base,
        kind,
        replicaGroupId: targetId,
        staleReplicas: Math.max(1, Math.round((selectedReplicaCount * strength) / 100)),
        versionLag: 1,
      };
    case "clock-skew":
      return {
        ...base,
        kind,
        replicaGroupId: targetId,
        maxSkewMs: Math.max(1, strength * 10),
      };
  }
}
