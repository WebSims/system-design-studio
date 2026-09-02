import type { Collection, Literal, Workflow } from "@sds/schema";

/**
 * The world: every piece of state both engines share.
 *
 * WHY ONE STATE TYPE FOR TWO ENGINES
 *
 * Because the alternative was tried by every tool that models correctness and
 * performance in the same product, and it fails the same way each time. The explorer
 * grows its own notion of a lease, the simulator grows another, and eventually one
 * says the design is safe while the other says it is broken. Both are then right about
 * their own model and the product is worthless, because a user cannot tell which model
 * they are being shown.
 *
 * So there is one state shape, one transition function over it, and a conformance test
 * that applies every operation through both engines and compares the resulting state
 * byte for byte.
 *
 * WHY PLAIN OBJECTS RATHER THAN A PERSISTENT DATA STRUCTURE
 *
 * The explorer forks state constantly, so an immutable map with structural sharing is
 * the obvious choice. It is the wrong one here for two reasons. First, the states are
 * small by construction -- a handful of counters, a table with tens of rows, three
 * frames -- so the copy is cheap and the pointer-chasing of a HAMT is not. Second, and
 * decisively, plain objects serialise canonically with no custom code, and canonical
 * serialisation is what duplicate-state detection depends on. A bug in a hand-written
 * hash for a clever data structure would silently prune reachable states, and the
 * symptom would be a false "no violation found" -- the one failure this tool must not
 * have.
 */

/** A table row. Keys are field names declared by the collection. */
export type Row = Record<string, Literal>;

/**
 * A lease held on one key.
 *
 * `token` is the fencing generation. It increments every time the key is granted to
 * anyone, and it never decreases, including across expiry -- which is precisely the
 * property that lets a datastore reject a writer whose lease was reassigned while it
 * was working. A token that reset on release would be worthless.
 */
export interface LeaseState {
  owner: string;
  token: number;
  grantedAt: number;
  expiresAt: number;
}

/**
 * A message sitting in a queue.
 *
 * `inflightOwner` is the model of a visibility timeout: non-null means some consumer
 * has taken the message and has not yet acknowledged it. An at-least-once queue may
 * hand it to somebody else anyway, which is what `deliveries > 1` records.
 */
export interface QueuedMessage {
  id: number;
  queue: string;
  body: Row;
  deliveries: number;
  inflightOwner: string | null;
  acked: boolean;
  /** Stopped being redelivered after exhausting `maxRedeliveries`. */
  abandoned: boolean;
  enqueuedAt: number;
}

/** An armed expiry timer. */
export interface Timer {
  id: number;
  handler: string;
  args: Row;
  dueAt: number;
  fired: boolean;
  /** Actor that armed it, for the trace. */
  armedBy: string;
}

export interface WorldState {
  counters: Record<string, number>;
  /** collection id -> (row key -> row). */
  tables: Record<string, Record<string, Row>>;
  /** `${lockId}\u0000${key}` -> lease. Absent means free. */
  leases: Record<string, LeaseState>;
  /**
   * Highest token ever issued per lease key, retained after release.
   *
   * Separate from `leases` because it must outlive the lease. This is the one field
   * in the world that is monotone by design, and it is the mechanism fencing rests on.
   */
  leaseGeneration: Record<string, number>;
  messages: QueuedMessage[];
  timers: Timer[];
  /**
   * Logical clock, milliseconds.
   *
   * In the simulator this is the discrete-event clock. In the explorer it is the
   * transition count, because the explorer does not model duration -- it fires expiry
   * as a *transition it may choose*, at any point, rather than by comparing a clock.
   * That is strictly stronger: it reaches the interleaving where a lease expires one
   * operation before its holder commits, which no clock-driven model reliably will.
   *
   * The consequence, and it is a real cost: a workflow that writes `now()` into state
   * makes almost every interleaving produce a distinct state, so deduplication stops
   * working and the search space explodes. Validation warns about it.
   */
  nowMs: number;
  /** Business outcome tallies, keyed by the label on a `respond` operation. */
  outcomes: Record<string, number>;
  /** Monotonic id source for messages and timers. */
  nextId: number;
}

/**
 * Build the initial world from a workflow's declarations.
 *
 * Seeded rows are inserted in declaration order and keyed by the table's key field. A
 * seed row missing its key is dropped rather than given a synthetic one, because a row
 * whose identity the study did not state cannot participate in a uniqueness argument.
 */
export function initialWorld(wf: Workflow): WorldState {
  const counters: Record<string, number> = {};
  const tables: Record<string, Record<string, Row>> = {};

  for (const c of wf.collections) {
    if (c.kind === "counter") {
      counters[c.id] = c.initial;
    } else {
      const rows: Record<string, Row> = {};
      for (const seed of c.seed) {
        const key = seed[c.key];
        if (key === undefined) continue;
        rows[String(key)] = completeRow(c, seed);
      }
      tables[c.id] = rows;
    }
  }

  return {
    counters,
    tables,
    leases: {},
    leaseGeneration: {},
    messages: [],
    timers: [],
    nowMs: 0,
    outcomes: {},
    nextId: 1,
  };
}

/**
 * Fill a row's unstated fields from their declared defaults.
 *
 * Absent-versus-default matters: an insert that names only the key must produce a row
 * whose other fields read as their declared default rather than as absent, or an
 * invariant comparing them would silently be comparing against nothing.
 */
export function completeRow(c: Collection, partial: Row): Row {
  if (c.kind !== "table") return { ...partial };
  const out: Row = {};
  for (const f of c.fields) {
    const given = partial[f.name];
    if (given !== undefined) out[f.name] = given;
    else if (f.default !== null) out[f.name] = f.default;
  }
  return out;
}

export function leaseKey(lock: string, key: Literal): string {
  return `${lock}\u0000${String(key)}`;
}

// ---------------------------------------------------------------------------
// copying
// ---------------------------------------------------------------------------

/**
 * Copy-on-write helpers.
 *
 * Every mutation in the kernel goes through one of these, so a caller that holds a
 * `WorldState` can rely on it never changing underneath. The explorer depends on that
 * absolutely: it keeps a state in a queue for thousands of transitions before
 * expanding it, and a shared mutable sub-object would corrupt the search in a way that
 * shows up as a missing counterexample rather than as a crash.
 *
 * Only the touched branch is copied. A write to one counter does not copy the tables.
 */
export function withCounter(w: WorldState, id: string, value: number): WorldState {
  return { ...w, counters: { ...w.counters, [id]: value } };
}

export function withRow(w: WorldState, collection: string, key: string, row: Row | null): WorldState {
  const table = { ...(w.tables[collection] ?? {}) };
  if (row === null) delete table[key];
  else table[key] = row;
  return { ...w, tables: { ...w.tables, [collection]: table } };
}

export function withLease(w: WorldState, lk: string, lease: LeaseState | null): WorldState {
  const leases = { ...w.leases };
  if (lease === null) delete leases[lk];
  else leases[lk] = lease;
  return { ...w, leases };
}

export function withMessages(w: WorldState, messages: QueuedMessage[]): WorldState {
  return { ...w, messages };
}

export function withTimers(w: WorldState, timers: Timer[]): WorldState {
  return { ...w, timers };
}

/**
 * Drop messages and timers that can never do anything again.
 *
 * WHY THIS IS SEMANTICS AND NOT HOUSEKEEPING
 *
 * An acknowledged message cannot be delivered, redelivered, read or acked. An abandoned one
 * cannot either. A fired timer cannot fire again. Nothing in the kernel, in the explorer, or in
 * the simulator ever reads one of them, and everything they accomplished is already recorded
 * where it belongs -- their writes are in the tables, their tallies are in the outcomes, their
 * counts are in the metrics the runtime accumulated from the events.
 *
 * So retaining them is not conservative, it is wrong in two separate ways.
 *
 * For the EXPLORER it splits states that are identical. Two worlds differing only in how many
 * finished messages are lying around behave identically forever, and giving them different keys
 * means exploring the same future twice.
 *
 * For the SIMULATOR it was quadratic. Every publish copied the whole array and scanned it to
 * check the queue depth, so a run publishing forty thousand messages did on the order of a
 * billion array operations -- which measured as ninety-seven seconds for a run that should take
 * one, and it was the single worst performance defect in the stateful layer.
 *
 * Called by both engines through the same function, so the two cannot disagree about what the
 * world contains.
 */
export function pruneFinished(w: WorldState): WorldState {
  const messages = w.messages.filter((m) => !m.acked && !m.abandoned);
  const timers = w.timers.filter((t) => !t.fired);
  if (messages.length === w.messages.length && timers.length === w.timers.length) return w;
  return { ...w, messages, timers };
}

export function withOutcome(w: WorldState, label: string): WorldState {
  return { ...w, outcomes: { ...w.outcomes, [label]: (w.outcomes[label] ?? 0) + 1 } };
}

// ---------------------------------------------------------------------------
// canonical hashing
// ---------------------------------------------------------------------------

/**
 * A canonical string for a world plus its actors, used to recognise a state already
 * visited.
 *
 * THREE PROPERTIES, IN ORDER OF HOW BADLY IT MATTERS IF THEY FAIL
 *
 *  1. Equal states must hash equal. If they do not, the search is merely slower.
 *  2. UNEQUAL STATES MUST NOT HASH EQUAL. If they do, reachable states are pruned and
 *     the tool reports "no violation found" for a design that has one. This is why the
 *     canonical form is a full string rather than a 32-bit digest: the explorer keys
 *     its visited set on the string itself, so there is no collision to worry about.
 *     A digest is offered separately for reporting, where a collision is harmless.
 *  3. It must be stable across builds and machines, so a cached result stays valid.
 *
 * MESSAGE AND TIMER IDENTITY
 *
 * Ids are allocation order, and allocation order is an artefact of which interleaving
 * got there first, not a property of the state. Two worlds that differ only in which
 * of two identical messages was numbered 1 are the same world. So messages and timers
 * are canonicalised by CONTENT: sorted, renumbered by position, and any frame
 * referring to a message refers to its sorted position instead of its id.
 *
 * This is ordinary symmetry reduction and it is worth the code. Without it, a workflow
 * that publishes two messages explores both orderings of an unordered pair, doubling
 * the space for no additional behaviour -- and the doubling compounds with every
 * further publish.
 */
export function canonicalKey(w: WorldState, frames: readonly FrameLike[]): string {
  const out: string[] = [];

  // ---- counters ----
  out.push("C");
  for (const id of sortedKeys(w.counters)) {
    out.push(id, "=", String(w.counters[id]));
  }

  // ---- tables ----
  out.push("|T");
  for (const cid of sortedKeys(w.tables)) {
    out.push(cid, "{");
    const table = w.tables[cid]!;
    for (const key of Object.keys(table).sort()) {
      out.push(key, ":");
      writeRow(out, table[key]!);
      out.push(";");
    }
    out.push("}");
  }

  // ---- leases ----
  out.push("|L");
  for (const lk of sortedKeys(w.leases)) {
    const l = w.leases[lk]!;
    // `expiresAt` and `grantedAt` are EXCLUDED. Both are derived from the clock, which is
    // itself excluded (see below), and including them would split states that differ only in
    // how many transitions had elapsed when the lease was taken. The token is included
    // because it is what fencing compares against.
    out.push(lk, "=", l.owner, "/", String(l.token), ";");
  }

  out.push("|G");
  for (const lk of sortedKeys(w.leaseGeneration)) {
    out.push(lk, "=", String(w.leaseGeneration[lk]), ";");
  }

  // ---- messages, canonicalised by content ----
  //
  // Ids are allocation order, and allocation order is an artefact of which interleaving got
  // there first rather than a property of the state. Two worlds that differ only in which of
  // two identical messages was numbered first are the same world, so messages are sorted by
  // content and any frame referring to one refers to its sorted position instead of its id.
  const messageOrder = canonicalMessageOrder(w.messages);
  const messageIndex = new Map<number, number>();
  out.push("|M");
  for (let i = 0; i < messageOrder.length; i++) {
    const m = messageOrder[i]!;
    messageIndex.set(m.id, i);
    out.push(m.queue, ":", String(m.deliveries), m.acked ? "a" : "-", m.abandoned ? "x" : "-");
    out.push(m.inflightOwner ?? "", ":");
    writeRow(out, m.body);
    out.push(";");
  }

  out.push("|X");
  for (const t of canonicalTimerOrder(w.timers)) {
    out.push(t.handler, t.fired ? "f" : "-", ":");
    writeRow(out, t.args);
    out.push(";");
  }

  out.push("|O");
  for (const label of sortedKeys(w.outcomes)) {
    out.push(label, "=", String(w.outcomes[label]), ";");
  }

  // The clock is deliberately EXCLUDED.
  //
  // In the explorer it is the transition count, so including it would make every state
  // unique by depth and defeat deduplication entirely. Nothing in the explorer's semantics
  // reads it as a condition -- expiry is a chosen transition, not a clock comparison -- so
  // two worlds differing only in elapsed transitions really are the same world. If a
  // workflow writes `now()` into a collection, that value is in the tables above and does
  // distinguish the states, correctly.

  // ---- frames ----
  //
  // Actors are interchangeable: two worlds differing only in which actor is doing which half
  // of the same pair of jobs are the same world. Serialising each frame independently and
  // then sorting the strings captures that, and it is the single largest reduction in the
  // search -- the actor count enters the state space factorially without it.
  const frameKeys: string[] = [];
  for (const f of frames) {
    const parts: string[] = [f.handlerId, "@"];
    if (f.status === "running") {
      // A TERMINAL frame is compressed to its handler and status.
      //
      // Nothing reads a finished actor's program counter, locals, request or tokens ever
      // again -- the fencing check runs only when a frame steps, and a terminal frame does
      // not. Anything a dead actor left behind that still matters is in the world: its
      // writes are in the tables, its lease is in the leases, its unacked message is in the
      // messages. Carrying its private state would split states that are genuinely
      // identical, and the split compounds with every actor that finishes.
      parts.push(String(f.pc), "/");
      writeRow(parts, f.locals);
      parts.push("/");
      writeRow(parts, f.request);
      parts.push("/", f.messageId === null ? "-" : String(messageIndex.get(f.messageId) ?? -1));
      parts.push("/");
      writeRow(parts, f.tokens);
    } else {
      parts.push(f.status);
    }
    frameKeys.push(parts.join(""));
  }
  frameKeys.sort();
  out.push("|F");
  for (const k of frameKeys) out.push(k, ";");

  return out.join("");
}

/**
 * Sorted keys of a plain object.
 *
 * Extracted so the sort is in one place. `Object.keys` order is insertion order for string
 * keys, and insertion order in the explorer is interleaving order, so sorting is not
 * cosmetic -- it is what makes two equal states produce equal keys.
 */
function sortedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort();
}

/**
 * Serialise a row into the parts array.
 *
 * The type tag matters: `1` and `"1"` are different values in this domain, and a key that
 * conflated them would merge two states that behave differently -- the `insertUnique` on a
 * numeric key and on its string spelling would appear to collide when they do not.
 *
 * Strings are emitted with a length prefix rather than quoted and escaped. `JSON.stringify`
 * on every string of every row of every state was the single largest cost in the search, and
 * a length prefix is unambiguous without any escaping at all.
 */
function writeRow(out: string[], row: Record<string, string | number | boolean>): void {
  for (const name of Object.keys(row).sort()) {
    const v = row[name]!;
    out.push(name, "=");
    if (typeof v === "string") out.push("s", String(v.length), ":", v);
    else if (typeof v === "number") out.push("n", String(v));
    else out.push(v ? "T" : "F");
    out.push(",");
  }
}

/** The shape `canonicalKey` needs from a frame. Avoids a circular import. */
export interface FrameLike {
  handlerId: string;
  pc: number;
  locals: Record<string, Literal>;
  request: Row;
  messageId: number | null;
  tokens: Record<string, number>;
  status: string;
}

function canonicalMessageOrder(messages: readonly QueuedMessage[]): QueuedMessage[] {
  if (messages.length < 2) return messages as QueuedMessage[];
  return [...messages].sort((a, b) => {
    const ka = messageSortKey(a);
    const kb = messageSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    // Stable across otherwise-identical messages so the mapping is a function.
    return a.id - b.id;
  });
}

function messageSortKey(m: QueuedMessage): string {
  const parts: string[] = [m.queue, String(m.deliveries), m.acked ? "a" : "-", m.abandoned ? "x" : "-", m.inflightOwner ?? ""];
  writeRow(parts, m.body);
  return parts.join("\u0001");
}

function canonicalTimerOrder(timers: readonly Timer[]): Timer[] {
  if (timers.length < 2) return timers as Timer[];
  return [...timers].sort((a, b) => {
    const ka = timerSortKey(a);
    const kb = timerSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.id - b.id;
  });
}

function timerSortKey(t: Timer): string {
  const parts: string[] = [t.handler, t.fired ? "f" : "-"];
  writeRow(parts, t.args);
  return parts.join("\u0001");
}

/**
 * A short digest of a canonical key, for display and for cache keys.
 *
 * FNV-1a. Collisions are possible and harmless here, because nothing branches on it --
 * the visited set uses the full key.
 */
export function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
