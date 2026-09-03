import { Handle, Position, type NodeProps } from "@xyflow/react";
import { describe } from "@sds/core";
import { CHIP_SIZE, MAX_CHIPS, NODE_HEIGHT, NODE_WIDTH } from "./geometry";
import { iconDataUrl, visitIcon } from "./identicon";
import { isTimeVarying, peakRate, type ArrivalProcess, type NodeKind, type SdsNode } from "@sds/schema";
import { useStudio } from "../store";
import { usePlayback } from "../playback";
import { useNodeState, useRaceModel } from "../raceModel";
import { useRacePlayback } from "../racePlayback";
import { useStudyStore } from "../study/store";
import { KindIcon } from "../ui/icons";
import { modelInputLabel } from "./provenance";

/**
 * NODE HEIGHT IS FIXED, ON PURPOSE.
 *
 * React Flow measures node dimensions to lay out edges and handles. A node whose
 * height changed as its occupancy display grew would trigger re-measurement many
 * times a second during playback, so every kind renders into the same box.
 */

const KIND_ACCENT: Record<NodeKind, string> = {
  client: "var(--sky)",
  loadbalancer: "var(--teal)",
  server: "var(--accent)",
  cache: "var(--pink)",
  database: "var(--purple)",
  queue: "var(--green)",
  gateway: "var(--yellow)",
  lock: "var(--bad)",
};

const KIND_LABEL: Record<NodeKind, string> = {
  client: "client",
  loadbalancer: "balancer",
  server: "service",
  cache: "cache",
  database: "database",
  queue: "queue",
  gateway: "gateway",
  lock: "lease",
};

/** The kind caption in a node's head: the same glyph the palette uses, so menu and drawing agree. */
function KindCaption({ kind }: { kind: NodeKind }) {
  return (
    <span className="node-kind">
      <KindIcon kind={kind} size={11} />
      {KIND_LABEL[kind]}
    </span>
  );
}

/** One-line summary of an arrival profile, including the time-varying shapes. */
function describeArrival(a: ArrivalProcess): string {
  switch (a.kind) {
    case "poisson":
    case "deterministic":
      return `${a.ratePerSec.toLocaleString()} req/s`;
    case "ramp":
      return `${a.fromRatePerSec.toLocaleString()} \u2192 ${a.toRatePerSec.toLocaleString()} req/s`;
    case "spike":
      return `${a.baseRatePerSec.toLocaleString()} \u2192 ${a.peakRatePerSec.toLocaleString()} for ${a.durationSec}s`;
    case "steps":
      return `${a.ratePerSec.toLocaleString()} req/s, ${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`;
  }
}

function utilTone(rho: number): string {
  // Queueing delay grows as 1/(1-rho), so 0.85 is already deep into the knee
  // rather than a comfortable margin.
  if (rho >= 1) return "crit";
  if (rho >= 0.85) return "bad";
  if (rho >= 0.7) return "warn";
  return "ok";
}

/** One line summarising what this component's own work costs. */
function summaryOf(node: SdsNode): string {
  switch (node.kind) {
    case "client": {
      const a = node.client!.arrival;
      const conns = node.client!.connections;
      const msgs = `${a.kind} \u00b7 ${describeArrival(a)}`;
      // Connections lead, because when a client holds them they are the headline
      // number and the message rate is secondary.
      return conns ? `${conns.count.toLocaleString()} connections \u00b7 ${msgs}` : msgs;
    }
    case "gateway": {
      const g = node.gateway!;
      const total = g.connectionCapacity * g.replicas;
      const reps = g.replicas > 1 ? `${g.replicas}\u00d7` : "";
      return `${reps}${(g.connectionCapacity / 1000).toFixed(0)}k sockets \u00b7 ${g.pushConcurrency} slots`;
    }
    case "loadbalancer":
      return `${node.loadbalancer!.algorithm} \u00b7 ${describe(node.loadbalancer!.serviceTime)}`;
    case "server": {
      const s = node.server!;
      const reps = s.replicas > 1 ? `${s.replicas}\u00d7` : "";
      return `${reps}${s.concurrency} slots \u00b7 ${describe(s.serviceTime)}`;
    }
    case "cache": {
      const c = node.cache!;
      const keys = c.keyspace.kind === "zipf" ? `${(c.keyspace.keys / 1000).toFixed(0)}k keys` : "fixed ratio";
      return `${(c.capacity / 1000).toFixed(0)}k cap \u00b7 ${keys}`;
    }
    case "database": {
      const d = node.database!;
      return `pool ${d.poolSize} / exec ${d.parallelism} \u00b7 ${describe(d.serviceTime)}`;
    }
    case "queue": {
      const q = node.queue!;
      const ack = q.delivery === "at-least-once" ? "at-least-once" : "at-most-once";
      return `${q.consumers} consumers \u00b7 ${ack}`;
    }
    case "lock": {
      const l = node.lock!;
      // Fencing leads, because it is the difference between mutual exclusion and a
      // strong suggestion, and a reader scanning the canvas should see which one
      // this is without opening the inspector.
      return `${l.fencingTokens ? "fenced" : "unfenced"} \u00b7 ${l.defaultTtlMs}ms ttl`;
    }
  }
}

/**
 * Second line: whichever measured figure is most diagnostic for this kind.
 *
 * A cache's hit ratio, a database's execution vs pool split, a queue's backlog.
 * Utilization alone is the wrong headline for a queue -- its consumers can be
 * comfortably busy while the backlog grows without bound.
 */
function detailOf(kind: NodeKind, measured: ReturnType<typeof useMeasured>): string | null {
  if (!measured) return null;
  switch (kind) {
    case "cache":
      return measured.cache
        ? `${(measured.cache.hitRatio * 100).toFixed(0)}% hit ratio`
        : null;
    case "database":
      return measured.database
        ? `pool ${(measured.database.poolUtilization * 100).toFixed(0)}% \u00b7 exec ${(
            measured.database.executionUtilization * 100
          ).toFixed(0)}%`
        : null;
    case "queue":
      return measured.queue
        ? `backlog ${Math.round(measured.queue.avgBacklog).toLocaleString()}` +
            (measured.queue.backlogGrowthPerSec > 0.05
              ? ` \u00b7 growing ${measured.queue.backlogGrowthPerSec.toFixed(0)}/s`
              : "")
        : null;
    case "loadbalancer":
      return measured.loadbalancer
        ? `\u00b1${measured.loadbalancer.worstImbalancePct.toFixed(1)}pp spread`
        : null;
    case "lock":
      return measured.lock
        ? `${measured.lock.acquired.toLocaleString()} granted` +
            (measured.lock.expired > 0
              ? ` \u00b7 ${measured.lock.expired.toLocaleString()} expired`
              : "") +
            (measured.lock.staleOwnerRejections > 0
              ? ` \u00b7 ${measured.lock.staleOwnerRejections.toLocaleString()} fenced off`
              : "")
        : null;
    case "gateway":
      return measured.connections
        ? measured.connections.capacity > 1
          ? `${Math.round(measured.connections.avgHeld).toLocaleString()} held` +
            (measured.connections.refused > 0
              ? ` \u00b7 ${measured.connections.refused.toLocaleString()} refused`
              : "")
          : `${measured.connections.pushRatePerSec.toFixed(0)} pushes/s`
        : null;
    default:
      return `${measured.completed.toLocaleString()} served`;
  }
}

function useMeasured(id: string) {
  const measured = useStudio((s) => s.run?.nodes.find((n) => n.nodeId === id));
  const stale = useStudio((s) => s.runStale);
  return stale ? undefined : measured;
}

/**
 * The occupancy strip: which requests are at this station right now.
 *
 * Restores the most legible idea from the original build. A request appears as its
 * identicon while it is here, and the sprite that arrives on the pipe docks into
 * exactly this chip -- so a fan-out reads as one shape leaving in several colours and
 * each colour returning to the slot that was held open for it.
 *
 * SLOT POSITIONS ARE FIXED AND THE STRIP DOES NOT GROW.
 *
 * React Flow measures node dimensions, so a strip that grew with occupancy would
 * trigger re-measurement many times a second during playback. It holds at most
 * `MAX_CHIPS` and reports the rest as a count, which is honest anyway: the trace is
 * sampled, so the chips were always a sample rather than a census.
 */
function ChipStrip({ nodeId }: { nodeId: string }) {
  // Narrow selector: this strip re-renders only when ITS OWN occupancy changes.
  const occ = usePlayback((s) => s.occupancy[nodeId]);
  if (!occ || occ.chips.length === 0) return null;

  const overflow = occ.total - occ.chips.length;

  return (
    <div className="chip-strip" style={{ height: CHIP_SIZE }}>
      {Array.from({ length: MAX_CHIPS }, (_, slot) => {
        const chip = occ.chips.find((c) => c.slot === slot);
        if (!chip) return <span className="chip-slot" key={slot} style={{ width: CHIP_SIZE }} />;
        const icon = visitIcon(chip.requestId, nodeId, chip.failed);
        return (
          <span
            className={`chip-slot filled ${chip.inService ? "serving" : "waiting"}`}
            key={slot}
            style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
            title={chip.inService ? "in service" : "queued"}
          >
            <img src={iconDataUrl(icon, CHIP_SIZE * 2)} alt="" width={CHIP_SIZE} height={CHIP_SIZE} />
          </span>
        );
      })}
      {overflow > 0 && <span className="chip-overflow tnum">+{overflow}</span>}
    </div>
  );
}

/**
 * The state strip: what this node's collections hold right now.
 *
 * The race is about data, so data has to be visible on the drawing. Each collection stored on this
 * node is a chip -- `inventory 1`, `claims no rows` -- showing the declared initial value until a
 * counterexample is loaded, then the value after the current step. A chip that just changed flashes;
 * a chip the violated rule reads turns red at the final step. That is the whole "watch it break".
 */
function StateStrip({ nodeId }: { nodeId: string }) {
  const chips = useNodeState(nodeId);
  if (chips.length === 0) return null;
  return (
    <div className="state-strip" aria-label="state held here">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className={`state-chip ${chip.changed ? "changed" : ""} ${chip.violated ? "violated" : ""}`}
          title={chip.label}
        >
          <span className="state-id">{chip.id}</span>
          <span className="state-value tnum">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}

/** Which part this node plays in the counterexample step under the cursor. */
function useRaceRole(nodeId: string): "" | "race-home" | "race-target" | "race-violated" {
  const plan = useRaceModel((s) => s.plan);
  const cursor = useRacePlayback((s) => s.cursor);
  const lens = useStudyStore((s) => s.lens);
  if (!plan || lens !== "behaviour" || cursor < 0) return "";
  const step = plan.steps[Math.min(cursor, plan.steps.length - 1)];
  if (!step) return "";
  const atEnd = cursor >= plan.steps.length - 1;
  if (atEnd && plan.violatingNodeId === nodeId) return "race-violated";
  if (step.targetNodeId === nodeId) return "race-target";
  if (step.homeNodeId === nodeId) return "race-home";
  return "";
}

export function StudioNode({ id, selected, data }: NodeProps) {
  const node = useStudio((s) => s.design.nodes.find((n) => n.id === id));
  const preview = useStudio((s) => s.preview.nodes.find((n) => n.nodeId === id));
  const measured = useMeasured(id);
  // Narrow selector: this node re-renders only when ITS OWN occupancy changes.
  const occ = usePlayback((s) => s.occupancy[id]);
  const raceRole = useRaceRole(id);
  const evidence = data as {
    repositoryLinked?: boolean;
    evidenceCount?: number;
    evidenceTone?: "observed" | "inferred" | "assumed" | "uncovered";
    noteCount?: number;
    noteTone?: "info" | "warn" | "bad";
  };

  if (!node) return null;
  const isClient = node.kind === "client";

  const rho = measured ? measured.utilization : (preview?.rho ?? 0);
  // Show rho above 1 rather than clamping: how far past capacity matters.
  const displayRho = !measured && preview && preview.rho > 1 ? preview.rho : rho;
  const tone = utilTone(displayRho);
  const detail = detailOf(node.kind, measured);
  const backlogGrowing = (measured?.queue?.backlogGrowthPerSec ?? 0) > 0.05;
  // Refusing connections is a hard failure, so it gets the same treatment as a queue
  // that will never drain.
  const refusingConnections = (measured?.connections?.refused ?? 0) > 0;

  return (
    <div
      className={`node kind-${node.kind} ${selected ? "selected" : ""} tone-${tone} ${
        backlogGrowing || refusingConnections ? "async-alert" : ""
      } ${raceRole}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT, "--accent-node": KIND_ACCENT[node.kind] } as React.CSSProperties}
    >
      {!isClient && <Handle type="target" position={Position.Left} />}

      <div className="node-head">
        <span className="node-label">{node.label}</span>
        {evidence.noteCount ? (
          <button
            className={`node-note note-${evidence.noteTone ?? "info"}`}
            title={`${evidence.noteCount} note${evidence.noteCount === 1 ? "" : "s"} from the agent. Click to read them.`}
            onClick={(e) => {
              e.stopPropagation();
              useStudio.getState().select({ kind: "node", id });
              useStudyStore.getState().setAgentOpen(true);
            }}
          >
            {evidence.noteCount}
          </button>
        ) : null}
        {evidence.repositoryLinked && (
          <button
            className={`node-evidence evidence-${evidence.evidenceTone ?? "uncovered"}`}
            title={
              evidence.evidenceCount
                ? `${evidence.evidenceCount} source evidence record${evidence.evidenceCount === 1 ? "" : "s"}. Click to see the cited lines.`
                : "No source evidence attached. Treat this component as an assumption."
            }
            onClick={(e) => {
              e.stopPropagation();
              useStudio.getState().select({ kind: "node", id });
            }}
          >
            {evidence.evidenceCount || "?"}
          </button>
        )}
        <KindCaption kind={node.kind} />
      </div>

      <div className="node-service">{summaryOf(node)}</div>

      <StateStrip nodeId={id} />

      {!isClient && (
        <div className="util-row">
          <div className="util-bar">
            <div className="util-fill" style={{ width: `${Math.min(100, displayRho * 100)}%` }} />
            <div className="util-mark" style={{ left: "100%" }} />
          </div>
          <span className="util-value tnum">{(displayRho * 100).toFixed(0)}%</span>
        </div>
      )}

      <div className="node-foot">
        {occ ? (
          <span className="occ tnum">
            {occ.inService} in service &middot; {occ.queued} queued
          </span>
        ) : detail ? (
          <span className="occ tnum">{detail}</span>
        ) : (
          <span className="node-src">
            {measured
              ? "measured"
              : modelInputLabel(Boolean(evidence.repositoryLinked), evidence.evidenceTone)}
          </span>
        )}
      </div>

      <ChipStrip nodeId={id} />

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/**
 * Every kind renders through the same component; React Flow needs a map.
 *
 * Kept exhaustive over `NodeKind` by construction, because a missing entry does not
 * fail loudly -- React Flow silently falls back to its default node, which renders
 * nothing useful and breaks selection. That is how the gateway shipped invisible in a
 * first pass.
 */
/**
 * A component that exists in the version being diffed against but not in the one on the
 * canvas. Drawn where it used to be, hollow, so a removal is visible as a removal rather
 * than as an absence.
 */
export function GhostNode({ data }: NodeProps) {
  const ghost = data as { label?: string; kind?: NodeKind }
  const kind = ghost.kind ?? "server"
  return (
    <div
      className={`node ghost kind-${kind}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT, "--accent-node": KIND_ACCENT[kind] } as React.CSSProperties}
      title="present in the version being compared, removed in this one"
    >
      {kind !== "client" && <Handle type="target" position={Position.Left} />}
      <div className="node-head">
        <span className="node-label">{ghost.label ?? "removed"}</span>
        <KindCaption kind={kind} />
      </div>
      <div className="node-service">removed in this version</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const nodeTypes: Record<NodeKind | "ghost", typeof StudioNode | typeof GhostNode> = {
  client: StudioNode,
  loadbalancer: StudioNode,
  server: StudioNode,
  cache: StudioNode,
  database: StudioNode,
  queue: StudioNode,
  gateway: StudioNode,
  lock: StudioNode,
  ghost: GhostNode,
};
