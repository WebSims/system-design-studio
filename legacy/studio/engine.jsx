// engine.jsx — call-tree ambient sim + scenario runner, with identicon sprites & two-lane pipes.
(function () {
  const S = window.SDS;
  const TRAVEL = 520;
  const NETMS = { https:45, http:18, grpc:9, tcp:8, ws:30, sql:14, mongo:16, redis:3, s3:30, amqp:12, event:12 };
  const PROCMS = { client:0, loadbalancer:4, server:34, database:22, cache:6, store:24, queue:8, cdn:6 };
  const ARRIVE_EVENT = { client:"response", loadbalancer:"request", server:"request", database:"query", cache:"query", store:"query", queue:"publish", cdn:"request" };
  const SC_PROC = 90;
  const jit = (m) => m * (0.7 + Math.random() * 0.6);
  const ID = () => window.Identicon;

  class SimEngine {
    constructor(opts) { this.opts = opts; this.running = false; this.paused = false; this.raf = null; this.mode = null; this.reset(); }
    reset() {
      this.tNow = 0; this.lastWall = 0; this.packets = []; this.events = []; this.dom = {};
      this.pid = 0; this.tid = 0; this.nodeState = {}; this.active = {}; this.depth = {}; this.processed = {}; this.resource = {};
      this.rrIndex = {}; this.completions = []; this.inflight = 0; this.emitAcc = {};
      this._dirty = true; this._lastStatPush = -999; this.scenario = null;
      this.occupants = {}; this.cuid = 0;
    }
    graph() { return this.opts.getGraph(); }
    nodeOf(id) { return this.graph().nodes.find(n => n.id === id); }
    edgeOf(id) { return this.graph().edges.find(e => e.id === id); }
    findEdge(a, b) { return this.graph().edges.find(e => e.from === a && e.to === b); }
    typeOf(id) { const n = this.nodeOf(id); return n ? n.type : ""; }
    isRouter(node) { return node.type === "loadbalancer" || node.type === "cdn" || node.role === "gateway" || node.paletteKey === "gateway"; }

    // ============ AMBIENT ============
    start() {
      const g = this.graph();
      g.nodes.forEach(n => { this.nodeState[n.id] = n.fsm.current; this.processed[n.id] = 0; this.depth[n.id] = 0;
        if (n.resource && n.resource.kind === "stock") this.resource[n.id] = n.resource.stock; });
      this.mode = "ambient"; this.running = true; this.paused = false;
      this.pushState(); this.pushStats(); this.log("ok", "traffic simulation started"); this._run();
    }
    _run() {
      this.lastWall = performance.now();
      const loop = (wall) => {
        if (!this.running) return;
        const dt = Math.min(64, wall - this.lastWall); this.lastWall = wall;
        if (!this.paused) this.tick(dt * (this.opts.getSpeed() || 1));
        this.render(); this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      this.running = false; this.paused = false; this.mode = null;
      if (this.raf) cancelAnimationFrame(this.raf);
      Object.values(this.dom).forEach(el => el.remove());
      const g = this.graph(); const ns = {}; g.nodes.forEach(n => ns[n.id] = n.fsm.current);
      this.reset(); this.nodeState = ns; this.pushState(); this.pushActive(); this.pushStats(true);
    }
    pause() { this.paused = true; this.log("warn", "paused"); }
    resume() { this.paused = false; this.lastWall = performance.now(); this.log("ok", "resumed"); }
    step() { this.paused = true; this.tick(60); this.render(); }

    // fire a one-shot burst of concurrent requests from selected client sources
    burst(count, sourceIds) {
      if (!this.running) return 0;
      const g = this.graph();
      let sources = g.nodes.filter(n => n.type === "client" && (!sourceIds || !sourceIds.length || sourceIds.indexOf(n.id) >= 0));
      if (!sources.length) sources = g.nodes.filter(n => n.type === "client");
      let fired = 0;
      for (let i = 0; i < count; i++) {
        const c = sources[i % sources.length];
        if (!c) break;
        const out = g.edges.filter(e => e.from === c.id);
        if (!out.length) continue;
        const edge = out[Math.floor(Math.random() * out.length)];
        this.schedule(Math.random() * 280, () => this.startTrace(c, edge));
        fired++;
      }
      if (fired) this.log("ok", `burst · ${fired} concurrent request${fired === 1 ? "" : "s"}`);
      return fired;
    }
    schedule(dtMs, fn) { this.events.push({ t: this.tNow + dtMs, fn }); }

    tick(dtSim) {
      this.tNow += dtSim;
      if (this.events.length) {
        const due = [], keep = [];
        for (const e of this.events) (e.t <= this.tNow ? due : keep).push(e);
        this.events = keep; due.sort((a, b) => a.t - b.t); due.forEach(e => e.fn());
      }
      for (const id in this.active) if (this.active[id] <= this.tNow) { delete this.active[id]; this._dirty = true; }
      if (this.mode === "ambient") {
        const g = this.graph();
        const load = this.opts.getLoad ? this.opts.getLoad() : 1;
        const interval = 1000 / Math.max(0.2, load);
        const sel = this.opts.getSources ? this.opts.getSources() : null;
        const emit = this.opts.getEmit ? this.opts.getEmit() : true;
        if (emit && this.packets.length < 150) g.nodes.filter(n => n.type === "client" && (!sel || !sel.length || sel.indexOf(n.id) >= 0)).forEach(c => {
          const out = g.edges.filter(e => e.from === c.id); if (!out.length) return;
          this.emitAcc[c.id] = (this.emitAcc[c.id] || 0) + dtSim;
          if (this.emitAcc[c.id] >= jit(interval)) { this.emitAcc[c.id] = 0; this.startTrace(c, out[Math.floor(Math.random() * out.length)]); }
        });
      }
      const dead = [], gone = [];
      for (const p of this.packets) {
        if (p.phase === "dock") { if (this.tNow - p.dockStart >= 300) { p._dockDone = true; dead.push(p); } continue; }
        if (p.phase === "launch") { if (this.tNow - p.launchStart >= 300) { p.phase = null; p.start = this.tNow; } continue; }
        p.prog = (this.tNow - p.start) / p.dur;
        if (p.lost && !p.leaking && p.prog >= p.dropAt) { p.leaking = true; p.leakStart = this.tNow; this.onPacketLost(p); }
        if (p.leaking) { if (this.tNow - p.leakStart > 480) gone.push(p); }
        else if (p.prog >= 1) {
          // requests dock into the node they reach; responses dock back into the caller awaiting them
          if (p.meta.call && (p.meta.kind === "req" || p.meta.kind === "res")) this.startDock(p);
          else dead.push(p);
        }
      }
      if (dead.length) { this.packets = this.packets.filter(p => !dead.includes(p)); dead.forEach(p => { if (p._dockDone) this.finishDock(p); else this.arrive(p); }); }
      if (gone.length) this.packets = this.packets.filter(p => !gone.includes(p));
      const cutoff = this.tNow - 1000;
      this.completions = this.completions.filter(c => c.t >= cutoff);
      if (this.tNow - this._lastStatPush > 180) { this.pushStats(); this._lastStatPush = this.tNow; }
      if (this._dirty) { this.pushState(); this.pushActive(); this._dirty = false; }
    }

    startTrace(client, firstEdge) {
      const tid = ++this.tid;
      const icon = ID().root(tid);
      this.setState(client.id, this.fsmFire(client, "request"));
      this.processed[client.id] = (this.processed[client.id] || 0) + 1;
      const root = { fromId: client.id, toId: firstEdge.to, edge: firstEdge, icon, depth: 0,
        ancestors: new Set([client.id]), onDone: null, root: true, startT: this.tNow };
      this.sendCall(root);
    }
    sendCall(call) {
      if (call.root) this.inflight++;
      call.uid = call.uid || ("c" + (++this.cuid));
      // every outgoing request leaves a "ghost" of the in-flight identicon where it originated.
      // offspring nest as a ghost chip inside their parent's parked counter row (same row as the
      // parent identicon); a root request gets its own ghost row at the client (the same identicon
      // that leaves the right edge). it stays until the matching response returns (or is lost).
      let slot;
      if (call.parent) slot = this.attachGhost(call.fromId, call.parent.uid, call);
      else { this.parkGhost(call.fromId, call); slot = (this.occupants[call.fromId] || []).length - 1; }
      const p = this.spawn(call.edge, "fwd", "req", { kind: "req", call, icon: call.icon });
      // the live sprite launches out of that row's slot, then flies to the pipe mouth before travelling.
      p.phase = "launch"; p.launchStart = this.tNow; p.launchNodeId = call.fromId; p.launchSlot = Math.max(0, slot);
    }
    spawn(edge, dir, kind, meta) {
      const color = kind === "res" ? (meta.error ? "var(--red)" : "#f6f3ec")
        : (S.PROTOCOLS[edge.protocol] ? S.PROTOCOLS[edge.protocol].color : "#aaa");
      const p = { id: ++this.pid, edgeId: edge.id, dir, kind, start: this.tNow, dur: TRAVEL, prog: 0, color, r: kind === "res" ? 3.2 : 4.2, meta };
      const loss = this.opts.getLoss ? this.opts.getLoss() : 0;
      if (loss && Math.random() * 100 < loss) { p.lost = true; p.dropAt = 0.30 + Math.random() * 0.40; }
      this.packets.push(p); return p;
    }

    arrive(p) {
      if (p.meta.kind === "fan") { const e = this.edgeOf(p.edgeId); if (e) this.flash(e.to); return; }
      if (p.meta.kind === "req") return this.handleCall(p.meta.call);
      if (p.meta.kind === "res") return this.resolveCall(p.meta.call, p);
    }

    handleCall(call) {
      const node = this.nodeOf(call.toId); if (!node) return;
      this.flash(call.toId); this.processed[call.toId] = (this.processed[call.toId] || 0) + 1;
      if (this.opts.getBreakpoints()[call.toId] && this.running && !this.paused) {
        this.paused = true; this.opts.onBreak && this.opts.onBreak(call.toId); this.log("warn", `breakpoint · ${node.label}`);
      }
      this.setState(call.toId, this.fsmFire(node, ARRIVE_EVENT[node.type] || "request"));
      this.park(call.toId, call);
      const proc = jit(PROCMS[node.type] || 20); call.proc = proc;
      const errRate = this.opts.getErrorRate ? this.opts.getErrorRate() : 0;
      const faulted = node.type === "server" && Math.random() < errRate;

      if (node.type === "queue") {
        this.depth[call.toId] = (this.depth[call.toId] || 0) + 1; this._dirty = true;
        const cons = this.graph().edges.filter(e => e.from === call.toId);
        this.schedule(jit(TRAVEL * 0.5), () => {
          cons.forEach((e, k) => this.spawn(e, "fwd", "req", { kind: "fan", icon: ID().mutate(call.icon, "evt" + k) }));
          this.depth[call.toId] = Math.max(0, this.depth[call.toId] - 1); this.setState(call.toId, this.fsmFire(node, "tick")); this._dirty = true;
          this.depart(call, { error: false, payload: [] });
        });
        return;
      }
      if (faulted) {
        this.setState(call.toId, this.fsmFire(node, "fault"));
        this.schedule(TRAVEL * 0.5, () => this.setState(call.toId, this.fsmFire(node, "recover")));
        this.schedule(jit(TRAVEL * 0.5), () => this.depart(call, { error: true, payload: [] }));
        return;
      }
      let childEdges = [];
      const outs = this.graph().edges.filter(e => e.from === call.toId && !call.ancestors.has(e.to));
      if (this.isRouter(node)) {
        const fwd = outs.filter(e => { const t = this.typeOf(e.to); return t === "server" || t === "loadbalancer" || t === "cdn"; });
        if (fwd.length) { const k = (this.rrIndex[call.toId] = (this.rrIndex[call.toId] || 0) + 1) % fwd.length; childEdges = [fwd[k]]; }
      } else if (node.type === "server") {
        childEdges = outs.filter(e => { const t = this.typeOf(e.to); return t === "server" || t === "database" || t === "cache" || t === "store" || t === "queue"; });
      }
      if (call.depth >= 8) childEdges = [];

      if (!childEdges.length) { // leaf -> return data
        this.schedule(jit(TRAVEL * 0.7), () => {
          this.setState(call.toId, this.fsmFire(node, "done"));
          let payload = [];
          if (node.type === "database" || node.type === "cache" || node.type === "store") {
            const rows = 1 + Math.floor(Math.random() * 2);
            for (let k = 0; k < rows; k++) payload.push({ icon: ID().mutate(call.icon, "row" + k), error: false, mod: 0 });
          }
          this.depart(call, { error: false, payload });
        });
        return;
      }
      // orchestrate: fan out, then join
      this.schedule(proc, () => {
        call.pending = childEdges.length; call.results = [];
        childEdges.forEach((ce, k) => {
          const childIcon = ID().mutate(call.icon, k);
          const child = { fromId: call.toId, toId: ce.to, edge: ce, icon: childIcon, depth: call.depth + 1,
            ancestors: new Set([...call.ancestors, call.toId]), parent: call,
            onDone: (res) => {
              call.results.push({ icon: res.icon, error: res.error, payload: res.payload, mod: res.mod });
              if (--call.pending === 0) {
                const anyErr = call.results.some(r => r.error);
                this.schedule(proc * 0.5, () => { this.setState(call.toId, this.fsmFire(node, anyErr ? "fault" : "done")); this.depart(call, { error: anyErr, payload: call.results }); });
              }
            } };
          this.sendCall(child);
        });
      });
    }

    park(nodeId, call) {
      const arr = this.occupants[nodeId] || (this.occupants[nodeId] = []);
      arr.push({ uid: call.uid, icon: call.icon, error: false });
      if (arr.length > 24) arr.shift();
      this._dirty = true;
    }
    parkGhost(nodeId, call) {
      const arr = this.occupants[nodeId] || (this.occupants[nodeId] = []);
      arr.push({ uid: call.uid, icon: call.icon, error: false, ghost: true });
      if (arr.length > 24) arr.shift();
      this._dirty = true;
    }
    // attach an offspring ghost chip onto its parent's parked counter row; returns that row's slot index
    attachGhost(nodeId, parentUid, call) {
      const arr = this.occupants[nodeId];
      if (arr) {
        const ent = arr.find(o => o.uid === parentUid && !o.ghost);
        if (ent) {
          (ent.ghosts || (ent.ghosts = [])).push({ uid: call.uid, icon: call.icon, error: false });
          this._dirty = true;
          return arr.indexOf(ent);
        }
      }
      // parent row not found (e.g. shifted out) — fall back to a standalone ghost row
      this.parkGhost(nodeId, call);
      return (this.occupants[nodeId] || []).length - 1;
    }
    clearGhost(call) {
      const arr = this.occupants[call.fromId];
      if (!arr) return;
      if (call.parent) {
        const ent = arr.find(o => o.uid === call.parent.uid && o.ghosts);
        if (ent) { const n = ent.ghosts.filter(g => g.uid !== call.uid); if (n.length !== ent.ghosts.length) { ent.ghosts = n; this._dirty = true; } }
        // also clear any standalone fallback ghost row
      }
      const next = arr.filter(o => !(o.uid === call.uid && o.ghost));
      if (next.length !== arr.length) { this.occupants[call.fromId] = next; this._dirty = true; }
    }
    depart(call, res) {
      // capture the parked row's exact world position before it leaves, so the response identicon
      // launches out of the list (not the edge); then fade the row out so the gap closes behind it.
      const node = this.nodeOf(call.toId);
      const arr = this.occupants[call.toId];
      const idx = arr ? arr.findIndex(o => o.uid === call.uid) : -1;
      let from = this.ghostWorld(call.toId, call.uid);
      if (!from && node) from = this.slotWorld(node, idx >= 0 ? idx : 0);
      this.markDeparting(call.toId, call.uid);
      this.respondCall(call, res, from);
    }
    onPacketLost(p) {
      this._dirty = true;
      if (p.meta && p.meta.call) this.failCall(p.meta.call);
      this.log("err", "packet lost in transit · network drop");
    }
    failCall(call) {
      this.clearGhost(call);
      if (call.onDone) call.onDone({ icon: call.icon, error: true, payload: [], mod: call.mod || 140 });
      else { this.inflight = Math.max(0, this.inflight - 1); this.completions.push({ t: this.tNow, latency: 140, error: true }); }
    }
    // a request reaching a node "docks": same sprite flies from the pipe into its counter slot
    startDock(p) {
      p.phase = "dock"; p.dockStart = this.tNow;
      // a request docks at its destination; a response docks back into the caller that dispatched it
      const nodeId = p.kind === "res" ? p.meta.call.fromId : p.meta.call.toId;
      p.dockNodeId = nodeId;
      const occ = this.occupants[nodeId];
      // a returning response flies back into the row that has been holding it open: an offspring
      // lands on its parent's row (where its ghost chip lives); a root lands on its own ghost row.
      if (p.kind === "res" && occ) {
        const c = p.meta.call;
        let idx;
        if (c.parent) idx = occ.findIndex(o => o.uid === c.parent.uid && o.ghosts && o.ghosts.some(g => g.uid === c.uid));
        else idx = occ.findIndex(o => o.uid === c.uid && o.ghost);
        p.dockSlot = idx >= 0 ? idx : occ.length;
      } else {
        p.dockSlot = occ ? occ.length : 0;
      }
    }
    finishDock(p) { if (p.kind === "res") this.resolveCall(p.meta.call, p); else this.handleCall(p.meta.call); }
    slotWorld(node, i) {
      const idx = Math.min(i, 6);
      return { x: node.x + 26, y: node.y + 73 + idx * 38 };
    }
    // exact world centre of a rendered counter element (row or ghost chip) carrying data-uid,
    // mapped out of the packet layer's coordinate space so it is correct at any zoom/pan.
    ghostWorld(nodeId, uid) {
      const layer = this.opts.packetLayerRef.current; if (!layer) return null;
      const nodeEl = document.querySelector('[data-node="' + nodeId + '"]'); if (!nodeEl) return null;
      const el = nodeEl.querySelector('[data-uid="' + uid + '"]'); if (!el) return null;
      let m; try { m = layer.getScreenCTM(); } catch (e) { return null; }
      if (!m) return null;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const inv = m.inverse();
      return { x: inv.a * cx + inv.c * cy + inv.e, y: inv.b * cx + inv.d * cy + inv.f };
    }
    // fade a parked row out and remove it shortly after, so the list animates the gap closed
    markDeparting(nodeId, uid) {
      const arr = this.occupants[nodeId]; if (!arr) return;
      const ent = arr.find(o => o.uid === uid); if (!ent) return;
      ent.departing = true; this._dirty = true;
      this.schedule(320, () => {
        const a2 = this.occupants[nodeId];
        if (a2) { const n = a2.filter(o => o.uid !== uid); if (n.length !== a2.length) { this.occupants[nodeId] = n; this._dirty = true; } }
      });
    }

    respondCall(call, res, from) {
      const net = NETMS[call.edge.protocol] || 18;
      const childMax = (call.results && call.results.length) ? Math.max.apply(null, call.results.map(r => r.mod || 0)) : 0;
      call.mod = net * 2 + (call.proc || 20) + childMax;
      const icon = res.error ? ID().err(call.icon) : call.icon;
      const p = this.spawn(call.edge, "back", "res", { kind: "res", call, icon, payload: res.payload || [], error: res.error, mod: call.mod });
      // the response identicon launches out of the responding node's list to its left-edge mouth,
      // then travels back toward the caller.
      if (from) { p.phase = "launch"; p.launchBack = true; p.launchStart = this.tNow; p.launchNodeId = call.toId; p.launchFrom = from; p.launchFromExact = true; }
    }
    resolveCall(call, p) {
      this.clearGhost(call);
      this.flash(call.fromId);
      if (call.onDone) { call.onDone({ icon: p.meta.icon, error: p.meta.error, payload: p.meta.payload || [], mod: p.meta.mod }); return; }
      // root
      this.setState(call.fromId, this.fsmFire(this.nodeOf(call.fromId), "response"));
      this.inflight = Math.max(0, this.inflight - 1);
      this.completions.push({ t: this.tNow, latency: p.meta.mod || 0, error: p.meta.error });
      if (p.meta.error) this.log("err", `request returned empty-handed · ${Math.round(p.meta.mod)}ms`);
    }

    // ============ shared ============
    flash(id) { this.active[id] = this.tNow + 360; this._dirty = true; }
    setState(id, sid) { if (sid && this.nodeState[id] !== sid) { this.nodeState[id] = sid; this._dirty = true; } }
    fsmFire(node, event) { const cur = this.nodeState[node.id] || node.fsm.current; const t = node.fsm.transitions.filter(x => x.from === cur && x.on === event); return t.length ? t[0].to : cur; }
    pushStats(zero) {
      const comps = this.completions; const rps = zero ? 0 : comps.length;
      const lat = comps.length ? comps.reduce((a, c) => a + c.latency, 0) / comps.length : 0;
      const errs = comps.filter(c => c.error).length; const errRate = comps.length ? (errs / comps.length) * 100 : 0;
      this.opts.onStats && this.opts.onStats({ rps, latency: lat, inflight: this.inflight, errRate, packets: this.packets.length });
    }
    pushState() {
      const occ = {};
      for (const id in this.occupants) if (this.occupants[id].length) occ[id] = this.occupants[id].map(o => ({ uid: o.uid, icon: o.icon, error: o.error, ghost: o.ghost, departing: o.departing, ghosts: o.ghosts ? o.ghosts.map(g => ({ uid: g.uid, icon: g.icon, error: g.error })) : undefined }));
      this.opts.onState && this.opts.onState({ ...this.nodeState }, { ...this.depth }, { ...this.processed }, { ...this.resource }, occ);
    }
    pushActive() { const a = {}; for (const id in this.active) a[id] = true; this.opts.onActive && this.opts.onActive(a); }
    log(level, msg) { this.opts.onLog && this.opts.onLog({ level, msg, t: Math.round(this.tNow) }); }

    // ============ render: sprites + two-lane offset ============
    render() {
      const layer = this.opts.packetLayerRef.current; if (!layer) return;
      const viz = this.opts.getViz ? this.opts.getViz() : "identicons";
      const live = new Set();
      for (const p of this.packets) {
        if (p.phase === "launch") {
          const node = this.nodeOf(p.launchNodeId); if (!node) continue;
          // origin: the exact counter element this identicon left from (ghost chip / row). retry the
          // DOM measure until the element has rendered, then lock it in; fall back to an estimate.
          if (!p.launchFromExact) {
            const w = this.ghostWorld(p.launchNodeId, p.meta.call.uid);
            if (w) { p.launchFrom = w; p.launchFromExact = true; }
            else if (!p.launchFrom) p.launchFrom = this.slotWorld(node, p.launchSlot);
          }
          const pe = this.opts.pathRefs.current[p.edgeId];
          let to;
          if (p.launchBack) {
            // a response launches out of the list to the node's LEFT-edge mouth (path end, response lane)
            to = { x: node.x, y: node.y + 62 };
            if (pe) { try {
              const len = pe.getTotalLength();
              const P = pe.getPointAtLength(len), a2 = pe.getPointAtLength(Math.max(0, len - 2));
              let tx = P.x - a2.x, ty = P.y - a2.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
              const nx = -ty, ny = tx; const off = (viz === "identicons") ? S.LANE : 0;
              to = { x: P.x - nx * off, y: P.y - ny * off };
            } catch (e) {} }
          } else {
            // a request launches to the pipe mouth (path start, request lane), so travel picks up seamlessly
            to = { x: node.x + S.NODE_W, y: node.y + 62 };
            if (pe) { try {
              const len = pe.getTotalLength();
              const P = pe.getPointAtLength(0), b = pe.getPointAtLength(Math.min(len, 2));
              let tx = b.x - P.x, ty = b.y - P.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
              const nx = -ty, ny = tx; const off = (viz === "identicons") ? S.LANE : 0;
              to = { x: P.x + nx * off, y: P.y + ny * off };
            } catch (e) {} }
          }
          const e = Math.min(1, (this.tNow - p.launchStart) / 300); const ee = 1 - (1 - e) * (1 - e);
          const pos = { x: p.launchFrom.x + (to.x - p.launchFrom.x) * ee, y: p.launchFrom.y + (to.y - p.launchFrom.y) * ee };
          let lel = this.dom[p.id];
          if (lel && lel._k !== "i") { lel.remove(); lel = null; }
          if (!lel) { lel = this.buildSprite(p); lel._k = "i"; layer.appendChild(lel); this.dom[p.id] = lel; }
          lel.setAttribute("transform", `translate(${pos.x},${pos.y})`); lel.style.opacity = 1;
          live.add(p.id); continue;
        }
        if (p.phase === "dock") {
          const node = this.nodeOf(p.dockNodeId); if (!node) continue;
          if (!p.dockFrom) {
            const pe = this.opts.pathRefs.current[p.edgeId];
            // responses enter from the caller's outgoing edge mouth (path start); requests from the target end
            let fp = p.kind === "res" ? { x: node.x + S.NODE_W, y: node.y + 62 } : { x: node.x, y: node.y + 62 };
            if (pe) { try { fp = pe.getPointAtLength(p.kind === "res" ? 0 : pe.getTotalLength()); } catch (e) {} }
            p.dockFrom = { x: fp.x, y: fp.y };
          }
          // a response lands exactly on the ghost element it has been holding open; a request lands
          // on its freshly-parked row slot.
          const to = (p.kind === "res" && this.ghostWorld(p.dockNodeId, p.meta.call.uid)) || this.slotWorld(node, p.dockSlot);
          const e = Math.min(1, (this.tNow - p.dockStart) / 300); const ee = 1 - (1 - e) * (1 - e);
          const pos = { x: p.dockFrom.x + (to.x - p.dockFrom.x) * ee, y: p.dockFrom.y + (to.y - p.dockFrom.y) * ee };
          let del = this.dom[p.id];
          if (del && del._k !== "i") { del.remove(); del = null; }
          if (!del) { del = this.buildSprite(p); del._k = "i"; layer.appendChild(del); this.dom[p.id] = del; }
          del.setAttribute("transform", `translate(${pos.x},${pos.y})`); del.style.opacity = 1;
          live.add(p.id); continue;
        }
        const pathEl = this.opts.pathRefs.current[p.edgeId]; if (!pathEl) continue;
        let leakEase = 0;
        if (p.leaking) { const le = Math.min(1, (this.tNow - p.leakStart) / 460); leakEase = 1 - (1 - le) * (1 - le); }
        // a leaking packet keeps its forward momentum: it drifts +10% closer to the target
        // along the route while it slides out into the invisible outer lane — like a car
        // skidding into the guardrail rather than stopping dead.
        const baseProg = p.leaking ? Math.min(1, p.dropAt + 0.10 * leakEase) : p.prog;
        const along = Math.max(0, Math.min(1, p.dir === "back" ? (1 - baseProg) : baseProg));
        let len, P, a, b;
        try { len = pathEl.getTotalLength(); const at = along * len; P = pathEl.getPointAtLength(at); a = pathEl.getPointAtLength(Math.max(0, at - 2)); b = pathEl.getPointAtLength(Math.min(len, at + 2)); }
        catch (e) { continue; }
        if (!P || !isFinite(P.x)) continue;
        const useIcon = viz === "identicons" && p.meta && p.meta.icon;
        let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = -ty, ny = tx; const sign = p.kind === "res" ? -1 : 1;
        let ox = useIcon ? nx * S.LANE * sign : 0, oy = useIcon ? ny * S.LANE * sign : 0;
        let opacity = 1;
        if (p.leaking) {
          const e = leakEase;
          // slip from the inner (visible) lane out to the outer (external) lane of the same pipe — no scatter, no gravity
          const outer = S.LANE * 1.35;
          ox += nx * e * outer * sign; oy += ny * e * outer * sign;
          opacity = 1 - e * e;
        }
        const pos = { x: P.x + ox, y: P.y + oy };
        let el = this.dom[p.id];
        const want = useIcon ? "i" : "d";
        if (el && el._k !== want) { el.remove(); el = null; }
        if (!el) { el = useIcon ? this.buildSprite(p) : this.buildDot(p); el._k = want; layer.appendChild(el); this.dom[p.id] = el; }
        if (useIcon) { el.setAttribute("transform", `translate(${pos.x},${pos.y})`); el.style.opacity = opacity; }
        else { el.setAttribute("cx", pos.x); el.setAttribute("cy", pos.y); el.setAttribute("opacity", opacity); }
        live.add(p.id);
      }
      for (const id in this.dom) if (!live.has(+id)) { this.dom[id].remove(); delete this.dom[id]; }
    }
    buildDot(p) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("r", p.r); el.setAttribute("fill", p.color);
      el.style.filter = "drop-shadow(0 0 5px " + (p.kind === "res" ? "rgba(246,243,236,.6)" : "rgba(0,0,0,0)") + ")";
      return el;
    }
    buildSprite(p) {
      const NS = "http://www.w3.org/2000/svg", XL = "http://www.w3.org/1999/xlink";
      const Sz = S.ICON;
      const g = document.createElementNS(NS, "g");
      g.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.55))";
      // container ring conveys kind: request / response-with-data / response-error
      const ring = document.createElementNS(NS, "rect");
      const pad = 3.5;
      ring.setAttribute("x", -Sz / 2 - pad); ring.setAttribute("y", -Sz / 2 - pad);
      ring.setAttribute("width", Sz + pad * 2); ring.setAttribute("height", Sz + pad * 2);
      ring.setAttribute("rx", 7); ring.setAttribute("fill", "none"); ring.setAttribute("stroke-width", 2.5);
      ring.setAttribute("stroke", p.kind === "res" ? (p.meta.error ? "var(--red)" : "var(--tone-ok)") : "rgba(240,237,230,0.32)");
      if (p.kind === "res") ring.setAttribute("stroke-dasharray", "");
      g.appendChild(ring);
      const main = document.createElementNS(NS, "image");
      const u = window.Identicon.url(p.meta.icon, 48);
      main.setAttribute("href", u); main.setAttributeNS(XL, "href", u);
      main.setAttribute("x", -Sz / 2); main.setAttribute("y", -Sz / 2); main.setAttribute("width", Sz); main.setAttribute("height", Sz);
      main.setAttribute("preserveAspectRatio", "none"); main.style.imageRendering = "pixelated";
      g.appendChild(main);
      const pay = (p.meta.payload || []).slice(0, 4);
      if (pay.length) {
        const ms = Sz * 0.5;
        pay.forEach((it, i) => {
          const m = document.createElementNS(NS, "image");
          const iu = window.Identicon.url(it.error ? window.Identicon.err(it.icon) : it.icon, 32);
          m.setAttribute("href", iu); m.setAttributeNS(XL, "href", iu);
          const bx = Sz / 2 - ms * 0.35 + (i % 2) * (ms * 0.55);
          const by = Sz / 2 - ms * 0.35 + Math.floor(i / 2) * (ms * 0.55);
          m.setAttribute("x", bx - ms / 2); m.setAttribute("y", by - ms / 2); m.setAttribute("width", ms); m.setAttribute("height", ms);
          m.setAttribute("preserveAspectRatio", "none"); m.style.imageRendering = "pixelated";
          g.appendChild(m);
        });
      }
      return g;
    }
  }
  window.SimEngine = SimEngine;
})();
