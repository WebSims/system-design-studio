import type { NetworkProfile, SdsEdge } from "@sds/schema";
import { mean, sample } from "./distribution";
import type { FailureController } from "./failures";
import type { Rng } from "./rng";

export type NetworkDirection = "request" | "response";

export interface NetworkLeg {
  totalMs: number;
  propagationMs: number;
  serializationMs: number;
  transferMs: number;
  connectionMs: number;
  bytes: number;
  application: NetworkProfile["application"]["kind"];
  transport: NetworkProfile["transport"]["kind"];
}

export function transferTimeMs(bytes: number, bandwidthMbps: number | null): number {
  if (bytes <= 0 || bandwidthMbps === null) return 0;
  return (bytes * 8) / (bandwidthMbps * 1000);
}

/** Sample one directional request-level network transfer. */
export function sampleNetworkLeg(
  edge: SdsEdge,
  direction: NetworkDirection,
  rng: Rng,
  failures?: FailureController
): NetworkLeg {
  const profile = edge.network;
  const bytes = direction === "request" ? profile.requestBytes : profile.responseBytes;
  const propagationMs =
    sample(profile.propagationLatency, rng) * (failures?.latencyFactor(edge.id) ?? 1);
  const serializationMs = sample(
    direction === "request" ? profile.requestSerialization : profile.responseSerialization,
    rng
  );
  const transferMs = transferTimeMs(bytes, profile.bandwidthMbps);

  let connectionMs = 0;
  if (direction === "request" && profile.transport.kind === "tcp") {
    // Avoid a random draw at probability 0/1. This preserves the exact RNG stream of
    // migrated latency-only designs, whose reuse probability is one.
    const establish =
      profile.transport.reuseProbability <= 0
        ? true
        : profile.transport.reuseProbability >= 1
          ? false
          : !rng.chance(profile.transport.reuseProbability);
    if (establish) {
      connectionMs += sample(profile.transport.connectionSetup, rng);
      if (profile.transport.tls.enabled) connectionMs += sample(profile.transport.tls.cost, rng);
    }
  }

  return {
    totalMs: propagationMs + serializationMs + transferMs + connectionMs,
    propagationMs,
    serializationMs,
    transferMs,
    connectionMs,
    bytes,
    application: profile.application.kind,
    transport: profile.transport.kind,
  };
}

export function effectiveLossProbability(
  edge: SdsEdge,
  failures?: FailureController
): number {
  return failures?.lossProbability(edge.id, edge.network.lossProbability) ?? edge.network.lossProbability;
}

/** Mean request + response time used by analytic previews and attribution. */
export function meanNetworkRoundTripMs(profile: NetworkProfile): number {
  const request =
    mean(profile.propagationLatency) +
    mean(profile.requestSerialization) +
    transferTimeMs(profile.requestBytes, profile.bandwidthMbps);
  const response =
    mean(profile.propagationLatency) +
    mean(profile.responseSerialization) +
    transferTimeMs(profile.responseBytes, profile.bandwidthMbps);
  if (profile.transport.kind !== "tcp") return request + response;
  const setup =
    (1 - profile.transport.reuseProbability) *
    (mean(profile.transport.connectionSetup) +
      (profile.transport.tls.enabled ? mean(profile.transport.tls.cost) : 0));
  return request + response + setup;
}

/** True for the exact neutral profile emitted by the v6 migration. */
export function isLegacyLatencyOnlyNetwork(profile: NetworkProfile): boolean {
  return (
    profile.application.kind === "http" &&
    profile.application.version === "1.1" &&
    profile.transport.kind === "tcp" &&
    isZero(profile.transport.connectionSetup) &&
    !profile.transport.tls.enabled &&
    profile.transport.reuseProbability === 1 &&
    profile.requestBytes === 0 &&
    profile.responseBytes === 0 &&
    profile.bandwidthMbps === null &&
    isZero(profile.requestSerialization) &&
    isZero(profile.responseSerialization)
  );
}

function isZero(distribution: NetworkProfile["propagationLatency"]): boolean {
  return (
    (distribution.kind === "deterministic" && distribution.value === 0) ||
    (distribution.kind === "uniform" && distribution.min === 0 && distribution.max === 0)
  );
}
