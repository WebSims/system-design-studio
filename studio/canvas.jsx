// canvas.jsx — the design surface: pan/zoom, grid, nodes, ports, edges, packet layer.
(function () {
  const { useRef, useState, useEffect, useCallback } = React;
  const Icon = window.Icon;
  const S = window.SDS;

  const nodeHeight = (density) => density === "compact" ? 96 : density === "cozy" ? 112 : 130;

  function guessProtocol(srcType, dstType) {
    if (dstType === "database") return "sql";
    if (dstType === "cache") return "redis";
    if (dstType === "queue") return srcType === "queue" ? "event" : "amqp";
    if (srcType === "queue") return "event";
    if (srcType === "client") return "https";
    if (srcType === "loadbalancer") return "http";
    if (srcType === "cdn") return "https";
    if (dstType === "server" || dstType === "loadbalancer") return "grpc";
    return "http";
  }
  window.guessProtocol = guessProtocol;
  window.nodeHeight = nodeHeight;

  // anchor points in world coords
  function anchors(node, H) {
    const W = S.NODE_W;
    const cy = node.y + H / 2;
    return {
      out: { x: node.x + W, y: cy },
      in: { x: node.x, y: cy },
      cx: node.x + W / 2, cy,
    };
  }
  window.sdsAnchors = anchors;

  function edgePath(a, b, style) {
    const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
    if (style === "straight") return `M ${x1} ${y1} L ${x2} ${y2}`;
    if (style === "orthogonal") {
      const mx = (x1 + x2) / 2;
      const r = 14;
      const dir = y2 > y1 ? 1 : -1;
      if (Math.abs(y2 - y1) < 2 || Math.abs(x2 - x1) < 40) return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
      return `M ${x1} ${y1} L ${mx - r} ${y1} Q ${mx} ${y1} ${mx} ${y1 + r * dir} L ${mx} ${y2 - r * dir} Q ${mx} ${y2} ${mx + r} ${y2} L ${x2} ${y2}`;
    }
    // curved
    const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  window.sdsEdgePath = edgePath;

  // ---- slot layout: distribute a node's in/out pipes so they never share an anchor.
  // node height grows by one pipe-girth per extra input/output.
  function layoutMeta(nodes, edges, density) {
    const base = nodeHeight(density);
    const PW = S.PIPE_W;
    const outs = {}, ins = {}, yOf = {};
    nodes.forEach(n => { outs[n.id] = []; ins[n.id] = []; yOf[n.id] = n.y; });
    edges.forEach(e => { if (outs[e.from]) outs[e.from].push(e); if (ins[e.to]) ins[e.to].push(e); });
    const heightById = {}, outIdx = {}, inIdx = {};
    nodes.forEach(n => {
      const o = outs[n.id], i = ins[n.id];
      o.sort((a, b) => (yOf[a.to] || 0) - (yOf[b.to] || 0));   // order by target y -> tidy fan
      i.sort((a, b) => (yOf[a.from] || 0) - (yOf[b.from] || 0));
      o.forEach((e, k) => { outIdx[e.id] = k; });
      i.forEach((e, k) => { inIdx[e.id] = k; });
      const slots = Math.max(o.length, i.length, 1);
      heightById[n.id] = base + (slots - 1) * PW;
    });
    return { base, PW, heightById, outs, ins, outIdx, inIdx };
  }
  window.sdsLayout = layoutMeta;

  // slot Y (world) for a given index within a count, centred on the node
  function slotY(nodeY, H, idx, count) { return nodeY + H / 2 + (idx - (count - 1) / 2) * S.PIPE_W; }
  window.sdsSlotY = slotY;

  function Canvas(props) {
    const {
      nodes, edges, view, setView, density, lineStyle, accentOf,
      selection, setSelection, onMoveNode, onAddEdge, onContextNode, onContextEdge,
      onDropPalette, pathRefs, packetLayerRef, activeNodes, nodeStates, breakpoints,
      running, onCanvasContext, fsmOpen, viz, occupants,
    } = props;

    const stageRef = useRef(null);
    const meta = layoutMeta(nodes, edges, density);
    const heightOf = (id) => meta.heightById[id] || meta.base;
    const [pending, setPending] = useState(null); // {from, x, y}
    const drag = useRef(null);
    const panning = useRef(null);
    const [isPanning, setIsPanning] = useState(false);

    const toWorld = useCallback((clientX, clientY) => {
      const r = stageRef.current.getBoundingClientRect();
      return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
    }, [view]);

    // ---- wheel zoom / trackpad pan ----
    const onWheel = useCallback((e) => {
      e.preventDefault();
      const r = stageRef.current.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        setView(v => {
          const nk = Math.min(2.2, Math.max(0.25, v.k * factor));
          const px = e.clientX - r.left, py = e.clientY - r.top;
          const wx = (px - v.x) / v.k, wy = (py - v.y) / v.k;
          return { k: nk, x: px - wx * nk, y: py - wy * nk };
        });
      } else {
        setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    }, [setView]);

    useEffect(() => {
      const el = stageRef.current;
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, [onWheel]);

    // ---- global mousemove/up for drags ----
    useEffect(() => {
      const mm = (e) => {
        if (drag.current) {
          const w = toWorld(e.clientX, e.clientY);
          onMoveNode(drag.current.id, w.x - drag.current.dx, w.y - drag.current.dy);
        } else if (pending) {
          const w = toWorld(e.clientX, e.clientY);
          setPending(p => p && ({ ...p, x: w.x, y: w.y }));
        } else if (panning.current) {
          setView(v => ({ ...v, x: panning.current.vx + (e.clientX - panning.current.sx), y: panning.current.vy + (e.clientY - panning.current.sy) }));
        }
      };
      const mu = (e) => {
        if (pending) {
          const tgt = e.target.closest && e.target.closest("[data-node]");
          if (tgt) {
            const id = tgt.getAttribute("data-node");
            if (id && id !== pending.from) onAddEdge(pending.from, id);
          }
          setPending(null);
        }
        drag.current = null;
        if (panning.current) { panning.current = null; setIsPanning(false); }
      };
      window.addEventListener("mousemove", mm);
      window.addEventListener("mouseup", mu);
      return () => { window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    }, [pending, toWorld, onMoveNode, onAddEdge, setView]);

    const onStageDown = (e) => {
      if (e.target === stageRef.current || e.target.classList.contains("viewport") || e.target.tagName === "svg") {
        if (e.button === 0 || e.button === 1) {
          panning.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
          setIsPanning(true);
          setSelection(null);
        }
      }
    };

    const startNodeDrag = (e, node) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const w = toWorld(e.clientX, e.clientY);
      drag.current = { id: node.id, dx: w.x - node.x, dy: w.y - node.y };
      setSelection({ kind: "node", id: node.id });
    };

    const startPort = (e, node) => {
      e.stopPropagation();
      const w = toWorld(e.clientX, e.clientY);
      setPending({ from: node.id, x: w.x, y: w.y });
    };

    // ---- drop from palette ----
    const onDrop = (e) => {
      e.preventDefault();
      const key = e.dataTransfer.getData("text/sds-node");
      if (!key) return;
      const w = toWorld(e.clientX, e.clientY);
      onDropPalette(key, w.x - S.NODE_W / 2, w.y - meta.base / 2);
    };

    const nodeById = {}; nodes.forEach(n => nodeById[n.id] = n);
    const eAnchors = (ed) => {
      const sn = nodeById[ed.from], tn = nodeById[ed.to];
      const sh = heightOf(sn.id), th = heightOf(tn.id);
      const a = { x: sn.x + S.NODE_W, y: slotY(sn.y, sh, meta.outIdx[ed.id] || 0, meta.outs[sn.id].length || 1) };
      const b = { x: tn.x, y: slotY(tn.y, th, meta.inIdx[ed.id] || 0, meta.ins[tn.id].length || 1) };
      return { a, b };
    };

    return React.createElement("div", {
      ref: stageRef,
      className: "stage" + (isPanning ? " panning" : "") + (pending ? " connecting" : ""),
      onMouseDown: onStageDown,
      onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; },
      onDrop,
      onContextMenu: (e) => { if (e.target === stageRef.current || e.target.classList.contains("viewport") || e.target.tagName === "svg") { e.preventDefault(); onCanvasContext(e); } },
      style: { gridColumn: "2/3", gridRow: "2/3",
        backgroundImage: `radial-gradient(var(--grid) 1px, transparent 1px)`,
        backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px` },
    },
      // viewport
      React.createElement("div", { className: "viewport", style: { transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` } },
        // edges
        React.createElement("svg", { className: "edge-layer" },
          edges.map(ed => {
            const sn = nodeById[ed.from], tn = nodeById[ed.to];
            if (!sn || !tn) return null;
            const { a, b } = eAnchors(ed);
            const d = edgePath(a, b, lineStyle);
            const proto = S.PROTOCOLS[ed.protocol] || S.PROTOCOLS.http;
            const sel = selection && selection.kind === "edge" && selection.id === ed.id;
            const hit = { d, fill: "none", stroke: "transparent", className: "edge-hit",
              onClick: (e) => { e.stopPropagation(); setSelection({ kind: "edge", id: ed.id }); },
              onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); onContextEdge(e, ed.id); } };
            if (viz === "identicons") {
              const PW = S.PIPE_W;
              return React.createElement(React.Fragment, { key: ed.id },
                React.createElement("path", { d, fill: "none", stroke: sel ? "var(--red)" : "var(--ln-2)", strokeWidth: PW, strokeLinecap: "round", strokeOpacity: sel ? .55 : .4 }),
                React.createElement("path", { d, fill: "none", stroke: "var(--bg-0)", strokeWidth: PW - 3.5, strokeLinecap: "round" }),
                React.createElement("path", { d, fill: "none", stroke: proto.color, strokeWidth: PW - 3.5, strokeLinecap: "round", strokeOpacity: .1 }),
                React.createElement("path", { d, fill: "none", stroke: sel ? "var(--red)" : "var(--ln-3)", strokeWidth: 1.2, strokeDasharray: "2 8", strokeOpacity: .55,
                  ref: (el) => { if (el) pathRefs.current[ed.id] = el; } }),
                React.createElement("path", Object.assign({}, hit, { strokeWidth: PW })));
            }
            return React.createElement(React.Fragment, { key: ed.id },
              React.createElement("path", { d, fill: "none", stroke: sel ? "var(--red)" : proto.color,
                strokeWidth: sel ? 2.4 : 1.8, strokeOpacity: sel ? 1 : .62,
                strokeDasharray: proto.dash ? "6 6" : "none",
                ref: (el) => { if (el) pathRefs.current[ed.id] = el; },
                markerEnd: "" }),
              // arrowhead
              React.createElement("path", { d: arrowHead(a, b, lineStyle), fill: sel ? "var(--red)" : proto.color, fillOpacity: sel ? 1 : .7 }),
              React.createElement("path", Object.assign({}, hit, { strokeWidth: 16 }))
            );
          }),
          // pending connection
          pending && (() => {
            const sn = nodeById[pending.from]; if (!sn) return null;
            const a = { x: sn.x + S.NODE_W, y: sn.y + 26 };
            return React.createElement("path", { d: edgePath(a, { x: pending.x, y: pending.y }, lineStyle),
              fill: "none", stroke: "var(--red)", strokeWidth: 2, strokeDasharray: "4 5" });
          })()
        ),
        // edge labels
        edges.map(ed => {
          const sn = nodeById[ed.from], tn = nodeById[ed.to];
          if (!sn || !tn) return null;
          const { a, b } = eAnchors(ed);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const proto = S.PROTOCOLS[ed.protocol] || S.PROTOCOLS.http;
          const sel = selection && selection.kind === "edge" && selection.id === ed.id;
          return React.createElement("div", { key: "l" + ed.id, className: "elabel" + (sel ? " sel" : ""),
            style: { left: mx, top: my }, onClick: (e) => { e.stopPropagation(); setSelection({ kind: "edge", id: ed.id }); },
            onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); onContextEdge(e, ed.id); } },
            ed.label || proto.label);
        }),
        // packet layer (managed by engine via direct DOM)
        React.createElement("svg", { className: "packet-layer", ref: packetLayerRef }),
        // nodes
        nodes.map(n => {
          const nh = heightOf(n.id);
          const oc = meta.outs[n.id].length, ic = meta.ins[n.id].length;
          const outYs = oc ? meta.outs[n.id].map((e, k) => slotY(0, nh, k, oc)) : [nh / 2];
          const inYs = ic ? meta.ins[n.id].map((e, k) => slotY(0, nh, k, ic)) : [];
          return React.createElement(NodeView, {
            key: n.id, node: n, H: nh, density, accent: accentOf(n), outYs, inYs, occupants: occupants ? occupants[n.id] : null,
            selected: selection && selection.kind === "node" && selection.id === n.id,
            active: activeNodes[n.id], stateId: nodeStates[n.id], bp: breakpoints[n.id], running,
          onDown: startNodeDrag, onPort: startPort, onContext: onContextNode,
        });
        })
      ),
      // empty hint
      nodes.length === 0 && React.createElement("div", { className: "empty-hint" },
        React.createElement("div", { className: "box" },
          React.createElement(Icon, { name: "cursor", size: 30, color: "var(--fg-4)" }),
          React.createElement("div", { className: "e1" }, "drag a component from the left"),
          React.createElement("div", { className: "e2" }, "then connect ports and run a simulation"))),
    );
  }

  function arrowHead(a, b, style) {
    // direction at endpoint
    let dx, dy;
    if (style === "orthogonal") { dx = 1; dy = 0; }
    else { dx = b.x - a.x; dy = b.y - a.y; }
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const tip = { x: b.x, y: b.y };
    const back = { x: b.x - dx * 9, y: b.y - dy * 9 };
    const nx = -dy, ny = dx, w = 4.2;
    return `M ${tip.x} ${tip.y} L ${back.x + nx * w} ${back.y + ny * w} L ${back.x - nx * w} ${back.y - ny * w} Z`;
  }

  function NodeView({ node, H, density, accent, selected, active, stateId, bp, running, onDown, onPort, onContext, outYs, inYs, occupants }) {
    const Icon = window.Icon;
    const S = window.SDS;
    const st = node.fsm.states.find(s => s.id === (stateId || node.fsm.current)) || node.fsm.states[0];
    const toneVar = `var(--tone-${st ? st.tone : "idle"})`;
    const cls = "node " + density + (selected ? " sel" : "") + (active ? " active" : "");
    const occ = occupants || [];
    return React.createElement("div", {
      className: cls, "data-node": node.id,
      style: { left: node.x, top: node.y, height: H, "--accent": accent, "--act": toneVar },
      onMouseDown: (e) => onDown(e, node),
      onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); onContext(e, node.id); },
    },
      bp && React.createElement("div", { className: "bp-badge", title: "breakpoint" }),
      React.createElement("div", { className: "node-bar" }),
      React.createElement("div", { className: "node-head" },
        React.createElement("div", { className: "node-ic", style: { background: accent } },
          React.createElement(Icon, { name: node.icon, size: density === "compact" ? 15 : 18, color: "#fff", stroke: 2 })),
        React.createElement("div", { className: "node-tx" },
          React.createElement("div", { className: "nl" }, node.label),
          running && React.createElement("div", { className: "nm" },
            React.createElement("span", { className: "node-state-dot", style: { background: toneVar } }),
            st ? st.name : node.type)),
        running
          ? (node.type === "queue"
              ? React.createElement("span", { className: "node-stat" }, "q ", React.createElement("span", { className: "tnum" }, node.stat.depth))
              : React.createElement("span", { className: "node-stat" }, React.createElement("span", { className: "tnum" }, node.stat.processed)))
          : (node.engine
              ? React.createElement("span", { className: "node-stat", style: { textTransform: "none", color: "var(--fg-3)", fontWeight: 600 } }, node.engine)
              : null)),
      React.createElement("div", { className: "node-counters" },
        occ.length
          ? occ.map(o => React.createElement("div", { className: "counter" + (o.error ? " err" : "") + (o.ghost ? " ghost" : "") + (o.departing ? " departing" : ""), key: o.uid, "data-uid": o.uid },
              React.createElement("img", { className: "counter-ico", src: window.Identicon.url(o.icon, 30), alt: "" }),
              (o.ghosts && o.ghosts.length)
                ? React.createElement("div", { className: "counter-ghosts" },
                    o.ghosts.map(g => React.createElement("img", { className: "counter-ghost-ico", key: g.uid, "data-uid": g.uid, src: window.Identicon.url(g.icon, 30), alt: "" })))
                : null,
              React.createElement("span", { className: "counter-lane" })))
          : React.createElement("div", { className: "counter-idle" }, running ? "awaiting requests" : "counters")),
      // single output handle, centred on the header (drag it to draw a connection) — build mode only
      !running && React.createElement("div", { className: "port out", style: { left: S.NODE_W, top: 26 }, title: "drag to connect",
        onMouseDown: (e) => onPort(e, node) }),
    );
  }

  window.Canvas = Canvas;
})();
