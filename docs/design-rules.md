# Design rules and scope

The rules the tool holds itself to, why it exists in this shape, the architecture, and what is deliberately out of scope.

[< back to the README](../README.md)

## Design rules the tool holds itself to

**It refuses to print numbers it cannot defend.** An unstable design gets "does
not scale" plus where and by how much, never a latency figure — when arrivals
exceed capacity, p99 is a function of run length, which the suite asserts rather
than assumes. A multi-station p99 is withheld because summing per-station p99s
materially overstates the tail.

**It states its own precision, separately for mean and tail.** Reporting one
figure for both overstated confidence in the p99 — the number the SLO is written
against. Caught when the default design's p99 ranged 262–302ms across seeds while
the tool claimed 1% accuracy. It now reports mean ±1.8%, p99 ±3.9%, and warns when
a pass/fail verdict sits inside its own error bar.

**Approximations are labelled.** M/M/c and M/G/1 results are exact. Allen-Cunneen
for M/G/c is not, and says so.

**Non-convergence is a finding, not an error.** Retries make the graph circular:
load raises failures, failures raise retries. The preview solves that by iterating
to a fixed point, and when the loop has positive gain there is no fixed point to
find. The tool reports that divergence rather than capping the numbers and
presenting a steady state that does not exist — because the divergence *is* the
retry storm.

**Fixes are shown as trades.** The contained retry-storm example has a *higher*
error rate and slightly *lower* throughput than the broken one, because
suppressing retries means fewer recoveries. It buys that by keeping both stations
off 100% and p99 at 140ms instead of 2s. Which trade is right is a judgement; the
tool quantifies both sides rather than declaring the fix free.

**Disagreement between methods is reported, not hidden.** On the retry-storm
example the closed form predicts no steady state while the simulation reports
stability — and both are right. The client's 2s deadline turns an unbounded queue
into a bounded one by abandoning 11% of requests. The analyzer says exactly that,
rather than emitting "predicted unstable" next to a stable verdict and leaving the
reader to reconcile it.

**A zero-width interval is not precision.** When every seed returns the identical
p99 it means the metric is clamped — almost always by a client deadline — not that
the measurement is exact. The UI says so rather than letting a `±0.0%` read as
certainty.

**Aggregate percentiles are withheld for time-varying load.** A single p99 over a
ramp averages across regimes that never coexisted, part of it measured at 50/s and
part at 800/s. The figure is still computed, because it is the right thing for a
spike where most of the run *is* the base rate, but the result says what it does and
does not mean and points at the time series.

**The analyzer states what it does not search.** Config search covers capacity
only. Service times are excluded because "make the code twice as fast" is not a
configuration change, and retry settings because they trade error rate against
load rather than strictly improving — a search optimising p99 alone would happily
switch off protections. And with no cost model, it reports the smallest *set* of
changes, never the cheapest.


## Why this exists in this shape

The previous version could not find a bottleneck in principle, not merely in
practice:

| Problem | Where |
|---|---|
| Nodes had unbounded concurrency, so no contention, so no queueing, so latency was independent of load | `legacy/studio/engine.jsx:157` |
| Reported latency was a static sum of invented constants | `legacy/studio/engine.jsx:336` |
| FSM guards like `inflight < capacity` were never evaluated | `legacy/studio/data.jsx:48` |
| Cache hit rate was permanently 100% (first matching transition always won) | `legacy/studio/engine.jsx:357` |
| Every edge took the same 520ms regardless of topology | `legacy/studio/engine.jsx:4` |
| Throughput flattened because of a 150-packet render cap, not the system | `legacy/studio/engine.jsx:92` |
| `Math.random()` throughout, no seed, so no two runs were comparable | throughout |

A bottleneck is a queueing phenomenon. The root cause of all of the above was one
missing object: a capacity-limited resource with a queue.


## Architecture

```
packages/schema     Zod model, structural validation, versioned migrations,
                      the declarative domain layer and the Study document
packages/kernel     THE transition kernel — one implementation of every operation
packages/explore    breadth-first race explorer, counterexamples, bounds
packages/core       the engine — no DOM, no rAF, runs in Node and in a Worker
packages/analytic   closed-form solver: Erlang-B/C, M/M/c, M/M/c/K, P-K
packages/models     cited benchmark constants, presets, examples, the pizza study
packages/analyze    knobs, knees, critical path, sensitivity, config search
packages/study      resource accounting, eligibility gates, Pareto frontier, cache
apps/studio         Vite + React + React Flow; engine behind a Comlink worker
  correctness/         swimlane layout and the guided invariant builder (no DOM)
  study/               study store, candidate mutations, guided creation (no DOM)
  webmcp/              tool surface, generated JSON Schema, registration
  canvas/geometry      chip slots and edge curves, derived from the design
  canvas/identicon     deterministic per-request icons with lineage
  canvas/choreography  trace -> slots, anchors, sprites, time warp (no DOM)
  canvas/PacketLayer   Canvas2D player; owns the clock, outside React
```

Four properties are load-bearing:

**One kernel, two engines.** `packages/kernel` is the only code that changes
stateful state. The explorer enumerates interleavings and the simulator samples one,
and a conformance test drives every operation through both and compares the
resulting worlds. Two implementations would mean two sets of bugs, the worst class
of which is "the simulator says safe and the explorer says broken and neither is
wrong about its own model".


**The simulator is headless and deterministic.** 1200 simulated seconds run in
~15ms. Identical `(design, seed)` gives a byte-identical result. Random draws come
from independent per-purpose streams, so changing a replica count leaves the
arrival sequence untouched and an A/B difference is attributable to the change
rather than to a shifted workload.

**One closed-form solver, two consumers.** The same code validates the engine in
CI and powers the studio's instant estimate, so the estimate cannot drift from the
simulation unnoticed — a test asserts they agree.

**The visuals are a pure function of a finished trace, and never touch React Flow's
node data.** Playback state lives in its own store and reaches nodes through narrow
per-node selectors; the canvas owns its own clock and re-renders nothing. Pushing
per-frame state through `nodes` would re-render the whole graph sixty times a second.
`canvas/choreography` is DOM-free — edge curves are evaluated analytically with an
arc-length table rather than by asking an SVG element for `getPointAtLength` — which is
why the choreography can be unit-tested at all, and why sprites are positioned correctly
on their first frame instead of after the element they wanted to measure exists.


## Scope

Cycles in the *topology* are still rejected. A retry is a repeated call on the same
edge, not a loop in the graph, so retries needed no cycles — which is why the
restriction survived Phase 3 unchanged. The legacy engine tolerated cycles with an
`ancestors` set and a hard depth cap of 8, quietly simulating a different topology
from the one drawn.

Failure probability is load-independent and constant. Real failures correlate with
overload and arrive in bursts; modelling that needs time-varying scenarios, which
is Phase 5.

The stability verdict needs a long enough window to distinguish "still filling
towards a plateau" from "growing without bound". The retry-storm example reports
unstable at 120 simulated seconds and stable at 600, and both are correct
readings of their windows.

Failure probability now correlates with load, which is what gives a cascade positive
gain. It is still a linear interpolation between idle and saturated, and real
failures arrive in correlated bursts rather than independently — that would need a
failure process with memory.

The chat example models the gateways' inbound and delivery sides as separate
stations, because the graph is acyclic and a delivery path looping back to the
gateway would be a cycle. In a live deployment the same event loop does both, so
accept and delivery work contend more than they do here. The connection capacity and
memory figures still belong to the gateway, which is where the "how many users"
question lives.

**There is no embedded LLM, and there will not be one.** The tool is exposed over
[WebMCP](https://github.com/webmachinelearning/webmcp) instead, so an external agent
drives the studio through a typed surface rather than living inside it. That inverts
the trust boundary in the direction this project already leans: the engine stays the
only source of numbers, the schema stays the only way to describe a design, and a
model becomes one more caller subject to the same validation as the UI — and to two
restrictions the UI does not have. A model that emitted latency figures directly
would violate the first rule the tool holds itself to.

There is no API key, no hosted backend, no account system and no deployment step.
Everything runs locally, studies live in IndexedDB, and the only pointer in local
storage is which study is open.

### Deferred, and named in every result

V1 models **one logical region with a linearizable authoritative datastore**. Network
partitions, replica divergence, quorums, consensus and vendor-specific SQL isolation
behaviour are out of scope, and every correctness result lists them in its
assumptions rather than leaving a reader to discover the gap. Vendor examples may
explain a mapping; the engine's semantics stay vendor-neutral.

Liveness and fairness are not checkable here. "Eventually every reservation is
resolved" is a true and important property that needs reasoning about infinite runs,
and every run here is bounded by construction — offering a syntax for it would
produce results whose meaning depended on the bound.

The explorer's clock is a transition counter, not a duration. Expiry is a transition
the scheduler chooses rather than a clock comparison, which is strictly more thorough:
it reaches the interleaving where a lease dies one operation before its holder
commits, which a clock-driven model finds only if the arithmetic lines up. The cost is
that a workflow writing `now()` into state makes almost every interleaving distinct
and defeats deduplication.

A wall-clock bound makes a verdict host-dependent — the same study can report
inconclusive on a loaded machine and clean on an idle one. It is disclosed via
`stats.capHit` rather than hidden, and the default is set an order of magnitude above
what the shipped portfolio needs rather than close to it. An earlier five-second
default flipped the queue candidate's verdict under CI contention and took the whole
Pareto frontier with it; the bug was in the default, not the search.
