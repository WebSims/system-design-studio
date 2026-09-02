import type { GenStrategy, Literal, RequestField, Workflow } from "@sds/schema";
import type { Row } from "./state";

/**
 * Request identity generation.
 *
 * WHY THIS IS IN THE KERNEL RATHER THAN IN THE SIMULATOR
 *
 * Because identity is the independent variable of every correctness question. Which
 * requests share a user, which share an idempotency key, which are the same logical
 * request arriving twice -- those facts decide whether a race is reachable, and if the
 * two engines generated them differently then a counterexample found by one would not
 * reproduce in the other. The conformance test would pass on operations and the product
 * would still be incoherent.
 *
 * So both engines call `generateRequest`. The explorer supplies an enumerating source
 * (it walks a small finite domain); the simulator supplies its seeded RNG. The function
 * itself is deterministic given its source, which is what makes a simulator run
 * reproducible from its seed.
 */

/** Minimal randomness interface, so the kernel does not depend on the engine's RNG. */
export interface RandomSource {
  /** Uniform in [0, 1). */
  next(): number;
}

/**
 * Per-field memory across requests.
 *
 * Two things live here, and both are essential rather than incidental.
 *
 * `counters` backs the `sequence` strategy: a unique value per request, which is the
 * baseline that must NOT produce contention. If a design shows a race under sequence
 * generation, the race does not need concurrency of identity to happen.
 *
 * `previous` backs the `duplicate` strategy: the value a field took last time, so the
 * same logical intent can arrive twice. Without this the workload could never exhibit
 * a duplicate submission, and a tool that could not exhibit one would report every
 * design free of duplicate-claim bugs.
 */
export interface GenState {
  counters: Record<string, number>;
  previous: Record<string, Literal>;
  /** Zipf cumulative tables, built once per field. */
  zipf: Record<string, Float64Array>;
}

export function newGenState(): GenState {
  return { counters: {}, previous: {}, zipf: {} };
}

/**
 * Generate one request's fields.
 *
 * Fields are generated in DECLARATION ORDER, and `idempotencyKey` reads the fields
 * already generated. So a key derived from `userId` must be declared after it. That is a
 * validated constraint rather than a runtime surprise, and it is ordered rather than
 * resolved by dependency because the ordering is also the ordering a reader assumes when
 * scanning the list.
 */
export function generateRequest(
  wf: Workflow,
  state: GenState,
  rng: RandomSource
): Row {
  const row: Row = {};
  for (const field of wf.requestFields) {
    const v = generateField(field, row, state, rng);
    if (v !== null) {
      row[field.name] = v;
      state.previous[field.name] = v;
    }
  }
  return row;
}

function generateField(
  field: RequestField,
  soFar: Row,
  state: GenState,
  rng: RandomSource
): Literal | null {
  return drawStrategy(field, field.strategy, soFar, state, rng);
}

function drawStrategy(
  field: RequestField,
  s: GenStrategy,
  soFar: Row,
  state: GenState,
  rng: RandomSource
): Literal | null {
  switch (s.kind) {
    case "constant":
      return s.value;

    case "sequence": {
      const n = state.counters[field.name] ?? 0;
      state.counters[field.name] = n + 1;
      const value = s.start + n * s.step;
      return field.type === "string" || field.type === "enum" ? `${s.prefix}${value}` : value;
    }

    case "uniform": {
      const span = Math.max(0, s.max - s.min);
      const value = s.min + Math.floor(rng.next() * (span + 1));
      return field.type === "string" || field.type === "enum" ? `${s.prefix}${value}` : value;
    }

    case "choice": {
      const total = s.weights.length === s.values.length
        ? s.weights.reduce((a, b) => a + b, 0)
        : 0;
      if (total <= 0) {
        const i = Math.min(s.values.length - 1, Math.floor(rng.next() * s.values.length));
        return s.values[i] ?? null;
      }
      let target = rng.next() * total;
      for (let i = 0; i < s.values.length; i++) {
        target -= s.weights[i] ?? 0;
        if (target <= 0) return s.values[i] ?? null;
      }
      return s.values[s.values.length - 1] ?? null;
    }

    case "zipf": {
      const table = zipfTable(field.name, s.keys, s.skew, state);
      const target = rng.next() * table[table.length - 1]!;
      // Binary search over the cumulative table. Exact inverse transform, not a
      // rejection method, so the draw costs one log-time lookup regardless of skew.
      let lo = 0;
      let hi = table.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (table[mid]! < target) lo = mid + 1;
        else hi = mid;
      }
      const rank = lo + 1;
      return field.type === "string" || field.type === "enum" ? `${s.prefix}${rank}` : rank;
    }

    case "duplicate": {
      const previous = state.previous[field.name];
      if (previous !== undefined && rng.next() < s.probability) return previous;
      return drawStrategy(field, s.fallback, soFar, state, rng);
    }

    case "idempotencyKey": {
      // A deterministic function of the named fields, and nothing else. Stable across
      // retries of the same logical request BECAUSE it is derived from that request's
      // content, and colliding between two genuinely distinct requests with identical
      // content -- which is a real hazard, so the model reproduces it rather than
      // salting it away.
      const parts = s.of.map((name) => {
        const v = soFar[name];
        return v === undefined ? "\u0000" : `${typeof v}:${String(v)}`;
      });
      return `${s.prefix}${fnv(parts.join("|"))}`;
    }
  }
}

function zipfTable(name: string, keys: number, skew: number, state: GenState): Float64Array {
  const cached = state.zipf[name];
  if (cached && cached.length === keys) return cached;
  const table = new Float64Array(keys);
  let sum = 0;
  for (let i = 0; i < keys; i++) {
    sum += 1 / Math.pow(i + 1, skew);
    table[i] = sum;
  }
  state.zipf[name] = table;
  return table;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// exploration domains
// ---------------------------------------------------------------------------

/**
 * The finite set of values a field may take during exploration.
 *
 * THE EXPLORER DOES NOT SAMPLE. It enumerates, so it needs a small explicit domain, and
 * the honest way to get one is to say so rather than to quietly truncate a Zipf over a
 * million keys to its first two ranks and let a reader believe the search covered the
 * declared workload.
 *
 * Resolution order, and the reason for it:
 *
 *   1. The study's `identityDomains` override. Study-level, so every candidate contends
 *      over the same identities -- otherwise a candidate could win by being tested
 *      against a workload with no collisions in it.
 *   2. The field's own `exploreDomain`.
 *   3. A derived default.
 *
 * The derived default for a `sequence` field is TWO values, not one. One value would
 * make every request identical and no design could ever exhibit two contenders; three
 * would triple the space to demonstrate what two already demonstrate. For a `constant`
 * field it is that constant, because there is nothing else it could be.
 */
export function exploreDomain(
  field: RequestField,
  overrides: Record<string, readonly Literal[]>
): Literal[] {
  const override = overrides[field.name];
  if (override && override.length > 0) return [...override];
  if (field.exploreDomain.length > 0) return [...field.exploreDomain];
  return derivedDomain(field);
}

function derivedDomain(field: RequestField): Literal[] {
  const s = field.strategy;
  const stringy = field.type === "string" || field.type === "enum";
  switch (s.kind) {
    case "constant":
      return [s.value];
    case "choice":
      // Every declared choice, capped at two. The cap is the same reasoning as above:
      // a third distinct value adds a witness, not a behaviour.
      return s.values.slice(0, 2);
    case "sequence":
      return stringy
        ? [`${s.prefix}${s.start}`, `${s.prefix}${s.start + s.step}`]
        : [s.start, s.start + s.step];
    case "uniform":
      return stringy ? [`${s.prefix}${s.min}`, `${s.prefix}${s.max}`] : [s.min, s.max];
    case "zipf":
      // Rank 1 and rank 2. Under any skew above zero these are the two values that
      // actually collide, so they are also the pair most likely to race.
      return stringy ? [`${s.prefix}1`, `${s.prefix}2`] : [1, 2];
    case "duplicate":
      return derivedDomain({ ...field, strategy: s.fallback });
    case "idempotencyKey":
      // Derived, so it is not enumerated independently: doing so would generate keys
      // inconsistent with the fields they claim to be derived from, and the explorer
      // would then find "bugs" reachable only in a world where a client computed its
      // idempotency key wrong. `deriveKeys` fills these in after enumeration.
      return [];
  }
}

/**
 * Fill derived fields for an enumerated request.
 *
 * Called by the explorer after it has chosen a value for every independent field, so
 * that an idempotency key in an explored request is exactly the key the simulator would
 * have produced for the same request. Without this the two engines would disagree about
 * identity while agreeing about operations, which is the subtlest possible way for the
 * product to become incoherent.
 */
export function deriveKeys(wf: Workflow, row: Row): Row {
  const out: Row = { ...row };
  for (const field of wf.requestFields) {
    if (field.strategy.kind !== "idempotencyKey") continue;
    const s = field.strategy;
    const parts = s.of.map((name) => {
      const v = out[name];
      return v === undefined ? "\u0000" : `${typeof v}:${String(v)}`;
    });
    out[field.name] = `${s.prefix}${fnv(parts.join("|"))}`;
  }
  return out;
}

/**
 * Every combination of the explored domains, in deterministic order.
 *
 * Bounded by the product of the domain sizes, which validation caps at eight values per
 * field. The explorer draws actor identities from the head of this list, so the first
 * two actors always differ in the first declared field -- which is the arrangement most
 * likely to reach a contention bug in the fewest transitions, and therefore to yield the
 * shortest counterexample.
 */
export function enumerateRequests(
  wf: Workflow,
  overrides: Record<string, readonly Literal[]>,
  limit: number
): Row[] {
  const independent = wf.requestFields.filter((f) => f.strategy.kind !== "idempotencyKey");
  let rows: Row[] = [{}];
  for (const field of independent) {
    const domain = exploreDomain(field, overrides);
    if (domain.length === 0) continue;
    const next: Row[] = [];
    for (const row of rows) {
      for (const v of domain) {
        next.push({ ...row, [field.name]: v });
        if (next.length >= limit * 4) break;
      }
      if (next.length >= limit * 4) break;
    }
    rows = next;
  }
  return rows.slice(0, limit).map((r) => deriveKeys(wf, r));
}
