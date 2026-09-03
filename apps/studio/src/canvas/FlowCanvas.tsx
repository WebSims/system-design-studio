import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EdgeSchema, type ArchitectureEvidence, type Design } from "@sds/schema";
import { protocolFreeEdgeId } from "../ids";
import { NODE_HEIGHT, NODE_WIDTH } from "./geometry";
import { nodeTypes } from "./nodes";
import { PacketLayer } from "./PacketLayer";
import { RaceLayer } from "./RaceLayer";
import { PipeEdge } from "./PipeEdge";
import { useRaceModel } from "../raceModel";
import { useRacePlayback } from "../racePlayback";
import { useStudio } from "../store";
import { useStudyStore, type Annotation } from "../study/store";
import { compareDesignTopology, type DesignDelta } from "../topology";
import { TopologyExplorer, type TopologyExploration } from "./TopologyExplorer";

const edgeTypes = { pipe: PipeEdge };

type EvidenceTone = "observed" | "inferred" | "assumed" | "uncovered";

function evidenceTone(items: Array<{ confidence: "observed" | "inferred" | "assumed" }>): EvidenceTone {
  if (items.length === 0) return "uncovered";
  if (items.some((item) => item.confidence === "assumed")) return "assumed";
  if (items.some((item) => item.confidence === "inferred")) return "inferred";
  return "observed";
}

/** The loudest tone among the notes pinned to one element; that is the colour of its pin. */
function noteTone(notes: readonly Annotation[]): Annotation["tone"] {
  if (notes.some((note) => note.tone === "bad")) return "bad";
  if (notes.some((note) => note.tone === "warn")) return "warn";
  return "info";
}

/** Add a link between two nodes if the design allows one. Shared by drag-connect and click-connect. */
const addLink = (d: Design, from: string, to: string): void => {
  if (from === to) return;
  if (d.edges.some((e) => e.from === from && e.to === to)) return;
  const target = d.nodes.find((n) => n.id === to);
  if (!target || target.kind === "client") return;
  // Parsed so every policy field picks up its default rather than being
  // hand-listed here and drifting from the schema.
  d.edges.push(
    EdgeSchema.parse({
      id: protocolFreeEdgeId(d.edges.map((e) => e.id)),
      from,
      to,
      latency: { kind: "deterministic", value: 0.25 },
    })
  );
};

/**
 * Pan to what the agent (or the review drawer) asked to look at, then clear the request.
 *
 * A focus on a counterexample step also scrubs playback there, so the sprite, the chips and the
 * timeline all show that step. The request is consumed here rather than in the store because only
 * the canvas knows where a node is on screen.
 */
function useFocusRequests(design: Design) {
  const focusRequest = useStudyStore((s) => s.focusRequest);
  const requestFocus = useStudyStore((s) => s.requestFocus);
  const select = useStudio((s) => s.select);
  const { setCenter, getZoom } = useReactFlow();

  useEffect(() => {
    if (!focusRequest) return;
    const centreOn = (nodeId: string | null) => {
      const node = nodeId ? design.nodes.find((n) => n.id === nodeId) : null;
      if (!node) return;
      void setCenter(node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2, {
        zoom: Math.max(getZoom(), 0.8),
        duration: 500,
      });
    };
    if (focusRequest.kind === "node") {
      select({ kind: "node", id: focusRequest.id });
      centreOn(focusRequest.id);
    } else if (focusRequest.kind === "edge") {
      select({ kind: "edge", id: focusRequest.id });
      const edge = design.edges.find((e) => e.id === focusRequest.id);
      centreOn(edge?.to ?? null);
    } else {
      useStudyStore.getState().setLens("behaviour");
      useRacePlayback.getState().seek(focusRequest.index);
      const step = useRaceModel.getState().plan?.steps[focusRequest.index];
      centreOn(step?.targetNodeId ?? step?.homeNodeId ?? null);
    }
    requestFocus(null);
  }, [design, focusRequest, getZoom, requestFocus, select, setCenter]);
}

function Canvas() {
  const design = useStudio((s) => s.design);
  const selection = useStudio((s) => s.selection);
  const trace = useStudio((s) => (s.runStale ? null : (s.run?.trace ?? null)));
  const moveNode = useStudio((s) => s.moveNode);
  const select = useStudio((s) => s.select);
  const edit = useStudio((s) => s.edit);
  const study = useStudyStore((s) => s.study);
  const lens = useStudyStore((s) => s.lens);
  const annotations = useStudyStore((s) => s.annotations);
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
  const notesByTarget = useMemo(() => {
    const grouped = new Map<string, Annotation[]>();
    for (const note of annotations) {
      if (note.candidateId !== null && note.candidateId !== activeCandidateId) continue;
      if (note.targetKind !== "node" && note.targetKind !== "edge") continue;
      const key = `${note.targetKind}:${note.targetId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), note]);
    }
    return grouped;
  }, [activeCandidateId, annotations]);
  /**
   * Visual diff against another version.
   *
   * The active version stays the drawing; the other version contributes only what the active
   * one lacks, as ghosts. Marks on the real nodes say added / changed / moved. Nothing here
   * touches the design, so the diff can stay on while the person edits.
   */
  const diffBaseId = useStudyStore((s) => s.diffBaseId);
  const setDiffBase = useStudyStore((s) => s.setDiffBase);
  const diffBase =
    diffBaseId && diffBaseId !== activeCandidateId
      ? (study.candidates.find((candidate) => candidate.id === diffBaseId) ?? null)
      : null;
  const delta = useMemo<DesignDelta | null>(
    () => (diffBase ? compareDesignTopology(diffBase.design, design) : null),
    [design, diffBase]
  );
  const diffNodeStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const change of delta?.nodes ?? []) if (change.status !== "removed") map.set(change.id, change.status);
    return map;
  }, [delta]);
  const diffEdgeStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const change of delta?.edges ?? []) if (change.status !== "removed") map.set(change.id, change.status);
    return map;
  }, [delta]);
  const ghostNodes = useMemo<Node[]>(() => {
    if (!delta || !diffBase) return [];
    const removed = new Set(delta.nodes.filter((c) => c.status === "removed").map((c) => c.id));
    return diffBase.design.nodes
      .filter((n) => removed.has(n.id))
      .map((n) => ({
        id: `ghost:${n.id}`,
        type: "ghost",
        position: { x: n.x, y: n.y },
        data: { label: n.label, kind: n.kind },
        draggable: false,
        selectable: false,
        connectable: false,
        className: "diff-removed",
      }));
  }, [delta, diffBase]);
  const ghostEdges = useMemo<Edge[]>(() => {
    if (!delta || !diffBase) return [];
    const removedNodes = new Set(delta.nodes.filter((c) => c.status === "removed").map((c) => c.id));
    const removedEdges = new Set(delta.edges.filter((c) => c.status === "removed").map((c) => c.id));
    const endpoint = (id: string) => (removedNodes.has(id) ? `ghost:${id}` : id);
    return diffBase.design.edges
      .filter((e) => removedEdges.has(e.id))
      .map((e) => ({
        id: `ghost:${e.id}`,
        source: endpoint(e.from),
        target: endpoint(e.to),
        type: "default",
        selectable: false,
        className: "diff-removed",
      }));
  }, [delta, diffBase]);

  const [exploration, setExploration] = useState<TopologyExploration>(null);
  /** Click-to-link: the node picked as the source while waiting for a target. */
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  useFocusRequests(design);

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
          noteCount: notesByTarget.get(`node:${n.id}`)?.length ?? 0,
          noteTone: noteTone(notesByTarget.get(`node:${n.id}`) ?? []),
        },
        selected: selection?.kind === "node" && selection.id === n.id,
        className: [
          exploration ? (highlightedNodeIds.has(n.id) ? "topology-match" : "topology-muted") : "",
          exploration && n.id === explorationOrigin ? "topology-origin" : "",
          exploration && n.id === explorationEnd ? "topology-end" : "",
          linkFrom === n.id ? "link-source" : "",
          diffNodeStatus.has(n.id) ? `diff-${diffNodeStatus.get(n.id)}` : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
      })),
    [
      design.nodes,
      diffNodeStatus,
      evidenceByTarget,
      exploration,
      explorationEnd,
      explorationOrigin,
      highlightedNodeIds,
      linkFrom,
      notesByTarget,
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
        className:
          [
            exploration ? (highlightedEdgeIds.has(e.id) ? "topology-match" : "topology-muted") : "",
            diffEdgeStatus.has(e.id) ? `diff-${diffEdgeStatus.get(e.id)}` : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined,
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
    [design.edges, diffEdgeStatus, evidenceByTarget, exploration, highlightedEdgeIds, selection, study.repository]
  );

  const allNodes = useMemo(() => (ghostNodes.length ? [...nodes, ...ghostNodes] : nodes), [ghostNodes, nodes]);
  const allEdges = useMemo(() => (ghostEdges.length ? [...edges, ...ghostEdges] : edges), [edges, ghostEdges]);

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
      edit((d) => addLink(d, conn.source, conn.target));
    },
    [edit]
  );

  /**
   * Click-to-link. Dragging the tiny handles is the React Flow way and still works; this is the way
   * a person who has not found the handles gets a link made: press Link, click the source, click
   * the target.
   */
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Ghosts belong to the other version; there is nothing to select or link.
      if (node.type === "ghost") return;
      if (!linking) {
        select({ kind: "node", id: node.id });
        return;
      }
      if (!linkFrom) {
        setLinkFrom(node.id);
        select({ kind: "node", id: node.id });
        return;
      }
      edit((d) => addLink(d, linkFrom, node.id));
      setLinkFrom(null);
      setLinking(false);
    },
    [edit, linkFrom, linking, select]
  );

  const toggleLinking = useCallback(() => {
    setLinking((on) => !on);
    setLinkFrom(null);
  }, []);

  useEffect(() => {
    if (!linking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLinking(false);
      setLinkFrom(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linking]);

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => select({ kind: "edge", id: edge.id }),
    [select]
  );

  const onPaneClick = useCallback(() => {
    select(null);
    setLinkFrom(null);
  }, [select]);
  const onSelectNode = useCallback((id: string) => select({ kind: "node", id }), [select]);

  const linkableTargets = design.nodes.filter((n) => n.kind !== "client").length;

  return (
    <div className={`canvas-wrap ${linking ? "linking" : ""}`}>
      <ReactFlow
        nodes={allNodes}
        edges={allEdges}
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
        {diffBase && delta && (
          <Panel position="top-right" className="diff-panel" aria-label="Version diff legend">
            <span className="diff-title">
              compared with <b>{diffBase.label}</b>
            </span>
            <span className="diff-legend">
              <span className="diff-key diff-added">{delta.summary.nodesAdded + delta.summary.edgesAdded} added</span>
              <span className="diff-key diff-removed">{delta.summary.nodesRemoved + delta.summary.edgesRemoved} removed</span>
              <span className="diff-key diff-changed">{delta.summary.nodesChanged + delta.summary.edgesChanged} changed</span>
              {delta.summary.nodesMoved > 0 && <span className="diff-key diff-moved">{delta.summary.nodesMoved} moved</span>}
            </span>
            {!delta.comparable && <span className="muted">no shared ids, so only additions and removals are exact</span>}
            <button type="button" className="btn small ghost" onClick={() => setDiffBase(null)}>
              hide diff
            </button>
          </Panel>
        )}
        {design.nodes.length >= 2 && linkableTargets > 0 && (
          <Panel position="bottom-center" className="link-panel">
            <button
              type="button"
              className={`btn small ${linking ? "primary" : ""}`}
              onClick={toggleLinking}
              aria-pressed={linking}
              title="Make a link by clicking two components in turn. You can also drag from a component's right handle to another's left."
            >
              {linking ? "Linking\u2026" : "Link"}
            </button>
            {linking && (
              <span className="link-hint">
                {linkFrom
                  ? `now click the component ${design.nodes.find((n) => n.id === linkFrom)?.label ?? "it"} calls`
                  : "click the component that makes the call"}
                <span className="muted">{" \u00b7 Esc to cancel"}</span>
              </span>
            )}
          </Panel>
        )}
        {lens === "load" ? <PacketLayer design={design} trace={trace} /> : <RaceLayer />}
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
