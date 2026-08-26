import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodePreview } from "@sds/analytic";
import { describe } from "@sds/core";
import type { SdsNode } from "@sds/schema";
import { useStudio } from "../store";
import { usePlayback } from "../playback";

/**
 * NODE HEIGHT IS FIXED, ON PURPOSE.
 *
 * React Flow measures node dimensions to lay out edges and handles. A node whose
 * height changes as its occupancy list grows would trigger re-measurement many
 * times a second during playback. The occupancy display therefore lives inside a
 * fixed box and overflows rather than pushing the node taller.
 */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 104;

function utilTone(rho: number): string {
  // Thresholds are the ones the analyzer will use in Phase 4: queueing delay
  // grows as 1/(1-rho), so 0.85 is already deep into the knee, not a comfortable
  // margin.
  if (rho >= 1) return "crit";
  if (rho >= 0.85) return "bad";
  if (rho >= 0.7) return "warn";
  return "ok";
}

export function StationNode({ id, selected }: NodeProps) {
  const node = useStudio((s) => s.design.nodes.find((n) => n.id === id));
  const preview = useStudio((s) => s.preview.nodes.find((n) => n.nodeId === id));
  const measured = useStudio((s) => s.run?.nodes.find((n) => n.nodeId === id));
  const runStale = useStudio((s) => s.runStale);
  // Narrow selector: this node re-renders only when ITS OWN occupancy changes.
  const occ = usePlayback((s) => s.occupancy[id]);

  if (!node || node.kind !== "server") return null;
  const cfg = node.server!;
  const capacity = cfg.concurrency * cfg.replicas;

  // Prefer measured over predicted, but never silently: the label says which.
  const useMeasured = measured && !runStale;
  const rho = useMeasured ? measured.utilization : (preview?.rho ?? 0);
  const displayRho = preview && preview.rho > 1 && !useMeasured ? preview.rho : rho;
  const tone = utilTone(displayRho);

  return (
    <div
      className={`node station ${selected ? "selected" : ""} tone-${tone}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-label">{node.label}</span>
        <span className="node-cap tnum">c={capacity}</span>
      </div>

      <div className="node-service">{describe(cfg.serviceTime)}</div>

      <div className="util-row">
        <div className="util-bar">
          <div
            className="util-fill"
            style={{ width: `${Math.min(100, displayRho * 100)}%` }}
          />
          {/* Marker at rho = 1: the boundary past which no steady state exists. */}
          <div className="util-mark" style={{ left: "100%" }} />
        </div>
        <span className="util-value tnum">{(displayRho * 100).toFixed(0)}%</span>
      </div>

      <div className="node-foot">
        {occ ? (
          <span className="occ tnum">
            {occ.inService} in service · {occ.queued} queued
          </span>
        ) : (
          <span className="node-src">{useMeasured ? "measured" : "estimated"}</span>
        )}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function ClientNode({ id, selected }: NodeProps) {
  const node = useStudio((s) => s.design.nodes.find((n) => n.id === id)) as SdsNode | undefined;
  const throughput = useStudio((s) => s.run?.throughputPerSec);
  const runStale = useStudio((s) => s.runStale);

  if (!node || node.kind !== "client") return null;
  const rate = node.client!.arrival.ratePerSec;

  return (
    <div
      className={`node client ${selected ? "selected" : ""}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <div className="node-head">
        <span className="node-label">{node.label}</span>
        <span className="node-cap">{node.client!.arrival.kind}</span>
      </div>
      <div className="node-service">
        offering <b className="tnum">{rate.toLocaleString()}</b> req/s
      </div>
      <div className="node-foot">
        {throughput !== undefined && !runStale ? (
          <span className="occ tnum">{throughput.toFixed(1)} req/s completing</span>
        ) : (
          <span className="node-src">
            {node.client!.timeoutMs === null ? "no timeout" : `timeout ${node.client!.timeoutMs}ms`}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** Shared by the inspector to describe what model the preview applied. */
export function modelBadge(preview: NodePreview | undefined): string {
  return preview ? preview.model : "—";
}
