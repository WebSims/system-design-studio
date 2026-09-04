import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { mean as distMean, meanNetworkRoundTripMs } from "@sds/core";
import { useStudio } from "../store";
import { latencyLabel, performanceInputState } from "./provenance";

/**
 * A "pipe" edge: a wide dark casing with a lighter core, plus a mid-edge label.
 *
 * Two stacked paths give the depth the legacy canvas achieved by hand. The
 * important difference is that the geometry comes from React Flow's own
 * `getBezierPath`, which returns the SVG path string. The packet layer can build
 * an offscreen `SVGPathElement` from that same string and call
 * `getPointAtLength` on it -- no `document.querySelector` for a rendered node, no
 * `getScreenCTM().inverse()` (engine.jsx:311-321). The animation reads geometry
 * from the source of truth instead of measuring the DOM to recover it.
 */
export function PipeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  interactionWidth,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edge = useStudio((s) => s.design.edges.find((e) => e.id === id));
  const latencyMs = edge ? distMean(edge.network.propagationLatency) : 0;
  const roundTripMs = edge ? meanNetworkRoundTripMs(edge.network) : 0;
  const loss = edge?.network.lossProbability ?? 0;
  const topology = (data as { topology?: "none" | "match" | "muted" } | undefined)?.topology;
  const evidence = data as
    | {
        repositoryLinked?: boolean;
        performanceCalibrated?: boolean;
        hasPerformanceEvidence?: boolean;
        evidenceCount?: number;
        evidenceTone?: "observed" | "inferred" | "assumed" | "uncovered";
      }
    | undefined;
  const inputState = performanceInputState({
    repositoryLinked: Boolean(evidence?.repositoryLinked),
    calibrated: evidence?.performanceCalibrated !== false,
    hasPerformanceEvidence: Boolean(evidence?.hasPerformanceEvidence),
    usable: Number.isFinite(latencyMs) && latencyMs > 0,
  });

  return (
    <>
      <BaseEdge id={`${id}-casing`} path={path} className="pipe-casing" interactionWidth={0} />
      <BaseEdge
        id={id}
        path={path}
        className={`pipe-core ${selected ? "selected" : ""}`}
        interactionWidth={Math.max(interactionWidth ?? 0, 32)}
      />
      <EdgeLabelRenderer>
        <div
          className={`edge-chip edge-latency-${inputState} ${selected ? "selected" : ""} ${topology ? `topology-${topology}` : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <span
            className="tnum"
            title={
              evidence?.repositoryLinked && evidence.performanceCalibrated === false
                ? inputState === "estimated"
                  ? "Estimated one-way latency. Load results stay withheld until runtime or user measurements calibrate this link."
                  : "One-way latency is unknown. Add a positive estimate with explicit provenance, then calibrate it with runtime or user measurements."
                : undefined
            }
          >
            {latencyLabel(latencyMs, inputState)}
          </span>
          {selected && <span className="edge-selected-marker" aria-hidden="true">✓</span>}
          {edge?.semantics.kind === "asynchronous" && (
            <span
              className="edge-async"
              title={`Asynchronous ${edge.semantics.channel} handoff; at most ${edge.semantics.maxHops} traversal${edge.semantics.maxHops === 1 ? "" : "s"} per root request`}
            >
              ⇢ async · {edge.semantics.maxHops}h
            </span>
          )}
          {edge && roundTripMs > latencyMs * 2 && (
            <span className="edge-network-total tnum" title="Mean request + response network cost">
              {roundTripMs.toFixed(1)}ms RTT
            </span>
          )}
          {evidence?.repositoryLinked && (
            <span
              className={`edge-evidence evidence-${evidence.evidenceTone ?? "uncovered"}`}
              title={
                evidence.evidenceCount
                  ? `${evidence.evidenceCount} source evidence record${evidence.evidenceCount === 1 ? "" : "s"}`
                  : "No source evidence attached"
              }
            >
              {evidence.evidenceCount || "?"}
            </span>
          )}
          {loss > 0 && <span className="edge-loss tnum">{(loss * 100).toFixed(1)}% loss</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
