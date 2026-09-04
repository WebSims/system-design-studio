import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getViewportForBounds,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EdgeSchema,
  performanceCalibration,
  type ArchitectureEvidence,
  type Design,
} from "@sds/schema";
import { protocolFreeEdgeId } from "../ids";
import { designBounds, neighbourhood } from "../agentAttention";
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
import { TopologyTools, type TopologyExploration } from "./TopologyExplorer";
import { CanvasToolbox, MinimapChrome, useCanvasToolboxPrefs } from "./CanvasToolbox";

const edgeTypes = { pipe: PipeEdge };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
/** Fitting the camera never zooms past 1: a drawing of two boxes should not fill the screen. */
const FIT_MAX_ZOOM = 1;
const FIT_PADDING = 0.25;
/** Below this, fitting the whole drawing makes the labels unreadable; fit the changed part instead. */
const WHOLE_DESIGN_MIN_ZOOM = 0.45;
const CAMERA_MS = 500;

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
  const { setCenter, getZoom, setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  useEffect(() => {
    if (!focusRequest) return;
    const centreOn = (nodeId: string | null) => {
      const node = nodeId ? design.nodes.find((n) => n.id === nodeId) : null;
      if (!node) return;
      void setCenter(node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2, {
        zoom: Math.max(getZoom(), 0.8),
        duration: CAMERA_MS,
      });
    };
    /**
     * Cover the whole drawing when it still reads at that size; otherwise cover the changed part
     * and its neighbours. Bounds come from design coordinates, so a node added this very frame is
     * already accounted for without waiting for React Flow to measure it.
     */
    const reveal = (nodeIds: string[], edgeIds: string[]) => {
      if (width === 0 || height === 0) return;
      const fit = (ids: string[]) => {
        const bounds = designBounds(design, ids);
        return bounds ? getViewportForBounds(bounds, width, height, MIN_ZOOM, FIT_MAX_ZOOM, FIT_PADDING) : null;
      };
      const whole = fit([]);
      if (!whole) return;
      const local = nodeIds.length || edgeIds.length ? neighbourhood(design, nodeIds, edgeIds) : [];
      const viewport = whole.zoom >= WHOLE_DESIGN_MIN_ZOOM || local.length === 0 ? whole : (fit(local) ?? whole);
      void setViewport(viewport, { duration: CAMERA_MS });
    };
    if (focusRequest.kind === "reveal") {
      reveal(focusRequest.nodeIds, focusRequest.edgeIds);
      select(focusRequest.select);
    } else if (focusRequest.kind === "node") {
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
  }, [design, focusRequest, getZoom, height, requestFocus, select, setCenter, setViewport, width]);
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
  /**
   * What the agent touched a moment ago, so it pulses. Elements only; a whole-design reveal has
   * nothing in particular to point at and the camera move is the whole message.
   */
  const attention = useStudyStore((s) =>
    s.agentAttention && s.agentAttention.candidateId === s.study.activeCandidateId ? s.agentAttention : null
  );
  const touchedNodeIds = useMemo(() => new Set(attention?.nodeIds ?? []), [attention]);
  const touchedEdgeIds = useMemo(() => new Set(attention?.edgeIds ?? []), [attention]);
  const primaryTouch = attention?.primary ?? null;
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
  const uncalibratedTargets = useMemo(() => {
    if (!activeCandidate) return new Set<string>();
    return new Set(
      performanceCalibration(study, activeCandidate).gaps.map(
        (gap) => `${gap.targetKind}:${gap.targetId}`
      )
    );
  }, [activeCandidate, study]);
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
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
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
  const [toolbox, setToolbox] = useCanvasToolboxPrefs();
  const expandToolbox = useCallback(() => setToolbox({ collapsed: false }), [setToolbox]);
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
   *
   * Every node carries its size. `onNodesChange` writes back positions only, so React Flow's
   * measurements never reach these objects, and a node without dimensions is skipped by the
   * minimap and by any fit that runs before first paint. The DOM box is this size already.
   */
  const nodes = useMemo<Node[]>(
    () =>
      design.nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: {
          repositoryLinked: study.repository !== null,
          performanceCalibrated: !uncalibratedTargets.has(`node:${n.id}`),
          hasPerformanceEvidence:
            evidenceByTarget.get(`node:${n.id}`)?.some((item) => item.aspect === "performance") ?? false,
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
          touchedNodeIds.has(n.id) ? "agent-touched" : "",
          primaryTouch?.kind === "node" && primaryTouch.id === n.id ? "agent-primary" : "",
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
      primaryTouch,
      selection,
      study.repository,
      touchedNodeIds,
      uncalibratedTargets,
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
            touchedEdgeIds.has(e.id) ? "agent-touched" : "",
            primaryTouch?.kind === "edge" && primaryTouch.id === e.id ? "agent-primary" : "",
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
          performanceCalibrated: !uncalibratedTargets.has(`edge:${e.id}`),
          hasPerformanceEvidence:
            evidenceByTarget.get(`edge:${e.id}`)?.some((item) => item.aspect === "performance") ?? false,
          evidenceCount: evidenceByTarget.get(`edge:${e.id}`)?.length ?? 0,
          evidenceTone: evidenceTone(evidenceByTarget.get(`edge:${e.id}`) ?? []),
        },
      })),
    [
      design.edges,
      diffEdgeStatus,
      evidenceByTarget,
      exploration,
      highlightedEdgeIds,
      primaryTouch,
      selection,
      study.repository,
      touchedEdgeIds,
      uncalibratedTargets,
    ]
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
        fitViewOptions={{ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "pipe" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2621" />
        {toolbox.minimap && (
          <MiniMap
            pannable
            zoomable
            maskColor="rgba(10,9,7,0.7)"
            maskStrokeColor="rgba(232,224,212,0.35)"
            maskStrokeWidth={1}
            nodeClassName={(node) =>
              [
                "minimap-node",
                node.type === "ghost" ? "minimap-ghost" : `minimap-kind-${node.type}`,
                node.selected ? "selected" : "",
                touchedNodeIds.has(node.id) ? "agent-touched" : "",
              ]
                .filter(Boolean)
                .join(" ")
            }
          />
        )}
        <MinimapChrome shown={toolbox.minimap} onToggle={() => setToolbox({ minimap: !toolbox.minimap })} />
        <CanvasToolbox
          prefs={toolbox}
          onPrefs={setToolbox}
          linking={linking}
          linkFrom={linkFrom}
          linkFromLabel={linkFrom ? (design.nodes.find((n) => n.id === linkFrom)?.label ?? null) : null}
          linkableTargets={linkableTargets}
          nodeCount={design.nodes.length}
          onToggleLinking={toggleLinking}
        >
          <TopologyTools
            key={`${activeCandidateId ?? "none"}:${topologyFingerprint}`}
            design={design}
            selectedNodeId={selection?.kind === "node" ? selection.id : null}
            exploration={exploration}
            onExplorationChange={setExploration}
            onSelectNode={onSelectNode}
            onReveal={expandToolbox}
          />
        </CanvasToolbox>
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
