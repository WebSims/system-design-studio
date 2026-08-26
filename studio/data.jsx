// data.jsx — node taxonomy, palette, protocols, seed graph, FSM templates.
// Everything attaches to window.SDS.
(function () {
  // ---- type accents ----
  const ACCENT = {
    client:       "#4ab4e6", // sky
    loadbalancer: "#2aa8a8", // teal
    server:       "#f08d2c", // orange
    database:     "#7b51a1", // purple
    cache:        "#ec6ca0", // pink
    store:        "#f5c518", // yellow
    queue:        "#6cb33e", // green
  };

  // ---- protocols (edge kinds) ----
  const PROTOCOLS = {
    https: { label: "https", dash: false, color: "#4ab4e6" },
    http:  { label: "http",  dash: false, color: "#7b766e" },
    grpc:  { label: "grpc",  dash: false, color: "#f08d2c" },
    tcp:   { label: "tcp",   dash: false, color: "#2aa8a8" },
    ws:    { label: "ws",    dash: true,  color: "#4ab4e6" },
    sql:   { label: "sql",   dash: false, color: "#7b51a1" },
    mongo: { label: "mongo", dash: false, color: "#9a6fc0" },
    redis: { label: "redis", dash: false, color: "#ec6ca0" },
    s3:    { label: "s3",    dash: false, color: "#f5c518" },
    amqp:  { label: "amqp",  dash: true,  color: "#6cb33e" },
  };

  // ---- FSM templates per base type ----
  function fsm(states, transitions, current) { return { states, transitions, current }; }
  const FSM_TEMPLATES = {
    client: () => fsm(
      [{ id: "idle", name: "idle", tone: "idle" },
       { id: "await", name: "awaiting", tone: "busy" }],
      [{ id: "t1", from: "idle", to: "await", on: "request", action: "request", guard: "" },
       { id: "t2", from: "await", to: "idle", on: "response", action: "", guard: "" }],
      "idle"),
    loadbalancer: () => fsm(
      [{ id: "idle", name: "idle", tone: "idle" },
       { id: "route", name: "routing", tone: "busy" }],
      [{ id: "t1", from: "idle", to: "route", on: "request", action: "route", guard: "healthy > 0" },
       { id: "t2", from: "route", to: "idle", on: "tick", action: "", guard: "" }],
      "idle"),
    server: () => fsm(
      [{ id: "idle", name: "idle", tone: "idle" },
       { id: "busy", name: "processing", tone: "busy" },
       { id: "err",  name: "error", tone: "error" }],
      [{ id: "t1", from: "idle", to: "busy", on: "request", action: "handle", guard: "inflight < capacity" },
       { id: "t2", from: "busy", to: "idle", on: "done", action: "respond", guard: "" },
       { id: "t3", from: "busy", to: "err", on: "fault", action: "respond", guard: "" },
       { id: "t4", from: "err", to: "idle", on: "recover", action: "", guard: "" }],
      "idle"),
    database: () => fsm(
      [{ id: "idle", name: "idle", tone: "idle" },
       { id: "io",   name: "i/o", tone: "busy" }],
      [{ id: "t1", from: "idle", to: "io", on: "query", action: "read", guard: "conns < pool" },
       { id: "t2", from: "io", to: "idle", on: "done", action: "respond", guard: "" }],
      "idle"),
    cache: () => fsm(
      [{ id: "idle", name: "idle", tone: "idle" },
       { id: "hit",  name: "hit", tone: "ok" },
       { id: "miss", name: "miss", tone: "warn" }],
      [{ id: "t1", from: "idle", to: "hit", on: "query", action: "get", guard: "key in store" },
       { id: "t2", from: "idle", to: "miss", on: "query", action: "get", guard: "key not in store" },
       { id: "t3", from: "hit", to: "idle", on: "done", action: "respond", guard: "" },
       { id: "t4", from: "miss", to: "idle", on: "done", action: "respond", guard: "" }],
      "idle"),
    store: () => fsm(
      [{ id: "idle", name: "idle", tone: "idle" },
       { id: "io",   name: "transfer", tone: "busy" }],
      [{ id: "t1", from: "idle", to: "io", on: "query", action: "get", guard: "" },
       { id: "t2", from: "io", to: "idle", on: "done", action: "respond", guard: "" }],
      "idle"),
    queue: () => fsm(
      [{ id: "empty", name: "empty", tone: "idle" },
       { id: "buf",   name: "buffering", tone: "busy" },
       { id: "drain", name: "draining", tone: "ok" }],
      [{ id: "t1", from: "empty", to: "buf", on: "publish", action: "enqueue", guard: "depth < maxlen" },
       { id: "t2", from: "buf", to: "drain", on: "tick", action: "dequeue", guard: "consumers > 0" },
       { id: "t3", from: "drain", to: "empty", on: "tick", action: "", guard: "depth == 0" }],
      "empty"),
  };

  // ---- methods per type ----
  const METHODS = {
    client: ["onPageLoad", "onClick", "onRouteChange"], // event handlers — each fires an http request
    loadbalancer: ["route", "healthCheck"],
    server: ["handle", "query", "publish", "respond"],
    database: ["read", "write", "respond"],
    cache: ["get", "set", "respond"],
    store: ["put", "get", "respond"],
    queue: ["publish", "consume", "ack"],
  };

  // ---- palette ----
  // type = engine behaviour; engines = selectable backend (picker in inspector)
  const PALETTE = [
    { group: "clients", items: [
      { key: "web",    type: "client",       icon: "monitor",    label: "web client" },
    ]},
    { group: "edge", items: [
      { key: "lb",     type: "loadbalancer", icon: "split",      label: "load balancer" },
    ]},
    { group: "compute", items: [
      { key: "server", type: "server",       icon: "server",     label: "server" },
    ]},
    { group: "data", items: [
      { key: "relational", type: "database", icon: "database", label: "relational db", engines: ["postgres", "mysql"] },
      { key: "nosql",      type: "database", icon: "boxes",    label: "nosql db",      engines: ["mongodb"] },
      { key: "kv",         type: "cache",    icon: "bolt",     label: "kv store",      engines: ["redis"] },
      { key: "object",     type: "store",    icon: "box",      label: "object store",  engines: ["aws s3", "gcs"] },
    ]},
    { group: "messaging", items: [
      { key: "queue",    type: "queue", icon: "layers", label: "rabbitmq queue",    engines: ["rabbitmq"] },
      { key: "exchange", type: "queue", icon: "radio",  label: "rabbitmq exchange", engines: ["rabbitmq"] },
    ]},
  ];

  const PALETTE_BY_KEY = {};
  PALETTE.forEach(g => g.items.forEach(it => { PALETTE_BY_KEY[it.key] = it; }));

  // ---- node factory ----
  let _id = 0;
  function uid(prefix) { _id += 1; return (prefix || "n") + "_" + _id + "_" + Math.random().toString(36).slice(2, 6); }

  function makeNode(paletteKey, x, y, labelOverride) {
    const def = PALETTE_BY_KEY[paletteKey];
    return {
      id: uid(def.type),
      paletteKey,
      type: def.type,
      icon: def.icon,
      label: labelOverride || def.label,
      x, y,
      engines: def.engines ? def.engines.slice() : null,
      engine: def.engines ? def.engines[0] : null,
      fsm: FSM_TEMPLATES[def.type](),
      methods: METHODS[def.type].slice(),
      stat: { processed: 0, depth: 0 },
    };
  }
  function makeEdge(from, to, protocol) {
    return { id: uid("e"), from, to, protocol: protocol || "http", label: "" };
  }

  // pick a sensible protocol for an edge given its endpoints
  function protocolFor(src, dst) {
    if (!src || !dst) return "http";
    if (dst.type === "database") return dst.engine === "mongodb" ? "mongo" : "sql";
    if (dst.type === "cache") return "redis";
    if (dst.type === "store") return "s3";
    if (dst.type === "queue" || src.type === "queue") return "amqp";
    if (src.type === "client") return "https";
    if (src.type === "loadbalancer") return "http";
    if (dst.type === "server" || dst.type === "loadbalancer") return "grpc";
    return "http";
  }

  // ---- seed: a generic web service (no domain specifics) ----
  function seed() {
    _id = 0;
    const N = {};
    const def = (k, key, x, y, label, engine) => {
      const n = makeNode(key, x, y, label); if (engine) n.engine = engine; N[k] = n; return n;
    };
    def("web",   "web",        80,  470, "web client");
    def("lb",    "lb",        470,  470, "load balancer");
    def("api1",  "server",    920,  170, "api server");
    def("api2",  "server",    920,  470, "api server");
    def("api3",  "server",    920,  770, "api server");
    def("db",    "relational",1400, 200, "relational db", "postgres");
    def("kv",    "kv",        1400, 470, "kv store", "redis");
    def("mq",    "queue",     1400, 740, "task queue", "rabbitmq");
    def("wrk",   "server",    1850, 740, "worker");
    def("mongo", "nosql",     2300, 740, "document db", "mongodb");

    const E = (a, b) => makeEdge(N[a].id, N[b].id, protocolFor(N[a], N[b]));
    const edges = [
      E("web", "lb"),
      E("lb", "api1"), E("lb", "api2"), E("lb", "api3"),
      E("api1", "db"),
      E("api2", "kv"),
      E("api3", "mq"),
      E("mq", "wrk"), E("wrk", "mongo"),
    ];
    return { nodes: Object.values(N), edges };
  }

  window.SDS = {
    ACCENT, PROTOCOLS, FSM_TEMPLATES, METHODS, PALETTE, PALETTE_BY_KEY,
    makeNode, makeEdge, seed, uid, protocolFor,
    NODE_W: 168, NODE_H: 64,
    PIPE_W: 46, LANE: 13, ICON: 19,
  };
})();
