# system design studio

A discrete-event simulator for finding bottlenecks and scaling limits in system
designs, validated against closed-form queueing theory.

## Status: Phase 4

Validated engine, component library, and studio. `legacy/` holds the previous
animation-driven build, kept as a visual reference.

```bash
pnpm install
pnpm verify     # typecheck + 278 tests (~70s)
pnpm dev        # studio at localhost:5173
```

## Components

| Component | Modelled as | The thing it exists to show |
|---|---|---|
| **service** | M/M/c, optionally holding its slot across dependency calls | thread-pool exhaustion from a slow dependency |
| **load balancer** | round-robin / random / least-connections / power-of-two-choices | two random probes beat one by an exponential margin |
| **cache** | real Zipf key population, real LRU map, real TTL, read-through | the hit ratio is an *output*, so "how much cache do I need" is answerable |
| **database** | connection pool *outside*, execution parallelism *inside* | raising the pool past parallelism buys nothing |
| **queue** | asynchronous: publish returns immediately | the backlog grows without bound while every percentile stays green |

Plus **request classes** (traffic mix, per-class routing, cost multipliers), so
"reads go through the cache, writes go straight to the database" is expressible,
and fan-out is either fork-join (`max`) or sequential (`sum`) — explicitly, not
by assumption.

## The analyzer

```bash
pnpm sim --analyze --example retry-storm
```

Four questions, answered by simulation rather than by rule of thumb:

| Question | How | Cost |
|---|---|---|
| **Where does it break?** | binary search on offered load, bracketed by the closed form | ~10 runs |
| **Where does the latency go?** | per-station self time × visits per request | free (one run) |
| **Which knob matters?** | perturb each parameter, re-simulate with an identical arrival sequence | 2 runs per knob |
| **What is the smallest fix?** | greedy on measured effect, then a shrink pass | ~10 runs |

Plus a findings engine. Two rules, both enforced by tests: every finding cites the
numbers that produced it, and every remediation names specific values.

On the retry-storm example that produces:

```
where it breaks
  currently 450/s, holds to 345/s — OVER by 23%
  first breach: latency at 348/s
  knee located to about ±1% (bracket ±1.0%, probe p99 noise ±16.1%)

which knob matters
  parameter                          change       p99      gain elasticity
  flaky database query parallelism     8→10   268.0ms    -1.71s      -3.46
  flaky database query time           15→12   296.0ms    -1.68s       4.25
  api concurrency                     64→77   912.0ms    -1.06s      -2.65
  flaky database pool size            20→24     1.98s    -0.0ms       0.00

smallest change that meets the SLO
  flaky database query parallelism      8→ 11 (1.4×)
  p99 1.98s → 153.0ms · 8 simulations in 3356ms
```

Note the pool size: **zero gain**. Phase 2's insight — that a pool above execution
parallelism buys nothing — reappears here as a measurement rather than a claim.

The whole analysis is ~25 simulations in about 8 seconds, in a worker, off the main
thread. That is the entire return on making the engine headless.

## Failure policies

Per-edge, because that is what they are: the caller's client configuration for one
particular dependency.

| Policy | The failure it addresses |
|---|---|
| **per-attempt timeout** | a hung attempt consuming the whole retry budget |
| **retry + backoff + jitter** | transient failures; jitter stops synchronised retry waves |
| **retry budget** | retries multiplying load on a struggling dependency |
| **circuit breaker** | the *caller* spending its workers waiting on something already broken |
| **bulkhead** | one slow dependency consuming every worker the caller has |
| **health checks / outlier ejection** | a broken backend keeping its full share of traffic |

Retry amplification (`attempts / calls`) is reported per edge and system-wide.
Each tier multiplies, so three layers retrying three times is 27×.

Every default comes from a **cited benchmark library**: each constant carries a
plausible range, a source, and an as-of date, all rendered in the inspector.
They are order-of-magnitude starting points, not measurements of your system,
and the UI says so.

## Testing it

Four ways, cheapest first.

### 1. The automated gate

```bash
pnpm verify                  # typecheck + all 278 tests
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
pnpm sim --example cached-read-path  # balancer, replicas, cache, pooled database
pnpm sim --example async-write-path  # a queue whose backlog grows invisibly
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
| **examples → async write path**, then run | *"meets SLO, p99 31.8ms"* next to *"async backlog growing — invisible in every percentile"*, backlog age p50 **207 seconds** |
| **examples → cached read path**, then run | database at 74% is the bottleneck; cache absorbs 73% of reads; per-class rows show reads p99 73ms against writes 229ms |
| On that run, read the postgres row | *"capped at 1600/s by execution parallelism, not by the pool"* — the pool is at 41% while execution is at 74% |
| Switch a service to **non-blocking** | its utilization collapses, because the slot no longer covers the dependency call |
| **examples → retry storm**, before running | predicts the storm: database offered **625/s against 533/s capacity**, amplification 1.39× — retries alone push it over |
| Run it | both stations at 100%, p99 **1.98s**, 122k retries for 225k calls (1.54×) |
| **examples → retry storm, contained** | same topology, same capacity: api at 12%, p99 **139ms**, amplification 1.09×, 50k retries budget-capped |
| **examples → one broken backend**, run | the outlier is ejected 98× (98% of the window) and takes 0.7% of traffic instead of 33% |
| **analyse design** on the retry storm | ~25 simulations in 8s: holds to 345/s (23% over), api is 84% of latency and all of it queueing, parallelism 8→11 fixes it, pool size does nothing |
| Read the first finding | *"over capacity, with the queue held down by abandonment"* — the closed form and the run disagree, and the analyzer explains why |

The refusals are the point of the exercise: a tool that declines to answer is more
useful than one that guesses. So is the async example — every percentile green
while the work silently piles up is a failure mode a synchronous queue model
cannot express at all.

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

Phase 2 components, each against a theorem or a known result:

- **Pooling beats partitioning** — one queue over c servers beats c queues, by the
  Erlang-C margin. Least-connections lands near the pooled floor but cannot reach
  it, because assignment is irrevocable: a freed backend takes a new arrival, not
  one already queued elsewhere.
- **Power of two choices** — p2c beats random by >15% on p99 and comes within 5%
  of least-connections. The mean barely moves, which is exactly why the closed
  form cannot see it and the simulation must.
- **Cache hit ratio** — uniform keys give exactly `capacity/keys`; skewed keys sit
  just below the Zipf top-`C` mass (the perfect-cache bound), because LRU wastes
  some capacity. Only misses reach the origin, verified by counting arrivals.
- **Database ceiling** — throughput is `parallelism / E[S]` across pool sizes 4 to
  500. Raising the pool moves waiting from pool to execution and changes total
  latency by <8%.
- **Queue** — consumer backlog wait matches Erlang-C; an overloaded queue grows
  >20 msg/s while p99 stays under 50ms and the error rate under 1%.
- **Blocking vs non-blocking** — a blocking caller's utilization tracks its
  dependency's latency (matching `λ·(own+dep)/c`); a non-blocking one stays under
  5%. Same dependency, same load, only the concurrency model differs.
- **Fork-join** — parallel lands between `max(E)` and `sum(E)`; sequential matches
  the sum. The preview reports `max(E)` as a *lower bound*, verified in both
  directions.

Phase 3 failure policies, against exact formulas where they exist:

- **Retry amplification is exact.** Attempts follow a truncated geometric
  distribution, so `E[attempts] = (1-p^n)/(1-p)` and `success = 1-p^n`. Checked at
  four (p, n) pairs against the simulation, and the closed form is itself checked
  against the series it summarises.
- **Retry budget** — caps amplification near `1 + ratio` at 10%, 25% and 50%,
  against an unbudgeted 2.4× on the same design.
- **Circuit breaker** — trips on sustained failure, fails fast, cycles rather than
  latching, never trips on a healthy dependency, and is never retried past.
- **Bulkhead** — occupancy bounded by construction; bounds the caller's utilization
  to <35% where an unprotected caller sits above 90%.
- **Health checking** — a broken backend drops from a 33% share to under 3%, and
  the ejection cap holds when every backend looks unhealthy at once.
- **Little's Law survives retry amplification.** Retries change the attempt count,
  not the request count, so the identity must still hold exactly — and it would
  break immediately if a retried request were double-counted or a bulkhead slot
  leaked.
- **A too-short timeout makes things worse**, not safer: the dependency does 1.5×
  the work and delivers fewer successes.

Phase 4 analyzer, against exact answers where they exist:

- **The knee has a closed form.** For a single M/M/c station the sojourn p99 is
  known exactly, so the load at which it crosses an SLO target can be found by
  inverting that formula. The search reproduces it within 12% at three
  (c, service, target) combinations — and reports its own precision, since it is
  limited by probe noise rather than by its bracket.
- **Latency attribution is exact for the mean.** Contributions sum to the
  end-to-end mean within 2%, and per-station shares match the analytic per-station
  response times within 8%. p99 attribution is *withheld*: the p99 of a sum is not
  the sum of p99s.
- **Config search results are verified and minimal.** The proposed design is
  re-run at full length to confirm it passes, and every change is checked to be
  necessary — dialling any single one back must break the SLO again.
- **Sensitivity is measured with common random numbers**, so a difference is
  attributable to the parameter and not to a different workload.

Run lengths are derived from the `1/(1-rho)^2` relaxation scaling rather than tuned
until green. Convergence was measured directly (5.4% → 0.07% error as a run grew
64x) to confirm residual disagreement at `rho=0.9` is variance, not bias.

## What the invariants caught

Four bugs that inspection would not have found, each producing plausible-looking
wrong numbers:

- Station bookkeeping ignored occupancy at the warm-up boundary.
- Cohort-based measurement understated throughput by 25% under overload — 37/s
  against a true capacity of 50/s — because with a long backlog most requests
  completing in the window entered before it. Measurement is now flow-based.
- The analytic preview derived throughput from edge loss alone, ignoring load
  shedding, and so reported 150/s for a station whose capacity was 100/s.
- A station invariant was *reconstructed* from the result type, which cannot
  express boundary occupancy, so it failed on correct runs. A false alarm damages
  trust as much as a missed one; the check now lives on the component that owns
  the data.
- `Resource.queueLength` counted abandoned tombstones. Harmless until Phase 3
  introduced timeouts at scale, at which point it silently inflated `Lq`, the
  queue-length series, and the stability verdict — in exactly the runs where
  timeouts were firing.
- The preview named the *caller* as the bottleneck and reported its capacity as
  0/s. A blocking caller inherits an infinite service time from a saturated
  dependency, and infinity beats every finite ρ, so the tool pointed at the victim
  and hid the thing to fix. Caught by reading the rendered UI, not by an
  assertion — which is the argument for checking the real interface.
- Latency attribution double-counted network time by 26%, because three edges
  pointing at one cache were each credited with the cache's *full* traffic.
  Traversals are now counted per edge instead of inferred. Found by the residual
  check the decomposition reports on itself — the reason to publish a residual
  rather than a tidy pie chart.
- Two findings violated the project's own rule that evidence must cite numbers.
  A test asserting that rule across every shipped example caught them.

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

**The analyzer states what it does not search.** Config search covers capacity
only. Service times are excluded because "make the code twice as fast" is not a
configuration change, and retry settings because they trade error rate against
load rather than strictly improving — a search optimising p99 alone would happily
switch off protections. And with no cost model, it reports the smallest *set* of
changes, never the cheapest.

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

Next: replication-based confidence intervals (measured rather than modelled),
time-varying scenarios (ramp, spike, soak) so failures can correlate with overload
instead of being constant, and run comparison.
