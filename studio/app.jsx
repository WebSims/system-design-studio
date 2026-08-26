// app.jsx — System Design Studio root. Wires canvas + panels + fsm + engine + tweaks.
(function () {
  const { useState, useRef, useEffect, useCallback } = React;
  const Icon = window.Icon;
  const S = window.SDS;

  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "viz": "identicons",
    "density": "full",
    "lineStyle": "curved",
    "simSpeed": 0.25,
    "load": 1,
    "errorRate": 2,
    "loss": 2,
    "accent": "default"
  }/*EDITMODE-END*/;

  // accent palette overrides (else per-type colors from design system)
  const ACCENT_SETS = {
    default: null,
    red:   "#ed2923",
    blue:  "#1f6fb4",
    mono:  "#8d8678",
  };

  const LS_KEY = "sds.graph.v4";
  function loadGraph() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const g = JSON.parse(raw);
        if (g && Array.isArray(g.nodes) && g.nodes.length && Array.isArray(g.edges)) return g;
      }
    } catch (e) {}
    return S.seed();
  }
  function saveGraph(nodes, edges) {
    try {
      const clean = nodes.map(n => { const c = Object.assign({}, n); delete c.stat; return c; });
      localStorage.setItem(LS_KEY, JSON.stringify({ nodes: clean, edges }));
    } catch (e) {}
  }
  function clearGraph() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

  function App() {
    const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
    const seeded = useRef(loadGraph());
    const [nodes, setNodes] = useState(seeded.current.nodes);
    const [edges, setEdges] = useState(seeded.current.edges);
    const [view, setView] = useState({ x: 60, y: 30, k: 0.82 });
    const [selection, setSelection] = useState(null);
    const [running, setRunning] = useState(false);
    const [paused, setPaused] = useState(false);
    const [breakpoints, setBreakpoints] = useState({});
    const [liveStates, setLiveStates] = useState({});
    const [active, setActive] = useState({});
    const [depthMap, setDepthMap] = useState({});
    const [procMap, setProcMap] = useState({});
    const [resourceMap, setResourceMap] = useState({});
    const [stats, setStats] = useState({ rps: 0, latency: 0, inflight: 0, errRate: 0, packets: 0 });
    const [log, setLog] = useState([]);
    const [occByNode, setOccByNode] = useState({});
    const [fsmOpen, setFsmOpen] = useState(null);   // nodeId
    const [menu, setMenu] = useState(null);
    const [toast, setToast] = useState(null);
    const [leftTab, setLeftTab] = useState("build");
    const [runSources, setRunSources] = useState({});   // id -> false to disable; default all on
    const [emitOn, setEmitOn] = useState(true);
    const [burstCount, setBurstCount] = useState(6);

    const pathRefs = useRef({});
    const packetLayerRef = useRef(null);
    const nodesRef = useRef(nodes); nodesRef.current = nodes;
    const edgesRef = useRef(edges); edgesRef.current = edges;
    const bpRef = useRef(breakpoints); bpRef.current = breakpoints;
    const tRef = useRef(t); tRef.current = t;
    const emitRef = useRef(emitOn); emitRef.current = emitOn;
    const engineRef = useRef(null);

    const clientNodes = nodes.filter(n => n.type === "client");
    const activeSourceIds = clientNodes.filter(n => runSources[n.id] !== false).map(n => n.id);
    const srcRef = useRef(activeSourceIds); srcRef.current = (activeSourceIds.length === clientNodes.length) ? [] : activeSourceIds;

    const flash = (msg) => { setToast(msg); clearTimeout(flash._t); flash._t = setTimeout(() => setToast(null), 1600); };

    // ---- engine ----
    useEffect(() => {
      engineRef.current = new window.SimEngine({
        getGraph: () => ({ nodes: nodesRef.current, edges: edgesRef.current }),
        getSpeed: () => tRef.current.simSpeed,
        getLoad: () => tRef.current.load,
        getErrorRate: () => tRef.current.errorRate / 100,
        getLoss: () => tRef.current.loss,
        getViz: () => tRef.current.viz,
        getDensity: () => tRef.current.density,
        getBreakpoints: () => bpRef.current,
        getSources: () => srcRef.current,
        getEmit: () => emitRef.current,
        pathRefs, packetLayerRef,
        onStats: (s) => setStats(s),
        onState: (st, dp, pr, res, occ) => { setLiveStates(st); setDepthMap(dp); setProcMap(pr); setResourceMap(res || {}); setOccByNode(occ || {}); },
        onActive: (a) => setActive(a),
        onLog: (l) => setLog(prev => [...prev.slice(-120), l]),
        onBreak: (id) => { setPaused(true); const n = nodesRef.current.find(x => x.id === id); flash("breakpoint · " + (n ? n.label : id)); },
      });
      window.__eng = engineRef.current;
      window.__setView = setView;
      return () => { if (engineRef.current) engineRef.current.stop(); };
    }, []);

    // persist graph (positions, wiring, edits) to localStorage, debounced
    useEffect(() => {
      const id = setTimeout(() => saveGraph(nodes, edges), 350);
      return () => clearTimeout(id);
    }, [nodes, edges]);

    const accentOf = useCallback((n) => {
      const set = ACCENT_SETS[t.accent];
      return set || S.ACCENT[n.type] || "#888";
    }, [t.accent]);

    // ---- node display merge (live stats) ----
    const displayNodes = nodes.map(n => ({ ...n, stat: {
      processed: procMap[n.id] || 0, depth: depthMap[n.id] || 0,
      stock: resourceMap[n.id] != null ? resourceMap[n.id] : (n.resource && n.resource.kind === "stock" ? n.resource.stock : null),
    } }));

    // ---- run controls ----
    const doRun = () => { setRunning(true); setPaused(false); setLeftTab("run"); engineRef.current.start(); };
    const doStop = () => { engineRef.current.stop(); setRunning(false); setPaused(false); setLiveStates({}); setActive({}); setProcMap({}); setDepthMap({}); setResourceMap({}); setOccByNode({}); setStats({ rps: 0, latency: 0, inflight: 0, errRate: 0, packets: 0 }); };
    const doPause = () => { if (paused) { engineRef.current.resume(); setPaused(false); } else { engineRef.current.pause(); setPaused(true); } };
    const doStep = () => { engineRef.current.step(); setPaused(true); };
    const doBurst = (n) => {
      setLeftTab("run");
      if (!running) { setRunning(true); setPaused(false); engineRef.current.start(); setTimeout(() => engineRef.current.burst(n, srcRef.current), 60); }
      else engineRef.current.burst(n, srcRef.current);
    };
    const toggleSource = (id) => setRunSources(s => ({ ...s, [id]: s[id] === false }));

    // ---- graph mutations ----
    const moveNode = useCallback((id, x, y) => setNodes(ns => ns.map(n => n.id === id ? { ...n, x: Math.round(x), y: Math.round(y) } : n)), []);
    const addEdge = useCallback((from, to) => {
      setEdges(es => {
        if (es.some(e => e.from === from && e.to === to)) return es;
        const sn = nodesRef.current.find(n => n.id === from), tn = nodesRef.current.find(n => n.id === to);
        if (!sn || !tn) return es;
        if (tn.type === "client") { flash("clients only send requests — they take no input"); return es; }
        const proto = S.protocolFor(sn, tn);
        const ne = S.makeEdge(from, to, proto);
        setSelection({ kind: "edge", id: ne.id });
        return [...es, ne];
      });
    }, []);
    const dropPalette = useCallback((key, x, y) => {
      const n = S.makeNode(key, Math.round(x), Math.round(y));
      setNodes(ns => [...ns, n]); setSelection({ kind: "node", id: n.id });
    }, []);
    const deleteSel = useCallback(() => {
      if (!selection) return;
      if (selection.kind === "node") {
        setNodes(ns => ns.filter(n => n.id !== selection.id));
        setEdges(es => es.filter(e => e.from !== selection.id && e.to !== selection.id));
        setBreakpoints(b => { const c = { ...b }; delete c[selection.id]; return c; });
        if (fsmOpen === selection.id) setFsmOpen(null);
      } else setEdges(es => es.filter(e => e.id !== selection.id));
      setSelection(null);
    }, [selection, fsmOpen]);
    const dupNode = (id) => { const n = nodesRef.current.find(x => x.id === id); if (!n) return;
      const c = S.makeNode(n.paletteKey, n.x + 36, n.y + 36, n.label); c.fsm = JSON.parse(JSON.stringify(n.fsm));
      setNodes(ns => [...ns, c]); setSelection({ kind: "node", id: c.id }); };
    const setLabel = (id, v) => setNodes(ns => ns.map(n => n.id === id ? { ...n, label: v } : n));
    const setProtocol = (id, v) => setEdges(es => es.map(e => e.id === id ? { ...e, protocol: v } : e));
    const setEngine = (id, v) => setNodes(ns => ns.map(n => n.id === id ? { ...n, engine: v } : n));
    const setEdgeLabel = (id, v) => setEdges(es => es.map(e => e.id === id ? { ...e, label: v } : e));
    const toggleBp = (id) => setBreakpoints(b => ({ ...b, [id]: !b[id] }));
    const addMethod = (id) => setNodes(ns => ns.map(n => n.id === id ? { ...n, methods: [...n.methods, "method" + (n.methods.length + 1)] } : n));
    const updateFsm = useCallback((id, fsm) => setNodes(ns => ns.map(n => n.id === id ? { ...n, fsm } : n)), []);

    // ---- view helpers ----
    const stageSize = () => ({ w: window.innerWidth - 236 - 312, h: window.innerHeight - 52 - (fsmOpen ? 271 : 0) });
    const fitView = () => {
      if (!nodes.length) return;
      const W = S.NODE_W;
      const meta = window.sdsLayout(nodes, edges, t.density);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(n => { const H = meta.heightById[n.id] || meta.base; minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + W); maxY = Math.max(maxY, n.y + H); });
      const { w, h } = stageSize(); const pad = 52;
      const k = Math.min(1.4, Math.max(0.3, Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY))));
      setView({ k, x: pad - minX * k + (w - pad * 2 - (maxX - minX) * k) / 2, y: pad - minY * k + (h - pad * 2 - (maxY - minY) * k) / 2 });
    };
    useEffect(() => { const id = setTimeout(fitView, 60); return () => clearTimeout(id); }, []);

    // ---- context menus ----
    const nodeMenu = (e, id) => { setSelection({ kind: "node", id }); setMenu({ x: e.clientX, y: e.clientY, items: [
      { icon: "flow", label: "edit state machine", fn: () => setFsmOpen(id) },
      { icon: breakpoints[id] ? "dot" : "target", label: breakpoints[id] ? "clear breakpoint" : "set breakpoint", fn: () => toggleBp(id) },
      { icon: "save", label: "duplicate", kb: "⌘D", fn: () => dupNode(id) },
      { sep: true },
      { icon: "trash", label: "delete", kb: "⌫", danger: true, fn: () => { setSelection({ kind: "node", id }); setTimeout(() => { setNodes(ns => ns.filter(n => n.id !== id)); setEdges(es => es.filter(x => x.from !== id && x.to !== id)); setSelection(null); }, 0); } },
    ] }); };
    const edgeMenu = (e, id) => { setSelection({ kind: "edge", id }); setMenu({ x: e.clientX, y: e.clientY, items: [
      { icon: "trash", label: "delete connection", danger: true, fn: () => { setEdges(es => es.filter(x => x.id !== id)); setSelection(null); } },
    ] }); };
    const canvasMenu = (e) => { setMenu({ x: e.clientX, y: e.clientY, items: [
      { icon: "target", label: "fit to view", fn: fitView },
      { icon: "grid", label: "reset zoom", fn: () => setView({ x: 60, y: 30, k: 0.82 }) },
      { sep: true },
      { icon: "save", label: "load example system", fn: () => { clearGraph(); const s = S.seed(); setNodes(s.nodes); setEdges(s.edges); setSelection(null); flash("example loaded"); } },
      { icon: "trash", label: "clear canvas", danger: true, fn: () => { if (running) doStop(); clearGraph(); setNodes([]); setEdges([]); setSelection(null); } },
    ] }); };

    // ---- keyboard ----
    useEffect(() => {
      const kd = (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSel(); }
        else if (e.key === "Escape") { setMenu(null); if (fsmOpen) setFsmOpen(null); else setSelection(null); }
        else if ((e.metaKey || e.ctrlKey) && e.key === "d" && selection && selection.kind === "node") { e.preventDefault(); dupNode(selection.id); }
        else if (e.key === " ") { e.preventDefault(); running ? doPause() : doRun(); }
      };
      window.addEventListener("keydown", kd);
      return () => window.removeEventListener("keydown", kd);
    }, [deleteSel, selection, fsmOpen, running, paused]);

    const fsmNode = fsmOpen ? nodes.find(n => n.id === fsmOpen) : null;
    const bottomInset = fsmNode ? 271 : 0;

    return React.createElement("div", { className: "shell" },
      // ---------- topbar ----------
      React.createElement("div", { className: "topbar" },
        React.createElement("div", { className: "brand" },
          React.createElement("div", { className: "mark" },
            React.createElement(Icon, { name: "flow", size: 16, color: "#fff", stroke: 2.4 })),
          React.createElement("div", null,
            React.createElement("div", { className: "name lc" }, "system design ", React.createElement("b", null, "studio")),
            React.createElement("div", { className: "sub lc" }, "distributed-systems sandbox"))),
        React.createElement("div", { className: "tb-group" },
          running
            ? React.createElement("button", { className: "run stop", onClick: doStop }, React.createElement(Icon, { name: "stop", size: 15 }), "stop")
            : React.createElement("button", { className: "run", onClick: doRun }, React.createElement(Icon, { name: "play", size: 15, fill: "#fff", color: "#fff" }), "run simulation"),
          React.createElement("button", { className: "tool icon", onClick: doPause, disabled: !running, title: paused ? "resume" : "pause" },
            React.createElement(Icon, { name: paused ? "play" : "pause", size: 17 })),
          React.createElement("button", { className: "tool icon", onClick: doStep, disabled: !running, title: "step" },
            React.createElement(Icon, { name: "step", size: 17 }))),
        React.createElement("div", { className: "tb-sep" }),
        React.createElement("div", { className: "tb-group" },
          React.createElement("span", { style: { fontSize: 12, color: "var(--fg-3)" } }, nodes.length, " nodes · ", edges.length, " links"),
          Object.values(breakpoints).filter(Boolean).length > 0 && React.createElement("span", { className: "tag", style: { marginLeft: 6 } },
            React.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", background: "var(--red)" } }),
            Object.values(breakpoints).filter(Boolean).length, " bp")),
        React.createElement("div", { className: "tb-spacer" }),
        React.createElement("div", { className: "tb-group" },
          React.createElement("button", { className: "tool", onClick: () => window.postMessage({ type: "__activate_edit_mode" }, "*") }, React.createElement(Icon, { name: "settings", size: 16 }), "tweaks"),
          React.createElement("button", { className: "tool icon", onClick: fitView, title: "fit to view" }, React.createElement(Icon, { name: "target", size: 17 })),
          React.createElement("button", { className: "tool icon", onClick: () => setView({ x: 60, y: 30, k: 0.82 }), title: "reset zoom" }, React.createElement(Icon, { name: "grid", size: 17 })))),

      // ---------- left rail ----------
      React.createElement(window.LeftRail, { tab: leftTab, setTab: setLeftTab, accentOf,
        runProps: { clients: clientNodes, running, emitOn, setEmitOn, sources: runSources, toggleSource,
          onBurst: doBurst, burstCount, setBurstCount,
          load: t.load, setLoad: (v) => setTweak("load", v), fault: t.errorRate, setFault: (v) => setTweak("errorRate", v),
          loss: t.loss, setLoss: (v) => setTweak("loss", v),
          log, stats } }),

      // ---------- canvas ----------
      React.createElement(window.Canvas, {
        nodes: displayNodes, edges, view, setView, density: t.density, lineStyle: t.lineStyle, accentOf,
        selection, setSelection, onMoveNode: moveNode, onAddEdge: addEdge,
        onContextNode: nodeMenu, onContextEdge: edgeMenu, onCanvasContext: canvasMenu,
        onDropPalette: dropPalette, pathRefs, packetLayerRef,
        activeNodes: active, nodeStates: liveStates, breakpoints, running, fsmOpen, viz: t.viz, occupants: occByNode,
      }),

      // ---------- right rail ----------
      React.createElement(window.Inspector, {
        selection, nodes: displayNodes, edges, accentOf, onLabel: setLabel, onProtocol: setProtocol, onEdgeLabel: setEdgeLabel, onEngine: setEngine,
        onDelete: deleteSel, onToggleBp: toggleBp, breakpoints, onEditFsm: (id) => setFsmOpen(id),
        onAddMethod: addMethod, fsmOpenFor: fsmOpen, running, nodeStates: liveStates,
      }),

      // ---------- overlays in canvas area ----------
      React.createElement(CanvasOverlays, { running, paused, view, setView, bottomInset }),

      // ---------- bottom dock: fsm editor ----------
      fsmNode && React.createElement(window.FsmDock, { node: fsmNode, liveState: running ? liveStates[fsmNode.id] : null, onUpdate: updateFsm, onClose: () => setFsmOpen(null) }),

      // ---------- menus / toast ----------
      React.createElement(window.ContextMenu, { menu, onClose: () => setMenu(null) }),
      toast && React.createElement("div", { className: "toast" }, toast),

      // ---------- tweaks ----------
      React.createElement(window.TweaksPanel, null,
        React.createElement(window.TweakSection, { label: "canvas" }),
        React.createElement(window.TweakRadio, { label: "connections", value: t.lineStyle, options: ["orthogonal", "curved", "straight"], onChange: (v) => setTweak("lineStyle", v) }),
        React.createElement(window.TweakSection, { label: "simulation" }),
        React.createElement(window.TweakSlider, { label: "speed", value: t.simSpeed, min: 0.25, max: 3, step: 0.25, unit: "×", onChange: (v) => setTweak("simSpeed", v) }),
        React.createElement(window.TweakSlider, { label: "load", value: t.load, min: 0.4, max: 6, step: 0.2, unit: " req/s", onChange: (v) => setTweak("load", v) }),
        React.createElement(window.TweakSlider, { label: "fault rate", value: t.errorRate, min: 0, max: 25, step: 1, unit: "%", onChange: (v) => setTweak("errorRate", v) }))
    );
  }

  function CanvasOverlays({ running, paused, view, setView, bottomInset }) {
    return React.createElement(React.Fragment, null,
      // these are absolutely positioned within .stage's grid cell; render into a fixed overlay aligned to canvas
      React.createElement("div", { style: { position: "fixed", left: 236, right: 312, top: 52, bottom: bottomInset || 0, pointerEvents: "none", zIndex: 12 } },
        React.createElement("div", { style: { position: "absolute", inset: 0 } },
          // paused banner
          (running && paused) && React.createElement("div", { className: "paused-banner", style: { pointerEvents: "auto" } },
            React.createElement(Icon, { name: "pause", size: 13, color: "#14110d" }), "paused"),
          // zoom
          React.createElement("div", { className: "zoomctl", style: { pointerEvents: "auto" } },
            React.createElement("button", { onClick: () => setView(v => ({ ...v, k: Math.min(2.2, v.k * 1.2) })) }, "+"),
            React.createElement("div", { className: "zv" }, Math.round(view.k * 100), "%"),
            React.createElement("button", { onClick: () => setView(v => ({ ...v, k: Math.max(0.25, v.k / 1.2) })) }, "–")))));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
})();
