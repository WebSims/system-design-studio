import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import { EdgeSchema } from "@sds/schema";
import { protocolFreeEdgeId } from "../ids";
import { nodeTypes } from "./nodes";
import { PacketLayer } from "./PacketLayer";
import { PipeEdge } from "./PipeEdge";
import { useStudio } from "../store";

const edgeTypes = { pipe: PipeEdge };

function Canvas() {
  const design = useStudio((s) => s.design);
  const selection = useStudio((s) => s.selection);
  const trace = useStudio((s) => (s.runStale ? null : (s.run?.trace ?? null)));
  const moveNode = useStudio((s) => s.moveNode);
  const select = useStudio((s) => s.select);
  const edit = useStudio((s) => s.edit);

  /**
   * The React Flow node array is derived from the design and carries NOTHING that
   * changes during playback. Live state reaches the node components through the
   * playback store instead, so an animating graph does not re-render here.
   */
  const nodes = useMemo<Node[]>(
    () =>
      design.nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        data: {},
        selected: selection?.kind === "node" && selection.id === n.id,
      })),
    [design.nodes, selection]
  );

  const edges = useMemo<Edge[]>(
    () =>
      design.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "pipe",
        selected: selection?.kind === "edge" && selection.id === e.id,
      })),
    [design.edges, selection]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Only positions are written back; React Flow's other change kinds concern
      // its own view state, which the design has no business storing.
      const next = applyNodeChanges(changes, nodes);
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moveNode(change.id, change.position.x, change.position.y);
        }
      }
      void next;
    },
    [nodes, moveNode]
  );

  const onConnect = useCallback<OnConnect>(
    (conn) => {
      if (!conn.source || !conn.target) return;
      edit((d) => {
        if (d.edges.some((e) => e.from === conn.source && e.to === conn.target)) return;
        const target = d.nodes.find((n) => n.id === conn.target);
        if (!target || target.kind === "client") return;
        // Parsed so every policy field picks up its default rather than being
        // hand-listed here and drifting from the schema.
        d.edges.push(
          EdgeSchema.parse({
            id: protocolFreeEdgeId(d.edges.map((e) => e.id)),
            from: conn.source,
            to: conn.target,
            latency: { kind: "deterministic", value: 0.25 },
          })
        );
      });
    },
    [edit]
  );

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => select({ kind: "node", id: n.id })}
        onEdgeClick={(_, e) => select({ kind: "edge", id: e.id })}
        onPaneClick={() => select(null)}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
        defaultEdgeOptions={{ type: "pipe" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2621" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="#3a342c" maskColor="rgba(10,9,7,0.7)" />
        <PacketLayer design={design} trace={trace} />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
