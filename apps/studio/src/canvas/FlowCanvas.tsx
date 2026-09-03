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
import { useCallback, useEffect, useMemo, useState } from "react";
import { EdgeSchema, type ArchitectureEvidence } from "@sds/schema";
import { protocolFreeEdgeId } from "../ids";
import { nodeTypes } from "./nodes";
import { PacketLayer } from "./PacketLayer";
import { PipeEdge } from "./PipeEdge";
import { useStudio } from "../store";
import { useStudyStore } from "../study/store";
import { TopologyExplorer, type TopologyExploration } from "./TopologyExplorer";

const edgeTypes = { pipe: PipeEdge };

type EvidenceTone = "observed" | "inferred" | "assumed" | "uncovered";

function evidenceTone(items: Array<{ confidence: "observed" | "inferred" | "assumed" }>): EvidenceTone {
  if (items.length === 0) return "uncovered";
  if (items.some((item) => item.confidence === "assumed")) return "assumed";
  if (items.some((item) => item.confidence === "inferred")) return "inferred";
  return "observed";
}

function Canvas() {
  const design = useStudio((s) => s.design);
  const selection = useStudio((s) => s.selection);
  const trace = useStudio((s) => (s.runStale ? null : (s.run?.trace ?? null)));
  const moveNode = useStudio((s) => s.moveNode);
  const select = useStudio((s) => s.select);
  const edit = useStudio((s) => s.edit);
  const study = useStudyStore((s) => s.study);
  const activeCandidateId = study.activeCandidateId;
  const activeCandidate =
    study.candidates.find((candidate) => candidate.id === activeCandidateId) ?? study.candidates[0];
  const evidenceByTarget = useMemo(() => {
    const grouped = new Map<string, ArchitectureEvidence[]>();
    for (const evidence of activeCandidate?.evidence ?? []) {
      const key = `${evidence.targetKind}:${evidence.targetId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), evidence]);
    }
    return grouped;
  }, [activeCandidate]);
  const [exploration, setExploration] = useState<TopologyExploration>(null);

  const topologyFingerprint = useMemo(
    () =>
      JSON.stringify({
        nodes: design.nodes.map((node) => node.id),
        edges: design.edges.map((edge) => [edge.id, edge.from, edge.to]),
      }),
    [design.edges, design.nodes]
  );
  useEffect(() => setExploration(null), [activeCandidateId, topologyFingerprint]);
  const highlightedNodeIds = useMemo(
    () => new Set(exploration?.result.nodeIds ?? []),
    [exploration]
  );
  const highlightedEdgeIds = useMemo(
    () => new Set(exploration?.result.edgeIds ?? []),
    [exploration]
  );
  const explorationOrigin =
    exploration?.kind === "route" ? exploration.result.sourceId : exploration?.result.originId;
  const explorationEnd = exploration?.kind === "route" ? exploration.result.targetId : null;

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
        data: {
          repositoryLinked: study.repository !== null,
          evidenceCount: evidenceByTarget.get(`node:${n.id}`)?.length ?? 0,
          evidenceTone: evidenceTone(evidenceByTarget.get(`node:${n.id}`) ?? []),
        },
        selected: selection?.kind === "node" && selection.id === n.id,
        className: exploration
          ? [
              highlightedNodeIds.has(n.id) ? "topology-match" : "topology-muted",
              n.id === explorationOrigin ? "topology-origin" : "",
              n.id === explorationEnd ? "topology-end" : "",
            ]
              .filter(Boolean)
              .join(" ")
          : undefined,
      })),
    [
      design.nodes,
      evidenceByTarget,
      exploration,
      explorationEnd,
      explorationOrigin,
      highlightedNodeIds,
      selection,
      study.repository,
    ]
  );

  const edges = useMemo<Edge[]>(
    () =>
      design.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "pipe",
        selected: selection?.kind === "edge" && selection.id === e.id,
        className: exploration
          ? highlightedEdgeIds.has(e.id)
            ? "topology-match"
            : "topology-muted"
          : undefined,
        data: {
          topology: exploration
            ? highlightedEdgeIds.has(e.id)
              ? "match"
              : "muted"
            : "none",
          repositoryLinked: study.repository !== null,
          evidenceCount: evidenceByTarget.get(`edge:${e.id}`)?.length ?? 0,
          evidenceTone: evidenceTone(evidenceByTarget.get(`edge:${e.id}`) ?? []),
        },
      })),
    [design.edges, evidenceByTarget, exploration, highlightedEdgeIds, selection, study.repository]
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

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => select({ kind: "node", id: node.id }),
    [select]
  );

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => select({ kind: "edge", id: edge.id }),
    [select]
  );

  const onPaneClick = useCallback(() => select(null), [select]);
  const onSelectNode = useCallback((id: string) => select({ kind: "node", id }), [select]);

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
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
        <TopologyExplorer
          key={`${activeCandidateId ?? "none"}:${topologyFingerprint}`}
          design={design}
          selectedNodeId={selection?.kind === "node" ? selection.id : null}
          exploration={exploration}
          onExplorationChange={setExploration}
          onSelectNode={onSelectNode}
        />
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
