import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { mean as distMean } from "@sds/core";
import { useStudio } from "../store";

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
  const latencyMs = edge ? distMean(edge.latency) : 0;
  const loss = edge?.lossProbability ?? 0;

  return (
    <>
      <BaseEdge id={`${id}-casing`} path={path} className="pipe-casing" />
      <BaseEdge id={id} path={path} className={`pipe-core ${selected ? "selected" : ""}`} />
      <EdgeLabelRenderer>
        <div
          className="edge-chip"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <span className="tnum">{latencyMs}ms</span>
          {loss > 0 && <span className="edge-loss tnum">{(loss * 100).toFixed(1)}% loss</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
