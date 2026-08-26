# system design studio

A discrete-event simulator for finding bottlenecks and scaling limits in system
designs, validated against closed-form queueing theory.

## Status: Phase 1

The engine and a single-station studio are complete and validated. `legacy/`
holds the previous animation-driven build, kept as a visual reference.

```bash
pnpm install
pnpm verify     # typecheck + 159 tests
pnpm dev        # studio at localhost:5173
```

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
packages/schema     Zod model, structural validation, versioned migrations
packages/core       the engine — no DOM, no rAF, runs in Node and in a Worker
packages/analytic   closed-form solver: Erlang-B/C, M/M/c, M/M/c/K, P-K
apps/studio         Vite + React + React Flow; engine behind a Comlink worker
```

Two properties are load-bearing:

**The simulator is headless and deterministic.** 1200 simulated seconds run in
~15ms. Identical `(design, seed)` gives a byte-identical result. Random draws come
from independent per-purpose streams, so changing a replica count leaves the
arrival sequence untouched and an A/B difference is attributable to the change
rather than to a shifted workload.

**One closed-form solver, two consumers.** The same code validates the engine in
CI and powers the studio's instant estimate, so the estimate cannot drift from the
simulation unnoticed — a test asserts they agree.

## The validation gate

159 tests, ~14s. Every assertion compares against a **formula**, never a recorded
output; a snapshot would only prove the engine still does what it did yesterday.

- **M/M/1** — mean, population, utilization, and the full sojourn *distribution*
  (exactly `Exp(mu-lambda)`), so the tail is checked and not just the mean
- **M/M/c** — Erlang-C: `W`, `Wq`, `Lq`, and p99 against the closed-form quantile
- **M/M/c/K** — blocking probability, effective throughput, sojourn of admitted work
- **Tandem chains** — Burke's theorem, per-station and end-to-end
- **M/G/1** — Pollaczek-Khinchine, including the `(1+Cs^2)` variability effect
- **Little's Law and flow conservation** — invariants on *every* run, not only in tests
- **Determinism** and common random numbers across configuration changes
- **The tool's own precision claims**, against observed seed-to-seed spread

Run lengths are derived from the `1/(1-rho)^2` relaxation scaling rather than tuned
until green. Convergence was measured directly (5.4% → 0.07% error as a run grew
64x) to confirm residual disagreement at `rho=0.9` is variance, not bias.

## What the invariants caught

Two bugs that inspection would not have found, and that produce plausible-looking
wrong numbers:

- Station bookkeeping ignored occupancy at the warm-up boundary.
- Cohort-based measurement understated throughput by 25% under overload — 37/s
  against a true capacity of 50/s — because with a long backlog most requests
  completing in the window entered before it. Measurement is now flow-based.

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

## Phase 1 scope, deliberately narrow

Two node kinds and linear chains only. A fan-out throws rather than guessing a
routing policy — the legacy engine sent every request to *all* downstream
dependencies, silently inventing a workload the user never described. Refusing is
more useful: a fan-out is an unanswered question until per-class routing arrives.

Next: component library (load balancer, cache, connection pool, queue) with cited
benchmark constants, then failure policies (timeout, retry, circuit breaker), then
the analyzer (knee finding, sensitivity, config search).
