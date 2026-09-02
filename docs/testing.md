# Testing and validation

How to check the engine yourself, the validation gate, and what the invariants caught.

[< back to the README](../README.md)

## Testing it

Four ways, cheapest first.

### 1. The automated gate

```bash
pnpm verify                  # typecheck + every test
pnpm test                    # tests only
pnpm vitest run -t "M/M/c"   # one group
pnpm browser                 # 12 checks in a real Chrome (needs `pnpm build` + preview)
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
| Look at **trace playback** | Opens in *follow one request* with a request already chosen; the waterfall shows where its time went, and a **non-linear timeline** warning names the stretch factor |
| Watch the focused request | Its identicon sits in a chip at the station holding it, then launches out of that exact chip onto the pipe and docks into the chip waiting at the other end; the readout alternates `1 in flight` / `at a station` |
| Switch to **ambient** | Waterfall and request picker disappear; several stations show occupancy at once, at the same simulated instant, and the default speed is 0.01x |
| Scrub, then scrub back | The same requests occupy the same chips — slots are assigned from the trace, not from arrival order at render time |
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
| **examples → ramp to failure**, run | *"SLO first broke at 533/s"* — exactly the database's `parallelism/E[S]` ceiling, found in one run |
| **measure intervals** | eight seeds, real 95% intervals, and the modelled error checked against them |
| **save as baseline**, raise DB parallelism 8→20, **compare** | p99 +95.2%, throughput +9.7%, errors 8.29%→0 — all paired on shared seeds |

The refusals are the point of the exercise: a tool that declines to answer is more
useful than one that guesses. So is the async example — every percentile green
while the work silently piles up is a failure mode a synchronous queue model
cannot express at all.

### 5. Drive the built app in a real browser

The step that has found the most, and the only one that exercises what a user
actually loads:

```bash
pnpm build
cd apps/studio && npx vite preview --port 4319
```

Then drive it over the Chrome DevTools Protocol — headless Chrome with
`--remote-debugging-port`, clicking real buttons and reading the real DOM and canvas.
Four of the bugs listed below were invisible to both `tsc` and the test suite: a
missing `nodeTypes` entry that React Flow silently papered over, a non-null assertion
that blanked the app on every run, a preview that blamed the wrong component, and a
sprite canvas that was correct in every assertion and empty on screen.

The canvas is worth checking by counting non-transparent pixels over a full playback
loop rather than at one instant. A first attempt sampled 24 times across less than half
a loop and reported the animation dead, when it was working and simply aliased against
its own duty cycle — sprites are on wires roughly 8% of the time by nature of the
designs, not by accident.


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

Phase 5 statistics and scenarios:

- **Interval coverage is tested by its own definition.** Samples drawn from a normal
  with a known mean, 4000 trials: a 95% interval must contain the true mean about
  95% of the time, and it does (93–97%).
- **Paired comparison detects a shift smaller than the spread.** Samples swinging
  80–130 with every pair moving down by exactly 5 → significant. Two independent
  noise samples → correctly not significant. A design against itself → difference
  exactly zero.
- **Arrival profiles integrate to exact totals** — ramp, spike and steps each
  checked against their integral.
- **The ramp knee and the steady-state knee agree within a third**, and a *steeper*
  ramp reports a higher limit — the lag, measured directly with duration held fixed
  so the sample window doesn't confound the slope.

Phase 7 connections and fan-out:

- **Little's Law for connections** — accept rate equals population/session at three
  (N, S) pairs, and held connections equal `accept rate × session length`.
- **Fan-out is exact** — `N` deliveries per message gives exactly `N` traversals, at
  factors 1, 5, 20 and 50, and multiplies *delivery* load without touching message
  throughput.
- **Capacity refusal** — a population above capacity holds exactly the capacity and
  refuses the rest.
- **A gateway does not hold its work slot** across downstream calls; utilization
  reflects only its own push work.
- **Reconnect storm** — the configured share drops and all of it returns; delivery
  p99 degrades >10× for connections that never dropped, and spreading the reconnects
  measurably reduces the damage.

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
- Breach detection fired on noise. A p99 taken from one ~20-sample window is
  essentially the maximum, and a lognormal service time throws a large maximum often
  enough that the ramp example reported its limit at 64/s instead of 533/s. Detection
  now merges the last six windows and requires 200 samples.
- Load-correlated failure counted the request being served as load, putting a floor
  of `1/capacity` under the pressure term — a 4-slot station could never read below
  25% busy. It now excludes the request itself and includes the queue.
- A forced connection drop released the descriptor while the holder was still parked
  on its session timer, so the holder later closed a connection that no longer
  existed — the count was decremented twice and *the reconnect storm never happened*,
  because nobody was told their connection had gone. Fixed with a revoke handshake;
  the gateway invariant is what proves it.
- The queue's bookkeeping invariant read `consumed <= enqueued`, which is false at
  any non-empty warm-up boundary. It had been wrong since Phase 2 and went unnoticed
  until a design arrived whose queue was actually busy when measurement began.
- A gateway held its work slot across downstream calls, as a thread-per-request
  server correctly does. For an event loop that is wrong, and at fan-out scale
  catastrophically so: a station doing 0.26 core-seconds of work per second read as
  **74% utilized** and the bottleneck was attributed to the wrong component.
- **A concurrency of 1e9 typed into the inspector froze the studio permanently** — no
  console error, no recovery, just an unresponsive tab. The Erlang recursion is O(c) and
  the M/M/c/K solver is O(c+k), and the live preview evaluates them per station, per
  request class, inside a fixed-point loop, so one nine-second call became an endless
  one. Three fixes, because one was not enough: the solvers now refuse beyond a million
  states rather than truncating (a truncated recursion returns something that looks like
  an answer); `validateDesign` checks *effective* concurrency, because the quantity that
  reaches the solver is `concurrency x replicas` and bounding each factor separately still
  permits 1e10; and `NumberInput` clamps to both bounds instead of only `min`, since
  `min`/`max` on a number input are advisory and every call site had been clamping the
  lower bound by hand and none the upper.
- Bad numeric CLI flags printed a raw thirty-line ZodError stack. `--seed abc` became
  `NaN` and `--duration 0` a value the schema rejects, and the whole override block sat
  *outside* the try/catch that produces the one-line `refused:` every other bad input
  gets. Silently ignoring the flag would have been worse: the run would have proceeded on
  a different seed than the one asked for and printed numbers for it.
- `--duration` overrode the run length but not the warm-up, so asking any shipped example
  for a short run was rejected as unrunnable — warm-up outlasted the whole run. The
  engine would have accepted it, clamping warm-up to 90% and quietly measuring a
  six-second window. Two code paths held different opinions about the same config, and
  the more permissive one was the one that produced numbers. The flag now scales warm-up
  by the design's own fraction, as `--sweep` already did.
- `nodeTypes` was missing `gateway`. React Flow silently falls back to a default node
  rather than failing, so the component shipped invisible and unselectable in a first
  pass. The map is now typed exhaustively over `NodeKind`.
- A non-null assertion crashed the entire studio. Focus mode is the default, so the panel
  rendered once before the effect that picks a request had run, and `focused!.endMs`
  threw — blanking the app after every run. The `!` is what let it compile: it silenced
  precisely the check that mattered. Caught by loading the built app in a browser, not by
  `tsc`, and the reason a real browser check is part of the ritual.
- The sprite canvas was drawing nothing, and the waterfall said why: two network hops
  accounted for 0.6% of a 380ms request while a single database visit accounted for 99%.
  Played to scale, the sprite crossing the wire existed for under one frame of a six-second
  loop. Not a rendering bug — an honest picture of a design nobody can see. It forced the
  time-warp decision above, including its disclosure.
- A first attempt at the slot-overlap invariant was O(n^3) and hung the suite rather than
  failing it. Rewritten as a per-slot sweep. A test that never finishes is worse than no
  test, because it reads as an infrastructure problem instead of a bug.
- `errIcon` was not idempotent and `hopIcon`/`visitIcon` shared a salt space, so a node
  and an edge with the same id produced identical icons — a request would have looked
  unchanged on docking. Both found by asserting properties of the identicons rather than
  by looking at them.


## Watching it run

The original build's best idea was visual: every request was a small identicon, it
mutated as it crossed each hop so a fan-out read as one shape in several colours, and
each station showed the requests currently inside it. That idea is back — but as an
observer of a finished trace rather than as the model itself.

The engine runs in a worker and finishes before anything is drawn. The player then
samples the recorded trace. Nothing on screen can influence a number, which is what
makes scrubbing, replaying and following one request free, and what lets the engine
measure millions of requests while the canvas animates a sampled few thousand. The
original could not exceed 60 frames per second or 150 concurrent packets, because the
animation *was* the simulation.

**Occupancy chips.** Each station shows the requests inside it right now, as identicons.
A sprite arriving on a pipe docks into the exact chip its request will occupy, and
launches from the chip it was in — so a fan-out reads as one shape leaving in several
colours and each colour returning to the slot held open for it. Slots are assigned once
by interval colouring, so a request keeps its slot for its whole visit and scrubbing
backwards produces the same arrangement as scrubbing forwards. Green means in service,
amber means queued.

The strip holds seven and reports the rest as a count, for two reasons: the trace is
sampled, so the chips were always a sample rather than a census; and React Flow measures
node heights, so a node that grew during playback would re-measure many times a second.

**Two modes, because one timescale cannot be honest about a real design.** Durations span
four orders of magnitude — a quarter-millisecond network hop inside a request that takes
half a second.

*Ambient* plays simulated time linearly, so everything on screen is at the same instant.
Its default is 0.01×, and even then wires are usually empty: a request spends almost all
of its life at a station, not on a wire. The transport says `at a station` rather than
leaving that to look like a broken animation. What ambient mode is genuinely good for is
the chips — seeing which stations hold work, simultaneously.

*Focus* follows one request and stretches its journey to a few seconds. This is a
**non-linear timeline** and it says so, in the panel, with the stretch factor. It is
defensible only because two things hold: following a single request makes no claim about
what else was happening at that instant, so there is no simultaneity left to distort;
and the waterfall beside it stays strictly to scale with every bar labelled in real time.
The animation shows the shape of the journey, the waterfall owns its proportions.
Ambient mode is never warped, because there the simultaneity claim is real.

The compression is a power law rather than a floor, so ordering survives: a longer phase
always gets at least as much screen time as a shorter one, and the station where the time
actually goes still visibly dominates. Both properties are asserted.

**The waterfall** is the payload of focus mode: which station held the request, for how
long, and how much of that was queueing rather than work. Queue wait is hatched over the
front of each bar, because that is the half capacity can buy back.
