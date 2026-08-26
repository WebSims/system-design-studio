// panels.jsx — Palette, Inspector, Log, ContextMenu. -> window.*
(function () {
  const { useState } = React;
  const Icon = window.Icon;
  const S = window.SDS;

  function PaletteBody({ accentOf }) {
    return React.createElement("div", { className: "palette-scroll" },
      S.PALETTE.map(group =>
        React.createElement("div", { className: "pgroup", key: group.group },
          React.createElement("div", { className: "pgroup-h" }, group.group),
          group.items.map(it => {
            const accent = S.ACCENT[it.type];
            return React.createElement("div", {
              key: it.key, className: "pitem", draggable: true,
              onDragStart: (e) => { e.dataTransfer.setData("text/sds-node", it.key); e.dataTransfer.effectAllowed = "copy"; },
            },
              React.createElement("div", { className: "gi", style: { color: accent } },
                React.createElement(Icon, { name: it.icon, size: 18, color: accent })),
              React.createElement("div", null,
                React.createElement("div", { className: "pl" }, it.label),
                React.createElement("div", { className: "pk" }, it.type)));
          })))
    );
  }

  function Inspector(props) {
    const { selection, nodes, edges, accentOf, onLabel, onProtocol, onEdgeLabel, onEngine,
      onDelete, onToggleBp, breakpoints, onEditFsm, onAddMethod, fsmOpenFor, running, nodeStates } = props;

    if (!selection) {
      return React.createElement("div", { className: "rail right" },
        React.createElement("div", { className: "insp-empty" },
          React.createElement("div", { className: "ic" }, React.createElement(Icon, { name: "cursor", size: 20, color: "var(--fg-3)" })),
          React.createElement("div", { style: { fontWeight: 600, color: "var(--fg-2)" } }, "nothing selected"),
          React.createElement("div", { style: { fontSize: 12, marginTop: 6 } }, "select a node or connection to inspect & edit its behavior")));
    }

    if (selection.kind === "edge") {
      const ed = edges.find(e => e.id === selection.id);
      if (!ed) return null;
      const sn = nodes.find(n => n.id === ed.from), tn = nodes.find(n => n.id === ed.to);
      return React.createElement("div", { className: "rail right" },
        React.createElement("div", { className: "insp-hd" },
          React.createElement("div", { className: "node-ic", style: { background: "var(--bg-3)" } }, React.createElement(Icon, { name: "link", size: 18, color: "var(--fg-2)" })),
          React.createElement("div", null,
            React.createElement("div", { style: { fontWeight: 700, fontSize: 15 } }, "connection"),
            React.createElement("div", { className: "nm" }, (sn ? sn.label : "?"), " → ", (tn ? tn.label : "?")))),
        React.createElement("div", { className: "field" },
          React.createElement("div", { className: "lbl" }, "protocol"),
          React.createElement("select", { className: "inp", value: ed.protocol, onChange: (e) => onProtocol(ed.id, e.target.value) },
            Object.keys(S.PROTOCOLS).map(k => React.createElement("option", { key: k, value: k }, k)))),
        React.createElement("div", { className: "field" },
          React.createElement("div", { className: "lbl" }, "label (optional)"),
          React.createElement("input", { className: "inp mono", value: ed.label, placeholder: S.PROTOCOLS[ed.protocol].label,
            onChange: (e) => onEdgeLabel(ed.id, e.target.value) })),
        React.createElement("div", { className: "field" },
          React.createElement("button", { className: "btn danger block", onClick: () => onDelete() },
            React.createElement(Icon, { name: "trash", size: 15 }), "delete connection")));
    }

    // node
    const n = nodes.find(x => x.id === selection.id);
    if (!n) return null;
    const accent = accentOf(n);
    const curState = (running && nodeStates[n.id]) || n.fsm.current;
    const stObj = n.fsm.states.find(s => s.id === curState);
    return React.createElement("div", { className: "rail right" },
      React.createElement("div", { className: "insp-hd" },
        React.createElement("div", { className: "node-ic", style: { background: accent } }, React.createElement(Icon, { name: n.icon, size: 19, color: "#fff" })),
        React.createElement("div", { style: { flex: 1 } },
          React.createElement("div", { style: { fontWeight: 700, fontSize: 15 } }, n.label),
          React.createElement("div", { className: "nm" }, n.type, " · ", n.paletteKey))),
      React.createElement("div", { className: "field" },
        React.createElement("div", { className: "lbl" }, "label"),
        React.createElement("input", { className: "inp", value: n.label, onChange: (e) => onLabel(n.id, e.target.value) })),

      // engine / backend picker
      n.engines && React.createElement("div", { className: "field" },
        React.createElement("div", { className: "lbl" }, "engine"),
        n.engines.length > 1
          ? React.createElement("select", { className: "inp", value: n.engine || n.engines[0], onChange: (e) => onEngine(n.id, e.target.value) },
              n.engines.map(g => React.createElement("option", { key: g, value: g }, g)))
          : React.createElement("div", { className: "tag", style: { textTransform: "none" } }, n.engine || n.engines[0])),
      // state machine summary
      React.createElement("div", { className: "field" },
        React.createElement("div", { className: "lbl" },
          React.createElement("span", null, "state machine"),
          React.createElement("button", { className: "tag", onClick: () => onEditFsm(n.id), style: { cursor: "pointer", textTransform: "lowercase" } },
            React.createElement(Icon, { name: "flow", size: 12 }), fsmOpenFor === n.id ? "editing" : "edit")),
        React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
          n.fsm.states.map(s => React.createElement("span", { key: s.id, className: "tag",
            style: { background: curState === s.id ? "var(--bg-4)" : "var(--bg-2)", boxShadow: curState === s.id ? `0 0 0 1px var(--tone-${s.tone})` : "none" } },
            React.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", background: `var(--tone-${s.tone})` } }), s.name))),
        running && stObj && React.createElement("div", { style: { fontSize: 11.5, color: "var(--fg-3)", marginTop: 8 } },
          "current: ", React.createElement("b", { style: { color: `var(--tone-${stObj.tone})` } }, stObj.name))),

      // methods
      React.createElement("div", { className: "field" },
        React.createElement("div", { className: "lbl" },
          React.createElement("span", null, "methods"),
          React.createElement("button", { className: "tag", style: { cursor: "pointer" }, onClick: () => onAddMethod(n.id) },
            React.createElement(Icon, { name: "plus", size: 12 }), "add")),
        n.methods.map((m, i) => {
          const wired = n.fsm.transitions.filter(t => t.action === m || t.on === m);
          return React.createElement("div", { className: "method-row", key: i },
            React.createElement(Icon, { name: "brackets", size: 14, color: "var(--fg-3)" }),
            React.createElement("span", { className: "mn" }, m, "()"),
            React.createElement("span", { className: "mt" }, wired.length ? `${wired.length} transition${wired.length > 1 ? "s" : ""}` : "unwired"));
        })),

      // live stats
      running && React.createElement("div", { className: "field" },
        React.createElement("div", { className: "lbl" }, "live"),
        React.createElement("div", { style: { display: "flex", gap: 16, fontSize: 13 } },
          React.createElement("div", null, React.createElement("div", { className: "tnum", style: { fontWeight: 700, fontSize: 18 } }, n.stat.processed),
            React.createElement("div", { style: { fontSize: 10.5, color: "var(--fg-3)" } }, "processed")),
          n.type === "queue" && React.createElement("div", null, React.createElement("div", { className: "tnum", style: { fontWeight: 700, fontSize: 18 } }, n.stat.depth),
            React.createElement("div", { style: { fontSize: 10.5, color: "var(--fg-3)" } }, "queue depth")))),

      React.createElement("div", { className: "field", style: { display: "flex", gap: 8 } },
        React.createElement("button", { className: "btn ghost", style: { flex: 1 }, onClick: () => onToggleBp(n.id) },
          React.createElement(Icon, { name: breakpoints[n.id] ? "dot" : "target", size: 15, color: breakpoints[n.id] ? "var(--red)" : "currentColor" }),
          breakpoints[n.id] ? "clear bp" : "breakpoint"),
        React.createElement("button", { className: "btn danger", onClick: () => onDelete() },
          React.createElement(Icon, { name: "trash", size: 15 })))
    );
  }

  function Log({ lines, onClose }) {
    return React.createElement("div", { className: "log" },
      React.createElement("div", { className: "log-hd" },
        React.createElement(Icon, { name: "activity", size: 13, color: "var(--fg-3)" }),
        React.createElement("span", { style: { flex: 1 } }, "trace log"),
        React.createElement("button", { onClick: onClose, style: { color: "var(--fg-3)", display: "grid", placeItems: "center" } }, React.createElement(Icon, { name: "x", size: 14 }))),
      React.createElement("div", { className: "log-body" },
        lines.length === 0 && React.createElement("div", { className: "log-line", style: { color: "var(--fg-4)" } }, "waiting for events…"),
        lines.map((l, i) => React.createElement("div", { className: "log-line " + (l.level || ""), key: i },
          React.createElement("span", { className: "lt" }, (l.t / 1000).toFixed(1), "s"),
          React.createElement("span", { className: "lm" }, l.msg)))));
  }

  function ContextMenu({ menu, onClose }) {
    if (!menu) return null;
    return React.createElement(React.Fragment, null,
      React.createElement("div", { style: { position: "fixed", inset: 0, zIndex: 199 }, onMouseDown: onClose, onContextMenu: (e) => { e.preventDefault(); onClose(); } }),
      React.createElement("div", { className: "ctx", style: { left: menu.x, top: menu.y } },
        menu.items.map((it, i) => it.sep
          ? React.createElement("div", { className: "sep", key: i })
          : React.createElement("button", { key: i, className: it.danger ? "dng" : "", onClick: () => { it.fn(); onClose(); } },
            it.icon && React.createElement(Icon, { name: it.icon, size: 15 }), it.label,
            it.kb && React.createElement("span", { className: "kb" }, it.kb)))));
  }

  window.PaletteBody = PaletteBody;
  window.Inspector = Inspector;
  window.Log = Log;
  window.ContextMenu = ContextMenu;
})();
