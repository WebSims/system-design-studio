# system design studio

A discrete-event simulator for finding bottlenecks and scaling limits in system
designs, validated against closed-form queueing theory.

## Status: Phase 1

The engine and a single-station studio are complete and validated. `legacy/`
holds the previous animation-driven build, kept as a visual reference.

```bash
pnpm install
pnpm verify     # typecheck + 159 tests (~35s)
pnpm dev        # studio at localhost:5173
```

## Testing it

Four ways, cheapest first.

### 1. The automated gate

```bash
pnpm verify                  # typecheck + all 159 tests
pnpm test                    # tests only
pnpm vitest run -t "M/M/c"   # one group
```

Worth reading the failures rather than just the count: every assertion names the
formula it checks.

### 2. Cross-check the engine against theory yourself

```bash
pnpm sim --validate
```

Runs the current design against the exact M/M/c solution over 8 independent
seeds and prints the error on `W`, `L`, `Lq`, `Wq`, utilization and p99. All six
land inside ~2.4%. Anything above 5% means the run is too short — samples needed
scale as `1/(1-rho)^2`, so raise `--duration`.

### 3. Full report on any design

```bash
pnpm sim                             # the default design
pnpm sim --duration 300 --seed 5     # override scenario
pnpm sim --file my-design.json       # a design exported from the studio
```

Prints throughput, percentiles, per-station utilization and queue stats, the
invariants, the tool's own error estimate, and an analytic-vs-simulated
comparison. Two things to look at:

- **Invariants all PASS.** Little's Law should read `error 0.00%`.
- **`analytic` and `simulated` agree** within the reported precision. They are
  independent code paths, so disagreement beyond that means one is wrong.

Note `--duration 300` reports `TOO LOOSE TO ACT ON` (mean ±5.5%, p99 ±11.5%).
That is the tool working: 8,000 samples is not enough at 80% utilization.

### 4. Find where a design breaks

```bash
pnpm sim --sweep
```

17 full simulations in under half a second. Throughput saturates at exactly
`c * mu` (100/s for the default: 4 servers, 40ms service) while offered load keeps
climbing, the p99 knee appears around 80/s, and past 96/s the design is reported
`unstable` rather than given a latency number.

This is the clearest evidence for the headless split. Under the previous
architecture, where the model advanced only on animation frames, seventeen
200-second runs would have taken 57 minutes.

### Manual check in the studio

`pnpm dev`, then:

| Do this | Expect |
|---|---|
| Open it | Estimate before any run: 80% bottleneck load, ~70.8ms mean, ~276.7ms p99 |
| Press **run simulation** | p99 ~302ms, `MISSES SLO` against the 250ms target, all invariants green, Little's Law error 0.00% |
| Read the precision box | `mean ±1.8%, p99 ±3.9%` — two figures, not one |
| Press **play** under trace playback | Packets animate along the pipe; scrubbing and 4x work because playback cannot affect the model |
| Click the client, set rate to **260** | Estimate immediately withholds every number: *"does not scale — api server is offered 260/s against a capacity of 100/s (ρ = 2.60)"* |
| Run it | Names the growing queue (~160 req/s) and warns the latency figures are a function of run length |
| Set the server's service time to **lognormal**, mean 40, p99 200 | Inspector badges it `M/G/c (approx)`; the estimate's p99 is withheld with a reason |
| Drag a second connection out of the client | Run refuses: *"Phase 1 models linear chains only"* — it will not invent a routing policy |

The last two are the point of the exercise. A tool that declines to answer is
more useful than one that guesses.

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
