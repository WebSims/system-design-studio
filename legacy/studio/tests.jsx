// tests.jsx — left rail: Build (components) / Run (generalized scenario + live log).
(function () {
  const Icon = window.Icon;

  function LeftRail(props) {
    const { tab, setTab, accentOf, runProps } = props;
    return React.createElement("div", { className: "rail left" },
      React.createElement("div", { className: "rail-tabs" },
        React.createElement("button", { className: "rt" + (tab === "build" ? " on" : ""), onClick: () => setTab("build") },
          React.createElement(Icon, { name: "boxes", size: 14 }), "build"),
        React.createElement("button", { className: "rt" + (tab === "run" ? " on" : ""), onClick: () => setTab("run") },
          React.createElement(Icon, { name: "activity", size: 14 }), "run")),
      tab === "build"
        ? React.createElement(window.PaletteBody, { accentOf })
        : React.createElement(RunPanel, runProps));
  }

  function Section({ label, right }) {
    return React.createElement("div", { className: "run-sec" }, React.createElement("span", null, label), right);
  }
  function Stepper({ value, min, max, onChange }) {
    return React.createElement("div", { className: "stepper sm" },
      React.createElement("button", { onClick: () => onChange(Math.max(min, value - 1)), disabled: value <= min }, "–"),
      React.createElement("div", { className: "sv tnum" }, value),
      React.createElement("button", { onClick: () => onChange(Math.min(max, value + 1)), disabled: value >= max }, "+"));
  }

  function RunPanel(props) {
    const { clients, running, emitOn, setEmitOn, sources, toggleSource, onBurst, burstCount, setBurstCount,
      load, setLoad, fault, setFault, log, stats } = props;

    const sourceRows = clients.length
      ? clients.map(c => {
          const on = sources[c.id] !== false;
          return React.createElement("button", { key: c.id, className: "src-row" + (on ? " on" : ""), onClick: () => toggleSource(c.id) },
            React.createElement("span", { className: "src-check" }, on && React.createElement(Icon, { name: "check", size: 12, color: "#fff" })),
            React.createElement(Icon, { name: c.icon, size: 14, color: "var(--label-sky)" }),
            React.createElement("span", { className: "src-name" }, c.label));
        })
      : React.createElement("div", { className: "run-empty" }, "no client nodes on the canvas — drag one from build");

    const fmt = (n, d) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: d || 0 });
    return React.createElement("div", { className: "run-scroll" },
      React.createElement("div", { className: "run-status" + (running ? " live" : "") },
        React.createElement("span", { className: "rs-dot" }), running ? "running — live system" : "stopped · press run"),

      React.createElement(Section, { label: "traffic sources" }),
      React.createElement("div", { className: "src-list" }, sourceRows),

      React.createElement(Section, { label: "continuous traffic" }),
      React.createElement("button", { className: "toggle-row" + (emitOn ? " on" : ""), onClick: () => setEmitOn(!emitOn) },
        React.createElement("span", { className: "tg" }, React.createElement("span", { className: "tg-knob" })),
        emitOn ? "emitting requests" : "paused (no new requests)"),
      React.createElement("div", { className: "run-slider" },
        React.createElement("label", null, "load", React.createElement("b", null, fmt(load, 1), " req/s")),
        React.createElement("input", { type: "range", min: 0.4, max: 6, step: 0.2, value: load, onChange: (e) => setLoad(+e.target.value) })),
      React.createElement("div", { className: "run-slider" },
        React.createElement("label", null, "fault rate", React.createElement("b", null, fault, "%")),
        React.createElement("input", { type: "range", min: 0, max: 30, step: 1, value: fault, onChange: (e) => setFault(+e.target.value) })),
      React.createElement("div", { className: "run-slider" },
        React.createElement("label", null, "packet loss", React.createElement("b", null, props.loss, "%")),
        React.createElement("input", { type: "range", min: 0, max: 30, step: 1, value: props.loss, onChange: (e) => props.setLoss(+e.target.value) })),

      React.createElement(Section, { label: "burst", right: React.createElement("span", { className: "run-hint" }, "fire at once") }),
      React.createElement("div", { className: "burst-row" },
        React.createElement(Stepper, { value: burstCount, min: 1, max: 40, onChange: setBurstCount }),
        React.createElement("button", { className: "btn primary", onClick: () => onBurst(burstCount) },
          React.createElement(Icon, { name: "zap", size: 14 }), "send burst")),
      React.createElement("div", { className: "run-note" }, "sends ", burstCount, " concurrent requests through the live graph — watch them queue at each node's counters."),

      React.createElement("div", { className: "run-metrics" },
        metric("throughput", fmt(stats.rps), "/s"),
        metric("latency", fmt(stats.latency), "ms", stats.latency > 220 ? "warn" : ""),
        metric("in-flight", fmt(stats.inflight)),
        metric("faults", fmt(stats.errRate, 1) + "%", "", stats.errRate > 8 ? "bad" : (stats.errRate > 0 ? "warn" : ""))),

      React.createElement(Section, { label: "trace log" }),
      React.createElement("div", { className: "run-log" },
        log.length === 0 && React.createElement("div", { className: "rl-line muted" }, "waiting for events…"),
        log.slice(-80).map((l, i) => React.createElement("div", { className: "rl-line " + (l.level || ""), key: i },
          React.createElement("span", { className: "rl-t" }, (l.t / 1000).toFixed(1), "s"),
          React.createElement("span", { className: "rl-m" }, l.msg)))));
  }
  function metric(label, value, unit, cls) {
    return React.createElement("div", { className: "rmetric" },
      React.createElement("div", { className: "rm-v " + (cls || "") }, value, unit && React.createElement("span", { className: "rm-u" }, unit)),
      React.createElement("div", { className: "rm-l" }, label));
  }

  window.LeftRail = LeftRail;
})();
