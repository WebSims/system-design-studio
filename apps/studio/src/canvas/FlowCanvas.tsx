import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  SelectionMode,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnNodeDrag,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CanvasToolbox, LinkAction, MinimapChrome, useCanvasToolboxPrefs } from "./CanvasToolbox";
import { CanvasObjectNode, canvasFlowId, canvasObjectId } from "./CanvasObjects";
import { CanvasEditingToolbar } from "./CanvasEditingToolbar";
import { useAddPreset } from "../chrome/useAddPreset";
import { applyCanvasSelectionDeltas, CANVAS_PRESET_MIME, type CanvasSelectionDelta } from "./editing";

const edgeTypes = { pipe: PipeEdge };
const allNodeTypes = { ...nodeTypes, canvasObject: CanvasObjectNode };

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
      network: {
        propagationLatency: { kind: "deterministic", value: 0.25 },
      },
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
  const canvasSelection = useStudio((s) => s.canvasSelection);
  const canvasObjects = useStudio((s) => s.canvasObjects);
  const canvasAnnouncement = useStudio((s) => s.canvasAnnouncement);
  const trace = useStudio((s) =>
    s.runStale ? null : (s.session?.trace ?? s.run?.trace ?? null)
  );
  const sessionMode = useStudio((s) => s.sessionMode);
  const injectRequest = useStudio((s) => s.injectRequest);
  const select = useStudio((s) => s.select);
  const selectMany = useStudio((s) => s.selectMany);
  const edit = useStudio((s) => s.edit);
  const editWorkspace = useStudio((s) => s.editWorkspace);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const copySelection = useStudio((s) => s.copySelection);
  const pasteSelection = useStudio((s) => s.pasteSelection);
  const duplicateSelection = useStudio((s) => s.duplicateSelection);
  const deleteSelection = useStudio((s) => s.deleteSelection);
  const nudgeSelection = useStudio((s) => s.nudgeSelection);
  const selectAll = useStudio((s) => s.selectAll);
  const addPreset = useAddPreset();
  const { screenToFlowPosition } = useReactFlow();
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
  const selectedNodeIds = useMemo(() => new Set(canvasSelection.nodeIds), [canvasSelection.nodeIds]);
  const selectedEdgeIds = useMemo(() => new Set(canvasSelection.edgeIds), [canvasSelection.edgeIds]);
  const selectedObjectIds = useMemo(() => new Set(canvasSelection.objectIds), [canvasSelection.objectIds]);
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
          repositoryLinked: study.repositorySnapshots.length > 0,
          performanceCalibrated: !uncalibratedTargets.has(`node:${n.id}`),
          hasPerformanceEvidence:
            evidenceByTarget.get(`node:${n.id}`)?.some((item) => item.aspect === "performance") ?? false,
          evidenceCount: evidenceByTarget.get(`node:${n.id}`)?.length ?? 0,
          evidenceTone: evidenceTone(evidenceByTarget.get(`node:${n.id}`) ?? []),
          noteCount: notesByTarget.get(`node:${n.id}`)?.length ?? 0,
          noteTone: noteTone(notesByTarget.get(`node:${n.id}`) ?? []),
        },
        selected: selectedNodeIds.has(n.id),
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
      selectedNodeIds,
      study.repositorySnapshots.length,
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
        selected: selectedEdgeIds.has(e.id),
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
          repositoryLinked: study.repositorySnapshots.length > 0,
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
      selectedEdgeIds,
      study.repositorySnapshots.length,
      touchedEdgeIds,
      uncalibratedTargets,
    ]
  );

  const objectNodes = useMemo<Node[]>(
    () =>
      [...canvasObjects]
        .sort((first, second) => (first.kind === second.kind ? 0 : first.kind === "frame" ? -1 : 1))
        .map((object) => ({
          id: canvasFlowId(object.id),
          type: "canvasObject",
          position: { x: object.x, y: object.y },
          width: object.width,
          height: object.height,
          style: { width: object.width, height: object.height },
          data: { object },
          selected: selectedObjectIds.has(object.id),
          connectable: false,
          zIndex: object.kind === "frame" ? -10 : 2,
          ariaLabel:
            object.kind === "frame"
              ? `Frame: ${object.title || "Untitled frame"}`
              : `Text note: ${object.text || "Empty note"}`,
          className: `canvas-object-node canvas-${object.kind}-node`,
        })),
    [canvasObjects, selectedObjectIds]
  );
  /**
   * Drag positions stay local until pointer-up, then become one document edit and one
   * undo step. Persisting every pointermove would create dozens of revisions per drag.
   */
  const dragPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const pointerDragActiveRef = useRef(false);
  const [dragPositions, setDragPositions] = useState(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    dragPositionsRef.current = new Map();
    setDragPositions(new Map());
  }, [design.nodes, canvasObjects]);
  const positionedNodes = useMemo(
    () =>
      [...objectNodes, ...nodes].map((node) => ({
        ...node,
        position: dragPositions.get(node.id) ?? node.position,
      })),
    [dragPositions, nodes, objectNodes]
  );
  const allNodes = useMemo(
    () => (ghostNodes.length ? [...positionedNodes, ...ghostNodes] : positionedNodes),
    [ghostNodes, positionedNodes]
  );
  const allEdges = useMemo(() => (ghostEdges.length ? [...edges, ...ghostEdges] : edges), [edges, ghostEdges]);

  const syncSelectionChanges = useCallback((deltas: CanvasSelectionDelta[]) => {
    if (deltas.length === 0) return;
    // Node and edge selection changes are emitted in separate callbacks. Read the live Zustand
    // value so the second callback folds into the first even before React has rendered again.
    const current = useStudio.getState().canvasSelection;
    const next = applyCanvasSelectionDeltas(current, deltas);
    useStudio.getState().selectMany(next.selection, next.primary ?? undefined);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      syncSelectionChanges(
        changes.flatMap((change): CanvasSelectionDelta[] => {
          if (change.type !== "select" || change.id.startsWith("ghost:")) return [];
          const objectId = canvasObjectId(change.id);
          return [{
            group: objectId ? "objectIds" : "nodeIds",
            id: objectId ?? change.id,
            selected: change.selected,
          }];
        })
      );

      const next = new Map(dragPositionsRef.current);
      let changed = false;
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          next.set(change.id, change.position);
          changed = true;
        }
      }
      if (!changed) return;
      if (!pointerDragActiveRef.current) {
        editWorkspace((workspace) => {
          for (const [flowId, position] of next) {
            const objectId = canvasObjectId(flowId);
            if (objectId) {
              const object = workspace.objects.find((item) => item.id === objectId);
              if (object) {
                object.x = Math.round(position.x);
                object.y = Math.round(position.y);
              }
              continue;
            }
            const component = workspace.design.nodes.find((item) => item.id === flowId);
            if (component) {
              component.x = Math.round(position.x);
              component.y = Math.round(position.y);
            }
          }
        }, `Moved ${next.size} element${next.size === 1 ? "" : "s"}.`);
        return;
      }
      dragPositionsRef.current = next;
      setDragPositions(next);
    },
    [editWorkspace, syncSelectionChanges]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      syncSelectionChanges(
        changes.flatMap((change): CanvasSelectionDelta[] =>
          change.type === "select" && !change.id.startsWith("ghost:")
            ? [{ group: "edgeIds", id: change.id, selected: change.selected }]
            : []
        )
      );
    },
    [syncSelectionChanges]
  );

  const onNodeDragStart = useCallback(() => {
    pointerDragActiveRef.current = true;
    dragPositionsRef.current = new Map();
    setDragPositions(new Map());
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_event, node) => {
      const positions = new Map(dragPositionsRef.current);
      positions.set(node.id, node.position);
      editWorkspace((workspace) => {
        for (const [flowId, position] of positions) {
          const objectId = canvasObjectId(flowId);
          if (objectId) {
            const object = workspace.objects.find((item) => item.id === objectId);
            if (object) {
              object.x = Math.round(position.x);
              object.y = Math.round(position.y);
            }
            continue;
          }
          const component = workspace.design.nodes.find((item) => item.id === flowId);
          if (component) {
            component.x = Math.round(position.x);
            component.y = Math.round(position.y);
          }
        }
      }, `Moved ${positions.size} element${positions.size === 1 ? "" : "s"}.`);
      pointerDragActiveRef.current = false;
      dragPositionsRef.current = new Map();
      setDragPositions(new Map());
    },
    [editWorkspace]
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
      if (canvasObjectId(node.id)) return;
      if (!linking) {
        if (lens === "load" && sessionMode === "manual" && node.type === "client") {
          void injectRequest(node.id);
        }
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
    [edit, injectRequest, lens, linkFrom, linking, select, sessionMode]
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

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const nodeIds: string[] = [];
      const objectIds: string[] = [];
      for (const node of selectedNodes) {
        const objectId = canvasObjectId(node.id);
        if (objectId) objectIds.push(objectId);
        else if (node.type !== "ghost") nodeIds.push(node.id);
      }
      const next = {
        nodeIds,
        objectIds,
        edgeIds: selectedEdges
          .filter((edge) => !edge.id.startsWith("ghost:"))
          .map((edge) => edge.id),
      };
      selectMany(next);
    },
    [selectMany]
  );

  const onPaneClick = useCallback(() => {
    select(null);
    setLinkFrom(null);
  }, [select]);
  const onSelectNode = useCallback((id: string) => select({ kind: "node", id }), [select]);

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(CANVAS_PRESET_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const presetId = event.dataTransfer.getData(CANVAS_PRESET_MIME);
      if (!presetId) return;
      event.preventDefault();
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addPreset(presetId, {
        x: point.x - NODE_WIDTH / 2,
        y: point.y - NODE_HEIGHT / 2,
      });
    },
    [addPreset, screenToFlowPosition]
  );

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.matches("input, textarea, select") || target?.isContentEditable === true;
      if (typing) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (command && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (command && key === "c") {
        event.preventDefault();
        copySelection();
        return;
      }
      if (command && key === "v") {
        event.preventDefault();
        pasteSelection();
        return;
      }
      if (command && key === "d") {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if (command && key === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === "Escape") {
        select(null);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      const delta: [number, number] | null =
        event.key === "ArrowLeft"
          ? [-step, 0]
          : event.key === "ArrowRight"
            ? [step, 0]
            : event.key === "ArrowUp"
              ? [0, -step]
              : event.key === "ArrowDown"
                ? [0, step]
                : null;
      if (delta) {
        event.preventDefault();
        // Capture before React Flow's built-in 1/4px key handler so every focus location
        // uses the Studio's documented 1/10px movement contract.
        if (target?.closest(".react-flow__node")) event.stopPropagation();
        nudgeSelection(delta[0], delta[1]);
      }
    };
    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, [copySelection, deleteSelection, duplicateSelection, nudgeSelection, pasteSelection, redo, select, selectAll, undo]);

  const linkableTargets = design.nodes.filter((n) => n.kind !== "client").length;

  return (
    <div
      className={`canvas-wrap ${linking ? "linking" : ""}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={allNodes}
        edges={allEdges}
        nodeTypes={allNodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onSelectionChange={onSelectionChange}
        onPaneClick={onPaneClick}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        elevateNodesOnSelect={false}
        deleteKeyCode={null}
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
        <Controls showInteractive={false} />
        <CanvasEditingToolbar />
        <CanvasToolbox prefs={toolbox} onPrefs={setToolbox} linking={linking}>
          <TopologyTools
            key={`${activeCandidateId ?? "none"}:${topologyFingerprint}`}
            design={design}
            selectedNodeId={selection?.kind === "node" ? selection.id : null}
            exploration={exploration}
            onExplorationChange={setExploration}
            onSelectNode={onSelectNode}
            onReveal={expandToolbox}
            actions={
              <LinkAction
                linking={linking}
                linkFrom={linkFrom}
                linkFromLabel={linkFrom ? (design.nodes.find((n) => n.id === linkFrom)?.label ?? null) : null}
                linkableTargets={linkableTargets}
                nodeCount={design.nodes.length}
                onToggleLinking={toggleLinking}
              />
            }
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
      <p className="sr-only" role="status" aria-live="polite">
        {canvasAnnouncement}
      </p>
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
