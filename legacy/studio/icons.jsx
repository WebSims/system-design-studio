// icons.jsx — lucide-style stroked icons. window.Icon({name,size,...})
(function () {
  // each entry returns the inner SVG markup (paths) — stroke styling on <svg>
  const P = {
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    smartphone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 9.5h5v5h-5z M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
    split: '<path d="M5 4v6a4 4 0 0 0 4 4h6"/><path d="M5 20v-6"/><path d="M15 11l3 3-3 3"/><circle cx="5" cy="4" r="0.6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    doorway: '<path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M3 21h18"/><path d="M14 12h.01"/>',
    database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    boxes: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
    bolt: '<path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    waves: '<path d="M2 8c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M2 14c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/>',
    radio: '<circle cx="12" cy="12" r="2.5"/><path d="M7.5 7.5a6.5 6.5 0 0 0 0 9M16.5 7.5a6.5 6.5 0 0 1 0 9M4.5 4.5a11 11 0 0 0 0 15M19.5 4.5a11 11 0 0 1 0 15"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M2.5 3h2.2l2.1 12.2h11l1.7-8.7H6.2"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19M6 15h4"/>',
    receipt: '<path d="M6 2.5h12v19l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 12h6"/>',
    box: '<path d="M3 7.5l9-4.5 9 4.5v9l-9 4.5-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
    truck: '<path d="M2.5 6.5h11v9h-11z"/><path d="M13.5 9.5h4l3 3v3h-7z"/><circle cx="6.5" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>',
    mail: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
    tag: '<path d="M3 3h7l11 11-7 7L3 10z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 6.5"/>',
    crown: '<path d="M3 7l4 4 5-7 5 7 4-4-2 12H5z"/>',
    // ui
    play: '<path d="M7 4.5l13 7.5-13 7.5z"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    step: '<path d="M5 4.5l10 7.5-10 7.5z"/><rect x="17" y="4" width="2.5" height="16" rx="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l1.7-1.3-2-3.4-2 .8a7.6 7.6 0 0 0-2.6-1.5L14 2h-4l-.5 2.1A7.6 7.6 0 0 0 6.9 5.6l-2-.8-2 3.4 1.7 1.3a7.8 7.8 0 0 0 0 3L2.9 13.8l2 3.4 2-.8a7.6 7.6 0 0 0 2.6 1.5L10 20h4l.5-2.1a7.6 7.6 0 0 0 2.6-1.5l2 .8 2-3.4z"/>',
    zap: '<path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    link: '<path d="M9.5 14.5l5-5M8 12l-2.5 2.5a3.5 3.5 0 0 0 5 5L13 17M16 12l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7"/>',
    grid: '<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    cursor: '<path d="M5 3l14 7-6 1.5L9.5 17z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M4 18a9 9 0 1 1 16 0"/><circle cx="12" cy="14" r="1.4"/>',
    alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v3.5H7.5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    dot: '<circle cx="12" cy="12" r="3.2"/>',
    flow: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 8l8 8"/>',
    brackets: '<path d="M8 4H6a2 2 0 0 0-2 2v4l-1.5 2L4 14v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l1.5 2L20 14v4a2 2 0 0 1-2 2h-2"/>',
  };

  function Icon({ name, size = 20, stroke = 2, fill = "none", color = "currentColor", style, className }) {
    const inner = P[name] || P.dot;
    return React.createElement("svg", {
      width: size, height: size, viewBox: "0 0 24 24",
      fill, stroke: color, strokeWidth: stroke,
      strokeLinecap: "round", strokeLinejoin: "round",
      style, className,
      dangerouslySetInnerHTML: { __html: inner },
    });
  }
  window.Icon = Icon;
  window.ICON_NAMES = Object.keys(P);
})();
