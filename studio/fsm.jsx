// fsm.jsx — bottom dock: visual finite-state-machine editor. -> window.FsmDock
(function () {
  const { useRef, useState, useEffect } = React;
  const Icon = window.Icon;
  const TONES = ["idle", "busy", "ok", "warn", "error"];

  function ensurePositions(fsm, w, h) {
    const need = fsm.states.some(s => s.sx == null);
    if (!need) return fsm;
    const n = fsm.states.length;
    const states = fsm.states.map((s, i) => ({ ...s,
      sx: s.sx != null ? s.sx : 130 + i * Math.min(220, (w - 260) / Math.max(1, n - 1 || 1)),
      sy: s.sy != null ? s.sy : (i % 2 === 0 ? h * 0.4 : h * 0.66) }));
    return { ...fsm, states };
  }

  function FsmDock(props) {
    const { node, liveState, onUpdate, onClose } = props;
    const bodyRef = useRef(null);
    const [sel, setSel] = useState(null);  // {kind:'state'|'trans', id}
    const drag = useRef(null);
    const [, force] = useState(0);

    const fsm = node.fsm;
    const W = 1100, Hh = 230;

    useEffect(() => {
      // lazy-init positions once
      const fixed = ensurePositions(fsm, (bodyRef.current ? bodyRef.current.clientWidth : 900), Hh);
      if (fixed !== fsm) onUpdate(node.id, fixed);
    }, [node.id]);

    const stById = {}; fsm.states.forEach(s => stById[s.id] = s);
    const cur = liveState || fsm.current;

    const update = (nf) => onUpdate(node.id, nf);
    const setStates = (states) => update({ ...fsm, states });
    const setTrans = (transitions) => update({ ...fsm, transitions });

    // ---- drag states ----
    useEffect(() => {
      const mm = (e) => {
        if (!drag.current) return;
        const r = bodyRef.current.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        setStates(fsm.states.map(s => s.id === drag.current.id ? { ...s, sx: x - drag.current.dx, sy: y - drag.current.dy } : s));
      };
      const mu = () => { drag.current = null; };
      window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
      return () => { window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    }, [fsm]);

    const startDrag = (e, s) => {
      const r = bodyRef.current.getBoundingClientRect();
      drag.current = { id: s.id, dx: e.clientX - r.left - s.sx, dy: e.clientY - r.top - s.sy };
      setSel({ kind: "state", id: s.id });
    };

    // ---- mutations ----
    const addState = () => {
      const id = "s" + Math.random().toString(36).slice(2, 6);
      const r = bodyRef.current.getBoundingClientRect();
      setStates([...fsm.states, { id, name: "new state", tone: "idle", sx: r.width / 2, sy: Hh / 2 }]);
      setSel({ kind: "state", id });
    };
    const addTrans = () => {
      const from = sel && sel.kind === "state" ? sel.id : fsm.states[0].id;
      const to = fsm.states[Math.min(1, fsm.states.length - 1)].id;
      const id = "t" + Math.random().toString(36).slice(2, 6);
      setTrans([...fsm.transitions, { id, from, to, on: "event", action: "", guard: "" }]);
      setSel({ kind: "trans", id });
    };
    const delSel = () => {
      if (!sel) return;
      if (sel.kind === "state") {
        update({ ...fsm, states: fsm.states.filter(s => s.id !== sel.id),
          transitions: fsm.transitions.filter(t => t.from !== sel.id && t.to !== sel.id),
          current: fsm.current === sel.id ? (fsm.states[0] && fsm.states[0].id) : fsm.current });
      } else setTrans(fsm.transitions.filter(t => t.id !== sel.id));
      setSel(null);
    };
    const patchState = (id, patch) => setStates(fsm.states.map(s => s.id === id ? { ...s, ...patch } : s));
    const patchTrans = (id, patch) => setTrans(fsm.transitions.map(t => t.id === id ? { ...t, ...patch } : t));

    // ---- geometry ----
    const transPath = (t) => {
      const a = stById[t.from], b = stById[t.to];
      if (!a || !b) return null;
      if (a.id === b.id) {
        const x = a.sx, y = a.sy;
        return { d: `M ${x - 18} ${y - 20} C ${x - 50} ${y - 70}, ${x + 50} ${y - 70}, ${x + 18} ${y - 20}`, mx: x, my: y - 56, self: true };
      }
      const dx = b.sx - a.sx, dy = b.sy - a.sy, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const x1 = a.sx + ux * 56, y1 = a.sy + uy * 22;
      const x2 = b.sx - ux * 56, y2 = b.sy - uy * 22;
      const cx = (x1 + x2) / 2 - uy * 34, cy = (y1 + y2) / 2 + ux * 34;
      return { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, mx: cx, my: cy, x2, y2, ux, uy };
    };

    return React.createElement("div", { className: "dock" },
      React.createElement("div", { className: "dock-hd" },
        React.createElement("span", { className: "dt" }, React.createElement(Icon, { name: "flow", size: 14, color: "var(--red)" }), "state machine"),
        React.createElement("span", { className: "dsub" }, node.label),
        React.createElement("div", { style: { flex: 1 } }),
        React.createElement("button", { className: "btn ghost sm", onClick: addState }, React.createElement(Icon, { name: "plus", size: 13 }), "state"),
        React.createElement("button", { className: "btn ghost sm", onClick: addTrans }, React.createElement(Icon, { name: "link", size: 13 }), "transition"),
        sel && React.createElement("button", { className: "btn danger sm", onClick: delSel }, React.createElement(Icon, { name: "trash", size: 13 })),
        React.createElement("div", { className: "tb-sep" }),
        React.createElement("button", { onClick: onClose, style: { color: "var(--fg-3)", display: "grid", placeItems: "center", width: 28, height: 28 } }, React.createElement(Icon, { name: "x", size: 16 }))),
      React.createElement("div", { style: { display: "flex", flex: 1, minHeight: 0 } },
        // graph
        React.createElement("div", { className: "dock-body", ref: bodyRef, style: { flex: 1 },
          onMouseDown: (e) => { if (e.target === bodyRef.current || e.target.tagName === "svg") setSel(null); } },
          React.createElement("svg", { className: "fsm-canvas" },
            fsm.transitions.map(t => {
              const p = transPath(t); if (!p) return null;
              const s = sel && sel.kind === "trans" && sel.id === t.id;
              return React.createElement("path", { key: t.id, d: p.d, fill: "none",
                stroke: s ? "var(--red)" : "var(--ln-3)", strokeWidth: s ? 2.4 : 1.8 });
            }),
            // arrowheads
            fsm.transitions.map(t => {
              const p = transPath(t); if (!p || p.self) return null;
              const ang = Math.atan2(p.uy, p.ux);
              const a1 = ang + 2.6, a2 = ang - 2.6;
              const s = sel && sel.kind === "trans" && sel.id === t.id;
              return React.createElement("path", { key: "a" + t.id,
                d: `M ${p.x2} ${p.y2} L ${p.x2 + Math.cos(a1) * 9} ${p.y2 + Math.sin(a1) * 9} L ${p.x2 + Math.cos(a2) * 9} ${p.y2 + Math.sin(a2) * 9} Z`,
                fill: s ? "var(--red)" : "var(--ln-3)" });
            })),
          // transition labels
          fsm.transitions.map(t => {
            const p = transPath(t); if (!p) return null;
            const s = sel && sel.kind === "trans" && sel.id === t.id;
            return React.createElement("div", { key: "l" + t.id, className: "tlabel" + (s ? " sel" : ""),
              style: { left: p.mx, top: p.my }, onMouseDown: (e) => { e.stopPropagation(); setSel({ kind: "trans", id: t.id }); } },
              React.createElement("span", { className: "on" }, t.on),
              t.action && React.createElement("span", { className: "ac" }, " / ", t.action),
              t.guard && React.createElement("span", { className: "gd" }, " [", t.guard, "]"));
          }),
          // states
          fsm.states.map(s => React.createElement("div", { key: s.id,
            className: "fsm-state" + (sel && sel.kind === "state" && sel.id === s.id ? " sel" : "") + (cur === s.id ? " cur" : ""),
            style: { left: s.sx, top: s.sy }, onMouseDown: (e) => { e.stopPropagation(); startDrag(e, s); } },
            React.createElement("div", { className: "sn" },
              React.createElement("span", { className: "sd", style: { background: `var(--tone-${s.tone})` } }), s.name),
            React.createElement("div", { className: "stag" }, s.id === fsm.current ? "initial" : s.tone)))),
        // editor side
        React.createElement(FsmEditor, { sel, fsm, stById, patchState, patchTrans, setInitial: (id) => update({ ...fsm, current: id }) }))
    );
  }

  function FsmEditor({ sel, fsm, stById, patchState, patchTrans, setInitial }) {
    if (!sel) return React.createElement("div", { style: { width: 290, borderLeft: "1px solid var(--ln-1)", padding: 16, color: "var(--fg-4)", fontSize: 12.5 } },
      "select a state or transition to edit. drag states to arrange. transitions fire on a method/event and run an action when the simulation routes a packet through this node.");
    if (sel.kind === "state") {
      const s = stById[sel.id]; if (!s) return null;
      return React.createElement("div", { style: { width: 290, borderLeft: "1px solid var(--ln-1)", overflowY: "auto" } },
        React.createElement("div", { className: "field" }, React.createElement("div", { className: "lbl" }, "state name"),
          React.createElement("input", { className: "inp", value: s.name, onChange: (e) => patchState(s.id, { name: e.target.value }) })),
        React.createElement("div", { className: "field" }, React.createElement("div", { className: "lbl" }, "tone"),
          React.createElement("div", { className: "seg" }, TONES.map(t => React.createElement("button", { key: t,
            className: s.tone === t ? "on" : "", onClick: () => patchState(s.id, { tone: t }), title: t },
            React.createElement("span", { style: { width: 9, height: 9, borderRadius: "50%", background: `var(--tone-${t})`, display: "inline-block" } }))))),
        React.createElement("div", { className: "field" },
          React.createElement("button", { className: "btn ghost block", disabled: fsm.current === s.id, onClick: () => setInitial(s.id) },
            fsm.current === s.id ? "initial state" : "set as initial")));
    }
    const t = fsm.transitions.find(x => x.id === sel.id); if (!t) return null;
    const fld = (label, key, ph) => React.createElement("div", { className: "field" },
      React.createElement("div", { className: "lbl" }, label),
      React.createElement("input", { className: "inp mono", value: t[key], placeholder: ph || "", onChange: (e) => patchTrans(t.id, { [key]: e.target.value }) }));
    const stateSel = (label, key) => React.createElement("div", { className: "field" },
      React.createElement("div", { className: "lbl" }, label),
      React.createElement("select", { className: "inp", value: t[key], onChange: (e) => patchTrans(t.id, { [key]: e.target.value }) },
        fsm.states.map(s => React.createElement("option", { key: s.id, value: s.id }, s.name))));
    return React.createElement("div", { style: { width: 290, borderLeft: "1px solid var(--ln-1)", overflowY: "auto" } },
      stateSel("from", "from"), stateSel("to", "to"),
      fld("on event / method", "on", "request"),
      fld("action (method)", "action", "handle"),
      fld("guard (optional)", "guard", "inflight < capacity"));
  }

  window.FsmDock = FsmDock;
})();
