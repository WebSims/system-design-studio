import { useReactFlow, type Node } from "@xyflow/react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Design } from "@sds/schema";
import {
  authoredReachability,
  reachableDestinations,
  shortestDirectedRoute,
  type DirectedRoute,
  type ReachDirection,
  type ReachabilityResult,
} from "../topology";

export type TopologyExploration =
  | { kind: "reach"; result: ReachabilityResult }
  | { kind: "route"; result: DirectedRoute }
  | null;

interface TopologyToolsProps {
  design: Design;
  selectedNodeId: string | null;
  exploration: TopologyExploration;
  onExplorationChange(exploration: TopologyExploration): void;
  onSelectNode(id: string): void;
  /** Called before the `/` hotkey focuses the search, so a collapsed host can open first. */
  onReveal?(): void;
  /** Extra actions that sit at the end of the first row, after Downstream (the host's Link). */
  actions?: ReactNode;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.25" />
      <path d="m12.4 12.4 4.1 4.1" />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="4" cy="5" r="1.75" />
      <circle cx="16" cy="15" r="1.75" />
      <path d="M5.75 5h4.5a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2" />
    </svg>
  );
}

/**
 * Find, Route, Upstream, Downstream: the rows of the topology tools, without a surface of their own.
 * The canvas toolbox hosts them, with its Link action at the end of the first row.
 */
export function TopologyTools({
  design,
  selectedNodeId,
  exploration,
  onExplorationChange,
  onSelectNode,
  onReveal,
  actions,
}: TopologyToolsProps) {
  const { fitView, getNode } = useReactFlow();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searchMessage, setSearchMessage] = useState("");
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeSource, setRouteSource] = useState("");
  const [routeTarget, setRouteTarget] = useState("");

  const labels = useMemo(
    () => new Map(design.nodes.map((node) => [node.id, node.label])),
    [design.nodes]
  );
  const selectedNode = selectedNodeId
    ? design.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const upstream = selectedNode
    ? authoredReachability(design, selectedNode.id, "upstream")
    : null;
  const downstream = selectedNode
    ? authoredReachability(design, selectedNode.id, "downstream")
    : null;
  const upstreamCount = Math.max(0, (upstream?.nodeIds.length ?? 1) - 1);
  const downstreamCount = Math.max(0, (downstream?.nodeIds.length ?? 1) - 1);

  const routeSources = useMemo(() => {
    const from = new Set(design.edges.map((edge) => edge.from));
    return design.nodes.filter((node) => from.has(node.id));
  }, [design.edges, design.nodes]);
  const routeDestinations = useMemo(
    () => (routeSource ? reachableDestinations(design, routeSource) : []),
    [design, routeSource]
  );

  const reveal = useCallback(
    (ids: string[]) => {
      const nodes = ids.map((id) => getNode(id)).filter((node): node is Node => node !== undefined);
      if (nodes.length === 0) return;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      void fitView({
        nodes,
        padding: ids.length === 1 ? 0.9 : 0.42,
        minZoom: 0.35,
        maxZoom: ids.length === 1 ? 1.15 : 1,
        duration: reduceMotion ? 0 : 280,
      });
    },
    [fitView, getNode]
  );

  const findNode = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const wanted = query.trim().toLocaleLowerCase();
      if (!wanted) {
        searchRef.current?.focus();
        return;
      }
      const exact = design.nodes.find(
        (node) => node.id.toLocaleLowerCase() === wanted || node.label.toLocaleLowerCase() === wanted
      );
      const partial = design.nodes.find((node) =>
        `${node.label} ${node.id} ${node.kind}`.toLocaleLowerCase().includes(wanted)
      );
      const match = exact ?? partial;
      if (!match) {
        setSearchMessage(`No component matches “${query.trim()}”.`);
        return;
      }
      setSearchMessage(`Focused ${match.label}.`);
      onSelectNode(match.id);
      reveal([match.id]);
    },
    [design.nodes, onSelectNode, query, reveal]
  );

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.matches("input, textarea, select") || target?.getAttribute("contenteditable") === "true";
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        onReveal?.();
        // The host may have been collapsed; the input exists once it has re-rendered.
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [onReveal]);

  const showReach = (direction: ReachDirection) => {
    if (!selectedNode) return;
    const result = authoredReachability(design, selectedNode.id, direction);
    if (!result || result.nodeIds.length < 2) return;
    setRouteOpen(false);
    setRouteSource("");
    setRouteTarget("");
    onExplorationChange({ kind: "reach", result });
    reveal(result.nodeIds);
  };

  const openRoute = () => {
    const closing = routeOpen;
    setRouteOpen(!closing);
    if (closing) {
      setRouteSource("");
      setRouteTarget("");
      if (exploration?.kind === "route") onExplorationChange(null);
      return;
    }
    const selectedCanStart = selectedNode && routeSources.some((node) => node.id === selectedNode.id);
    setRouteSource(selectedCanStart ? selectedNode.id : "");
    setRouteTarget("");
    onExplorationChange(null);
  };

  const chooseRouteTarget = (targetId: string) => {
    setRouteTarget(targetId);
    const result = shortestDirectedRoute(design, routeSource, targetId);
    if (!result) {
      onExplorationChange(null);
      return;
    }
    onExplorationChange({ kind: "route", result });
    reveal(result.nodeIds);
  };

  const clear = () => {
    setSearchMessage("");
    setRouteOpen(false);
    setRouteSource("");
    setRouteTarget("");
    onExplorationChange(null);
    reveal(design.nodes.map((node) => node.id));
  };

  const receipt = exploration?.result;

  return (
      <div className="topology-explorer" aria-label="Topology explorer">
        <div className="topology-tools-row">
          <form className="topology-search" role="search" onSubmit={findNode}>
            <SearchIcon />
            <input
              ref={searchRef}
              className="nodrag nowheel nopan"
              type="search"
              list="topology-node-options"
              value={query}
              placeholder="Find component  /"
              aria-label="Find a component by label or stable ID"
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchMessage("");
              }}
            />
            <datalist id="topology-node-options">
              {design.nodes.map((node) => (
                <option key={node.id} value={node.label}>{`${node.kind} · ${node.id}`}</option>
              ))}
            </datalist>
            <button className="topology-go nodrag nopan" type="submit">
              Find
            </button>
          </form>

          <span className="topology-divider" aria-hidden="true" />

          <button
            className={`topology-action nodrag nopan ${routeOpen ? "active" : ""}`}
            type="button"
            aria-expanded={routeOpen}
            onClick={openRoute}
          >
            <RouteIcon />
            Route
          </button>

          <button
            className={`topology-action nodrag nopan ${
              exploration?.kind === "reach" && exploration.result.direction === "upstream" ? "active" : ""
            }`}
            type="button"
            disabled={upstreamCount === 0}
            aria-pressed={exploration?.kind === "reach" && exploration.result.direction === "upstream"}
            title={selectedNode ? `Trace authored inputs to ${selectedNode.label}` : "Select a component first"}
            onClick={() => showReach("upstream")}
          >
            Upstream <span className="topology-count tnum">{upstreamCount}</span>
          </button>

          <button
            className={`topology-action nodrag nopan ${
              exploration?.kind === "reach" && exploration.result.direction === "downstream" ? "active" : ""
            }`}
            type="button"
            disabled={downstreamCount === 0}
            aria-pressed={exploration?.kind === "reach" && exploration.result.direction === "downstream"}
            title={selectedNode ? `Trace authored outputs from ${selectedNode.label}` : "Select a component first"}
            onClick={() => showReach("downstream")}
          >
            Downstream <span className="topology-count tnum">{downstreamCount}</span>
          </button>

          {actions && (
            <>
              <span className="topology-divider" aria-hidden="true" />
              {actions}
            </>
          )}

          {(exploration || routeOpen) && (
            <button className="topology-clear nodrag nopan" type="button" onClick={clear}>
              Clear
            </button>
          )}
        </div>

        {routeOpen && (
          <div className="topology-route-row">
            <label>
              <span>From</span>
              <select
                className="nodrag nowheel nopan"
                aria-label="Route start"
                value={routeSource}
                onChange={(event) => {
                  const sourceId = event.target.value;
                  setRouteSource(sourceId);
                  setRouteTarget("");
                  onExplorationChange(null);
                  if (sourceId) {
                    onSelectNode(sourceId);
                    reveal([sourceId]);
                  }
                }}
              >
                <option value="">Choose component</option>
                {routeSources.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
            </label>

            <span className="topology-route-arrow" aria-hidden="true">
              →
            </span>

            <label>
              <span>To</span>
              <select
                className="nodrag nowheel nopan"
                aria-label="Route destination"
                value={routeTarget}
                disabled={!routeSource || routeDestinations.length === 0}
                onChange={(event) => chooseRouteTarget(event.target.value)}
              >
                <option value="">
                  {!routeSource
                    ? "Choose start first"
                    : routeDestinations.length === 0
                      ? "No reachable components"
                      : "Choose destination"}
                </option>
                {routeDestinations.map(({ id, hops }) => (
                  <option key={id} value={id}>
                    {labels.get(id) ?? id} · {hops} {hops === 1 ? "hop" : "hops"}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {(searchMessage || receipt) && (
          <div
            className={`topology-receipt ${
              exploration?.kind === "route" ? "topology-route-receipt" : ""
            }`}
            role="status"
            aria-live="polite"
          >
            {exploration?.kind === "route" ? (
              <>
                <div className="topology-path">
                  {exploration.result.nodeIds.map((id, index) => (
                    <span key={id}>
                      {index > 0 && <b aria-hidden="true">→</b>}
                      <span>{labels.get(id) ?? id}</span>
                    </span>
                  ))}
                </div>
                <p>
                  Shortest authored route · {exploration.result.hops}{" "}
                  {exploration.result.hops === 1 ? "hop" : "hops"}
                </p>
              </>
            ) : exploration?.kind === "reach" ? (
              <p>
                {exploration.result.nodeIds.length - 1} {exploration.result.direction} components ·{" "}
                {exploration.result.edgeIds.length} authored links · {exploration.result.maxDepth} max hops
              </p>
            ) : (
              <p>{searchMessage}</p>
            )}
            {receipt && <small>Topology only; runtime impact is not inferred.</small>}
          </div>
        )}
      </div>
  );
}
