# The simulation engine

Components, realtime connections and fan-out, measured uncertainty, A/B comparison, time-varying load, the analyzer and failure policies.

[< back to the README](../README.md)

## Components

| Component | Modelled as | The thing it exists to show |
|---|---|---|
| **service** | M/M/c, optionally holding its slot across dependency calls | thread-pool exhaustion from a slow dependency |
| **load balancer** | round-robin / random / least-connections / power-of-two-choices | two random probes beat one by an exponential margin |
| **cache** | real Zipf key population, real LRU map, real TTL, read-through | the hit ratio is an *output*, so "how much cache do I need" is answerable |
| **database** | connection pool *outside*, execution parallelism *inside* | raising the pool past parallelism buys nothing |
| **queue** | asynchronous: publish returns immediately | the backlog grows without bound while every percentile stays green |
| **gateway** | sockets held for a session + a small event-loop work pool | how many *users*, not how many requests — and that handshakes starve delivery |

Plus **request classes** (traffic mix, per-class routing, cost multipliers), so
"reads go through the cache, writes go straight to the database" is expressible,
and fan-out is either fork-join (`max`) or sequential (`sum`) — explicitly, not
by assumption.

## Interactive sessions

`SimulationSession` and the one-shot `runSimulation` API share the same event-queue
runtime. A session can advance to an absolute virtual time, advance a bounded number
of kernel events, inject one request from a client/work source in Manual mode, and
return trace and instantaneous occupancy deltas after every batch. Finishing a
session returns the ordinary `RunResult`; stepping it in any batch size produces the
same simulated result as the compatibility wrapper for the same design and seed.

Full mode starts the configured deterministic arrival generators for enabled sources.
Manual mode starts none: each canvas click injects exactly one root request and normal
routing takes over from there. Source selection is locked after the first event so a
run cannot silently change workloads halfway through.

Pause and presentation speed are session metadata. They never enter the event queue,
model options, or random streams. The worker owns active and completed sessions,
streams plain-data updates to the UI, and retains completed runs for trace replay.
Changing any executable design field invalidates an active session; moving a node does
not, because geometry is not model input.


## Realtime: connections and fan-out

```bash
pnpm sim --example chat-20k
pnpm sim --example chat-reconnect-storm
```

The question this project started from — *"a realtime chat app with 20k concurrent
users"* — needs a primitive nothing else in the model has: a resource held for an
entire session rather than a service time.

```
realtime
  connections held  20,000
  largest fan-out   20x one message becomes 20 deliveries
  total work        23.0 downstream calls per message, across every hop

stations
  gateways        gateway   8    3.2%
    connections 20,000 of 40,000 (50%) · peak 20,000 · 781 MB
    accepts 11.4/s at p99 40.3ms · 910 closed
  delivery        gateway   8   49.9%
    pushes 19,976/s · delivery p50 0.4ms / p99 0.4ms
```

**Holding sockets is cheap; pushing to them is not.** The gateways sit at 3% while
holding 20,000 connections and 781 MB. The delivery side, doing 20,000 pushes a
second, is at 50%. 1,000 messages/s costs what 20,000 requests/s would.

Fan-out is a real multiplier, not an equivalent increase in service time: 20
deliveries occupy 20 slots and queue independently. That makes a fan-out run
simulate far more work than its message rate suggests, which is the honest price of
the effect being real.

**Connections obey Little's Law.** A population of N with sessions of length S holds
N descriptors and generates N/S handshakes per second, forever — the same
`L = λW` identity the engine checks on requests, applied to a resource whose service
time is measured in minutes. Validated at three (N, S) pairs.

**Losing a gateway** drops a quarter of the connections at once. Handshakes cost far
more than messages and share the same work pool, so delivery p99 goes from **0.2ms
to 2.18s** — for users who never disconnected. That failure is invisible to every
steady-state measurement, and connection headroom is not the same thing as
resilience.


## Measured uncertainty

```bash
pnpm sim --replicate                       # independent seeds, real confidence intervals
pnpm sim --compare other.json              # paired comparison on shared seeds
```

Every precision figure before Phase 5 came from a *calibrated model* of the error.
That was a large improvement on silence, and it was still a model. Running
independent seeds and measuring the spread needs no calibration:

```
metric                      mean            95% interval      +/-
p50 latency              55.94ms          [54.76, 57.12]     2.1%
p99 latency             285.25ms        [268.94, 301.56]     5.7%
throughput               80.14/s          [79.91, 80.36]     0.3%

error model holds
modelled p99 error ±3.8% against a measured ±6.8% (1σ over 8 seeds)
```

The model is kept and **checked against the measurement on every replicated run**.
Two independent routes to the same quantity, which is the discipline the engine
itself is held to. Note the model runs somewhat optimistic — that is reported, not
smoothed over.

Intervals use Student's *t*, not 1.96. At eight replications `t(0.975, 7)` is 2.365,
so the normal quantile would report an interval ~20% too narrow — being optimistic
about your own uncertainty is the specific failure this guards.


## Did my change help?

```
metric                    baseline   candidate      change  verdict
p99 latency                1984.00      142.17      +92.8%  better
p50 latency                1642.67       28.65      +98.3%  better
throughput                  400.60      340.62      -15.0%  worse
error rate                   10.92       24.27     -122.3%  worse
retry amplification           1.54        1.08      +29.8%  better
```

Comparisons are **paired**: both designs run on the same seeds, so they see a
bit-identical workload and the per-seed difference isolates the effect of the change.
An unpaired comparison of two eight-run averages would be swamped by run-to-run
spread and would report a real 10% improvement as "not significant".

This is the return on the independent-RNG-streams decision made in Phase 1, before
there was anything to compare.


## Time-varying load

| Profile | Question it answers |
|---|---|
| **ramp** | how far does this get before it breaks — a load test in one run |
| **spike** | does it survive a burst, and *how long does recovery take* |
| **steps** | piecewise load changes |

```bash
pnpm sim --ramp --example ramp-to-failure
pnpm sim --spike --multiple 3
```

A ramp finds the limit in one simulation instead of a dozen:

```
        t   offered       p99
      169s     509/s   115.0ms
      211s     625/s     1.99s     ← breach at 573/s
```

Arrivals use **thinning** (Lewis & Shedler), which is exact. The obvious alternative
— recomputing an exponential gap from the instantaneous rate — assumes the rate holds
for the whole gap, so it lags a rising ramp and overshoots a falling one. Validated
against exact integrals: a ramp from *a* to *b* must deliver `(a+b)/2 × T` arrivals.


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
